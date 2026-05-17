import { TelegramInitDataError, verifyInitData, type ParsedInitData } from '@postdash/shared';
import type { FastifyRequest } from 'fastify';

/**
 * Hard ceiling on the initData string length, checked before any parsing or
 * HMAC work. A genuine Telegram initData is well under 1 KB (user JSON + a
 * handful of short fields + a 64-char hash); 8 KB is a generous bound that
 * still cheaply rejects an attacker streaming a huge Authorization header to
 * burn CPU on URLSearchParams + HMAC before the request is refused.
 */
const MAX_INITDATA_LENGTH = 8 * 1024;

/**
 * Reads `Authorization: tma <initData>` per Telegram's recommended pattern.
 * Returns the verified ParsedInitData or null if the header is missing.
 * Throws TelegramInitDataError on invalid hash / expired / parse error /
 * oversized payload.
 */
export function extractInitData(
  req: FastifyRequest,
  botToken: string,
  maxAgeSec: number,
): ParsedInitData | null {
  const rawHeader = req.headers.authorization;
  if (rawHeader === undefined) return null;
  // A duplicate `Authorization` header arrives as `string[]`. There is no
  // legitimate reason for two auth headers on one request — it is a
  // misconfigured proxy or a header-smuggling attempt. Reject as an initData
  // error (routes map this to 401) instead of letting `.startsWith` throw a
  // TypeError that would surface as an uncaught 500.
  if (Array.isArray(rawHeader)) {
    throw new TelegramInitDataError(
      'missing_hash',
      'multiple Authorization headers are not allowed',
    );
  }
  const header = rawHeader;
  if (!header) return null;
  if (!header.startsWith('tma ')) {
    throw new TelegramInitDataError(
      'missing_hash',
      'Authorization header must use scheme "tma <initData>"',
    );
  }
  const initData = header.slice(4).trim();
  if (!initData) {
    throw new TelegramInitDataError('missing_hash', 'empty initData after "tma " prefix');
  }
  if (initData.length > MAX_INITDATA_LENGTH) {
    throw new TelegramInitDataError('parse_error', 'initData exceeds maximum allowed length');
  }
  return verifyInitData(initData, botToken, { maxAgeSec });
}

/**
 * Maps initData to a stable idempotency key for AuthenticateTelegram.
 *
 * The key is derived from the HMAC-verified `parsed.hash`. The hash is a
 * SHA-256 HMAC over the whole initData payload keyed by the bot token, so it
 * is unguessable without the bot token and unique per WebApp session. Earlier
 * fallbacks (`uid:<id>:<auth_date>`) were forgeable: an attacker who knew a
 * victim's Telegram id could reconstruct the key and replay a cached
 * AuthProjection out of `command_idempotency` without ever passing HMAC
 * verification. Keying on the verified hash closes that hole — by the time we
 * reach this function the hash has already been proven authentic.
 */
export function idempotencyKeyFromInitData(parsed: ParsedInitData): string {
  return `tma:${parsed.hash}`;
}
