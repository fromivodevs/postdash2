import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Telegram WebApp initData verification per
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app.
 *
 * Used by `POST /auth/telegram` to authenticate Mini App requests without
 * trusting client-side data. Backend reconstructs the HMAC and compares.
 */

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
  allows_write_to_pm?: boolean;
}

export interface ParsedInitData {
  user: TelegramUser;
  auth_date: number;
  hash: string;
  query_id?: string;
  start_param?: string;
  chat_type?: string;
  chat_instance?: string;
  raw: string;
}

export type InitDataErrorCode =
  | 'missing_hash'
  | 'missing_user'
  | 'missing_auth_date'
  | 'invalid_hash'
  | 'expired'
  | 'future_auth_date'
  | 'parse_error';

export class TelegramInitDataError extends Error {
  public readonly code: InitDataErrorCode;

  constructor(code: InitDataErrorCode, message?: string) {
    super(message ?? `Telegram initData ${code}`);
    this.name = 'TelegramInitDataError';
    this.code = code;
  }
}

const DEFAULT_MAX_AGE_SEC = 86_400; // 24h per 12-EDGE-CASES.md §1.1
const DEFAULT_FUTURE_SKEW_SEC = 60; // clock-skew tolerance; reject anything further in the future

export interface VerifyOptions {
  /** Override "now" for tests (seconds since epoch). */
  nowSec?: number;
  /** Freshness window in seconds. Default 86400 (24h). */
  maxAgeSec?: number;
  /**
   * How far into the future auth_date is allowed (clock skew). Default 60s.
   * A leaked bot token could otherwise mint forged initData with auth_date set
   * far in the future and never expire — bound both sides.
   */
  futureSkewSec?: number;
}

/**
 * Parses initData URL-encoded string. Does not verify the HMAC — use
 * `verifyInitData` for that. Throws TelegramInitDataError on malformed input.
 */
export function parseInitData(initData: string): ParsedInitData {
  return parseInitDataParams(new URLSearchParams(initData), initData);
}

/**
 * Core parse over an already-constructed `URLSearchParams`. `verifyInitData`
 * builds the params once (for the HMAC data_check_string) and reuses them here,
 * so the initData string is never parsed twice on the verify path.
 */
function parseInitDataParams(params: URLSearchParams, raw: string): ParsedInitData {
  const hash = params.get('hash');
  if (!hash) throw new TelegramInitDataError('missing_hash');

  const userJson = params.get('user');
  if (!userJson) throw new TelegramInitDataError('missing_user');

  const authDateStr = params.get('auth_date');
  if (!authDateStr) throw new TelegramInitDataError('missing_auth_date');
  const authDate = Number(authDateStr);
  if (!Number.isFinite(authDate) || authDate <= 0) {
    throw new TelegramInitDataError('missing_auth_date', 'auth_date is not a positive number');
  }

  let user: TelegramUser;
  try {
    user = JSON.parse(userJson) as TelegramUser;
  } catch {
    throw new TelegramInitDataError('parse_error', 'user field is not valid JSON');
  }
  if (typeof user.id !== 'number' || typeof user.first_name !== 'string') {
    throw new TelegramInitDataError('parse_error', 'user.id or user.first_name missing');
  }
  // Telegram user IDs are 64-bit; JSON.parse decodes them as JS numbers, which
  // lose precision above 2^53. Today's IDs are well below that, but if Telegram
  // ever crosses the line we must fail loudly here rather than silently collide
  // two distinct users on the same truncated id downstream.
  if (!Number.isSafeInteger(user.id)) {
    throw new TelegramInitDataError(
      'parse_error',
      'user.id exceeds the safe integer range — cannot represent without precision loss',
    );
  }

  // photo_url comes straight from the Telegram user JSON and flows into the DB
  // (telegram_identities.photo_url). A non-https value — javascript:, data:, a
  // plain http:// URL — has no business being stored or later rendered, but a
  // bad photo_url is cosmetic and must not fail an otherwise valid auth. So we
  // silently drop it rather than throw: gentler than rejecting the whole login.
  if (typeof user.photo_url === 'string' && !user.photo_url.startsWith('https://')) {
    delete user.photo_url;
  }

  const result: ParsedInitData = {
    user,
    auth_date: authDate,
    hash,
    raw,
  };
  const queryId = params.get('query_id');
  if (queryId !== null) result.query_id = queryId;
  const startParam = params.get('start_param');
  if (startParam !== null) result.start_param = startParam;
  const chatType = params.get('chat_type');
  if (chatType !== null) result.chat_type = chatType;
  const chatInstance = params.get('chat_instance');
  if (chatInstance !== null) result.chat_instance = chatInstance;

  return result;
}

/**
 * Verifies HMAC + freshness. Returns parsed initData on success, throws
 * TelegramInitDataError on any failure.
 */
export function verifyInitData(
  initData: string,
  botToken: string,
  opts: VerifyOptions = {},
): ParsedInitData {
  if (!botToken) {
    throw new TelegramInitDataError('invalid_hash', 'bot token missing');
  }

  const params = new URLSearchParams(initData);
  const providedHash = params.get('hash');
  if (!providedHash) throw new TelegramInitDataError('missing_hash');

  // Build data_check_string per Telegram spec:
  //   key=value joined with \n, sorted alphabetically, excluding 'hash' itself.
  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  // secret_key = HMAC_SHA256("WebAppData", bot_token)
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();

  // computed = HMAC_SHA256(data_check_string, secret_key) hex
  const computedHex = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // Constant-time comparison to avoid timing attacks.
  let equal = false;
  try {
    const providedBuf = Buffer.from(providedHash, 'hex');
    const computedBuf = Buffer.from(computedHex, 'hex');
    if (providedBuf.length === computedBuf.length) {
      equal = timingSafeEqual(providedBuf, computedBuf);
    }
  } catch {
    equal = false;
  }
  if (!equal) throw new TelegramInitDataError('invalid_hash');

  // Reuse the `params` already built for the HMAC check — no second
  // `new URLSearchParams(initData)` parse on the verify path.
  const parsed = parseInitDataParams(params, initData);

  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const maxAgeSec = opts.maxAgeSec ?? DEFAULT_MAX_AGE_SEC;
  const futureSkewSec = opts.futureSkewSec ?? DEFAULT_FUTURE_SKEW_SEC;
  const age = nowSec - parsed.auth_date;
  if (age > maxAgeSec) {
    throw new TelegramInitDataError('expired');
  }
  if (-age > futureSkewSec) {
    throw new TelegramInitDataError('future_auth_date');
  }

  return parsed;
}

/**
 * Helper for tests: signs a synthetic initData string with the given bot token.
 * Mirrors the Telegram client behaviour for fixture-based test cases.
 */
export function signInitDataForTest(
  fields: Omit<Record<string, string>, 'hash'>,
  botToken: string,
): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    params.set(key, value);
  }
  params.set('hash', hash);
  return params.toString();
}
