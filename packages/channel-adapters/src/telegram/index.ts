/**
 * Public entry point: `createTelegramChannelAdapter`.
 *
 * Decision (architecture/channel-connection.md): `botUserId` is resolved
 * once at app startup via `bot.api.getMe()` and passed in here. Token
 * rotation requires a restart — acceptable for MVP.
 *
 * The factory wires `callBotApi` (HTTP boundary) into `verifyConnection`
 * (pure logic) and exposes only the `TelegramChannelAdapter` interface.
 * `verifyConnection`'s signature on the adapter is intentionally narrow
 * (`(input) => Promise<VerifyConnectionResult>`) so that the command
 * layer can replace it with a stub in tests without dragging in HTTP.
 */

import { TelegramAdapterError } from './errors.js';
import { callBotApi, DEFAULT_TIMEOUT_MS } from './api-client.js';
import { verifyConnection } from './verify-connection.js';
import type { VerifyConnectionInput, VerifyConnectionResult } from './types.js';

export interface TelegramChannelAdapter {
  verifyConnection(input: VerifyConnectionInput): Promise<VerifyConnectionResult>;
}

export interface CreateTelegramChannelAdapterDeps {
  botToken: string;
  /** Resolved at startup via `bot.api.getMe()`. Must be a positive integer. */
  botUserId: number;
  /** Injected for tests; defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Hard timeout for each Bot API call. Default 5000ms. */
  timeoutMs?: number;
  /** Override base URL (for tests / proxies). Default `https://api.telegram.org`. */
  baseUrl?: string;
}

export function createTelegramChannelAdapter(
  deps: CreateTelegramChannelAdapterDeps,
): TelegramChannelAdapter {
  // Programmer-error validation — fail fast so the bug surfaces at
  // startup, not on the first incoming request.
  if (typeof deps.botToken !== 'string' || deps.botToken.length === 0) {
    throw new TelegramAdapterError('createTelegramChannelAdapter: botToken is required');
  }
  if (
    typeof deps.botUserId !== 'number' ||
    !Number.isFinite(deps.botUserId) ||
    !Number.isInteger(deps.botUserId) ||
    deps.botUserId <= 0
  ) {
    throw new TelegramAdapterError(
      'createTelegramChannelAdapter: botUserId must be a positive integer',
    );
  }
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TelegramAdapterError(
      'createTelegramChannelAdapter: timeoutMs must be a positive finite number',
    );
  }

  // Bind the HTTP boundary into a thin function the verify-connection
  // pure module can call. Tests of `verifyConnection` mock this directly;
  // tests of `callBotApi` mock `fetch`.
  const call = (method: string, params: Record<string, unknown>) =>
    callBotApi(deps.botToken, method, params, {
      // Only forward `fetch` when it's defined — `exactOptionalPropertyTypes`
      // disallows passing `undefined` to a `fetch?: typeof globalThis.fetch`
      // property. (Same for `baseUrl`.)
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
      ...(deps.baseUrl === undefined ? {} : { baseUrl: deps.baseUrl }),
      timeoutMs,
    });

  return {
    verifyConnection(input: VerifyConnectionInput): Promise<VerifyConnectionResult> {
      return verifyConnection({ callBotApi: call, botUserId: deps.botUserId }, input);
    },
  };
}

export { TelegramAdapterError } from './errors.js';
export type {
  VerifyConnectionInput,
  VerifyConnectionResult,
  VerifyConnectionErrorCode,
  ChannelType,
} from './types.js';
