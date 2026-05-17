/**
 * Yandex AI Studio adapter — primary provider.
 *
 * Phase 4 implements `embed()` (real HTTP call, IAM-bearer auth, dim
 * validation, single 401-retry on token expiry).
 * Phase 5 implements `score()` (relevance scoring via DeepSeek completion,
 * zod-validated JSON output, one repair-attempt on parse failure).
 * `generateDraft()` / `rewriteDraft()` remain `not_implemented` stubs until
 * Phase 6.
 *
 * See tg_mvp_plan/11-AI-PROVIDER.md §4.1, §5, §6, §9.
 */

import { z } from 'zod';
import {
  AIProviderError,
  ScoreOutputSchema,
  type AIProvider,
  type DraftInput,
  type DraftOutput,
  type EmbedInput,
  type EmbedOutput,
  type RewriteInput,
  type ScoreInput,
  type ScoreOutput,
} from '../provider.js';
import type { IAMTokenCache } from '../iam-token.js';

const EMBEDDING_ENDPOINT = 'https://llm.api.cloud.yandex.net/foundationModels/v1/textEmbedding';
const COMPLETION_ENDPOINT = 'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

/**
 * Hard cap on the news body fed into the score prompt. Beyond ~8k chars the
 * additional context rarely changes the relevance score but burns input
 * tokens linearly. The prompt template documents this in
 * tg_mvp_plan/07-AI-SCORING-AND-DRAFTS.md §8.1 ("extracted_text_truncated_8k").
 */
const SCORE_PROMPT_BODY_MAX_CHARS = 8_000;

/** Stable id for prompt-version tracking. Bump on any template change. */
export const YANDEX_SCORE_PROMPT_VERSION = 'yandex-deepseek-score@v1.0';

/**
 * Foundation Models completion response shape. We only consume the fields we
 * need so the parser tolerates new SDK fields without breaking. Cast through
 * zod for runtime safety — the upstream contract has no guarantee against
 * field renaming.
 */
const CompletionResponseSchema = z.object({
  result: z.object({
    alternatives: z
      .array(
        z.object({
          message: z.object({
            role: z.string(),
            text: z.string(),
          }),
          status: z.string().optional(),
        }),
      )
      .min(1),
    usage: z
      .object({
        inputTextTokens: z.union([z.string(), z.number()]).optional(),
        completionTokens: z.union([z.string(), z.number()]).optional(),
        totalTokens: z.union([z.string(), z.number()]).optional(),
      })
      .optional(),
    modelVersion: z.string().optional(),
  }),
});

export interface YandexProviderConfig {
  folderId: string;
  llmModelUri: string;
  embedDocModelUri: string;
  embedQueryModelUri: string;
  requestTimeoutMs: number;
  llmMaxTokens: number;
  llmTemperature: number;
  /** 256 in MVP (Yandex `text-search-doc`). Validated against response. */
  embeddingDim: number;
  iamToken: IAMTokenCache;
  /** Injectable for tests. */
  fetch?: typeof globalThis.fetch;
}

export class YandexAIStudioDeepSeekProvider implements AIProvider {
  public readonly name = 'yandex-deepseek';
  /**
   * The single IAMTokenCache instance this provider consults. Exposed so the
   * worker's `refresh_iam_token` task handler can invoke `forceRefresh()` on
   * the SAME in-memory cache the provider reads from — without this seam the
   * handler would have to build a sibling cache and rely on the system_state
   * writethrough to converge, which doubles the IAM-exchange budget on every
   * proactive refresh tick.
   */
  public readonly iamToken: IAMTokenCache;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly config: YandexProviderConfig) {
    this.fetchImpl = config.fetch ?? globalThis.fetch;
    this.iamToken = config.iamToken;
  }

  /**
   * Relevance score for (workspace, news_item). Returns a `ScoreOutput`
   * validated by `ScoreOutputSchema` — score clamped to [0,10], reason ≤280
   * chars, risk_flags surfaced from the LLM response.
   *
   * Failure modes (matrix in tg_mvp_plan/11-AI-PROVIDER.md §9):
   *   - 401 → force IAM refresh + retry once. Still 401 → `auth_error`.
   *   - 429 → `rate_limit` (handler retries with backoff).
   *   - 5xx → `server_error` (transient; handler retries).
   *   - 4xx → `parse_error` (permanent; handler swaps to TemplateProvider).
   *   - Safety refusal (alternative.status='ALTERNATIVE_STATUS_CONTENT_FILTER'
   *     or risk_flags contains 'refused') → `refused`.
   *   - JSON parse failure → ONE repair-attempt with a stricter system prompt;
   *     if that still fails → `parse_error` (handler falls back).
   *
   * Repair-attempt is intentionally a single retry — DeepSeek 3.2 has reliable
   * JSON mode, so a persistent parse failure usually means the prompt template
   * drifted, not model flakiness. Retrying many times would burn tokens
   * without converging.
   */
  async score(input: ScoreInput): Promise<ScoreOutput> {
    const messages = buildScoreMessages(input);
    const firstText = await this.completion(messages);
    const firstParsed = tryParseScoreJson(firstText);
    if (firstParsed.ok) {
      return finalizeScore(firstParsed.value);
    }

    // ONE repair-attempt. The repair system prompt is added on top of the
    // original messages (instead of replacing them) so the model still sees
    // the original input context.
    const repairMessages: ChatMessage[] = [
      ...messages,
      {
        role: 'assistant',
        text: firstText.slice(0, 800),
      },
      {
        role: 'system',
        text:
          'Your previous response was not valid JSON matching the schema. ' +
          'Return ONLY a JSON object with keys: score (number 0..10), ' +
          'relevance_reason (string <=280 chars), should_create_draft (bool), ' +
          'risk_flags (string[]). No prose, no markdown, no code fences.',
      },
    ];
    const secondText = await this.completion(repairMessages);
    const secondParsed = tryParseScoreJson(secondText);
    if (secondParsed.ok) {
      return finalizeScore(secondParsed.value);
    }
    throw new AIProviderError(
      `score parse failed after repair: ${secondParsed.reason}`,
      'parse_error',
    );
  }

  async generateDraft(_input: DraftInput): Promise<DraftOutput> {
    throw new AIProviderError(
      'YandexAIStudioDeepSeekProvider.generateDraft() not implemented (Phase 6)',
      'not_implemented',
    );
  }

  async rewriteDraft(_input: RewriteInput): Promise<DraftOutput | DraftOutput[]> {
    throw new AIProviderError(
      'YandexAIStudioDeepSeekProvider.rewriteDraft() not implemented (Phase 6)',
      'not_implemented',
    );
  }

  /**
   * Force-refresh the IAM token cache. Exposed via the optional
   * `AIProvider.iamRefresh` seam so the worker's `refresh_iam_token` handler
   * can invoke it without `instanceof` checks against this concrete class.
   */
  async iamRefresh(): Promise<void> {
    await this.config.iamToken.forceRefresh();
  }

  /**
   * Generate an embedding for `input.text` against the doc or query model
   * (chosen by `input.kind`). Validates that the response vector length
   * matches `config.embeddingDim` (256 in MVP) — a mismatch is a permanent
   * failure (edge case 6.5).
   *
   * Retries the request ONCE on 401 after forcing an IAM refresh — the
   * token may have been revoked server-side before our local TTL caught
   * up. Other 5xx / network errors are surfaced as `server_error` so the
   * task queue retries via its backoff policy.
   */
  async embed(input: EmbedInput): Promise<EmbedOutput> {
    if (input.text.trim().length === 0) {
      throw new AIProviderError('embed input.text is empty', 'parse_error');
    }
    const modelUri = this.embedModelUriFor(input.kind);

    const send = async (token: string): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      try {
        return await this.fetchImpl(EMBEDDING_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'x-folder-id': this.config.folderId,
          },
          body: JSON.stringify({ modelUri, text: input.text }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };

    let token = await this.config.iamToken.getToken();
    let response: Response;
    try {
      response = await send(token);
    } catch (err) {
      // Abort and other network failures both map to `server_error` — the task
      // queue's transient-retry policy is the right response for either. Kept
      // as a single branch to make that policy intent obvious.
      throw new AIProviderError(
        `embed network error: ${(err as Error).message ?? String(err)}`,
        'server_error',
        err,
      );
    }

    if (response.status === 401) {
      // Token might have been revoked / rotated. Force-refresh once, retry once.
      token = await this.config.iamToken.forceRefresh();
      try {
        response = await send(token);
      } catch (err) {
        throw new AIProviderError(
          `embed retry-after-401 network error: ${(err as Error).message ?? String(err)}`,
          'server_error',
          err,
        );
      }
      // If the retry still comes back 401 the credentials themselves are bad
      // (revoked SA key, wrong folder, etc.) — surface as auth_error so the
      // dispatcher's classifyFailure maps it to permanent. Without this
      // branch the generic 4xx path below would mislabel it as parse_error.
      if (response.status === 401) {
        throw new AIProviderError('embed still 401 after token refresh', 'auth_error');
      }
    }

    if (response.status === 429) {
      throw new AIProviderError(`embed rate-limited (429)`, 'rate_limit');
    }
    if (response.status >= 500) {
      throw new AIProviderError(`embed upstream ${response.status}`, 'server_error');
    }
    if (response.status >= 400) {
      // 4xx is permanent: bad request, invalid model URI, banned content,
      // etc. The task queue should mark `failed_permanent` immediately.
      throw new AIProviderError(`embed rejected with ${response.status}`, 'parse_error');
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new AIProviderError('embed response is not JSON', 'parse_error', err);
    }

    // Foundation Models textEmbedding response shape:
    //   { embedding: number[], numTokens: string, modelVersion: string }
    if (
      !body ||
      typeof body !== 'object' ||
      !Array.isArray((body as { embedding?: unknown }).embedding)
    ) {
      throw new AIProviderError('embed response missing `embedding` array', 'parse_error');
    }
    const vector = (body as { embedding: unknown[] }).embedding;
    for (const v of vector) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new AIProviderError('embed vector contains non-finite values', 'parse_error');
      }
    }
    const typed = vector as number[];

    if (typed.length !== this.config.embeddingDim) {
      throw new AIProviderError(
        `embed vector dim mismatch: got ${typed.length}, want ${this.config.embeddingDim}`,
        'parse_error',
      );
    }

    const usedModel =
      typeof (body as { modelVersion?: unknown }).modelVersion === 'string'
        ? (body as { modelVersion: string }).modelVersion
        : modelUri;
    return { vector: typed, used_model: usedModel };
  }

  /** Selects modelUri by kind (doc | query). */
  protected embedModelUriFor(kind: 'doc' | 'query'): string {
    return kind === 'doc' ? this.config.embedDocModelUri : this.config.embedQueryModelUri;
  }

  /**
   * Single round-trip to the completion endpoint. Returns the assistant text
   * exactly as the model produced it (parsing/validation is the caller's job).
   *
   * Error mapping mirrors `embed()` 1:1 so the failure matrix stays uniform
   * across LLM and embedding calls.
   */
  private async completion(messages: ChatMessage[]): Promise<string> {
    const body = {
      modelUri: this.config.llmModelUri,
      completionOptions: {
        stream: false,
        temperature: this.config.llmTemperature,
        maxTokens: String(this.config.llmMaxTokens),
      },
      messages,
    };

    const send = async (token: string): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      try {
        return await this.fetchImpl(COMPLETION_ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'x-folder-id': this.config.folderId,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };

    let token = await this.config.iamToken.getToken();
    let response: Response;
    try {
      response = await send(token);
    } catch (err) {
      throw new AIProviderError(
        `completion network error: ${(err as Error).message ?? String(err)}`,
        'server_error',
        err,
      );
    }

    if (response.status === 401) {
      token = await this.config.iamToken.forceRefresh();
      try {
        response = await send(token);
      } catch (err) {
        throw new AIProviderError(
          `completion retry-after-401 network error: ${(err as Error).message ?? String(err)}`,
          'server_error',
          err,
        );
      }
      if (response.status === 401) {
        throw new AIProviderError('completion still 401 after token refresh', 'auth_error');
      }
    }

    if (response.status === 429) {
      throw new AIProviderError('completion rate-limited (429)', 'rate_limit');
    }
    if (response.status >= 500) {
      throw new AIProviderError(`completion upstream ${response.status}`, 'server_error');
    }
    if (response.status >= 400) {
      throw new AIProviderError(`completion rejected with ${response.status}`, 'parse_error');
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch (err) {
      throw new AIProviderError('completion response is not JSON', 'parse_error', err);
    }

    const parsed = CompletionResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AIProviderError(
        `completion envelope shape unexpected: ${parsed.error.issues
          .map((i) => i.message)
          .join('; ')
          .slice(0, 200)}`,
        'parse_error',
      );
    }
    const first = parsed.data.result.alternatives[0]!;
    // Yandex marks safety-filter rejections via the alternative status. Map
    // explicitly so the score handler can short-circuit to the 'ai_refused'
    // workspace_news_matches status without a TemplateProvider fallback.
    if (first.status === 'ALTERNATIVE_STATUS_CONTENT_FILTER') {
      throw new AIProviderError('completion refused by safety filter', 'refused');
    }
    return first.message.text;
  }
}

// =============================================================================
// Helpers (module-level, no `this`).
// =============================================================================

/**
 * Message envelope for Foundation Models. Yandex calls it `messages: [{role, text}]`
 * — note `text` not `content`. Roles supported: 'system' | 'user' | 'assistant'.
 */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  text: string;
}

/**
 * Build the score prompt messages. Mirrors the schema-by-prose contract in
 * tg_mvp_plan/07-AI-SCORING-AND-DRAFTS.md §8.1, with body truncated to keep
 * prompt budget predictable.
 */
function buildScoreMessages(input: ScoreInput): ChatMessage[] {
  const body = input.news.extracted_text ?? input.news.summary ?? input.news.title;
  const truncatedBody =
    body.length > SCORE_PROMPT_BODY_MAX_CHARS
      ? `${[...body].slice(0, SCORE_PROMPT_BODY_MAX_CHARS).join('')}…`
      : body;

  const tp = input.topic_profile;
  const negative = tp.negative_keywords.length > 0 ? tp.negative_keywords.join(', ') : '(none)';
  const mainTopics = tp.main_topics.length > 0 ? tp.main_topics.join(', ') : '(none)';
  const keywords = tp.keywords.length > 0 ? tp.keywords.join(', ') : '(none)';
  const publishedAt = input.news.published_at ? input.news.published_at.toISOString() : '(unknown)';

  const system =
    'You are an editorial assistant scoring news relevance for a publication channel. ' +
    'Output STRICT JSON matching: {"score": number 0-10, "relevance_reason": string (max 280 chars), ' +
    '"should_create_draft": boolean, "risk_flags": string[]}. ' +
    'No prose, no markdown, no code fences. ' +
    'Risk flags vocabulary: "medical_claim", "financial_advice", "legal_advice", ' +
    '"unverified_statistic", "personal_data", "refused". ' +
    'If you cannot or will not score the news, return risk_flags=["refused"] and score=0.';

  const user = [
    `Workspace language: ${input.language}.`,
    `Main topics: ${mainTopics}.`,
    `Positive keywords: ${keywords}.`,
    `Negative keywords (penalize hard): ${negative}.`,
    '',
    'News:',
    `- Title: ${input.news.title}`,
    `- Published: ${publishedAt}`,
    `- URL: ${input.news.url}`,
    `- Body:\n${truncatedBody}`,
  ].join('\n');

  return [
    { role: 'system', text: system },
    { role: 'user', text: user },
  ];
}

/**
 * Try to parse a JSON object out of the model's text. Handles two common
 * mis-formats DeepSeek occasionally produces despite JSON-mode instructions:
 *   - leading/trailing prose ("Here's the JSON: { ... }")
 *   - markdown fences (```json ... ```)
 *
 * Returns the typed shape on success, or a reason string on failure (so the
 * caller can decide between a repair-attempt and bubbling parse_error).
 */
function tryParseScoreJson(
  text: string,
): { ok: true; value: ParsedScoreLoose } | { ok: false; reason: string } {
  const trimmed = text.trim();
  const candidate = extractJsonObject(trimmed);
  if (!candidate) return { ok: false, reason: 'no JSON object found in response' };
  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch (err) {
    return { ok: false, reason: `JSON.parse: ${(err as Error).message}` };
  }
  const parsed = ParsedScoreLooseSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      reason: parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')
        .slice(0, 200),
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Pull out the first balanced `{...}` substring. Tolerates leading text like
 * "Here's the JSON:" and code fences. Returns null if no candidate found.
 *
 * Order of attempts matters: we scan for an outermost balanced object in the
 * FULL text first, only falling back to the fence body when no whole-text
 * candidate parses. Previously the fence body was preferred unconditionally,
 * which silently swallowed valid JSON OUTSIDE the fence when the body INSIDE
 * the fence was malformed (e.g. "```json {malformed``` {valid...}").
 */
function extractJsonObject(text: string): string | null {
  const fromFull = scanBalanced(text);
  if (fromFull !== null && parseable(fromFull)) return fromFull;
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    const fromFence = scanBalanced(fenceMatch[1]);
    if (fromFence !== null) return fromFence;
  }
  // Fall back to whatever the full-text scan returned (even if it didn't
  // parse) — the caller surfaces a parse_error with the original reason,
  // which is more diagnostic than "no JSON object found".
  return fromFull;
}

function scanBalanced(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\' && inString) {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

function parseable(candidate: string): boolean {
  try {
    JSON.parse(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lenient parse of the model output before clamping. The model may return
 * score outside [0,10] or relevance_reason >280 chars; clamping happens in
 * finalizeScore so the partial output isn't thrown away.
 */
const ParsedScoreLooseSchema = z.object({
  score: z.number(),
  relevance_reason: z.string(),
  should_create_draft: z.boolean(),
  risk_flags: z.array(z.string()),
});
type ParsedScoreLoose = z.infer<typeof ParsedScoreLooseSchema>;

/**
 * Clamp score, truncate reason, and validate against the strict
 * `ScoreOutputSchema`. If the strict validation fails (e.g. NaN score), throw
 * parse_error — that's a model fault the caller may fall back from.
 */
function finalizeScore(loose: ParsedScoreLoose): ScoreOutput {
  if (!Number.isFinite(loose.score)) {
    throw new AIProviderError('score is not a finite number', 'parse_error');
  }
  const clampedScore = Math.max(0, Math.min(10, loose.score));
  const truncatedReason =
    loose.relevance_reason.length > 280
      ? [...loose.relevance_reason].slice(0, 279).join('') + '…'
      : loose.relevance_reason;
  const refused = loose.risk_flags.includes('refused');
  // Refused content is communicated via risk_flags=['refused'] and score=0 —
  // mirrors what the system prompt asks for. Bubble as `refused` so the
  // dispatcher can mark the match row 'ai_refused' without a fallback.
  if (refused) {
    throw new AIProviderError('model returned risk_flags=["refused"]', 'refused');
  }
  return ScoreOutputSchema.parse({
    score: clampedScore,
    relevance_reason: truncatedReason,
    should_create_draft: loose.should_create_draft,
    risk_flags: loose.risk_flags,
    used_model: 'yandex-deepseek-v3.2',
    prompt_version: YANDEX_SCORE_PROMPT_VERSION,
  });
}
