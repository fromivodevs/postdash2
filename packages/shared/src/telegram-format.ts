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

export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;
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
