/**
 * Workspace-news-matches commands (Phase 5).
 *
 * Three responsibilities:
 *   1. `upsertWorkspaceNewsMatch` — write/refresh a (workspace, news_item)
 *      row from the score handler. Idempotent and race-free via
 *      `pg_advisory_xact_lock` + `SELECT ... FOR UPDATE`; the partial
 *      UNIQUE indexes (`workspace_news_matches_workspace_cluster_uniq` /
 *      `workspace_news_matches_workspace_item_uniq`) from migration 0008
 *      remain as defence-in-depth.
 *   2. `suppressWorkspaceNewsMatch` — user-driven "hide this" action
 *      (status='suppressed'). Phase 6+ UX hook; the route + UI land later
 *      but the command is here so audit-log + policy live with the
 *      taxonomy.
 *   3. `listRadarMatches` — read projection for `GET /radar`. Joins
 *      `global_news_items` + `sources` for the Mini App card payload, with
 *      pagination and status / score filters.
 *
 * Layer rule: this module imports `@postdash/db` (schema) and is consumed by
 * apps/api routes + apps/worker handlers. It MUST NOT import provider SDKs
 * (Telegram, Yandex) or the worker handlers themselves.
 */

import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '@postdash/db';
import { globalNewsItems, newsClusters, sources, workspaceNewsMatches } from '@postdash/db';
import { CommandError } from './errors.js';
import { writeOperationLog } from './operation-log.js';
import { assertWorkspaceRole } from './policies.js';

// =============================================================================
// Status taxonomy (mirrors CHECK in migration 0008).
// =============================================================================

export const WORKSPACE_NEWS_MATCH_STATUSES = [
  'candidate',
  'filtered_negative',
  'hidden',
  'ai_refused',
  'low_score',
  'suppressed',
] as const;
export type WorkspaceNewsMatchStatus = (typeof WORKSPACE_NEWS_MATCH_STATUSES)[number];

// =============================================================================
// upsertWorkspaceNewsMatch
// =============================================================================

/**
 * Composite score components. Kept loose (Record) at the DB layer to allow
 * future weights to evolve without a migration; the JSON shape is fixed by
 * convention to {llm, cosine, freshness, reliability, weighted}.
 */
export interface ScoreComponents {
  llm: number;
  cosine: number;
  freshness: number;
  reliability: number;
  weighted: number;
}

export const UpsertWorkspaceNewsMatchInputSchema = z.object({
  workspaceId: z.string().uuid(),
  newsItemId: z.string().uuid(),
  clusterId: z.string().uuid().nullable(),
  // score is null for filtered_negative / hidden / ai_refused rows; finite
  // 0..10 number otherwise. Enforced by the DB CHECK; we re-enforce here so
  // a programmer error surfaces before the round-trip.
  score: z.number().min(0).max(10).nullable(),
  relevanceReason: z.string().max(280).nullable(),
  shouldCreateDraft: z.boolean().default(false),
  riskFlags: z.array(z.string()).default([]),
  scoreComponents: z.record(z.string(), z.number()).default({}),
  aiProvider: z.string().nullable(),
  usedModel: z.string().nullable(),
  promptVersion: z.string().nullable(),
  status: z.enum(WORKSPACE_NEWS_MATCH_STATUSES),
  scoredAt: z.date().nullable(),
});
export type UpsertWorkspaceNewsMatchInput = z.infer<typeof UpsertWorkspaceNewsMatchInputSchema>;

export interface UpsertResult {
  id: string;
  inserted: boolean;
}

/**
 * Upsert the workspace_news_matches row for (workspace_id, news_item_id).
 *
 * Concurrency model:
 *   1. Acquire `pg_advisory_xact_lock(hashtext(workspace_id), hashtext(
 *      news_item_id))` — two concurrent matchers for the same (workspace,
 *      item) serialize on this lock. If `cluster_id` is known, a second
 *      `(workspace, cluster)` lock serializes cluster-level dedup too.
 *      Released automatically at tx end.
 *   2. `SELECT ... FOR UPDATE` the existing row, if any. The advisory lock
 *      guarantees no second tx is in flight, so the FOR UPDATE is a safety
 *      belt rather than a primary serialization mechanism.
 *   3. UPDATE if a row exists (refreshing every settable field, including
 *      `cluster_id` — handles the NULL→non-NULL flip when cluster_news
 *      attaches the item between two match runs); INSERT otherwise.
 *
 * Why advisory lock instead of relying on the two partial UNIQUEs alone:
 *   - Pre-fix, the matcher SELECTed cluster_id=NULL, then cluster_news
 *     committed and flipped cluster_id to non-NULL, then the matcher tried
 *     to INSERT with cluster_id=NULL via the item-level partial UNIQUE — but
 *     the existing row's cluster_id is now non-NULL, so the item-level UNIQUE
 *     (`WHERE cluster_id IS NULL`) no longer covers it. Result: 2 radar rows
 *     per (workspace, item).
 *   - With the advisory lock + FOR UPDATE, concurrent matchers serialize and
 *     the second one observes the first one's row regardless of whether
 *     cluster_id has been flipped. The two partial UNIQUEs remain as a
 *     defence-in-depth check at the DB layer.
 *
 * Behaviour on UPDATE branch: every settable field is refreshed (score,
 * reason, components, model, status, scoredAt, cluster_id). `created_at` is
 * NOT touched (immutable). `updated_at` advances to now().
 *
 * Returns `{id, inserted}` so the worker can decide whether to enqueue
 * downstream `generate_post_draft` (Phase 6) on a fresh row vs a re-score.
 */
export async function upsertWorkspaceNewsMatch(
  db: Database,
  input: UpsertWorkspaceNewsMatchInput,
): Promise<UpsertResult> {
  const parsed = UpsertWorkspaceNewsMatchInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CommandError(
      'validation_failed',
      `upsertWorkspaceNewsMatch: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const data = parsed.data;

  return db.transaction(async (tx) => {
    // Serialize concurrent matchers for the same (workspace, item). Uses the
    // two-int4 form of pg_advisory_xact_lock; `hashtext()` returns int4 and
    // a single bigint is reconstructed from the two ints, giving a stable
    // deterministic key per pair. Released at tx end.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${data.workspaceId}), hashtext(${data.newsItemId}))`,
    );
    if (data.clusterId !== null) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${data.workspaceId}), hashtext(${data.clusterId}))`,
      );
    }

    const existingByItem = await tx
      .select({
        id: workspaceNewsMatches.id,
      })
      .from(workspaceNewsMatches)
      .where(
        and(
          eq(workspaceNewsMatches.workspaceId, data.workspaceId),
          eq(workspaceNewsMatches.newsItemId, data.newsItemId),
        ),
      )
      .for('update')
      .limit(1);
    const itemRow = existingByItem[0];

    if (data.clusterId !== null) {
      const existingByCluster = await tx
        .select({
          id: workspaceNewsMatches.id,
        })
        .from(workspaceNewsMatches)
        .where(
          and(
            eq(workspaceNewsMatches.workspaceId, data.workspaceId),
            eq(workspaceNewsMatches.clusterId, data.clusterId),
          ),
        )
        .for('update')
        .limit(1);
      const clusterRow = existingByCluster[0];
      if (clusterRow && clusterRow.id !== itemRow?.id) {
        if (itemRow) {
          await tx
            .update(workspaceNewsMatches)
            .set({
              score: null,
              relevanceReason: 'Cluster duplicate; canonical match already exists',
              shouldCreateDraft: false,
              riskFlags: Array.from(new Set([...data.riskFlags, 'cluster_duplicate'])),
              status: 'hidden',
              updatedAt: new Date(),
            })
            .where(eq(workspaceNewsMatches.id, itemRow.id));
        }
        return { id: clusterRow.id, inserted: false };
      }
    }

    if (itemRow) {
      const updated = await tx
        .update(workspaceNewsMatches)
        .set({
          clusterId: data.clusterId,
          score: data.score === null ? null : String(data.score),
          relevanceReason: data.relevanceReason,
          shouldCreateDraft: data.shouldCreateDraft,
          riskFlags: data.riskFlags,
          scoreComponents: data.scoreComponents,
          aiProvider: data.aiProvider,
          usedModel: data.usedModel,
          promptVersion: data.promptVersion,
          status: data.status,
          scoredAt: data.scoredAt,
          updatedAt: new Date(),
        })
        .where(eq(workspaceNewsMatches.id, itemRow.id))
        .returning({ id: workspaceNewsMatches.id });
      const row = updated[0];
      if (!row) {
        throw new CommandError('internal', 'workspace_news_matches update returned no row');
      }
      return { id: row.id, inserted: false };
    }

    const inserted = await tx
      .insert(workspaceNewsMatches)
      .values({
        workspaceId: data.workspaceId,
        newsItemId: data.newsItemId,
        clusterId: data.clusterId,
        score: data.score === null ? null : String(data.score),
        relevanceReason: data.relevanceReason,
        shouldCreateDraft: data.shouldCreateDraft,
        riskFlags: data.riskFlags,
        scoreComponents: data.scoreComponents,
        aiProvider: data.aiProvider,
        usedModel: data.usedModel,
        promptVersion: data.promptVersion,
        status: data.status,
        scoredAt: data.scoredAt,
      })
      .returning({ id: workspaceNewsMatches.id });
    const row = inserted[0];
    if (!row) {
      throw new CommandError('internal', 'workspace_news_matches insert returned no row');
    }
    return { id: row.id, inserted: true };
  });
}

// =============================================================================
// suppressWorkspaceNewsMatch (Phase 6+ UX, command ships in Phase 5)
// =============================================================================

export const SuppressWorkspaceNewsMatchInputSchema = z.object({
  matchId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
});
export type SuppressWorkspaceNewsMatchInput = z.infer<typeof SuppressWorkspaceNewsMatchInputSchema>;

export async function suppressWorkspaceNewsMatch(
  db: Database,
  input: SuppressWorkspaceNewsMatchInput,
): Promise<void> {
  const parsed = SuppressWorkspaceNewsMatchInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CommandError(
      'validation_failed',
      `suppressWorkspaceNewsMatch: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const data = parsed.data;
  await db.transaction(async (tx) => {
    await assertWorkspaceRole(tx, data.workspaceId, data.userId, 'editor');
    const updated = await tx
      .update(workspaceNewsMatches)
      .set({ status: 'suppressed', updatedAt: new Date() })
      .where(
        and(
          eq(workspaceNewsMatches.id, data.matchId),
          eq(workspaceNewsMatches.workspaceId, data.workspaceId),
        ),
      )
      .returning({ id: workspaceNewsMatches.id });
    const row = updated[0];
    if (!row) {
      throw new CommandError('not_found', `workspace_news_match ${data.matchId} not found`);
    }
    await writeOperationLog(tx, {
      workspaceId: data.workspaceId,
      userId: data.userId,
      commandType: 'SuppressWorkspaceNewsMatch',
      objectType: 'workspace_news_match',
      objectId: row.id,
      payloadSummary: { action: 'suppress' },
    });
  });
}

// =============================================================================
// listRadarMatches (read for GET /radar)
// =============================================================================

export const ListRadarMatchesInputSchema = z.object({
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  status: z.enum(WORKSPACE_NEWS_MATCH_STATUSES).or(z.literal('all')).default('candidate'),
  minScore: z.number().min(0).max(10).optional(),
  maxScore: z.number().min(0).max(10).optional(),
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(50).default(20),
});
export type ListRadarMatchesInput = z.infer<typeof ListRadarMatchesInputSchema>;

/**
 * Domain object handed to the projection layer. The HTTP wire schema is
 * defined separately in `@postdash/shared` (radar-projection.ts).
 */
export interface RadarMatchRow {
  matchId: string;
  workspaceId: string;
  newsItemId: string;
  clusterId: string | null;
  score: number | null;
  relevanceReason: string | null;
  shouldCreateDraft: boolean;
  riskFlags: string[];
  scoreComponents: Record<string, unknown>;
  aiProvider: string | null;
  usedModel: string | null;
  promptVersion: string | null;
  status: WorkspaceNewsMatchStatus;
  scoredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  news: {
    title: string;
    url: string;
    canonicalUrl: string;
    summary: string | null;
    publishedAt: Date | null;
    language: string | null;
  };
  source: {
    id: string;
    name: string | null;
    canonicalUrl: string;
  };
  cluster: {
    sourcesCount: number;
  } | null;
}

export interface RadarListResult {
  items: RadarMatchRow[];
  page: number;
  pageSize: number;
  total: number;
}

export async function listRadarMatches(
  db: Database,
  input: ListRadarMatchesInput,
): Promise<RadarListResult> {
  const parsed = ListRadarMatchesInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CommandError(
      'validation_failed',
      `listRadarMatches: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const data = parsed.data;

  return db.transaction(
    async (tx) => {
      await assertWorkspaceRole(tx, data.workspaceId, data.userId, 'viewer');

      const filters = [eq(workspaceNewsMatches.workspaceId, data.workspaceId)];
      if (data.status !== 'all') {
        filters.push(eq(workspaceNewsMatches.status, data.status));
      }
      if (data.minScore !== undefined) {
        filters.push(gte(workspaceNewsMatches.score, String(data.minScore)));
      }
      if (data.maxScore !== undefined) {
        filters.push(lte(workspaceNewsMatches.score, String(data.maxScore)));
      }
      const where = filters.length === 1 ? filters[0]! : and(...filters)!;

      // Single-statement projection: `count(*) OVER ()` returns the filtered
      // row count alongside each row so we get pagination metadata without a
      // second SELECT (which would drift on concurrent INSERT between the
      // two statements). The total is the same for every row, so we read it
      // off the first row.
      const offset = (data.page - 1) * data.pageSize;
      const rows = await tx
        .select({
          matchId: workspaceNewsMatches.id,
          workspaceId: workspaceNewsMatches.workspaceId,
          newsItemId: workspaceNewsMatches.newsItemId,
          clusterId: workspaceNewsMatches.clusterId,
          score: workspaceNewsMatches.score,
          relevanceReason: workspaceNewsMatches.relevanceReason,
          shouldCreateDraft: workspaceNewsMatches.shouldCreateDraft,
          riskFlags: workspaceNewsMatches.riskFlags,
          scoreComponents: workspaceNewsMatches.scoreComponents,
          aiProvider: workspaceNewsMatches.aiProvider,
          usedModel: workspaceNewsMatches.usedModel,
          promptVersion: workspaceNewsMatches.promptVersion,
          status: workspaceNewsMatches.status,
          scoredAt: workspaceNewsMatches.scoredAt,
          createdAt: workspaceNewsMatches.createdAt,
          updatedAt: workspaceNewsMatches.updatedAt,
          newsTitle: globalNewsItems.title,
          newsUrl: globalNewsItems.url,
          newsCanonicalUrl: globalNewsItems.canonicalUrl,
          newsSummary: globalNewsItems.summary,
          newsPublishedAt: globalNewsItems.publishedAt,
          newsLanguage: globalNewsItems.language,
          sourceId: sources.id,
          sourceName: sources.name,
          sourceCanonicalUrl: sources.canonicalUrl,
          clusterSourcesCount: newsClusters.sourcesCount,
          total: sql<number>`count(*) OVER ()::int`,
        })
        .from(workspaceNewsMatches)
        .innerJoin(globalNewsItems, eq(globalNewsItems.id, workspaceNewsMatches.newsItemId))
        .innerJoin(sources, eq(sources.id, globalNewsItems.sourceId))
        .leftJoin(newsClusters, eq(newsClusters.id, workspaceNewsMatches.clusterId))
        .where(where)
        // score DESC NULLS LAST keeps candidate rows with scores at the top
        // and parks filtered/hidden (null score) at the bottom. Stable
        // secondary order on createdAt DESC for deterministic pagination.
        .orderBy(
          sql`${workspaceNewsMatches.score} DESC NULLS LAST`,
          desc(workspaceNewsMatches.createdAt),
        )
        .limit(data.pageSize)
        .offset(offset);

      // `count(*) OVER ()` returns the filtered row count on every row. If
      // the page is empty (zero matches under the filter), there is no row to
      // read `total` from — fall back to 0. Note: pages BEYOND the last row
      // also resolve to total=0 here; callers wanting to distinguish "empty
      // page past the end" can check `items.length === 0 && page > 1`. This
      // matches the prior two-statement semantics on the common path
      // (page=1, no rows) without the second SELECT race.
      const total = rows.length > 0 ? (rows[0]!.total ?? 0) : 0;

      const items: RadarMatchRow[] = rows.map((r) => ({
        matchId: r.matchId,
        workspaceId: r.workspaceId,
        newsItemId: r.newsItemId,
        clusterId: r.clusterId,
        score: r.score === null ? null : Number(r.score),
        relevanceReason: r.relevanceReason,
        shouldCreateDraft: r.shouldCreateDraft,
        riskFlags: r.riskFlags,
        scoreComponents: (r.scoreComponents as Record<string, unknown>) ?? {},
        aiProvider: r.aiProvider,
        usedModel: r.usedModel,
        promptVersion: r.promptVersion,
        status: narrowStatus(r.status),
        scoredAt: r.scoredAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        news: {
          title: r.newsTitle,
          url: r.newsUrl,
          canonicalUrl: r.newsCanonicalUrl,
          summary: r.newsSummary,
          publishedAt: r.newsPublishedAt,
          language: r.newsLanguage,
        },
        source: {
          id: r.sourceId,
          name: r.sourceName,
          canonicalUrl: r.sourceCanonicalUrl,
        },
        cluster:
          r.clusterId !== null && r.clusterSourcesCount !== null
            ? { sourcesCount: r.clusterSourcesCount }
            : null,
      }));

      return { items, page: data.page, pageSize: data.pageSize, total };
    },
    { accessMode: 'read only' },
  );
}

function narrowStatus(s: string): WorkspaceNewsMatchStatus {
  return (WORKSPACE_NEWS_MATCH_STATUSES as ReadonlyArray<string>).includes(s)
    ? (s as WorkspaceNewsMatchStatus)
    : 'candidate';
}
