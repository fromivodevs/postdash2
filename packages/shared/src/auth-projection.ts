/**
 * Wire-format contract for auth/identity reads — the single typed source of
 * truth shared by the API (apps/api/src/routes/projection.ts) and the Mini App
 * (apps/miniapp/src/api/types.ts).
 *
 * Previously this shape was hand-mirrored in both places, which is a drift
 * risk: a field added on the server but forgotten on the client (or vice
 * versa) would only surface at runtime. Defining it once here makes the
 * cross-module contract a compile-time guarantee.
 *
 * Keeps wire format separate from internal command/domain types so those can
 * change without breaking Mini App clients.
 *
 * `photoUrl` is deliberately omitted: it exists on `telegram_identities` and in
 * the command result, but the Mini App never renders it, and a Telegram CDN
 * photo URL is unnecessary PII to push over the wire. Excluding it here is a
 * PII-minimization decision — add it back only when a screen actually needs it.
 *
 * The idempotency `replayed` flag is also deliberately NOT projected: it is
 * internal command-layer state (was this a cache hit?), the client never reads
 * it, and exposing it would leak implementation detail into the public contract.
 */
export interface AuthProjection {
  user: {
    id: string;
    status: 'active' | 'disabled';
    last_active_workspace_id: string | null;
  };
  identity: {
    id: string;
    telegram_user_id: string; // bigint serialized as decimal string
    username: string | null;
    first_name: string | null;
    last_name: string | null;
    status: 'active' | 'blocked_bot' | 'revoked';
  };
  workspace: {
    id: string;
    name: string;
    status: 'active' | 'disabled';
  };
  role: 'owner' | 'admin' | 'editor' | 'viewer';
  /**
   * True only on the fresh execution that created the user. This is an
   * execute-only signal and is NOT part of the idempotent-replay contract: a
   * replay of the same idempotency key — and every GET /me read — reports
   * `is_new: false`, because by then the user already exists. Clients must
   * treat `is_new: true` as a best-effort "first login" hint visible on the
   * original call only, never as a value stable across a retried POST.
   */
  is_new: boolean;
}

/** Standard error envelope returned by the API on a non-2xx response. */
export interface ApiErrorBody {
  error: string;
  code?: string;
  message?: string;
}
