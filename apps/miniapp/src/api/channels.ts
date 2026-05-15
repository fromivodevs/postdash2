/**
 * Channel-connection API client (Phase 2).
 *
 * Three endpoints back the four ChannelScreen views (not_connected / pending /
 * connected / broken):
 *   - `POST /channels/connect-codes` — issues a one-time code + deep-link.
 *   - `POST /channels/connect`       — redeems a code against a chat_id/@username.
 *   - `GET  /channels`               — reads the workspace's current binding.
 *
 * Domain errors on the channel routes carry a wire-level `code` discriminator
 * (`expired_code`, `reused_code`, `channel_taken`, `bot_not_admin`, ...). The
 * screen needs to dispatch on those codes to render the right inline banner
 * (architecture/channel-connection.md "Mini App: ChannelScreen.tsx"), so we
 * translate the generic `ApiError` thrown by `apiFetch` into a domain-shaped
 * `ChannelApiError { httpStatus, code? }` at this layer. Keeping the dispatch
 * here (not in the screen) means the screen never grafts onto raw HTTP shape,
 * and the dispatch is unit-testable without React.
 *
 * Idempotency: `POST /channels/connect` is mutating and must be safe to retry
 * on transient network failure. We generate a fresh UUID per call and forward
 * it as the `Idempotency-Key` header (architecture invariant 4 — code consumed
 * exactly once). `POST /channels/connect-codes` is also idempotent server-side
 * (one code per (workspace, user, minute)); we let the server derive the key
 * to keep the client simple — the architecture doc proposes
 * `cc:<workspace_id>:<user_id>:<unix_minute>` and that is owned by the route.
 */

import { ApiError, apiFetch } from './client.ts';
import type {
  ChannelListProjection,
  ChannelProjection,
  ConnectCodeProjection,
} from './types.ts';

/**
 * Wire-level error codes that the channel routes may attach to an error body.
 *
 * Mirrors the `details.code` taxonomy on the server side
 * (apps/api/src/routes/error-mapping.ts CHANNEL_DETAILS_TABLE). Listed as a
 * literal union so a typo in a screen-level switch is a compile error.
 */
export type ChannelApiErrorCode =
  | 'expired_code'
  | 'reused_code'
  | 'channel_taken'
  | 'bot_not_admin'
  | 'missing_post_permission'
  | 'chat_not_found'
  | 'bot_blocked'
  | 'unauthorized'
  // Generic CommandError codes that can also surface on channel routes.
  | 'validation_failed'
  | 'forbidden'
  | 'conflict'
  | 'not_found'
  | 'idempotency_replay_in_progress'
  | 'internal';

/**
 * Domain error surfaced to ChannelScreen. Carries the HTTP status (so the
 * caller can distinguish e.g. 410 expired vs 409 reused without inspecting
 * `code`) and the wire `code` when the server provided one.
 *
 * Subclasses `Error` so the React-Query `error` slot can hold it without a
 * wrapper, and exposes the original `ApiError` for tests that want to assert
 * the raw HTTP body.
 */
export class ChannelApiError extends Error {
  readonly httpStatus: number;
  readonly code: ChannelApiErrorCode | undefined;
  override readonly cause: ApiError;

  constructor(cause: ApiError) {
    super(cause.message);
    this.name = 'ChannelApiError';
    this.httpStatus = cause.status;
    // Narrow to the known channel codes — anything outside the union becomes
    // `undefined` so screen-level switches must always include a fallback.
    this.code = isChannelApiErrorCode(cause.code) ? cause.code : undefined;
    this.cause = cause;
  }
}

const KNOWN_CHANNEL_CODES: ReadonlySet<string> = new Set<ChannelApiErrorCode>([
  'expired_code',
  'reused_code',
  'channel_taken',
  'bot_not_admin',
  'missing_post_permission',
  'chat_not_found',
  'bot_blocked',
  'unauthorized',
  'validation_failed',
  'forbidden',
  'conflict',
  'not_found',
  'idempotency_replay_in_progress',
  'internal',
]);

function isChannelApiErrorCode(code: string | undefined): code is ChannelApiErrorCode {
  return code !== undefined && KNOWN_CHANNEL_CODES.has(code);
}

/**
 * Wraps an awaitable so any `ApiError` it throws is re-thrown as a
 * `ChannelApiError`. Non-`ApiError` failures (network / unexpected) propagate
 * untouched — the session-error path already handles those.
 */
async function mapChannelErrors<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ApiError) {
      throw new ChannelApiError(err);
    }
    throw err;
  }
}

/**
 * Generates a v4 UUID for the `Idempotency-Key` header. Uses
 * `crypto.randomUUID()` (available in modern browsers + the Vitest node
 * environment); falls back to a Math.random-based generator so the call never
 * throws in the rare runtime that lacks Web Crypto. The fallback is good
 * enough for an idempotency key (collision probability is astronomical at the
 * per-user request rate Phase 2 sees).
 */
export function generateIdempotencyKey(): string {
  const c: { randomUUID?: () => string } | undefined =
    typeof globalThis !== 'undefined' && 'crypto' in globalThis
      ? (globalThis.crypto as { randomUUID?: () => string })
      : undefined;
  if (c?.randomUUID) return c.randomUUID();
  // RFC4122 v4 fallback. Each `x` is replaced with a random nibble; `y` is
  // forced into the 0b10xx range per spec. Not cryptographically random but
  // good enough for an idempotency token (single-use, server-bound).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * POST /channels/connect-codes — issues a fresh connect code + deep-link.
 *
 * Body is empty: the workspace is inferred from the initData. The server is
 * responsible for the idempotency key (per-minute slot), so we do not send one
 * here — sending an Idempotency-Key from the client would override that and
 * risk replay-impossible failures (the architecture decision in
 * channel-connection.md says the plaintext code is never re-served on replay).
 */
export function postConnectCode(
  initData: string,
  signal?: AbortSignal,
): Promise<ConnectCodeProjection> {
  return mapChannelErrors(
    apiFetch<ConnectCodeProjection>('/channels/connect-codes', {
      method: 'POST',
      initData,
      json: {},
      ...(signal ? { signal } : {}),
    }),
  );
}

export interface PostConnectInput {
  /** Plaintext code issued by `postConnectCode` or pasted from the deep-link. */
  code: string;
  /** Telegram chat_id (negative int as string) OR `@username`. */
  external_chat_id: string;
  /**
   * Idempotency token. Optional — when omitted, a fresh UUID is generated so
   * the call is safe to retry on transient failure. Callers can pin a value
   * to make retries collapse onto the original POST.
   */
  idempotencyKey?: string;
}

/**
 * POST /channels/connect — redeems a connect code against a Telegram chat.
 *
 * Returns the freshly-created `ChannelProjection` on success. On a 4xx domain
 * error (expired code, channel taken, missing permission, ...) throws a
 * `ChannelApiError` whose `code` is the screen's dispatch discriminator.
 */
export function postConnect(
  initData: string,
  input: PostConnectInput,
  signal?: AbortSignal,
): Promise<ChannelProjection> {
  const idempotencyKey = input.idempotencyKey ?? generateIdempotencyKey();
  return mapChannelErrors(
    apiFetch<ChannelProjection>('/channels/connect', {
      method: 'POST',
      initData,
      json: { code: input.code, external_chat_id: input.external_chat_id },
      headers: { 'Idempotency-Key': idempotencyKey },
      ...(signal ? { signal } : {}),
    }),
  );
}

/**
 * GET /channels — lists the workspace's channel bindings (Phase 2 returns at
 * most one). The Mini App keys its state machine on the first item's `status`.
 */
export function getChannels(
  initData: string,
  signal?: AbortSignal,
): Promise<ChannelListProjection> {
  return mapChannelErrors(
    apiFetch<ChannelListProjection>('/channels', {
      method: 'GET',
      initData,
      ...(signal ? { signal } : {}),
    }),
  );
}
