/**
 * Programmer-error taxonomy for the Telegram adapter.
 *
 * Invariant 7 (architecture/channel-connection.md):
 *   The adapter NEVER throws on Telegram-side failures (4xx / 5xx /
 *   network timeouts). Those are returned as
 *   `{ ok:false, errorCode: '...' }`.
 *
 * Throwing is reserved for programmer / configuration errors that the
 * caller can only fix by changing code or boot configuration:
 *   - empty/missing botToken
 *   - non-positive botUserId
 *   - non-positive timeoutMs
 *
 * Caller MUST NOT catch these and turn them into user-facing 4xx; let
 * them bubble to the process supervisor.
 */

export class TelegramAdapterError extends Error {
  override readonly name = 'TelegramAdapterError';

  constructor(message: string) {
    super(message);
  }
}
