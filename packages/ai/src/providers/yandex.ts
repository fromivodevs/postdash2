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

export interface YandexProviderConfig {
  folderId: string;
  llmModelUri: string;
  embedDocModelUri: string;
  embedQueryModelUri: string;
  requestTimeoutMs: number;
  llmMaxTokens: number;
  llmTemperature: number;
  iamToken: IAMTokenCache;
}

/**
 * Skeleton для YandexAIStudioDeepSeekProvider.
 *
 * Phase 0: только структура и валидация конфига. Реальные вызовы
 * Foundation Models API — Phase 4 (embeddings) и Phase 5–6 (score/draft).
 *
 * См. tg_mvp_plan/11-AI-PROVIDER.md §4.1, §5, §6, §9.
 */
export class YandexAIStudioDeepSeekProvider implements AIProvider {
  public readonly name = 'yandex-deepseek';

  constructor(private readonly config: YandexProviderConfig) {}

  async score(_input: ScoreInput): Promise<ScoreOutput> {
    throw new AIProviderError(
      'YandexAIStudioDeepSeekProvider.score() not implemented in Phase 0',
      'not_implemented',
    );
  }

  async generateDraft(_input: DraftInput): Promise<DraftOutput> {
    throw new AIProviderError(
      'YandexAIStudioDeepSeekProvider.generateDraft() not implemented in Phase 0',
      'not_implemented',
    );
  }

  async rewriteDraft(_input: RewriteInput): Promise<DraftOutput | DraftOutput[]> {
    throw new AIProviderError(
      'YandexAIStudioDeepSeekProvider.rewriteDraft() not implemented in Phase 0',
      'not_implemented',
    );
  }

  async embed(_input: EmbedInput): Promise<EmbedOutput> {
    throw new AIProviderError(
      'YandexAIStudioDeepSeekProvider.embed() not implemented in Phase 0',
      'not_implemented',
    );
  }

  /** Возвращает modelUri для embedding'ов в зависимости от kind (doc | query). */
  protected embedModelUriFor(kind: 'doc' | 'query'): string {
    return kind === 'doc' ? this.config.embedDocModelUri : this.config.embedQueryModelUri;
  }
}
