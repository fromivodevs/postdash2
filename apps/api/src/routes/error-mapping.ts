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
