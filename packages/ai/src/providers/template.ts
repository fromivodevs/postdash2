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

const MODEL = 'template';
const SCORE_PROMPT_VERSION = 'template-score@v1.0';
const DRAFT_PROMPT_VERSION = 'template-draft@v1.0';

const SUMMARY_PREVIEW_CHARS = 400;

/**
 * No-AI fallback provider. Used when:
 * - LLM endpoint unavailable;
 * - JSON parse error after repair-attempt;
 * - content refused by safety filter;
 * - AI_FALLBACK_TO_TEMPLATE=true.
 *
 * См. tg_mvp_plan/11-AI-PROVIDER.md §4.2.
 */
export class TemplateProvider implements AIProvider {
  public readonly name = 'template';

  // eslint-disable-next-line @typescript-eslint/require-await
  async score(_input: ScoreInput): Promise<ScoreOutput> {
    return {
      score: 5.0,
      relevance_reason: 'LLM unavailable, candidate based on source',
      should_create_draft: false,
      risk_flags: ['fallback'],
      used_model: MODEL,
      prompt_version: SCORE_PROMPT_VERSION,
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async generateDraft(input: DraftInput): Promise<DraftOutput> {
    return this.buildFormatADraft(input);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async rewriteDraft(input: RewriteInput): Promise<DraftOutput> {
    // Template fallback не делает rewrite — возвращает Format A на основе исходной новости.
    return this.buildFormatADraft(input);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async embed(_input: EmbedInput): Promise<EmbedOutput> {
    throw new AIProviderError(
      'TemplateProvider does not support embeddings; use YandexEmbeddings provider',
      'not_implemented',
    );
  }

  private buildFormatADraft(input: DraftInput | RewriteInput): DraftOutput {
    const { news } = input;
    const summary = news.summary ?? this.firstChars(news.extracted_text, SUMMARY_PREVIEW_CHARS);
    const body = summary ? `Кратко: ${summary}\n\n` : '';
    const post_text = `Новость: ${news.title}\n\n${body}Источник: ${news.url}`.trim();

    return {
      title: news.title,
      post_text,
      source_links: [news.url],
      notes: 'Сгенерировано без AI (fallback).',
      risk_flags: ['fallback'],
      used_model: MODEL,
      prompt_version: DRAFT_PROMPT_VERSION,
    };
  }

  private firstChars(text: string | undefined, n: number): string | undefined {
    if (!text) return undefined;
    return text.length > n ? `${text.slice(0, n).trimEnd()}…` : text;
  }
}
