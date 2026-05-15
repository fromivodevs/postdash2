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
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// CHECK constraints over bare `text` columns (preferred over pg enums for
// migration flexibility — adding a value is a no-op constraint swap, not an
// ALTER TYPE). These mirror the `IN (...)` lists in 0001_phase1.sql exactly;
// schema.ts <-> migration parity is non-negotiable.
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
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
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
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
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
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
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
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
    check(
      'workspace_members_role_check',
      sql`${t.role} IN ('owner', 'admin', 'editor', 'viewer')`,
    ),
    check('workspace_members_status_check', sql`${t.status} IN ('active', 'removed')`),
  ],
);

export const commandIdempotency = pgTable(
  'command_idempotency',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
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
    check(
      'command_idempotency_status_check',
      sql`${t.status} IN ('pending', 'success')`,
    ),
  ],
);

export const operationLog = pgTable(
  'operation_log',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
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
