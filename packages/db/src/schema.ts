/**
 * Drizzle schema.
 *
 * Phase 1: identity (users, telegram_identities, workspaces, workspace_members)
 *          + idempotency (command_idempotency) + audit (operation_log).
 *
 * Reference: tg_mvp_plan/03-DATABASE-SCHEMA.md.
 *
 * Phase 2+: content_channels, channel_connections, channel_connect_codes.
 * Phase 3+: topic_profiles, sources, workspace_source_subscriptions.
 * Phase 4+: tasks, global_news_items, news_clusters, embeddings.
 */

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { vector } from 'drizzle-orm/pg-core';

// CHECK constraints over bare `text` columns (preferred over pg enums for
// migration flexibility — adding a value is a no-op constraint swap, not an
// ALTER TYPE). These mirror the `IN (...)` lists in 0001_phase1.sql exactly;
// schema.ts <-> migration parity is non-negotiable.
export const users = pgTable(
  'users',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    status: text('status').notNull().default('active'),
    primaryTelegramIdentityId: uuid('primary_telegram_identity_id'),
    lastActiveWorkspaceId: uuid('last_active_workspace_id'),
  },
  (t) => [check('users_status_check', sql`${t.status} IN ('active', 'disabled')`)],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    // ON DELETE RESTRICT: a user who created a workspace cannot be hard-deleted
    // out from under it. Account removal is a soft-delete (users.status =
    // 'disabled'), never a row DELETE — this FK enforces that expectation.
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    status: text('status').notNull().default('active'),
  },
  (t) => [check('workspaces_status_check', sql`${t.status} IN ('active', 'disabled')`)],
);

export const telegramIdentities = pgTable(
  'telegram_identities',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    telegramUserId: bigint('telegram_user_id', { mode: 'bigint' }).notNull(),
    username: text('username'),
    firstName: text('first_name'),
    lastName: text('last_name'),
    photoUrl: text('photo_url'),
    linkedAt: timestamp('linked_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    status: text('status').notNull().default('active'),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    unique('telegram_identities_telegram_user_id_unique').on(t.telegramUserId),
    index('telegram_identities_user_id_idx').on(t.userId),
    check(
      'telegram_identities_status_check',
      sql`${t.status} IN ('active', 'blocked_bot', 'revoked')`,
    ),
  ],
);

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    status: text('status').notNull().default('active'),
  },
  (t) => [
    unique('workspace_members_workspace_user_unique').on(t.workspaceId, t.userId),
    index('workspace_members_user_id_idx').on(t.userId),
    check('workspace_members_role_check', sql`${t.role} IN ('owner', 'admin', 'editor', 'viewer')`),
    check('workspace_members_status_check', sql`${t.status} IN ('active', 'removed')`),
  ],
);

export const commandIdempotency = pgTable(
  'command_idempotency',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    commandType: text('command_type').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    resultObjectType: text('result_object_type'),
    resultObjectId: uuid('result_object_id'),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [
    unique('command_idempotency_unique').on(t.commandType, t.idempotencyKey),
    index('command_idempotency_expires_at_idx').on(t.expiresAt),
    // Only 'pending' and 'success' are ever persisted: a failed work() DELETEs
    // its slot rather than marking it 'failed' (see runIdempotent). Mirrors
    // command_idempotency_status_check in 0001_phase1.sql.
    check('command_idempotency_status_check', sql`${t.status} IN ('pending', 'success')`),
  ],
);

export const operationLog = pgTable(
  'operation_log',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id'),
    userId: uuid('user_id'),
    telegramUserId: bigint('telegram_user_id', { mode: 'bigint' }),
    commandType: text('command_type').notNull(),
    objectType: text('object_type'),
    objectId: uuid('object_id'),
    payloadSummary: jsonb('payload_summary'),
    result: text('result').notNull(),
    errorMessage: text('error_message'),
    // correlation_id / idempotency_key are forward-provisions: Phase 1 commands
    // write neither (see authenticate-telegram.ts / mark-bot-blocked.ts), they
    // exist so later phases can populate them without a migration.
    //
    // =========================================================================
    // SECURITY — idempotency_key MUST NEVER store the raw `tma:<hash>` auth key.
    // =========================================================================
    // That hash is a session-bound credential (an HMAC over the whole initData,
    // see apps/api/src/auth/extract-initdata.ts); persisting it in an audit row
    // turns the operation_log into a credential store. The FIRST writer of this
    // column (a later-phase operation_log insert) MUST hash/truncate the value
    // to a non-reversible digest before it ever reaches this row — treat that as
    // a hard review gate, not a nice-to-have. Mirrored in 0001_phase1.sql.
    // =========================================================================
    correlationId: text('correlation_id'),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('operation_log_workspace_created_at_idx').on(t.workspaceId, t.createdAt),
    index('operation_log_command_created_at_idx').on(t.commandType, t.createdAt),
    index('operation_log_user_created_at_idx').on(t.userId, t.createdAt),
    // The command layer only ever writes 'success' today (see
    // authenticate-telegram.ts / mark-bot-blocked.ts); 'failure' is an
    // intentional forward-provision for later phases (a failing command logged
    // without a migration), not an oversight. Mirrors operation_log_result_check
    // in 0001_phase1.sql.
    check('operation_log_result_check', sql`${t.result} IN ('success', 'failure')`),
  ],
);

// =============================================================================
// Phase 2: channel connection. See architecture/channel-connection.md.
// Each table mirrors 0002_phase2.sql exactly — schema.ts <-> migration parity
// is non-negotiable.
// =============================================================================

export const contentChannels = pgTable(
  'content_channels',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    platform: text('platform').notNull(),
    // external_id is text (not bigint): platform-uniform key for future
    // adapters whose IDs are alphanumeric. Telegram int64 fits trivially.
    externalId: text('external_id').notNull(),
    type: text('type').notNull(),
    title: text('title').notNull(),
    username: text('username'),
    photoUrl: text('photo_url'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check('content_channels_platform_check', sql`${t.platform} IN ('telegram')`),
    check(
      'content_channels_type_check',
      sql`${t.type} IN ('channel', 'supergroup', 'group', 'private_chat')`,
    ),
    unique('content_channels_platform_external_unique').on(t.platform, t.externalId),
    index('content_channels_platform_idx').on(t.platform),
  ],
);

export const channelConnections = pgTable(
  'channel_connections',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    contentChannelId: uuid('content_channel_id')
      .notNull()
      .references(() => contentChannels.id, { onDelete: 'restrict' }),
    status: text('status').notNull().default('pending'),
    // null = "never verified" (pending); true/false after first verify call.
    canPostMessages: boolean('can_post_messages'),
    lastVerifyStatus: text('last_verify_status'),
    lastVerifyError: text('last_verify_error'),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true, mode: 'date' }),
    connectedAt: timestamp('connected_at', { withTimezone: true, mode: 'date' }),
    connectedByUserId: uuid('connected_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'channel_connections_status_check',
      sql`${t.status} IN ('pending', 'connected', 'broken', 'revoked')`,
    ),
    check(
      'channel_connections_last_verify_status_check',
      sql`${t.lastVerifyStatus} IS NULL OR ${t.lastVerifyStatus} IN (
        'ok', 'bot_not_admin', 'missing_post_permission',
        'chat_not_found', 'bot_blocked', 'network', 'unauthorized', 'unknown'
      )`,
    ),
    // Hard upper bound on last_verify_error length. Architecture doc says
    // "<=200 chars, never stack trace"; enforcing the cap at the DB so an
    // accidental log-spillover in a future verify path can't bloat the row.
    // Mirrors channel_connections_last_verify_error_length_check in 0002_phase2.sql.
    check(
      'channel_connections_last_verify_error_length_check',
      sql`${t.lastVerifyError} IS NULL OR length(${t.lastVerifyError}) <= 200`,
    ),
    // Phase 2: one workspace owns each content_channel. Phase 9 may relax to
    // a partial-unique excluding 'revoked'. Enforces edge case 3.3 (channel
    // taken by another workspace).
    unique('channel_connections_content_channel_unique').on(t.contentChannelId),
    index('channel_connections_workspace_idx').on(t.workspaceId, t.status),
  ],
);

export const channelConnectCodes = pgTable(
  'channel_connect_codes',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // =========================================================================
    // SECURITY — code_hash is sha256(plaintext_code) hex.
    // =========================================================================
    // Plaintext code is a short-lived bearer token (deep-link payload). At-rest
    // storage of plaintext would turn backups/replicas/logs into "any active
    // code is redeemable". sha256 + 40-bit code + TTL + single-use + connect-
    // route rate-limit makes brute force infeasible. Plaintext code MUST
    // NEVER appear in this column, operation_log.payload_summary, or
    // command_idempotency.idempotency_key. Mirrors 0002_phase2.sql.
    // =========================================================================
    codeHash: text('code_hash').notNull(),
    status: text('status').notNull().default('active'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
    consumedByTelegramUserId: bigint('consumed_by_telegram_user_id', { mode: 'bigint' }),
    consumedByExternalChatId: text('consumed_by_external_chat_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'channel_connect_codes_status_check',
      sql`${t.status} IN ('active', 'consumed', 'expired')`,
    ),
    unique('channel_connect_codes_code_hash_unique').on(t.codeHash),
    // Two narrow indexes: janitor sweeps via (status, expires_at); UI list via
    // (workspace_id, status). Lookup by code_hash is covered by UNIQUE.
    index('channel_connect_codes_status_expires_at_idx').on(t.status, t.expiresAt),
    index('channel_connect_codes_workspace_idx').on(t.workspaceId, t.status),
  ],
);

// =============================================================================
// Phase 3: topics + sources + workspace_source_subscriptions.
// See architecture/topics-and-sources.md. Mirrors 0003_phase3.sql exactly —
// schema.ts <-> migration parity is non-negotiable.
// =============================================================================

export const topicProfiles = pgTable(
  'topic_profiles',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    language: text('language').notNull(),
    mainTopics: text('main_topics')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    keywords: text('keywords')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    negativeKeywords: text('negative_keywords')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    toneProfile: jsonb('tone_profile'),
    // pgvector(256) — Yandex text-search-doc output dim.
    // NULL until Phase 4 recompute_topic_embedding task fills it.
    embedding: vector('embedding', { dimensions: 256 }),
    embeddingStatus: text('embedding_status').notNull().default('pending'),
    embeddingUpdatedAt: timestamp('embedding_updated_at', { withTimezone: true, mode: 'date' }),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check('topic_profiles_language_check', sql`${t.language} IN ('ru', 'en')`),
    check(
      'topic_profiles_embedding_status_check',
      sql`${t.embeddingStatus} IN ('pending', 'ok', 'failed')`,
    ),
    check('topic_profiles_status_check', sql`${t.status} IN ('active', 'disabled')`),
    index('topic_profiles_workspace_idx').on(t.workspaceId, t.status),
    // Phase 3 hardening (migration 0004): partial UNIQUE — at most one
    // active profile per workspace. Closes the SELECT-then-INSERT race in
    // createTopicProfile. Drizzle's `uniqueIndex(...).where(...)` mirrors
    // the same CREATE UNIQUE INDEX ... WHERE clause from 0004.
    uniqueIndex('topic_profiles_one_active_per_workspace_uniq')
      .on(t.workspaceId)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const sources = pgTable(
  'sources',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    type: text('type').notNull(),
    url: text('url').notNull(),
    canonicalUrl: text('canonical_url').notNull(),
    name: text('name'),
    fetchIntervalMinutes: integer('fetch_interval_minutes').notNull().default(60),
    maxItemsPerFetch: integer('max_items_per_fetch').notNull().default(50),
    reliabilityScore: numeric('reliability_score'),
    lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true, mode: 'date' }),
    lastFetchStatus: text('last_fetch_status'),
    lastFetchError: text('last_fetch_error'),
    canonicalizationRuleVersion: text('canonicalization_rule_version').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check('sources_type_check', sql`${t.type} IN ('rss', 'website', 'api', 'manual')`),
    check('sources_status_check', sql`${t.status} IN ('active', 'disabled', 'error')`),
    check(
      'sources_last_fetch_status_check',
      sql`${t.lastFetchStatus} IS NULL OR ${t.lastFetchStatus} IN (
        'ok', '4xx', '5xx', 'parse_error', 'timeout'
      )`,
    ),
    // Same length cap as channel_connections.last_verify_error: short label,
    // never a stack trace. Mirrors sources_last_fetch_error_length_check in
    // 0003_phase3.sql.
    check(
      'sources_last_fetch_error_length_check',
      sql`${t.lastFetchError} IS NULL OR length(${t.lastFetchError}) <= 200`,
    ),
    check('sources_fetch_interval_minutes_check', sql`${t.fetchIntervalMinutes} > 0`),
    check('sources_max_items_per_fetch_check', sql`${t.maxItemsPerFetch} > 0`),
    unique('sources_canonical_url_unique').on(t.canonicalUrl),
    index('sources_status_last_fetched_at_idx').on(t.status, t.lastFetchedAt),
  ],
);

export const workspaceSourceSubscriptions = pgTable(
  'workspace_source_subscriptions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'restrict' }),
    topicProfileId: uuid('topic_profile_id').references(() => topicProfiles.id, {
      onDelete: 'set null',
    }),
    enabled: boolean('enabled').notNull().default(true),
    priority: integer('priority').notNull().default(50),
    customRules: jsonb('custom_rules')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    // UNIQUE includes topic_profile_id so multi-profile per (workspace, source)
    // works in Phase 5+. MVP single-profile UX upserts on (workspace, source)
    // WHERE topic_profile_id IS NULL in the application layer.
    unique('workspace_source_subscriptions_unique').on(t.workspaceId, t.sourceId, t.topicProfileId),
    check(
      'workspace_source_subscriptions_priority_check',
      sql`${t.priority} >= 0 AND ${t.priority} <= 100`,
    ),
    index('workspace_source_subscriptions_source_idx').on(t.sourceId, t.enabled),
    index('workspace_source_subscriptions_workspace_idx').on(t.workspaceId, t.enabled),
    // Phase 3 hardening (migration 0004): partial UNIQUE for the
    // default-profile subscription. NULL topic_profile_id rows are now
    // deduplicated at the DB layer, enabling single-statement ON CONFLICT
    // upsert in createSource. Closes the SELECT-then-INSERT race.
    uniqueIndex('workspace_source_subscriptions_default_per_source_uniq')
      .on(t.workspaceId, t.sourceId)
      .where(sql`${t.topicProfileId} IS NULL`),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type NewWorkspaceRow = typeof workspaces.$inferInsert;
export type TelegramIdentityRow = typeof telegramIdentities.$inferSelect;
export type NewTelegramIdentityRow = typeof telegramIdentities.$inferInsert;
export type WorkspaceMemberRow = typeof workspaceMembers.$inferSelect;
export type NewWorkspaceMemberRow = typeof workspaceMembers.$inferInsert;
export type CommandIdempotencyRow = typeof commandIdempotency.$inferSelect;
export type NewCommandIdempotencyRow = typeof commandIdempotency.$inferInsert;
export type OperationLogRow = typeof operationLog.$inferSelect;
export type NewOperationLogRow = typeof operationLog.$inferInsert;
export type ContentChannelRow = typeof contentChannels.$inferSelect;
export type NewContentChannelRow = typeof contentChannels.$inferInsert;
export type ChannelConnectionRow = typeof channelConnections.$inferSelect;
export type NewChannelConnectionRow = typeof channelConnections.$inferInsert;
export type ChannelConnectCodeRow = typeof channelConnectCodes.$inferSelect;
export type NewChannelConnectCodeRow = typeof channelConnectCodes.$inferInsert;
export type TopicProfileRow = typeof topicProfiles.$inferSelect;
export type NewTopicProfileRow = typeof topicProfiles.$inferInsert;
export type SourceRow = typeof sources.$inferSelect;
export type NewSourceRow = typeof sources.$inferInsert;
export type WorkspaceSourceSubscriptionRow = typeof workspaceSourceSubscriptions.$inferSelect;
export type NewWorkspaceSourceSubscriptionRow = typeof workspaceSourceSubscriptions.$inferInsert;

// =============================================================================
// Phase 4: task system + global news layer + embeddings + system_state.
// See architecture/global-ingestion.md. Mirrors 0005_phase4.sql exactly —
// schema.ts <-> migration parity is non-negotiable.
// =============================================================================

export const systemState = pgTable(
  'system_state',
  {
    key: text('key').primaryKey(),
    value: jsonb('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    index('system_state_expires_at_idx')
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} IS NOT NULL`),
    // Allowlist for `key`: today only `ya_iam_token` is ever written (by
    // packages/ai/iam-token.ts via the worker's IAMTokenStore adapter). The
    // CHECK keeps additions a deliberate migration step instead of letting
    // system_state drift into a generic kv table. Extending the list requires
    // an ALTER TABLE migration AND a matching update here — schema.ts <->
    // migration parity is non-negotiable. Mirrors system_state_key_allowlist
    // in 0007_phase4_perf_security.sql.
    check('system_state_key_allowlist', sql`${t.key} IN ('ya_iam_token')`),
  ],
);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    type: text('type').notNull(),
    priority: integer('priority').notNull().default(50),
    status: text('status').notNull().default('pending'),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').references(() => sources.id, { onDelete: 'cascade' }),
    lockedBy: text('locked_by'),
    lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'date' }),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'tasks_type_check',
      sql`${t.type} IN ('fetch_source', 'extract_news_item', 'embed_news_item', 'cluster_news', 'janitor_release_stuck_tasks', 'refresh_iam_token', 'match_news_to_workspaces', 'score_workspace_match', 'recompute_topic_embedding')`,
    ),
    check(
      'tasks_status_check',
      sql`${t.status} IN ('pending', 'running', 'completed', 'failed', 'failed_permanent', 'deferred', 'skipped_volume_cap', 'cancelled')`,
    ),
    check('tasks_priority_check', sql`${t.priority} >= 0 AND ${t.priority} <= 100`),
    check('tasks_attempts_nonneg', sql`${t.attempts} >= 0`),
    check('tasks_max_attempts_pos', sql`${t.maxAttempts} > 0`),
    check(
      'tasks_last_error_length_check',
      sql`${t.lastError} IS NULL OR length(${t.lastError}) <= 200`,
    ),
    // Phase 4 perf (migration 0007): the polling index is `(priority DESC,
    // scheduled_at ASC) WHERE status='pending'` — column ordering that
    // matches the ORDER BY in pollNextTask exactly. Drizzle's `.on()` builder
    // does not preserve per-column sort direction in the partial-index form
    // used here, so the index lives ONLY in 0007_phase4_perf_security.sql.
    // Schema parity remains via the migration source-of-truth convention
    // (same as the ivfflat note below).
    index('tasks_stuck_running_idx')
      .on(t.lockedUntil)
      .where(sql`${t.status} = 'running'`),
    index('tasks_source_status_idx')
      .on(t.sourceId, t.status)
      .where(sql`${t.sourceId} IS NOT NULL`),
    index('tasks_workspace_status_idx')
      .on(t.workspaceId, t.status)
      .where(sql`${t.workspaceId} IS NOT NULL`),
    // Partial UNIQUE — at most one active fetch_source per source. Closes
    // edge case 9.3 (scheduler creating duplicate fetch tasks).
    uniqueIndex('tasks_unique_active_fetch_per_source')
      .on(t.sourceId)
      .where(sql`${t.type} = 'fetch_source' AND ${t.status} IN ('pending', 'running')`),
    uniqueIndex('tasks_unique_active_iam_refresh')
      .on(t.type)
      .where(sql`${t.type} = 'refresh_iam_token' AND ${t.status} IN ('pending', 'running')`),
    uniqueIndex('tasks_unique_active_janitor')
      .on(t.type)
      .where(
        sql`${t.type} = 'janitor_release_stuck_tasks' AND ${t.status} IN ('pending', 'running')`,
      ),
    // Phase 4 hardening (migration 0006): partial UNIQUE on the expression
    // `payload->>'news_item_id'` for `extract_news_item` and `embed_news_item`.
    // Drizzle's `.on()` builder takes table columns, not arbitrary SQL
    // expressions; mirroring an expression-based UNIQUE here is impossible
    // without an upstream API change. These indexes therefore live ONLY in
    // 0006_phase4_hardening.sql — same convention as the ivfflat note above.
    // Adding new expression-based indexes? Add them to the migration AND mention
    // them here so schema readers know to look at the migration too.
    //
    // Phase 4 perf+security (migration 0007): same pattern — partial UNIQUE
    // on `(payload->>'news_item_id')` for `cluster_news`, plus a re-created
    // `tasks_polling_idx` with `(priority DESC, scheduled_at ASC)` column
    // order that matches the polling ORDER BY exactly.
  ],
);

export const taskRuns = pgTable(
  'task_runs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    workerId: text('worker_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    status: text('status').notNull().default('running'),
    errorMessage: text('error_message'),
  },
  (t) => [
    check(
      'task_runs_status_check',
      sql`${t.status} IN ('running', 'completed', 'failed', 'failed_permanent')`,
    ),
    check(
      'task_runs_error_length_check',
      sql`${t.errorMessage} IS NULL OR length(${t.errorMessage}) <= 200`,
    ),
    index('task_runs_task_started_idx').on(t.taskId, t.startedAt),
  ],
);

export const globalNewsItems = pgTable(
  'global_news_items',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    url: text('url').notNull(),
    canonicalUrl: text('canonical_url').notNull(),
    contentHash: text('content_hash').notNull(),
    extractedText: text('extracted_text'),
    summary: text('summary'),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    language: text('language'),
    embedding: vector('embedding', { dimensions: 256 }),
    embeddingStatus: text('embedding_status').notNull().default('pending'),
    embeddingUpdatedAt: timestamp('embedding_updated_at', { withTimezone: true, mode: 'date' }),
    lastUpdatedInSourceAt: timestamp('last_updated_in_source_at', {
      withTimezone: true,
      mode: 'date',
    }),
    wasUpdated: boolean('was_updated').notNull().default(false),
    status: text('status').notNull().default('new'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'global_news_items_embedding_status_check',
      sql`${t.embeddingStatus} IN ('pending', 'ok', 'failed')`,
    ),
    check(
      'global_news_items_status_check',
      sql`${t.status} IN ('new', 'extracted', 'embedded', 'clustered', 'ignored', 'ai_refused', 'error')`,
    ),
    check(
      'global_news_items_language_check',
      sql`${t.language} IS NULL OR ${t.language} IN ('ru', 'en', 'other')`,
    ),
    unique('global_news_items_source_canonical_unique').on(t.sourceId, t.canonicalUrl),
    index('global_news_items_language_published_idx').on(t.language, t.publishedAt),
    index('global_news_items_pending_embedding_idx')
      .on(t.embeddingStatus, t.fetchedAt)
      .where(sql`${t.embeddingStatus} = 'pending'`),
    // pgvector ivfflat index — declared via raw SQL in 0005_phase4.sql.
    // Drizzle's vector index helper requires drizzle-orm >= 0.39; we keep the
    // index in the migration only, and consult the migration when adding new
    // vector indexes. Schema parity remains because the column type and
    // dimensions match exactly.
  ],
);

export const newsClusters = pgTable(
  'news_clusters',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    canonicalTitle: text('canonical_title').notNull(),
    mainUrl: text('main_url'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    sourcesCount: integer('sources_count').notNull().default(1),
    centroidEmbedding: vector('centroid_embedding', { dimensions: 256 }),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check('news_clusters_status_check', sql`${t.status} IN ('active', 'merged', 'archived')`),
    check('news_clusters_sources_count_check', sql`${t.sourcesCount} >= 1`),
    index('news_clusters_last_seen_idx')
      .on(t.lastSeenAt)
      .where(sql`${t.status} = 'active'`),
  ],
);

export const newsClusterItems = pgTable(
  'news_cluster_items',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    clusterId: uuid('cluster_id')
      .notNull()
      .references(() => newsClusters.id, { onDelete: 'cascade' }),
    newsItemId: uuid('news_item_id')
      .notNull()
      .references(() => globalNewsItems.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    unique('news_cluster_items_unique').on(t.clusterId, t.newsItemId),
    // One news item belongs to at most one cluster (otherwise cluster-level
    // matching in Phase 5 explodes into N matches per workspace per item).
    unique('news_cluster_items_news_item_unique').on(t.newsItemId),
    index('news_cluster_items_cluster_idx').on(t.clusterId),
  ],
);

export type SystemStateRow = typeof systemState.$inferSelect;
export type NewSystemStateRow = typeof systemState.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
export type TaskRunRow = typeof taskRuns.$inferSelect;
export type NewTaskRunRow = typeof taskRuns.$inferInsert;
export type GlobalNewsItemRow = typeof globalNewsItems.$inferSelect;
export type NewGlobalNewsItemRow = typeof globalNewsItems.$inferInsert;
export type NewsClusterRow = typeof newsClusters.$inferSelect;
export type NewNewsClusterRow = typeof newsClusters.$inferInsert;
export type NewsClusterItemRow = typeof newsClusterItems.$inferSelect;
export type NewNewsClusterItemRow = typeof newsClusterItems.$inferInsert;

// =============================================================================
// Phase 5: workspace_news_matches + ai_usage_events.
// See architecture/matching-and-scoring.md. Mirrors
// 0008_phase5_matching_scoring.sql exactly — schema.ts <-> migration parity
// is non-negotiable.
// =============================================================================

export const workspaceNewsMatches = pgTable(
  'workspace_news_matches',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    newsItemId: uuid('news_item_id')
      .notNull()
      .references(() => globalNewsItems.id, { onDelete: 'cascade' }),
    // cluster_id NULL means "not yet clustered" — the item-level partial
    // UNIQUE applies. Once cluster_news attaches the item, this column flips
    // to the cluster_id and the cluster-level UNIQUE governs dedup. Both
    // partial UNIQUE indexes live ONLY in the migration (Drizzle's
    // `.uniqueIndex(...).where(sql\`...\`)` mirrors them — see below).
    clusterId: uuid('cluster_id').references(() => newsClusters.id, { onDelete: 'set null' }),
    // numeric(4,2) — score range [0.00, 10.00]; CHECK enforces.
    score: numeric('score', { precision: 4, scale: 2 }),
    relevanceReason: text('relevance_reason'),
    shouldCreateDraft: boolean('should_create_draft').notNull().default(false),
    riskFlags: text('risk_flags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    scoreComponents: jsonb('score_components')
      .notNull()
      .default(sql`'{}'::jsonb`),
    aiProvider: text('ai_provider'),
    usedModel: text('used_model'),
    promptVersion: text('prompt_version'),
    status: text('status').notNull().default('candidate'),
    scoredAt: timestamp('scored_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'workspace_news_matches_status_check',
      sql`${t.status} IN ('candidate', 'filtered_negative', 'hidden', 'ai_refused', 'low_score', 'suppressed')`,
    ),
    check(
      'workspace_news_matches_score_range_check',
      sql`${t.score} IS NULL OR (${t.score} >= 0 AND ${t.score} <= 10)`,
    ),
    check(
      'workspace_news_matches_reason_length_check',
      sql`${t.relevanceReason} IS NULL OR length(${t.relevanceReason}) <= 280`,
    ),
    uniqueIndex('workspace_news_matches_workspace_cluster_uniq')
      .on(t.workspaceId, t.clusterId)
      .where(sql`${t.clusterId} IS NOT NULL`),
    uniqueIndex('workspace_news_matches_workspace_item_uniq')
      .on(t.workspaceId, t.newsItemId)
      .where(sql`${t.clusterId} IS NULL`),
    index('workspace_news_matches_workspace_status_score_idx').on(t.workspaceId, t.status, t.score),
    index('workspace_news_matches_news_item_idx').on(t.newsItemId),
  ],
);

export const aiUsageEvents = pgTable(
  'ai_usage_events',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    // task_id is intentionally NOT a FK — the audit trail must survive future
    // tasks-row retention sweeps (see migration 0008 comment). Joinable while
    // both rows exist; orphan when tasks GC'd.
    taskId: uuid('task_id'),
    actionType: text('action_type').notNull(),
    usedModel: text('used_model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costRub: numeric('cost_rub', { precision: 10, scale: 4 }).notNull().default('0'),
    durationMs: integer('duration_ms').notNull().default(0),
    status: text('status').notNull(),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'ai_usage_events_action_check',
      sql`${t.actionType} IN ('score', 'generate', 'rewrite', 'embed')`,
    ),
    check(
      'ai_usage_events_status_check',
      sql`${t.status} IN ('success', 'failed', 'refused', 'parse_error', 'fallback')`,
    ),
    check('ai_usage_events_tokens_nonneg', sql`${t.inputTokens} >= 0 AND ${t.outputTokens} >= 0`),
    check('ai_usage_events_cost_nonneg', sql`${t.costRub} >= 0`),
    check('ai_usage_events_duration_nonneg', sql`${t.durationMs} >= 0`),
    check(
      'ai_usage_events_error_length_check',
      sql`${t.errorMessage} IS NULL OR length(${t.errorMessage}) <= 500`,
    ),
    index('ai_usage_events_created_at_idx').on(t.createdAt),
    index('ai_usage_events_workspace_created_idx')
      .on(t.workspaceId, t.createdAt)
      .where(sql`${t.workspaceId} IS NOT NULL`),
    index('ai_usage_events_action_status_idx').on(t.actionType, t.status, t.createdAt),
  ],
);

export type WorkspaceNewsMatchRow = typeof workspaceNewsMatches.$inferSelect;
export type NewWorkspaceNewsMatchRow = typeof workspaceNewsMatches.$inferInsert;
export type AiUsageEventRow = typeof aiUsageEvents.$inferSelect;
export type NewAiUsageEventRow = typeof aiUsageEvents.$inferInsert;
