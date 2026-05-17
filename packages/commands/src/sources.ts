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
import { assertWorkspaceRole } from './policies.js';
import { rowToSource, rowToSubscription } from './topic-row-mappers.js';

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
    throw new CommandError('validation_failed', `unparseable URL after redirect resolution: ${resolved.finalUrl}`, {
      code: 'unparseable_url',
    });
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
      const ownerRow = await tx
        .select({ workspaceId: topicProfiles.workspaceId })
        .from(topicProfiles)
        .where(eq(topicProfiles.id, data.topicProfileId))
        .limit(1);
      const owner = ownerRow[0];
      if (!owner) throw new CommandError('not_found', `topic_profile ${data.topicProfileId} not found`);
      if (owner.workspaceId !== data.workspaceId) {
        throw new CommandError(
          'forbidden',
          `topic_profile ${data.topicProfileId} belongs to a different workspace`,
        );
      }
    }

    // Upsert the global source via Drizzle's onConflictDoUpdate. The DO
    // UPDATE branch is a no-op on the canonical_url itself but bumps
    // updated_at so consumers can see "this source was touched recently"
    // (and so the createdAt-vs-updatedAt comparison below can detect
    // insert-vs-update without dropping to raw SQL + xmax).
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
        set: { updatedAt: new Date() },
      })
      .returning();
    const sourceRow = upserted[0];
    if (!sourceRow) throw new CommandError('internal', 'sources upsert returned no row');
    const sourceId = sourceRow.id;
    // Insert-vs-update signal: a fresh insert has createdAt === updatedAt
    // (both default to now()). An existing-row update keeps the older
    // createdAt and bumps updatedAt to "now". A few-microsecond drift
    // between Postgres clock reads on the same INSERT round-trip is
    // possible, so we compare with a small tolerance.
    const sourceCreated =
      Math.abs(sourceRow.createdAt.getTime() - sourceRow.updatedAt.getTime()) < 5;

    // Subscription UPSERT. Single-default MVP: subscriptions with
    // topic_profile_id IS NULL use upsert semantics keyed by
    // (workspace_id, source_id). With an explicit topic_profile_id,
    // ON CONFLICT (workspace_id, source_id, topic_profile_id) handles the
    // standard case.
    const topicProfileId = data.topicProfileId ?? null;
    let subscriptionCreated: boolean;
    let subscriptionRow:
      | { id: string; workspaceId: string; sourceId: string; topicProfileId: string | null; enabled: boolean; priority: number; customRules: unknown; createdAt: Date; updatedAt: Date }
      | undefined;

    if (topicProfileId === null) {
      // Look up existing default subscription explicitly because the
      // 3-column UNIQUE treats two NULLs as distinct in Postgres.
      const existing = await tx
        .select()
        .from(workspaceSourceSubscriptions)
        .where(
          and(
            eq(workspaceSourceSubscriptions.workspaceId, data.workspaceId),
            eq(workspaceSourceSubscriptions.sourceId, sourceId),
            sql`${workspaceSourceSubscriptions.topicProfileId} IS NULL`,
          ),
        )
        .limit(1);
      if (existing[0]) {
        // Re-enable if it was disabled — UX for "re-add a paused source".
        const updated = await tx
          .update(workspaceSourceSubscriptions)
          .set({ enabled: true, updatedAt: new Date() })
          .where(eq(workspaceSourceSubscriptions.id, existing[0].id))
          .returning();
        subscriptionRow = updated[0];
        subscriptionCreated = false;
      } else {
        const inserted = await tx
          .insert(workspaceSourceSubscriptions)
          .values({
            workspaceId: data.workspaceId,
            sourceId,
            topicProfileId: null,
            enabled: true,
            priority: 50,
            customRules: {},
          })
          .returning();
        subscriptionRow = inserted[0];
        subscriptionCreated = true;
      }
    } else {
      // Pinned-profile path: rely on the 3-col UNIQUE.
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
        });
      subscriptionRow = inserted[0];
      // We can't distinguish insert from update via xmax through Drizzle's
      // returning(); query for it: if created_at == updated_at it was an
      // insert. Approximate (good enough for the UX hint — both branches
      // produce a usable subscription either way).
      subscriptionCreated = Boolean(
        subscriptionRow && subscriptionRow.createdAt.getTime() === subscriptionRow.updatedAt.getTime(),
      );
    }

    if (!subscriptionRow) {
      throw new CommandError('internal', 'subscription upsert returned no row');
    }

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
): Promise<WorkspaceSourceSubscription> {
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
      const ownerRow = await tx
        .select({ workspaceId: topicProfiles.workspaceId })
        .from(topicProfiles)
        .where(eq(topicProfiles.id, data.topicProfileId))
        .limit(1);
      const owner = ownerRow[0];
      if (!owner) throw new CommandError('not_found', `topic_profile ${data.topicProfileId} not found`);
      if (owner.workspaceId !== data.workspaceId) {
        throw new CommandError(
          'forbidden',
          `topic_profile ${data.topicProfileId} belongs to a different workspace`,
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
    return rowToSubscription(row);
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
  // Workspace + source uniquely identifies a subscription in MVP single-
  // profile UX. If Phase 5+ enables multi-profile, the API will need to
  // accept subscription_id explicitly.
  const rows = await tx
    .select({ id: workspaceSourceSubscriptions.id })
    .from(workspaceSourceSubscriptions)
    .where(
      and(
        eq(workspaceSourceSubscriptions.workspaceId, workspaceId),
        eq(workspaceSourceSubscriptions.sourceId, sourceId),
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
