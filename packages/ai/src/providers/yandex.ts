/**
 * Yandex AI Studio adapter — primary provider.
 *
 * Phase 4 implements `embed()` (real HTTP call, IAM-bearer auth, dim
 * validation, single 401-retry on token expiry). `score()`, `generateDraft()`,
 * `rewriteDraft()` remain `not_implemented` stubs until Phase 5/6.
 *
 * See tg_mvp_plan/11-AI-PROVIDER.md §4.1, §5, §6, §9.
 */

import {
  AIProviderError,
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

  async score(_input: ScoreInput): Promise<ScoreOutput> {
    throw new AIProviderError(
      'YandexAIStudioDeepSeekProvider.score() not implemented (Phase 5)',
      'not_implemented',
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
}
