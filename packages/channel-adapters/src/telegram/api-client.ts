/**
 * Minimal Bot API client.
 *
 * Single `fetch` boundary — tests stub one thing; verify-connection.ts
 * receives a `callBotApi` function via constructor injection.
 *
 * Returns a discriminated `{ ok:true, result } | { ok:false, errorCode, detail }`
 * shape that mirrors the adapter's public error taxonomy. Telegram's wire
 * shape (`{ ok, result | error_code + description }`) is normalized here so
 * callers never see Telegram-specific status codes.
 *
 * Invariant 7 (architecture/channel-connection.md): never throws on
 * Telegram-side errors — including 4xx, 5xx, timeouts, and JSON parse
 * failures. Programmer errors (empty botToken, invalid method) DO throw
 * `TelegramAdapterError`.
 */

import { TelegramAdapterError } from './errors.js';
import type { VerifyConnectionErrorCode } from './types.js';

export const DEFAULT_TIMEOUT_MS = 5000;

/** Wire shape Telegram's Bot API returns. */
interface TelegramApiOkEnvelope {
  ok: true;
  result: unknown;
}
interface TelegramApiErrEnvelope {
  ok: false;
  error_code?: number;
  description?: string;
  parameters?: { migrate_to_chat_id?: number; retry_after?: number };
}
type TelegramApiEnvelope = TelegramApiOkEnvelope | TelegramApiErrEnvelope;

export interface CallBotApiOptions {
  /** Injected for tests; defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Hard timeout via AbortController. Default 5000. */
  timeoutMs?: number;
  /** Override base URL (for tests / proxies). Default `https://api.telegram.org`. */
  baseUrl?: string;
}

export interface CallBotApiOk {
  ok: true;
  /** `result` field from the Telegram envelope, as `unknown` — caller validates shape. */
  result: unknown;
}
export interface CallBotApiFail {
  ok: false;
  errorCode: VerifyConnectionErrorCode;
  /** Safe-to-log; never includes the bot token. */
  detail: string;
}
export type CallBotApiResult = CallBotApiOk | CallBotApiFail;

/**
 * Maps a Telegram error envelope (HTTP status + `error_code` + description)
 * to our normalized adapter error code.
 *
 * Telegram returns the SAME HTTP status (200 OR matching 4xx) with `ok:false`
 * + `error_code`. We treat `error_code` as the primary signal and fall back
 * to HTTP status when JSON parsing fails.
 *
 * Reference: https://core.telegram.org/api/errors (Bot API mirrors the
 * core API codes for getChat / getChatMember in Phase 2's scope).
 */
function mapTelegramError(
  httpStatus: number,
  errorCode: number | undefined,
  description: string | undefined,
): { code: VerifyConnectionErrorCode; detail: string } {
  // 401: invalid bot token. Treat as `unauthorized` so the command layer can
  // surface a clear "bot token is bad" status. Programmer error in practice,
  // but we don't throw — caller decides.
  if (httpStatus === 401 || errorCode === 401) {
    return { code: 'unauthorized', detail: 'telegram: unauthorized' };
  }
  // 403: bot was blocked / kicked. For getChat this is rare; for
  // getChatMember on a private_chat it means the user blocked the bot.
  if (httpStatus === 403 || errorCode === 403) {
    return { code: 'bot_blocked', detail: 'telegram: forbidden' };
  }
  // 400: chat-shape errors. The most common in Phase 2 is "chat not found"
  // (bad @username, deleted chat, wrong sign on chat_id).
  if (httpStatus === 400 || errorCode === 400) {
    const desc = (description ?? '').toLowerCase();
    if (desc.includes('chat not found') || desc.includes('chat_id is empty')) {
      return { code: 'chat_not_found', detail: 'telegram: chat not found' };
    }
    if (desc.includes('user not found') || desc.includes('participant_id_invalid')) {
      // getChatMember with our botUserId returning "user not found" means the
      // bot has never joined this chat — treat as bot_not_admin for the
      // command layer (caller still needs to add the bot to the chat).
      return { code: 'bot_not_admin', detail: 'telegram: bot not in chat' };
    }
    return { code: 'chat_not_found', detail: 'telegram: 400 bad request' };
  }
  // 429: flood control. We don't have a retry budget here — surface as
  // network so the command layer can decide to retry the whole verify.
  if (httpStatus === 429 || errorCode === 429) {
    return { code: 'network', detail: 'telegram: rate limited' };
  }
  // 5xx: Telegram server-side. Treat as network — transient.
  if (httpStatus >= 500) {
    return { code: 'network', detail: `telegram: server ${String(httpStatus)}` };
  }
  return { code: 'unknown', detail: `telegram: ${String(httpStatus)}` };
}

/**
 * Calls a single Bot API method with the bot token in the URL path
 * (Telegram's standard auth shape — token leaks into URL but not into POST
 * bodies that might be logged by HTTP middlewares).
 *
 * NEVER throws on HTTP failures, timeouts, or JSON parse errors. The ONLY
 * thrown paths are programmer errors validated at the top of the function.
 */
export async function callBotApi(
  token: string,
  method: string,
  params: Record<string, unknown>,
  opts: CallBotApiOptions = {},
): Promise<CallBotApiResult> {
  // Programmer error: empty token / method. Throw — these aren't recoverable
  // at the command layer.
  if (typeof token !== 'string' || token.length === 0) {
    throw new TelegramAdapterError('callBotApi: empty bot token');
  }
  if (typeof method !== 'string' || method.length === 0) {
    throw new TelegramAdapterError('callBotApi: empty method');
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TelegramAdapterError('callBotApi: timeoutMs must be a positive finite number');
  }

  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TelegramAdapterError(
      'callBotApi: no fetch implementation available (pass `fetch` in opts or run on Node 18+)',
    );
  }

  const baseUrl = opts.baseUrl ?? 'https://api.telegram.org';
  const url = `${baseUrl}/bot${token}/${method}`;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    // Timeout (AbortError) and network errors collapse to `network`. We do
    // NOT echo the error message — it can leak the URL (and thus the bot
    // token) in some runtimes' stack traces.
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      errorCode: 'network',
      detail: isAbort ? 'timeout' : 'network error',
    };
  } finally {
    clearTimeout(timeoutHandle);
  }

  // Parse the JSON envelope. Telegram always returns JSON, even for 4xx,
  // but we defensively handle a non-JSON body (e.g., gateway HTML).
  let envelope: TelegramApiEnvelope | null = null;
  try {
    envelope = (await response.json()) as TelegramApiEnvelope;
  } catch {
    envelope = null;
  }

  if (envelope && envelope.ok === true) {
    return { ok: true, result: envelope.result };
  }

  const errCode = envelope && envelope.ok === false ? envelope.error_code : undefined;
  const desc = envelope && envelope.ok === false ? envelope.description : undefined;
  const mapped = mapTelegramError(response.status, errCode, desc);
  return { ok: false, errorCode: mapped.code, detail: mapped.detail };
}
