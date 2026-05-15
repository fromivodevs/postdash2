/**
 * Telegram message-format utilities.
 *
 * Shared between backend (publish) и Mini App (preview). Это важно:
 * preview-render должен совпадать с тем, что фактически отправит Telegram —
 * иначе пост в редакторе выглядит корректно, а в канале — со сломанными entities.
 *
 * См. tg_mvp_plan/13-MINIAPP-DESIGN-SYSTEM.md §4 (preview-render rule).
 *
 * Phase 0: только тип ParseMode + минимальный length-validator.
 * Полная MarkdownV2 / HTML валидация — Phase 6.
 */

export type ParseMode = 'MarkdownV2' | 'HTML' | 'Plain';

// Telegram channel message limit — see Telegram Bot API docs.
// Channel-specific limit; do NOT use as a generic AI output cap.
// Per-channel length validation belongs to channel-adapters (Phase 2+).
// `packages/ai/src/provider.ts` keeps DraftOutputSchema.post_text channel-
// agnostic; only the concrete TemplateProvider (MVP, Telegram-only) imports
// this constant directly for its early truncation, until channel-adapters
// take ownership in Phase 2.
export const TELEGRAM_POST_MAX_LENGTH = 4096;

/**
 * Validates draft post_text against Telegram's 4096-char channel message limit.
 * Telegram-specific — DO NOT call from generic AI/domain code.
 * Returns true if the text fits; false if it exceeds the cap.
 */
export function fitsTelegramPostLimit(postText: string): boolean {
  return postText.length <= TELEGRAM_POST_MAX_LENGTH;
}

export const TELEGRAM_MAX_MESSAGE_CHARS = TELEGRAM_POST_MAX_LENGTH;
export const TELEGRAM_MAX_CAPTION_CHARS = 1024;

export interface LengthCheckResult {
  ok: boolean;
  length: number;
  limit: number;
  overflow: number;
}

export function checkMessageLength(
  text: string,
  limit: number = TELEGRAM_MAX_MESSAGE_CHARS,
): LengthCheckResult {
  const length = [...text].length; // считаем символы Unicode, не байты
  return {
    ok: length <= limit,
    length,
    limit,
    overflow: Math.max(0, length - limit),
  };
}
