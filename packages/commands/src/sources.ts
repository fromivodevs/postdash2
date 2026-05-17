/**
 * Source + subscription commands (Phase 3).
 *
 * CORE INVARIANT: `sources` is a global table (one row per canonical_url
 * across all workspaces); `workspace_source_subscriptions` is the
 * per-workspace M:N glue. The createSource command embodies this split:
 *
 *   1. Resolve redirect (one-time HEAD on the user-provided URL).
 *   2. Canonicalize the resolved URL (or the input URL if resolve failed).
 *   3. INSERT into sources ON CONFLICT (canonical_url) DO UPDATE → returns
 *      either the new row id or the existing one (other workspace beat us).
 *   4. INSERT into workspace_source_subscriptions ON CONFLICT DO NOTHING →
 *      either fresh subscription or a no-op when already subscribed.
 *
 * Two workspaces adding `https://example.com/feed.xml` and
 * `https://example.com/feed.xml?utm=x` end up with ONE `sources` row and TWO
 * subscriptions pointing at it.
 *
 * The redirect resolver is injected (a `resolveRedirectFn` callable) so
 * unit tests can swap in a deterministic mock without spinning up real HTTP.
 * Default implementation uses the @postdash/sources resolveRedirect.
 *
 * Subscription mutations (PATCH / DELETE) operate ONLY on the subscription
 * row — they NEVER touch the global `sources` row, because that's shared
 * with other workspaces.
 */

import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalize, resolveRedirect } from '@postdash/sources';
import type { Source, WorkspaceSourceSubscription } from '@postdash/domain';
import type { Database, DbOrTx } from '@postdash/db';
import { sources, topicProfiles, workspaceSourceSubscriptions } from '@postdash/db';
import { CommandError } from './errors.js';
import { writeOperationLog, redactUrlForLog } from './operation-log.js';
import { assertWorkspaceRole } from './policies.js';
import { rowToSource, rowToSubscription } from './topic-row-mappers.js';

/**
 * Per-command operation_log writer, wraps the shared writeOperationLog.
 * Defaults `objectType` to `workspace_source_subscription` since all 3
 * source-side mutations target a subscription row.
 */
async function logSourceAction(
  tx: DbOrTx,
  args: { workspaceId: string; userId: string; commandType: string; objectId: string; payload?: Record<string, unknown> },
): Promise<void> {
  await writeOperationLog(tx, {
    workspaceId: args.workspaceId,
    userId: args.userId,
    commandType: args.commandType,
    objectType: 'workspace_source_subscription',
    objectId: args.objectId,
    payloadSummary: args.payload ?? {},
  });
}

// =============================================================================
// Schemas
// =============================================================================

const SourceTypeSchema = z.enum(['rss', 'website', 'api', 'manual']);

export const CreateSourceInputSchema = z.object({
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  url: z.string().min(1).max(2000),
  type: SourceTypeSchema,
  name: z.string().min(1).max(200).optional(),
  topicProfileId: z.string().uuid().optional(),
  fetchIntervalMinutes: z.number().int().min(1).max(10080).optional(),
});
export type CreateSourceInput = z.infer<typeof CreateSourceInputSchema>;

export const UpdateSourceSubscriptionInputSchema = z.object({
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  sourceId: z.string().uuid(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  topicProfileId: z.string().uuid().nullable().optional(),
});
export type UpdateSourceSubscriptionInput = z.infer<typeof UpdateSourceSubscriptionInputSchema>;

export const DeleteSourceSubscriptionInputSchema = z.object({
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  sourceId: z.string().uuid(),
});
export type DeleteSourceSubscriptionInput = z.infer<typeof DeleteSourceSubscriptionInputSchema>;

export const ListSourcesInputSchema = z.object({
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
});
export type ListSourcesInput = z.infer<typeof ListSourcesInputSchema>;

// =============================================================================
// Commands
// =============================================================================

export type ResolveRedirectFn = (url: string) => Promise<{ finalUrl: string }>;

/**
 * Default resolveRedirect adapter. Wraps `@postdash/sources/resolveRedirect`
 * so the command can ignore the status field — any failure (timeout,
 * network, too_many_hops) falls back to the input URL via the resolver's
 * own contract.
 */
const defaultResolveRedirect: ResolveRedirectFn = async (url) => {
  const r = await resolveRedirect(url);
  return { finalUrl: r.finalUrl };
};

export interface CreateSourceResult {
  source: Source;
  subscription: WorkspaceSourceSubscription;
  /** True if the global `sources` row was newly inserted (vs. reused). */
  sourceCreated: boolean;
  /** True if the subscription was newly inserted (vs. already subscribed). */
  subscriptionCreated: boolean;
}

export async function createSource(
  db: Database,
  input: CreateSourceInput,
  options: { resolveRedirect?: ResolveRedirectFn } = {},
): Promise<CreateSourceResult> {
  const parsed = CreateSourceInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CommandError(
      'validation_failed',
      `createSource: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const data = parsed.data;
  const resolver = options.resolveRedirect ?? defaultResolveRedirect;

  // Redirect resolution happens BEFORE the transaction so a slow HEAD
  // doesn't hold a Postgres transaction open for ~10 seconds. The actual
  // network call is bounded by the resolver's own timeout (10s default).
  const resolved = await resolver(data.url);

  const canon = canonicalize(resolved.finalUrl);
  if (canon.canonical === null) {
    // Redact: the URL may carry an API key in the query string. The error
    // message reaches server logs (req.log.warn) and operation_log entries
    // — keep only scheme+host+path.
    throw new CommandError(
      'validation_failed',
      `unparseable URL after redirect resolution: ${redactUrlForLog(resolved.finalUrl)}`,
      { code: 'unparseable_url' },
    );
  }
  // Hoist into a local string variable so TS narrowing survives the
  // db.transaction(async () => { ... }) callback boundary.
  const canonicalUrl: string = canon.canonical;
  const ruleVersion: string = canon.ruleVersion;

  return db.transaction(async (tx) => {
    await assertWorkspaceRole(tx, data.workspaceId, data.userId, 'editor');

    // Verify topic_profile ownership at the boundary. The subscription FK
    // would silently allow cross-workspace links without this; the
    // application-layer check matches the workspace check we run on the
    // subscription itself.
    if (data.topicProfileId) {
      // Verify ownership AND active status. A soft-deleted (status='disabled')
      // profile must not accept new subscription pins — otherwise a workspace
      // with a stale Settings UI can attach a source to a profile that's been
      // disabled, leading to "subscription pointed at a dead profile" state
      // that Phase 4 matching has no defined behaviour for.
      // FOR SHARE prevents a concurrent deleteTopicProfile from soft-deleting
      // this profile between the status check and the subscription INSERT.
      // Under READ COMMITTED without the row lock, T1 (createSource) reads
      // status='active', T2 (deleteTopicProfile) commits status='disabled',
      // T1 INSERTs a subscription pointing at a now-disabled profile. The
      // shared lock blocks T2's UPDATE on this row until T1 commits.
      const ownerRow = await tx
        .select({ workspaceId: topicProfiles.workspaceId, status: topicProfiles.status })
        .from(topicProfiles)
        .where(eq(topicProfiles.id, data.topicProfileId))
        .for('share')
        .limit(1);
      const owner = ownerRow[0];
      if (!owner) throw new CommandError('not_found', `topic_profile ${data.topicProfileId} not found`);
      if (owner.workspaceId !== data.workspaceId) {
        throw new CommandError(
          'forbidden',
          `topic_profile ${data.topicProfileId} belongs to a different workspace`,
        );
      }
      if (owner.status !== 'active') {
        throw new CommandError(
          'conflict',
          `topic_profile ${data.topicProfileId} is not active`,
          { code: 'topic_profile_disabled' },
        );
      }
    }

    // Upsert the global source. xmax-via-RETURNING is the canonical Postgres
    // trick to distinguish "row was actually inserted" from "row already
    // existed and DO UPDATE fired" — Postgres sets xmax=0 on fresh inserts,
    // non-zero on rows visited by UPDATE. The previous heuristic
    // (createdAt-vs-updatedAt within 5ms) was fragile across JS-vs-PG clocks.
    //
    // Drizzle exposes RETURNING-with-extras by appending a `sql` expression
    // to the returning() object. The base columns come from `sources.<col>`,
    // and `inserted: sql<boolean>...` adds the insert-vs-update bit.
    const upserted = await tx
      .insert(sources)
      .values({
        type: data.type,
        url: resolved.finalUrl,
        canonicalUrl,
        // Drizzle insert types use `undefined` for nullable columns, not
        // `null` — omitting the key means "leave as DB default / NULL".
        name: data.name,
        fetchIntervalMinutes: data.fetchIntervalMinutes ?? 60,
        canonicalizationRuleVersion: ruleVersion,
      })
      .onConflictDoUpdate({
        target: sources.canonicalUrl,
        // DO UPDATE bumps updated_at so consumers see "this source was
        // touched recently"; the column itself is harmless to overwrite.
        set: { updatedAt: new Date() },
      })
      .returning({
        id: sources.id,
        type: sources.type,
        url: sources.url,
        canonicalUrl: sources.canonicalUrl,
        name: sources.name,
        fetchIntervalMinutes: sources.fetchIntervalMinutes,
        maxItemsPerFetch: sources.maxItemsPerFetch,
        reliabilityScore: sources.reliabilityScore,
        lastFetchedAt: sources.lastFetchedAt,
        lastFetchStatus: sources.lastFetchStatus,
        lastFetchError: sources.lastFetchError,
        canonicalizationRuleVersion: sources.canonicalizationRuleVersion,
        status: sources.status,
        createdAt: sources.createdAt,
        updatedAt: sources.updatedAt,
        // xmax = 0 on a fresh insert; non-zero on a row that fell into
        // DO UPDATE. Cast to boolean for a clean wire shape.
        inserted: sql<boolean>`xmax = 0`,
      });
    const sourceRow = upserted[0];
    if (!sourceRow) throw new CommandError('internal', 'sources upsert returned no row');
    const sourceId = sourceRow.id;
    const sourceCreated = sourceRow.inserted === true;

    // Subscription UPSERT. Single-default MVP: subscriptions with
    // topic_profile_id IS NULL go through a single INSERT ... ON CONFLICT
    // targeting the partial unique index from migration 0004
    // (workspace_source_subscriptions_default_per_source_uniq). With an
    // explicit topic_profile_id, ON CONFLICT (workspace_id, source_id,
    // topic_profile_id) handles the standard case.
    //
    // The previous SELECT-then-INSERT-or-UPDATE path was race-prone (two
    // concurrent POSTs could both pass the SELECT, both INSERT, and the
    // 3-col UNIQUE was NULL-permissive). The partial unique index closes
    // the race at the DB layer; the catch-23505 fallback handles two
    // racers reaching INSERT simultaneously (one wins, the other lands on
    // DO UPDATE).
    const topicProfileId = data.topicProfileId ?? null;
    let subscriptionCreated: boolean;
    let subscriptionRow:
      | { id: string; workspaceId: string; sourceId: string; topicProfileId: string | null; enabled: boolean; priority: number; customRules: unknown; createdAt: Date; updatedAt: Date; inserted?: boolean }
      | undefined;

    if (topicProfileId === null) {
      // Targeting `workspaceId, sourceId` columns. Drizzle issues
      // ON CONFLICT (workspace_id, source_id) DO UPDATE — Postgres
      // picks the partial unique index from migration 0004 because the
      // INSERT row matches its WHERE topic_profile_id IS NULL predicate.
      const upserted = await tx
        .insert(workspaceSourceSubscriptions)
        .values({
          workspaceId: data.workspaceId,
          sourceId,
          topicProfileId: null,
          enabled: true,
          priority: 50,
          customRules: {},
        })
        .onConflictDoUpdate({
          target: [
            workspaceSourceSubscriptions.workspaceId,
            workspaceSourceSubscriptions.sourceId,
          ],
          targetWhere: sql`${workspaceSourceSubscriptions.topicProfileId} IS NULL`,
          // Re-enable on re-add (UX: paused → active).
          set: { enabled: true, updatedAt: new Date() },
        })
        .returning({
          id: workspaceSourceSubscriptions.id,
          workspaceId: workspaceSourceSubscriptions.workspaceId,
          sourceId: workspaceSourceSubscriptions.sourceId,
          topicProfileId: workspaceSourceSubscriptions.topicProfileId,
          enabled: workspaceSourceSubscriptions.enabled,
          priority: workspaceSourceSubscriptions.priority,
          customRules: workspaceSourceSubscriptions.customRules,
          createdAt: workspaceSourceSubscriptions.createdAt,
          updatedAt: workspaceSourceSubscriptions.updatedAt,
          inserted: sql<boolean>`xmax = 0`,
        });
      subscriptionRow = upserted[0];
      subscriptionCreated = subscriptionRow?.inserted === true;
    } else {
      // Pinned-profile path: rely on the 3-col UNIQUE in 0003. xmax is the
      // canonical insert-vs-update discriminator (replaces the previous
      // createdAt-vs-updatedAt heuristic).
      const inserted = await tx
        .insert(workspaceSourceSubscriptions)
        .values({
          workspaceId: data.workspaceId,
          sourceId,
          topicProfileId,
          enabled: true,
          priority: 50,
          customRules: {},
        })
        .onConflictDoUpdate({
          target: [
            workspaceSourceSubscriptions.workspaceId,
            workspaceSourceSubscriptions.sourceId,
            workspaceSourceSubscriptions.topicProfileId,
          ],
          set: { enabled: true, updatedAt: new Date() },
        })
        .returning({
          id: workspaceSourceSubscriptions.id,
          workspaceId: workspaceSourceSubscriptions.workspaceId,
          sourceId: workspaceSourceSubscriptions.sourceId,
          topicProfileId: workspaceSourceSubscriptions.topicProfileId,
          enabled: workspaceSourceSubscriptions.enabled,
          priority: workspaceSourceSubscriptions.priority,
          customRules: workspaceSourceSubscriptions.customRules,
          createdAt: workspaceSourceSubscriptions.createdAt,
          updatedAt: workspaceSourceSubscriptions.updatedAt,
          inserted: sql<boolean>`xmax = 0`,
        });
      subscriptionRow = inserted[0];
      subscriptionCreated = subscriptionRow?.inserted === true;
    }

    if (!subscriptionRow) {
      throw new CommandError('internal', 'subscription upsert returned no row');
    }

    await logSourceAction(tx, {
      workspaceId: data.workspaceId,
      userId: data.userId,
      commandType: 'CreateSource',
      objectId: subscriptionRow.id,
      payload: { source_created: sourceCreated, subscription_created: subscriptionCreated },
    });

    return {
      source: rowToSource(sourceRow),
      subscription: rowToSubscription(subscriptionRow),
      sourceCreated,
      subscriptionCreated,
    };
  });
}

export async function updateSourceSubscription(
  db: Database,
  input: UpdateSourceSubscriptionInput,
): Promise<{ subscription: WorkspaceSourceSubscription; source: Source }> {
  const parsed = UpdateSourceSubscriptionInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CommandError(
      'validation_failed',
      `updateSourceSubscription: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const data = parsed.data;

  return db.transaction(async (tx) => {
    await assertWorkspaceRole(tx, data.workspaceId, data.userId, 'editor');

    if (data.topicProfileId) {
      // Verify ownership AND active status. A soft-deleted (status='disabled')
      // profile must not accept new subscription pins — otherwise a workspace
      // with a stale Settings UI can attach a source to a profile that's been
      // disabled, leading to "subscription pointed at a dead profile" state
      // that Phase 4 matching has no defined behaviour for.
      // FOR SHARE prevents a concurrent deleteTopicProfile from soft-deleting
      // this profile between the status check and the subscription INSERT.
      // Under READ COMMITTED without the row lock, T1 (createSource) reads
      // status='active', T2 (deleteTopicProfile) commits status='disabled',
      // T1 INSERTs a subscription pointing at a now-disabled profile. The
      // shared lock blocks T2's UPDATE on this row until T1 commits.
      const ownerRow = await tx
        .select({ workspaceId: topicProfiles.workspaceId, status: topicProfiles.status })
        .from(topicProfiles)
        .where(eq(topicProfiles.id, data.topicProfileId))
        .for('share')
        .limit(1);
      const owner = ownerRow[0];
      if (!owner) throw new CommandError('not_found', `topic_profile ${data.topicProfileId} not found`);
      if (owner.workspaceId !== data.workspaceId) {
        throw new CommandError(
          'forbidden',
          `topic_profile ${data.topicProfileId} belongs to a different workspace`,
        );
      }
      if (owner.status !== 'active') {
        throw new CommandError(
          'conflict',
          `topic_profile ${data.topicProfileId} is not active`,
          { code: 'topic_profile_disabled' },
        );
      }
    }

    const existing = await loadOwnedSubscription(tx, data.sourceId, data.workspaceId);

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (data.enabled !== undefined) patch.enabled = data.enabled;
    if (data.priority !== undefined) patch.priority = data.priority;
    if (data.topicProfileId !== undefined) patch.topicProfileId = data.topicProfileId;

    const updated = await tx
      .update(workspaceSourceSubscriptions)
      .set(patch)
      .where(eq(workspaceSourceSubscriptions.id, existing.id))
      .returning();
    const row = updated[0];
    if (!row) throw new CommandError('internal', 'subscription update returned no row');

    // Single-row fetch of the joined source so the route can project without
    // re-running listSources. PK lookup → cheap, no JOIN.
    const sourceRows = await tx
      .select()
      .from(sources)
      .where(eq(sources.id, data.sourceId))
      .limit(1);
    const sourceRow = sourceRows[0];
    if (!sourceRow) {
      throw new CommandError('internal', `source ${data.sourceId} vanished mid-update`);
    }

    await logSourceAction(tx, {
      workspaceId: data.workspaceId,
      userId: data.userId,
      commandType: 'UpdateSourceSubscription',
      objectId: row.id,
    });

    return { subscription: rowToSubscription(row), source: rowToSource(sourceRow) };
  });
}

export async function deleteSourceSubscription(
  db: Database,
  input: DeleteSourceSubscriptionInput,
): Promise<void> {
  const parsed = DeleteSourceSubscriptionInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CommandError(
      'validation_failed',
      `deleteSourceSubscription: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const data = parsed.data;

  await db.transaction(async (tx) => {
    await assertWorkspaceRole(tx, data.workspaceId, data.userId, 'editor');
    const existing = await loadOwnedSubscription(tx, data.sourceId, data.workspaceId);
    // Hard delete the subscription row. The global `sources` row stays —
    // other workspaces may still subscribe to it. Phase 4+ janitor will
    // garbage-collect sources with zero subscriptions if that proves
    // wasteful; today we keep the row for source-health continuity.
    await tx
      .delete(workspaceSourceSubscriptions)
      .where(eq(workspaceSourceSubscriptions.id, existing.id));
    await logSourceAction(tx, {
      workspaceId: data.workspaceId,
      userId: data.userId,
      commandType: 'DeleteSourceSubscription',
      objectId: existing.id,
    });
  });
}

export interface ListSourcesResultItem {
  subscription: WorkspaceSourceSubscription;
  source: Source;
}

export async function listSources(
  db: Database,
  input: ListSourcesInput,
): Promise<ListSourcesResultItem[]> {
  const parsed = ListSourcesInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CommandError(
      'validation_failed',
      `listSources: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const data = parsed.data;

  return db.transaction(
    async (tx) => {
      await assertWorkspaceRole(tx, data.workspaceId, data.userId, 'viewer');
      const rows = await tx
        .select({
          subscription: workspaceSourceSubscriptions,
          source: sources,
        })
        .from(workspaceSourceSubscriptions)
        .innerJoin(sources, eq(sources.id, workspaceSourceSubscriptions.sourceId))
        .where(eq(workspaceSourceSubscriptions.workspaceId, data.workspaceId))
        .orderBy(asc(workspaceSourceSubscriptions.createdAt));
      return rows.map((row) => ({
        subscription: rowToSubscription(row.subscription),
        source: rowToSource(row.source),
      }));
    },
    { accessMode: 'read only' },
  );
}

async function loadOwnedSubscription(
  tx: DbOrTx,
  sourceId: string,
  workspaceId: string,
): Promise<{ id: string }> {
  // MVP UX assumes a single default subscription per (workspace, source).
  // The explicit `topic_profile_id IS NULL` filter pins us to the default
  // row; without it, Phase 5+ multi-profile would silently return one of
  // many matching subscriptions (`.limit(1)` orders by physical position).
  // Multi-profile API will need to accept subscription_id directly.
  const rows = await tx
    .select({ id: workspaceSourceSubscriptions.id })
    .from(workspaceSourceSubscriptions)
    .where(
      and(
        eq(workspaceSourceSubscriptions.workspaceId, workspaceId),
        eq(workspaceSourceSubscriptions.sourceId, sourceId),
        sql`${workspaceSourceSubscriptions.topicProfileId} IS NULL`,
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new CommandError(
      'not_found',
      `subscription for source ${sourceId} in workspace ${workspaceId} not found`,
    );
  }
  return { id: row.id };
}
