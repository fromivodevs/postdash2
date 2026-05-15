/**
 * CommandError -> HTTP boundary mapping.
 *
 * `CommandError.message` strings are written for server-side diagnostics:
 * they embed idempotency keys (`AuthenticateTelegram:tma:<hash>`), schema
 * field names (`firstName is required`), and internal state transitions
 * (`replay found user but no workspace`). None of that is safe to echo to a
 * Mini App client. This module is the single sanitization boundary used by
 * every route that surfaces a CommandError: it maps each code to an HTTP
 * status plus a short, generic, client-safe message. The original message is
 * kept for the caller to log server-side.
 */

import type { CommandError, CommandErrorCode } from '@postdash/commands';
import type { InitDataErrorCode, TelegramInitDataError } from '@postdash/shared';

export interface SanitizedCommandError {
  /** HTTP status code to send. */
  status: number;
  /** Generic, client-safe message. Never contains internal identifiers. */
  message: string;
}

const ERROR_TABLE: Record<CommandErrorCode, SanitizedCommandError> = {
  validation_failed: { status: 400, message: 'request could not be processed' },
  not_found: { status: 404, message: 'resource not found' },
  forbidden: { status: 403, message: 'access denied' },
  conflict: { status: 409, message: 'request conflicts with current state; retry' },
  idempotency_replay_in_progress: {
    status: 409,
    message: 'a previous request is still being processed; retry shortly',
  },
  // `internal` always returns a generic message anyway — included for
  // exhaustiveness so a new CommandErrorCode forces a decision here.
  internal: { status: 500, message: 'internal error' },
};

/**
 * Maps a CommandError to its sanitized HTTP representation. The returned
 * `message` is safe to send to the client; callers should still log
 * `err.message` (the raw, detail-bearing string) server-side.
 */
export function sanitizeCommandError(err: CommandError): SanitizedCommandError {
  return ERROR_TABLE[err.code] ?? ERROR_TABLE.internal;
}

/**
 * Phase 2 extension: per `details.code` overrides for `connectTelegramChannel`.
 *
 * The command layer attaches a wire-level discriminator on `CommandError.details.code`
 * (e.g. `'expired_code'`, `'channel_taken'`, `'bot_not_admin'`) — see architecture
 * doc Decision: "CommandError grows optional details". The route layer uses
 * this table to pick a non-default HTTP status for these specific codes:
 *   - `expired_code` -> 410 Gone (resource ceased to exist)
 *   - `reused_code` / `channel_taken` -> 409 Conflict
 *   - `bot_not_admin` / `missing_post_permission` / `chat_not_found` /
 *     `bot_blocked` / `unauthorized` -> 400 (user-fixable Telegram-side state)
 *
 * The message is intentionally generic; the wire `code` is the stable contract
 * the Mini App keys its copy on. `null` value means "use the default
 * `sanitizeCommandError` mapping" — used as the fallback when `details.code`
 * is absent or unrecognized.
 */
const CHANNEL_DETAILS_TABLE: Record<string, SanitizedCommandError | null> = {
  expired_code: { status: 410, message: 'connect code expired; create a new one' },
  reused_code: { status: 409, message: 'connect code already used' },
  channel_taken: {
    status: 409,
    message: 'channel is already connected to another workspace',
  },
  bot_not_admin: { status: 400, message: 'bot is not an admin in the channel' },
  missing_post_permission: {
    status: 400,
    message: 'bot lacks permission to post in the channel',
  },
  chat_not_found: { status: 400, message: 'channel not found' },
  bot_blocked: { status: 400, message: 'bot is blocked' },
  unauthorized: { status: 400, message: 'bot is unauthorized for the channel' },
};

/**
 * Sanitizes a CommandError that may carry a Phase 2 `details.code`. Falls back
 * to the default `sanitizeCommandError` mapping when `details.code` is absent
 * or not in the override table. Returns the (possibly extra) `detailsCode` so
 * the route can echo it on the wire as `{ code: <detailsCode> }`.
 */
export interface SanitizedChannelError extends SanitizedCommandError {
  /**
   * Wire-level discriminator the route MUST echo as the response body `code`.
   * Falls back to `err.code` (the CommandErrorCode) when no details.code is
   * attached — same shape Phase 1 routes already produce.
   */
  wireCode: string;
}

export function sanitizeChannelCommandError(err: CommandError): SanitizedChannelError {
  const detailsCode = err.details?.['code'];
  if (detailsCode && CHANNEL_DETAILS_TABLE[detailsCode]) {
    const override = CHANNEL_DETAILS_TABLE[detailsCode];
    if (override) {
      return { ...override, wireCode: detailsCode };
    }
  }
  const base = sanitizeCommandError(err);
  return { ...base, wireCode: detailsCode ?? err.code };
}

/**
 * TelegramInitDataError -> client-safe message mapping.
 *
 * `TelegramInitDataError.message` can carry diagnostic detail ("auth_date is
 * not a positive number", "user.id exceeds the safe integer range...") that is
 * useful in server logs but pointless — and mildly fingerprinting — to echo to
 * a client. The `code` is the stable contract the Mini App keys its error copy
 * on, so it passes through untouched; only the `message` is genericized.
 * Callers should still log `err.message` (the raw string) server-side.
 */
const INITDATA_MESSAGE_TABLE: Record<InitDataErrorCode, string> = {
  missing_hash: 'Telegram authentication data is missing or malformed',
  missing_user: 'Telegram authentication data is missing or malformed',
  missing_auth_date: 'Telegram authentication data is missing or malformed',
  parse_error: 'Telegram authentication data is missing or malformed',
  invalid_hash: 'Telegram authentication could not be verified',
  expired: 'Telegram authentication has expired; reopen the app',
  future_auth_date: 'Telegram authentication could not be verified',
};

/**
 * Maps a TelegramInitDataError to a generic, client-safe message. The returned
 * string never contains internal field names or value detail; the caller keeps
 * `err.code` for the response body and logs `err.message` server-side.
 */
export function sanitizeInitDataError(err: TelegramInitDataError): string {
  return INITDATA_MESSAGE_TABLE[err.code] ?? 'Telegram authentication failed';
}
