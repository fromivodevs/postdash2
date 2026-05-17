import { z } from 'zod';

export const ToneProfileSchema = z.object({
  length: z.enum(['short', 'medium', 'long']).default('medium'),
  style: z.enum(['strict', 'lively', 'expert', 'simple']).default('expert'),
  emoji: z.enum(['none', 'light', 'medium']).default('light'),
  language: z.enum(['ru', 'en']).default('ru'),
  cta_style: z.enum(['none', 'soft', 'direct']).default('soft'),
});
export type ToneProfile = z.infer<typeof ToneProfileSchema>;

export const TopicProfileSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  language: z.enum(['ru', 'en']),
  main_topics: z.array(z.string()),
  keywords: z.array(z.string()),
  negative_keywords: z.array(z.string()),
  tone_profile: ToneProfileSchema,
});
export type TopicProfile = z.infer<typeof TopicProfileSchema>;

export const NewsRefSchema = z.object({
  title: z.string(),
  summary: z.string().optional(),
  extracted_text: z.string().optional(),
  url: z.string().url(),
  published_at: z.date().optional(),
});
export type NewsRef = z.infer<typeof NewsRefSchema>;

export const ScoreInputSchema = z.object({
  workspace_id: z.string().uuid(),
  topic_profile: TopicProfileSchema,
  news: NewsRefSchema,
  language: z.enum(['ru', 'en']),
});
export type ScoreInput = z.infer<typeof ScoreInputSchema>;

export const ScoreOutputSchema = z.object({
  score: z.number().min(0).max(10),
  // soft UX cap on reason line length (~tweet-length); ensures Mini App cards
  // render without truncation
  relevance_reason: z.string().max(280),
  should_create_draft: z.boolean(),
  risk_flags: z.array(z.string()),
  used_model: z.string(),
  prompt_version: z.string(),
});
export type ScoreOutput = z.infer<typeof ScoreOutputSchema>;

export const DraftInputSchema = z.object({
  workspace_id: z.string().uuid(),
  topic_profile: TopicProfileSchema,
  tone_profile: ToneProfileSchema,
  news: NewsRefSchema,
  format: z.enum(['short_news', 'expert_angle']),
  language: z.enum(['ru', 'en']),
});
export type DraftInput = z.infer<typeof DraftInputSchema>;

// post_text is channel-agnostic — no length cap here. Per-channel length
// validation lives in channel adapters (e.g. `packages/channel-adapters/telegram`
// enforces TELEGRAM_POST_MAX_LENGTH at publish time, exposed today as
// `fitsTelegramPostLimit` in `@postdash/shared/telegram-format`). When
// VK/Discord adapters arrive in Phase 9/13, each enforces its own platform
// limit. Keeping the generic AI contract free of Telegram constants preserves
// "Telegram is an adapter, not core".
export const DraftOutputSchema = z.object({
  title: z.string().optional(),
  post_text: z.string().min(1),
  source_links: z.array(z.string().url()).min(1),
  notes: z.string().optional(),
  risk_flags: z.array(z.string()),
  used_model: z.string(),
  prompt_version: z.string(),
});
export type DraftOutput = z.infer<typeof DraftOutputSchema>;

export const RewriteInputSchema = DraftInputSchema.extend({
  current_text: z.string(),
  instruction: z.string(),
});
export type RewriteInput = z.infer<typeof RewriteInputSchema>;

export const EmbedInputSchema = z.object({
  text: z.string().min(1),
  kind: z.enum(['doc', 'query']),
});
export type EmbedInput = z.infer<typeof EmbedInputSchema>;

export const EmbedOutputSchema = z.object({
  vector: z.array(z.number()),
  used_model: z.string(),
});
export type EmbedOutput = z.infer<typeof EmbedOutputSchema>;

export type AIProviderErrorCode =
  | 'refused'
  | 'parse_error'
  | 'rate_limit'
  | 'server_error'
  | 'auth_error'
  | 'budget_exceeded'
  | 'not_implemented'
  | 'unknown';

export class AIProviderError extends Error {
  public readonly code: AIProviderErrorCode;
  public override readonly cause?: unknown;

  constructor(message: string, code: AIProviderErrorCode, cause?: unknown) {
    super(message);
    this.name = 'AIProviderError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export interface AIProvider {
  readonly name: string;
  score(input: ScoreInput): Promise<ScoreOutput>;
  generateDraft(input: DraftInput): Promise<DraftOutput>;
  rewriteDraft(input: RewriteInput): Promise<DraftOutput | DraftOutput[]>;
  embed(input: EmbedInput): Promise<EmbedOutput>;
  /**
   * Optional force-refresh hook for providers with IAM-token caching. The
   * worker's `refresh_iam_token` handler invokes this when present; providers
   * without an IAM cache (e.g. TemplateProvider) leave it undefined and the
   * handler treats that as a no-op. Keeping the seam optional on the
   * interface — instead of `instanceof YandexAIStudioDeepSeekProvider` in
   * loop.ts — preserves "ai is an adapter" without leaking provider classes
   * into orchestration code.
   */
  iamRefresh?(): Promise<void>;
}
