/**
 * Workspace-news-matches commands (Phase 5).
 *
 * Three responsibilities:
 *   1. `upsertWorkspaceNewsMatch` — write/refresh a (workspace, news_item OR
 *      cluster) row from the score handler. Idempotent via the partial UNIQUE
 *      indexes (`workspace_news_matches_workspace_cluster_uniq` /
 *      `workspace_news_matches_workspace_item_uniq`) from migration 0008.
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
 * Upsert by the natural key derived from clusterId.
 *
 * Cluster-level dedup: when `clusterId` is set, the partial UNIQUE
 * `(workspace_id, cluster_id) WHERE cluster_id IS NOT NULL` collapses repeat
 * inserts for the same story. We INSERT with `ON CONFLICT ... DO UPDATE` and
 * the planner picks the partial index because the row predicate matches.
 *
 * Item-level dedup: when `clusterId` is NULL (item not yet clustered), the
 * `(workspace_id, news_item_id) WHERE cluster_id IS NULL` partial UNIQUE
 * handles it instead. We split into two INSERT statements with different
 * ON CONFLICT targets — Postgres needs the target column list to choose a
 * partial index.
 *
 * Behaviour on UPDATE branch: every settable field is refreshed (score,
 * reason, components, model, status, scoredAt). created_at is NOT touched
 * (immutable). updated_at advances to now().
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

  // Two-statement strategy: ON CONFLICT must name a unique index target, and
  // Postgres has no way to "pick whichever partial unique matches". We branch
  // on the runtime value of clusterId — the predicate column matches a
  // specific partial UNIQUE, so the planner uses it.
  if (data.clusterId !== null) {
    return upsertByCluster(db, data);
  }
  return upsertByItem(db, data);
}

async function upsertByCluster(
  db: Database,
  data: UpsertWorkspaceNewsMatchInput,
): Promise<UpsertResult> {
  const rows = await db
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
    .onConflictDoUpdate({
      target: [workspaceNewsMatches.workspaceId, workspaceNewsMatches.clusterId],
      // Repeat the partial-index predicate so Postgres binds the ON CONFLICT
      // arbiter to `workspace_news_matches_workspace_cluster_uniq` exactly.
      targetWhere: sql`${workspaceNewsMatches.clusterId} IS NOT NULL`,
      set: {
        newsItemId: sql`EXCLUDED.news_item_id`,
        score: sql`EXCLUDED.score`,
        relevanceReason: sql`EXCLUDED.relevance_reason`,
        shouldCreateDraft: sql`EXCLUDED.should_create_draft`,
        riskFlags: sql`EXCLUDED.risk_flags`,
        scoreComponents: sql`EXCLUDED.score_components`,
        aiProvider: sql`EXCLUDED.ai_provider`,
        usedModel: sql`EXCLUDED.used_model`,
        promptVersion: sql`EXCLUDED.prompt_version`,
        status: sql`EXCLUDED.status`,
        scoredAt: sql`EXCLUDED.scored_at`,
        updatedAt: new Date(),
      },
    })
    .returning({
      id: workspaceNewsMatches.id,
      inserted: sql<boolean>`xmax = 0`,
    });
  const row = rows[0];
  if (!row) {
    throw new CommandError('internal', 'workspace_news_matches upsert returned no row');
  }
  return { id: row.id, inserted: row.inserted === true };
}

async function upsertByItem(
  db: Database,
  data: UpsertWorkspaceNewsMatchInput,
): Promise<UpsertResult> {
  const rows = await db
    .insert(workspaceNewsMatches)
    .values({
      workspaceId: data.workspaceId,
      newsItemId: data.newsItemId,
      clusterId: null,
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
    .onConflictDoUpdate({
      target: [workspaceNewsMatches.workspaceId, workspaceNewsMatches.newsItemId],
      // Binds the arbiter to `workspace_news_matches_workspace_item_uniq`,
      // the (workspace_id, news_item_id) WHERE cluster_id IS NULL index.
      targetWhere: sql`${workspaceNewsMatches.clusterId} IS NULL`,
      set: {
        score: sql`EXCLUDED.score`,
        relevanceReason: sql`EXCLUDED.relevance_reason`,
        shouldCreateDraft: sql`EXCLUDED.should_create_draft`,
        riskFlags: sql`EXCLUDED.risk_flags`,
        scoreComponents: sql`EXCLUDED.score_components`,
        aiProvider: sql`EXCLUDED.ai_provider`,
        usedModel: sql`EXCLUDED.used_model`,
        promptVersion: sql`EXCLUDED.prompt_version`,
        status: sql`EXCLUDED.status`,
        scoredAt: sql`EXCLUDED.scored_at`,
        updatedAt: new Date(),
      },
    })
    .returning({
      id: workspaceNewsMatches.id,
      inserted: sql<boolean>`xmax = 0`,
    });
  const row = rows[0];
  if (!row) {
    throw new CommandError('internal', 'workspace_news_matches upsert returned no row');
  }
  return { id: row.id, inserted: row.inserted === true };
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

      const totalRows = (await tx
        .select({ c: sql<number>`count(*)::int` })
        .from(workspaceNewsMatches)
        .where(where)) as Array<{ c: number }>;
      const total = totalRows[0]?.c ?? 0;

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
