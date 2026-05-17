/**
 * Handler: score_workspace_match.
 *
 * Calls `ai.score()` for a (workspace, news_item) pair and writes the
 * composite-scored row into `workspace_news_matches`. Falls back to
 * `TemplateProvider.score()` on AI failure (per §10 of
 * tg_mvp_plan/07-AI-SCORING-AND-DRAFTS.md) so the radar always shows a row
 * once a match enters scoring — never silently drops.
 *
 * Composite score per §3:
 *   final = clamp(0..10, 0.5*LLM + 0.3*cosine_10 + 0.1*freshness_10 + 0.1*reliability_10)
 * where each component is normalised to a 0..10 scale before weighting.
 *
 * Cost guard is a STUB in Phase 5 (Phase 6 will check ai_budget_state per
 * workspace per day). The hook is wired so the swap is a one-liner later.
 */

import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  AIProviderError,
  TemplateProvider,
  type AIProvider,
  type ScoreInput,
  type ScoreOutput,
} from '@postdash/ai';
import {
  aiUsageEvents,
  globalNewsItems,
  newsClusterItems,
  sources,
  topicProfiles,
} from '@postdash/db';
import {
  upsertWorkspaceNewsMatch,
  type WorkspaceNewsMatchStatus,
  type ScoreComponents,
} from '@postdash/commands';
import type { TaskHandler } from '../dispatcher.js';

const PayloadSchema = z.object({
  news_item_id: z.string().uuid(),
  cosine_pre_score: z.number().nullable().optional(),
  // ISO timestamp snapshot of topic_profiles.embedding_updated_at AT enqueue
  // time. The score handler compares this with the current topic row and
  // drops the cosine component if it doesn't match — the topic was
  // re-embedded between enqueue and dequeue so cosine_pre_score is stale.
  // Optional + nullable for backwards compatibility with payloads enqueued
  // before this field was added.
  topic_embedding_updated_at_iso: z.string().nullable().optional(),
});

interface NewsRow {
  id: string;
  sourceId: string;
  title: string;
  summary: string | null;
  extractedText: string | null;
  url: string;
  publishedAt: Date | null;
  language: string | null;
  clusterId: string | null;
}

interface TopicRow {
  id: string;
  workspaceId: string;
  language: string;
  mainTopics: string[];
  keywords: string[];
  negativeKeywords: string[];
  toneProfile: unknown;
  embeddingUpdatedAt: Date | null;
}

export const scoreWorkspaceMatchHandler: TaskHandler = async (task, ctx) => {
  const payload = PayloadSchema.parse(task.payload);
  if (!task.workspaceId) {
    throw permanent('score_workspace_match task is missing workspaceId');
  }
  const workspaceId = task.workspaceId;

  // Load news + topic_profile + source in three small queries. We deliberately
  // do NOT join them in one statement — the topic_profile FK is conditional on
  // a workspace's active profile, and a single JOIN would obscure the
  // not-found cases for log triage.

  const newsRows = await ctx.db
    .select({
      id: globalNewsItems.id,
      sourceId: globalNewsItems.sourceId,
      title: globalNewsItems.title,
      summary: globalNewsItems.summary,
      extractedText: globalNewsItems.extractedText,
      url: globalNewsItems.url,
      publishedAt: globalNewsItems.publishedAt,
      language: globalNewsItems.language,
    })
    .from(globalNewsItems)
    .where(eq(globalNewsItems.id, payload.news_item_id))
    .limit(1);
  const news = newsRows[0];
  if (!news) throw permanent(`news_item ${payload.news_item_id} not found`);

  const clusterRows = await ctx.db
    .select({ clusterId: newsClusterItems.clusterId })
    .from(newsClusterItems)
    .where(eq(newsClusterItems.newsItemId, payload.news_item_id))
    .limit(1);
  const clusterId = clusterRows[0]?.clusterId ?? null;

  const topicRows = await ctx.db
    .select({
      id: topicProfiles.id,
      workspaceId: topicProfiles.workspaceId,
      language: topicProfiles.language,
      mainTopics: topicProfiles.mainTopics,
      keywords: topicProfiles.keywords,
      negativeKeywords: topicProfiles.negativeKeywords,
      toneProfile: topicProfiles.toneProfile,
      embeddingUpdatedAt: topicProfiles.embeddingUpdatedAt,
    })
    .from(topicProfiles)
    .where(
      sql`${topicProfiles.workspaceId} = ${workspaceId} AND ${topicProfiles.status} = 'active'`,
    )
    .limit(1);
  const topic = topicRows[0];
  if (!topic) {
    // Active topic profile vanished between enqueue and run (delete /
    // disable). The match is pointless — UPSERT a 'hidden' row so the radar
    // doesn't repeatedly re-score it.
    ctx.logger.info({ workspaceId }, 'no active topic_profile for workspace, marking hidden');
    await upsertWorkspaceNewsMatch(ctx.db, {
      workspaceId,
      newsItemId: news.id,
      clusterId,
      score: null,
      relevanceReason: 'No active topic profile',
      shouldCreateDraft: false,
      riskFlags: ['no_topic_profile'],
      scoreComponents: {},
      aiProvider: null,
      usedModel: null,
      promptVersion: null,
      status: 'hidden',
      scoredAt: null,
    });
    return;
  }

  const sourceRows = await ctx.db
    .select({ id: sources.id, reliabilityScore: sources.reliabilityScore })
    .from(sources)
    .where(eq(sources.id, news.sourceId))
    .limit(1);
  const source = sourceRows[0];
  if (!source) throw permanent(`source ${news.sourceId} not found`);

  // Cost guard STUB. Phase 6 will INSERT/UPDATE ai_budget_state and defer
  // here on cap-reached. Keeping the call shape so the swap-in is mechanical.
  // Embeddings are uncapped per §10, so this guard only protects score/draft.
  const costGuardOk = await checkCostGuardStub(workspaceId);
  if (!costGuardOk) {
    // Phase 5 never trips this branch; left wired for parity with Phase 6.
    /* istanbul ignore next */ ctx.logger.info({ workspaceId }, 'cost guard blocked scoring');
    return;
  }

  // Score via AI provider with fallback to TemplateProvider. The fallback
  // path mirrors §10 of 07-AI-SCORING-AND-DRAFTS.md: the radar always shows
  // a row once we enter scoring, so the UI never has a phantom "stuck pending"
  // state.
  const scoreInput = buildScoreInput(workspaceId, news, topic);
  const scoredAt = new Date();
  const startedAt = Date.now();

  let scoreOutput: ScoreOutput;
  let aiUsageStatus: 'success' | 'failed' | 'refused' | 'parse_error' | 'fallback';
  let aiErrorMessage: string | null = null;
  let aiUsedProvider: AIProvider = ctx.ai;

  try {
    scoreOutput = await ctx.ai.score(scoreInput);
    aiUsageStatus = 'success';
  } catch (err) {
    if (err instanceof AIProviderError && err.code === 'refused') {
      // Refused content path per §13: status='ai_refused', no draft, no fallback.
      await upsertWorkspaceNewsMatch(ctx.db, {
        workspaceId,
        newsItemId: news.id,
        clusterId,
        score: null,
        relevanceReason: 'AI refused to score the content',
        shouldCreateDraft: false,
        riskFlags: ['refused'],
        scoreComponents: {},
        aiProvider: ctx.ai.name,
        usedModel: null,
        promptVersion: null,
        status: 'ai_refused',
        scoredAt,
      });
      await writeAiUsage(ctx, {
        workspaceId,
        taskId: task.id,
        actionType: 'score',
        usedModel: ctx.ai.name,
        promptVersion: 'unknown',
        durationMs: Date.now() - startedAt,
        status: 'refused',
        errorMessage: err.message,
      });
      return;
    }

    // Other AIProviderError or unknown errors → TemplateProvider fallback.
    // TemplateProvider.score returns a stub (score=5, fallback flag) so the
    // workspace at least sees a candidate row with a clear "no AI" badge.
    ctx.logger.warn(
      { err, workspaceId, newsItemId: news.id },
      'ai.score failed, falling back to TemplateProvider',
    );
    const template = new TemplateProvider();
    try {
      scoreOutput = await template.score(scoreInput);
      aiUsedProvider = template;
      aiUsageStatus = 'fallback';
      aiErrorMessage = err instanceof Error ? err.message : String(err);
    } catch (fallbackErr) {
      // TemplateProvider.score never throws today, but guard anyway. Treat
      // as permanent — without any score we can't write a useful row.
      throw permanent(
        `score failed and template fallback also failed: ${(fallbackErr as Error).message}`,
      );
    }
  }

  // Stale-cosine check: the matcher snapshotted topic.embedding_updated_at AT
  // enqueue time and passed it in the payload. If the topic's current
  // embedding_updated_at doesn't match, the topic was re-embedded between
  // enqueue and dequeue and `cosine_pre_score` no longer reflects the current
  // topic vector. Drop the cosine component (degrade to LLM-only composite)
  // rather than scoring against a stale value, and surface the decision via
  // a risk_flag so observability is clear. Backwards-compat: if the payload
  // didn't carry a snapshot (legacy enqueue → field `undefined`), skip the
  // check and trust the value.
  const snapshotIso = payload.topic_embedding_updated_at_iso;
  const currentIso = topic.embeddingUpdatedAt ? topic.embeddingUpdatedAt.toISOString() : null;
  const cosineIsStale = snapshotIso !== undefined && snapshotIso !== currentIso;
  const cosineForComposite = cosineIsStale ? null : (payload.cosine_pre_score ?? null);
  const staleCosineFlag: readonly string[] = cosineIsStale ? ['stale_cosine_dropped'] : [];

  // Composite score: §3. The LLM head is in 0..10; cosine_pre_score from the
  // matcher is in [-1..1] (we normalise to 0..10 via *5+5 then clamp); freshness
  // is exp(-hours/24) → multiplied by 10; reliability is in 0..1 → *10.
  const components = computeComposite({
    llm: scoreOutput.score,
    cosineRaw: cosineForComposite,
    publishedAt: news.publishedAt,
    reliabilityRaw: source.reliabilityScore === null ? null : Number(source.reliabilityScore),
  });
  const finalScore = components.weighted;

  // Status decision. low_score below AUTO_DRAFT_SCORE_THRESHOLD demotes the
  // row in UI but keeps it visible (user can override). 'candidate' above
  // threshold; should_create_draft surfaces the LLM's recommendation as-is.
  const status: WorkspaceNewsMatchStatus =
    finalScore < ctx.aiConfig.autoDraftScoreThreshold ? 'low_score' : 'candidate';

  await upsertWorkspaceNewsMatch(ctx.db, {
    workspaceId,
    newsItemId: news.id,
    clusterId,
    score: round2(finalScore),
    relevanceReason: scoreOutput.relevance_reason,
    shouldCreateDraft: scoreOutput.should_create_draft && status === 'candidate',
    riskFlags: Array.from(
      new Set([
        ...scoreOutput.risk_flags,
        ...(aiUsageStatus === 'fallback' ? ['fallback'] : []),
        ...staleCosineFlag,
      ]),
    ),
    scoreComponents: components as unknown as Record<string, number>,
    aiProvider: aiUsedProvider.name,
    usedModel: scoreOutput.used_model,
    promptVersion: scoreOutput.prompt_version,
    status,
    scoredAt,
  });

  await writeAiUsage(ctx, {
    workspaceId,
    taskId: task.id,
    actionType: 'score',
    usedModel: scoreOutput.used_model,
    promptVersion: scoreOutput.prompt_version,
    durationMs: Date.now() - startedAt,
    status: aiUsageStatus,
    errorMessage: aiErrorMessage,
  });
};

// =============================================================================
// Helpers
// =============================================================================

interface CompositeInput {
  llm: number;
  cosineRaw: number | null;
  publishedAt: Date | null;
  reliabilityRaw: number | null;
}

/**
 * Compose the final 0..10 score from four components per §3. Components are
 * each rescaled to 0..10 BEFORE weighting so the breakdown the UI shows lines
 * up with the user's mental model ("LLM gave 8, freshness gave 7, ...").
 *
 * - llm: already in 0..10.
 * - cosine: raw cosine in [-1..1] → (raw+1)/2*10 = 0..10. NULL (no topic
 *   embedding) zeros the component.
 * - freshness: exp(-hours_since_published / 24) * 10. NULL publishedAt → 5 (neutral).
 * - reliability: raw 0..1 → *10. NULL → 5 (neutral; new sources start
 *   un-rated).
 *
 * The 50/30/10/10 weight split matches §3.
 */
export function computeComposite(input: CompositeInput): ScoreComponents {
  const llm = clamp(0, 10, input.llm);
  const cosineComponent =
    input.cosineRaw === null ? 0 : clamp(0, 10, ((input.cosineRaw + 1) / 2) * 10);
  let freshness = 5;
  if (input.publishedAt) {
    const hours = Math.max(0, (Date.now() - input.publishedAt.getTime()) / (60 * 60 * 1000));
    freshness = clamp(0, 10, Math.exp(-hours / 24) * 10);
  }
  const reliability = input.reliabilityRaw === null ? 5 : clamp(0, 10, input.reliabilityRaw * 10);

  const weighted = 0.5 * llm + 0.3 * cosineComponent + 0.1 * freshness + 0.1 * reliability;

  return {
    llm,
    cosine: cosineComponent,
    freshness,
    reliability,
    weighted: clamp(0, 10, weighted),
  };
}

function clamp(min: number, max: number, v: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function buildScoreInput(
  workspaceId: string,
  news: Omit<NewsRow, 'clusterId'>,
  topic: TopicRow,
): ScoreInput {
  const topicProfile = {
    id: topic.id,
    workspace_id: topic.workspaceId,
    language: narrowLanguage(topic.language),
    main_topics: topic.mainTopics,
    keywords: topic.keywords,
    negative_keywords: topic.negativeKeywords,
    tone_profile: normalizeTone(topic.toneProfile),
  };
  const newsRef: ScoreInput['news'] = {
    title: news.title,
    url: news.url,
    ...(news.summary !== null ? { summary: news.summary } : {}),
    ...(news.extractedText !== null ? { extracted_text: news.extractedText } : {}),
    ...(news.publishedAt !== null ? { published_at: news.publishedAt } : {}),
  };
  return {
    workspace_id: workspaceId,
    topic_profile: topicProfile,
    news: newsRef,
    language: narrowLanguage(topic.language),
  };
}

function narrowLanguage(s: string): 'ru' | 'en' {
  return s === 'en' ? 'en' : 'ru';
}

/**
 * Coerce a raw `tone_profile` jsonb into the strict ToneProfile shape the
 * AIProvider expects. Missing/invalid fields fall back to the documented
 * defaults from ToneProfileSchema.
 */
function normalizeTone(raw: unknown): ScoreInput['topic_profile']['tone_profile'] {
  const defaults = {
    length: 'medium' as const,
    style: 'expert' as const,
    emoji: 'light' as const,
    language: 'ru' as const,
    cta_style: 'soft' as const,
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
  const r = raw as Record<string, unknown>;
  return {
    length: pick(r['length'], ['short', 'medium', 'long'], defaults.length),
    style: pick(r['style'], ['strict', 'lively', 'expert', 'simple'], defaults.style),
    emoji: pick(r['emoji'], ['none', 'light', 'medium'], defaults.emoji),
    language: pick(r['language'], ['ru', 'en'], defaults.language),
    cta_style: pick(r['cta_style'], ['none', 'soft', 'direct'], defaults.cta_style),
  };
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

async function checkCostGuardStub(_workspaceId: string): Promise<boolean> {
  // Phase 6 hook — for now always proceed. Embeddings are uncapped per §10.
  return Promise.resolve(true);
}

interface AiUsageRow {
  workspaceId: string;
  taskId: string;
  actionType: 'score' | 'generate' | 'rewrite' | 'embed';
  usedModel: string;
  promptVersion: string;
  durationMs: number;
  status: 'success' | 'failed' | 'refused' | 'parse_error' | 'fallback';
  errorMessage?: string | null;
}

async function writeAiUsage(ctx: Parameters<TaskHandler>[1], row: AiUsageRow): Promise<void> {
  // Best-effort write — failures here shouldn't fail the task. The audit
  // value is observability, not correctness.
  try {
    await ctx.db.insert(aiUsageEvents).values({
      workspaceId: row.workspaceId,
      taskId: row.taskId,
      actionType: row.actionType,
      usedModel: row.usedModel,
      promptVersion: row.promptVersion,
      durationMs: row.durationMs,
      status: row.status,
      errorMessage: truncateAiUsageError(row.errorMessage),
    });
  } catch (err) {
    ctx.logger.warn({ err }, 'ai_usage_events write failed (non-fatal)');
  }
}

export function truncateAiUsageError(message: string | null | undefined): string | null {
  if (message === null || message === undefined) return null;
  return message.length > 500 ? message.slice(0, 500) : message;
}

function permanent(message: string): Error {
  const e: Error & { kind?: string } = new Error(message);
  e.kind = 'permanent';
  return e;
}
