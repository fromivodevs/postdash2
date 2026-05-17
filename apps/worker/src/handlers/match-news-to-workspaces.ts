/**
 * Handler: match_news_to_workspaces.
 *
 * Triggered by cluster_news after attaching a news item to a cluster (or
 * creating a fresh cluster). Fans out per-workspace:
 *
 *   1. SELECT news_item + cluster_id (may be NULL if not yet clustered).
 *   2. SELECT all workspace_source_subscriptions WHERE source_id=$source_id
 *      AND enabled=true. Resolve the active topic_profile per workspace
 *      (subscription.topic_profile_id when set; otherwise the workspace's
 *      single active default profile per Phase 3 UX).
 *   3. For each (workspace, topic_profile):
 *      - Skip if a workspace_news_matches row already exists for this
 *        (workspace, cluster) — cluster-level dedup (§12.1).
 *      - Skip if a workspace_news_matches row exists for (workspace, item)
 *        when cluster_id is still NULL.
 *      - Pre-filter: negative keyword hit in title/summary → INSERT row with
 *        status='filtered_negative' (no LLM call).
 *      - Language gate: news.language != topic.language → status='hidden'.
 *      - Semantic pre-score: cosine = 1 - (topic.embedding <-> news.embedding).
 *        If < MATCHING_MIN_COSINE → status='hidden'.
 *      - Else enqueue `score_workspace_match` ({workspace_id, news_item_id}).
 *
 * Repeat enqueue of this task for the same news_item is collapsed by the
 * partial UNIQUE `tasks_unique_active_match_per_item` (migration 0008).
 *
 * No `client.begin(...)` here — each per-workspace decision is independent
 * and an early-loop crash is recoverable: the next match enqueue for this
 * item is blocked by the partial UNIQUE, but cluster_news re-enqueues us
 * after the next attachment so progress resumes.
 */

import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  globalNewsItems,
  newsClusterItems,
  sources,
  topicProfiles,
  workspaceNewsMatches,
  workspaceSourceSubscriptions,
} from '@postdash/db';
import { upsertWorkspaceNewsMatch } from '@postdash/commands';
import type { TaskHandler } from '../dispatcher.js';

const PayloadSchema = z.object({
  news_item_id: z.string().uuid(),
});

interface NewsRow {
  id: string;
  sourceId: string;
  title: string;
  summary: string | null;
  url: string;
  language: string | null;
  embedding: number[] | string | null;
  clusterId: string | null;
}

interface TopicRow {
  id: string;
  workspaceId: string;
  language: string;
  negativeKeywords: string[];
  embedding: number[] | string | null;
  embeddingStatus: string;
  embeddingUpdatedAt: Date | null;
}

export const matchNewsToWorkspacesHandler: TaskHandler = async (task, ctx) => {
  const payload = PayloadSchema.parse(task.payload);

  // Pull the item + its (optional) cluster_id and the source row in one round-trip.
  const itemRows = (await ctx.client`
    SELECT
      g.id           AS "id",
      g.source_id    AS "sourceId",
      g.title        AS "title",
      g.summary      AS "summary",
      g.url          AS "url",
      g.language     AS "language",
      g.embedding    AS "embedding",
      nci.cluster_id AS "clusterId"
    FROM global_news_items g
    LEFT JOIN news_cluster_items nci ON nci.news_item_id = g.id
    WHERE g.id = ${payload.news_item_id}
    LIMIT 1
  `) as NewsRow[];
  const item = itemRows[0];
  if (!item) {
    throw permanent(`news_item ${payload.news_item_id} not found`);
  }
  if (!item.embedding) {
    // No embedding yet — matching is meaningless. Re-enqueue happens
    // organically the next time cluster_news fires for this item.
    ctx.logger.info(
      { newsItemId: payload.news_item_id },
      'news_item has no embedding, skipping match',
    );
    return;
  }
  const itemEmbedding = parseEmbedding(item.embedding);

  // Pull subscriptions for this source, resolving the topic_profile per
  // subscription (FK or workspace default). Using one SQL with the explicit
  // join keeps the round-trip count flat at one even when a source has many
  // subscribers.
  //
  // The COALESCE picks the subscription's pinned topic_profile first; if
  // null, falls back to the workspace's single active profile (Phase 3 UX
  // guarantees ≤1).
  const targetsRaw = (await ctx.client`
    SELECT
      tp.id                     AS "id",
      tp.workspace_id           AS "workspaceId",
      tp.language               AS "language",
      tp.negative_keywords      AS "negativeKeywords",
      tp.embedding              AS "embedding",
      tp.embedding_status       AS "embeddingStatus",
      tp.embedding_updated_at   AS "embeddingUpdatedAt"
    FROM workspace_source_subscriptions wss
    JOIN topic_profiles tp ON tp.id = COALESCE(
      wss.topic_profile_id,
      (
        SELECT id FROM topic_profiles
        WHERE workspace_id = wss.workspace_id AND status = 'active'
        LIMIT 1
      )
    )
    WHERE wss.source_id = ${item.sourceId}
      AND wss.enabled = true
      AND tp.status = 'active'
  `) as TopicRow[];

  if (targetsRaw.length === 0) {
    ctx.logger.info(
      { sourceId: item.sourceId, newsItemId: payload.news_item_id },
      'no enabled subscriptions for source; no matches enqueued',
    );
    return;
  }

  // Per-workspace decisions. Each is independent: a failure for one workspace
  // does NOT abort the rest (we let the handler succeed and rely on partial
  // unique to suppress redundant re-fires).
  for (const topic of targetsRaw) {
    try {
      await matchOneWorkspace(item, topic, ctx, itemEmbedding);
    } catch (err) {
      // Soft-isolate: log and continue. A retry of the whole task would re-
      // process every workspace, most of which are already DONE (dedup via
      // partial UNIQUE on workspace_news_matches). The per-workspace try/catch
      // narrows the blast radius without burning the entire task.
      ctx.logger.warn(
        {
          err,
          newsItemId: payload.news_item_id,
          workspaceId: topic.workspaceId,
        },
        'match_news_to_workspaces per-workspace failure',
      );
    }
  }
};

async function matchOneWorkspace(
  item: NewsRow,
  topic: TopicRow,
  ctx: Parameters<TaskHandler>[1],
  itemVec: number[],
): Promise<void> {
  // Dedup gate — both partial UNIQUEs (cluster-level + item-level when
  // cluster_id NULL) are enforced at the DB layer by the migration's
  // workspace_news_matches_workspace_*_uniq indexes, but a pre-check spares
  // us building+sending the UPSERT for already-decided rows.
  const existing = await ctx.db
    .select({ id: workspaceNewsMatches.id, status: workspaceNewsMatches.status })
    .from(workspaceNewsMatches)
    .where(
      and(
        eq(workspaceNewsMatches.workspaceId, topic.workspaceId),
        item.clusterId !== null
          ? eq(workspaceNewsMatches.clusterId, item.clusterId)
          : and(
              eq(workspaceNewsMatches.newsItemId, item.id),
              isNull(workspaceNewsMatches.clusterId),
            )!,
      ),
    )
    .limit(1);
  if (existing[0]) {
    ctx.logger.debug(
      { workspaceId: topic.workspaceId, newsItemId: item.id },
      'workspace already has a match, skipping',
    );
    return;
  }

  // Pre-filter: negative_keywords. Case-insensitive whole-word match against
  // title + summary. A flat regex avoids loading the full extracted_text into
  // the matcher (it's an HTTP-bound concern, not a quality concern).
  const negativeHit = matchNegativeKeyword(
    `${item.title} ${item.summary ?? ''}`,
    topic.negativeKeywords,
  );
  if (negativeHit) {
    await upsertWorkspaceNewsMatch(ctx.db, {
      workspaceId: topic.workspaceId,
      newsItemId: item.id,
      clusterId: item.clusterId,
      score: null,
      relevanceReason: `Filtered by negative keyword: ${negativeHit}`,
      shouldCreateDraft: false,
      riskFlags: ['filtered_negative'],
      scoreComponents: {},
      aiProvider: null,
      usedModel: null,
      promptVersion: null,
      status: 'filtered_negative',
      scoredAt: null,
    });
    return;
  }

  // Language gate. Cross-language matching is intentionally disabled in MVP
  // per §12.2; the LLM can translate at draft time (Phase 6), but matching
  // stays strictly within the topic profile's language. 'other' news items
  // (language detected as neither ru nor en) skip too.
  if (item.language !== null && item.language !== topic.language) {
    await upsertWorkspaceNewsMatch(ctx.db, {
      workspaceId: topic.workspaceId,
      newsItemId: item.id,
      clusterId: item.clusterId,
      score: null,
      relevanceReason: `Language mismatch (news=${item.language}, topic=${topic.language})`,
      shouldCreateDraft: false,
      riskFlags: ['language_mismatch'],
      scoreComponents: {},
      aiProvider: null,
      usedModel: null,
      promptVersion: null,
      status: 'hidden',
      scoredAt: null,
    });
    return;
  }

  // Semantic pre-score. cosine_distance returned by pgvector `<=>` is in
  // [0, 2]; cosine_similarity = 1 - distance, in [-1, 1]. We compare similarity
  // against MATCHING_MIN_COSINE. If topic has no embedding yet (status !=
  // 'ok'), skip to LLM directly with cosine=0 component — relevance still
  // computable from LLM head.
  let cosineSimilarity: number | null = null;
  if (topic.embeddingStatus === 'ok' && topic.embedding) {
    const topicVec = parseEmbedding(topic.embedding);
    cosineSimilarity = cosineSim(itemVec, topicVec);
    if (cosineSimilarity < ctx.aiConfig.matchingMinCosine) {
      await upsertWorkspaceNewsMatch(ctx.db, {
        workspaceId: topic.workspaceId,
        newsItemId: item.id,
        clusterId: item.clusterId,
        score: null,
        relevanceReason: `Below cosine threshold (${cosineSimilarity.toFixed(3)} < ${ctx.aiConfig.matchingMinCosine})`,
        shouldCreateDraft: false,
        riskFlags: ['below_cosine_threshold'],
        scoreComponents: { cosine: cosineSimilarity },
        aiProvider: null,
        usedModel: null,
        promptVersion: null,
        status: 'hidden',
        scoredAt: null,
      });
      return;
    }
  }

  // Enqueue scoring. Composite-key partial UNIQUE
  // (`tasks_unique_active_score_per_workspace_item`) makes the enqueue
  // idempotent: concurrent fan-out runs for the same (workspace, item)
  // collapse via ON CONFLICT DO NOTHING.
  //
  // `topic_embedding_updated_at_iso` is a snapshot of the topic's embedding
  // freshness AT enqueue time. The score handler re-reads the topic and
  // drops the cosine component if the snapshot doesn't match — the topic was
  // re-embedded between enqueue and dequeue and the cosine value is stale.
  // See score-workspace-match.ts for the freshness check.
  await ctx.enqueue({
    type: 'score_workspace_match',
    workspaceId: topic.workspaceId,
    payload: {
      news_item_id: item.id,
      // Pass the cosine through so the scoring handler can compose the
      // composite without re-running the SQL distance query.
      cosine_pre_score: cosineSimilarity,
      topic_embedding_updated_at_iso: topic.embeddingUpdatedAt
        ? topic.embeddingUpdatedAt.toISOString()
        : null,
    },
  });
}

// =============================================================================
// Pure helpers (no DB).
// =============================================================================

/**
 * Parse a pgvector value back into a number[]. pgvector returns string
 * `[a,b,c]` by default; the `vector()` column type may return number[] when
 * the driver is configured for it. Accept both.
 */
function parseEmbedding(value: number[] | string): number[] {
  let arr: number[];
  if (Array.isArray(value)) {
    arr = value;
  } else {
    const trimmed = value.trim();
    const inner = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
    arr = inner.length === 0 ? [] : inner.split(',').map((s) => Number(s));
  }
  for (const v of arr) {
    if (!Number.isFinite(v)) {
      throw permanent('embedding contains non-finite value');
    }
  }
  return arr;
}

/**
 * Cosine similarity in [-1, 1]. Throws if dimensions differ — that's an
 * integrity bug (the dim-mismatch CHECK on the column should have caught it
 * at insert time).
 */
function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw permanent(`cosineSim dim mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Case-insensitive whole-word match against a haystack. Returns the matched
 * keyword, or null if none hit. Escapes regex metacharacters in user-supplied
 * keywords so a stray `.` or `(` from the topic profile doesn't blow up.
 *
 * "Whole word" uses Unicode-aware lookarounds (`\p{L}`/`\p{N}` with `/u`),
 * not ASCII `\b`. PostDash is Russian-first: with `\b` the keyword 'крипто'
 * fails to whole-word-match 'криптовалюта' because there is no ASCII boundary
 * between two Cyrillic letters — the regex either matches everywhere or
 * nowhere. The lookaround form correctly treats any Unicode letter or digit
 * on either side as "still inside a word". Requires Node >= 18 for the `u`
 * flag with Unicode property escapes (we run Node 22 per .nvmrc).
 *
 * Pre-processing:
 *   1. Normalize haystack + keyword to NFC so e.g. `café` (NFD: `cafe` + ́)
 *      matches the keyword `café` (NFC: single codepoint).
 *   2. Strip Unicode format characters (`\p{Cf}`, includes ZWJ / ZWNJ /
 *      directional marks) — without this, `крипто<ZWJ>рулит` would slip past
 *      the lookaround as a word break because ZWJ is neither letter nor digit.
 *   3. Lowercase via `toLocaleLowerCase('ru-RU')` instead of locale-
 *      independent `toLowerCase()`. ru-RU is correct for both Cyrillic and
 *      Latin (does NOT trigger the Turkish dotless-i collation).
 *
 * MVP rule per §12.2.
 */
export function matchNegativeKeyword(haystack: string, keywords: readonly string[]): string | null {
  if (keywords.length === 0) return null;
  const hayLower = haystack
    .normalize('NFC')
    .replace(/\p{Cf}/gu, '')
    .toLocaleLowerCase('ru-RU');
  for (const kw of keywords) {
    const k = kw.trim();
    if (k.length === 0) continue;
    const normalized = k
      .normalize('NFC')
      .replace(/\p{Cf}/gu, '')
      .toLocaleLowerCase('ru-RU');
    // After stripping \p{Cf}, a keyword that consisted ONLY of invisible
    // format chars (e.g. a stray ZWJ saved by the UI) becomes the empty
    // string. The lookaround regex `(?<![\p{L}\p{N}])(?![\p{L}\p{N}])` would
    // then match every non-letter boundary in the haystack — i.e. ALL news
    // items would be flagged filtered_negative for that workspace. Skip.
    if (normalized.length === 0) continue;
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
    if (re.test(hayLower)) return kw;
  }
  return null;
}

export const __testables = { cosineSim, parseEmbedding };

function permanent(message: string): Error {
  const e: Error & { kind?: string } = new Error(message);
  e.kind = 'permanent';
  return e;
}

// Suppress unused-import lints for helpers wired in via the prepared statement
// (when later refactor uses Drizzle for the JOIN).
void or;
void sources;
void newsClusterItems;
void topicProfiles;
void globalNewsItems;
void workspaceSourceSubscriptions;
void sql;
