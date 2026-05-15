/**
 * Pure domain types for channel connection (Phase 2).
 *
 * No I/O, no SDK imports. DB row types live in @postdash/db; these are the
 * shapes domain logic + API projections work with.
 *
 * See architecture/channel-connection.md (Interface contracts).
 */

/**
 * Discriminator for the per-platform channel adapter. Phase 2 only supports
 * `'telegram'`; future platforms (`'vk'`, `'discord'`) extend this union AND
 * the `content_channels.platform` CHECK constraint via a new migration.
 */
export type ChannelPlatform = 'telegram';

/**
 * Mirrors Telegram's `chat.type` taxonomy verbatim — kept generic so future
 * platforms can either reuse the same labels or extend the union.
 *
 * Note: `'private_chat'` here means Telegram's literal `private_chat` type
 * (1:1 bot DM), which is NOT a publishable target. The Phase 2 connect flow
 * rejects it with `missing_post_permission`. "Private channel" in the UX
 * sense (a `'channel'` with no `@username`) is a different concept handled
 * by `ContentChannel.username` being `null`.
 */
export type ChannelType = 'channel' | 'supergroup' | 'group' | 'private_chat';

export interface ContentChannel {
  id: string;
  platform: ChannelPlatform;
  externalId: string;
  type: ChannelType;
  title: string;
  username: string | null;
  photoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Lifecycle of a single workspace→channel binding.
 *
 * - `pending`   — code created/redeemed but adapter not yet verified.
 * - `connected` — adapter returned ok=true; can_post_messages=true.
 * - `broken`    — was connected but most recent verify failed (Phase 8+).
 * - `revoked`   — owner explicitly disconnected (Phase 9+). Phase 2 commands
 *                 NEVER write this state; reserved.
 */
export type ChannelConnectionStatus = 'pending' | 'connected' | 'broken' | 'revoked';

/**
 * Result-code taxonomy for the most recent `verifyConnection` call. Mirrors
 * the `last_verify_status` CHECK constraint exactly — add a new value here
 * AND in a fresh ALTER TABLE migration (see architecture doc "How to extend").
 */
export type ChannelVerifyStatus =
  | 'ok'
  | 'bot_not_admin'
  | 'missing_post_permission'
  | 'chat_not_found'
  | 'bot_blocked'
  | 'network'
  | 'unauthorized'
  | 'unknown';

export interface ChannelConnection {
  id: string;
  workspaceId: string;
  contentChannelId: string;
  status: ChannelConnectionStatus;
  canPostMessages: boolean | null;
  lastVerifyStatus: ChannelVerifyStatus | null;
  lastVerifyError: string | null;
  lastVerifiedAt: Date | null;
  connectedAt: Date | null;
  connectedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One-time bearer-token state for a connect handshake.
 *
 * - `active`   — created, TTL not yet hit.
 * - `consumed` — redeemed successfully by `ConnectTelegramChannelCommand`.
 * - `expired`  — TTL passed. Either the janitor flipped it (Phase 8) or the
 *                connect path observed `now() > expires_at` and forced-flipped
 *                it before throwing.
 */
export type ChannelConnectCodeStatus = 'active' | 'consumed' | 'expired';

export interface ChannelConnectCode {
  id: string;
  workspaceId: string;
  createdByUserId: string;
  /**
   * Always 30 minutes after `createdAt` for codes minted by
   * `CreateConnectCodeCommand`. Exposed as a field rather than computed so a
   * future per-workspace TTL override doesn't break the domain shape.
   */
  expiresAt: Date;
  status: ChannelConnectCodeStatus;
  consumedAt: Date | null;
  consumedByTelegramUserId: bigint | null;
  consumedByExternalChatId: string | null;
  createdAt: Date;
  // Note: plaintext `code` is intentionally NOT part of this type. The
  // plaintext exists only at the API boundary (the response of POST
  // /channels/connect-codes) and in the deep-link URL; it is never reloaded
  // from the DB because only sha256(code) is persisted. See architecture doc
  // Invariant 1.
}

// =============================================================================
// Narrowers: bare `text` columns -> domain union types.
//
// The DB stores `content_channels.type`, `channel_connections.status`, and
// `channel_connections.last_verify_status` as bare `text` with a CHECK
// constraint. Drizzle returns them as `string`; consumers need the domain
// union. These helpers live here (in @postdash/domain) so command code and
// route code share ONE definition — drift between two copies would be a real
// risk (we hit it once; the helpers were duplicated in commands + routes).
// =============================================================================

export function narrowChannelType(s: string): ChannelType {
  if (s === 'supergroup') return 'supergroup';
  if (s === 'group') return 'group';
  if (s === 'private_chat') return 'private_chat';
  return 'channel';
}

export function narrowConnectionStatus(s: string): ChannelConnectionStatus {
  if (s === 'connected') return 'connected';
  if (s === 'broken') return 'broken';
  if (s === 'revoked') return 'revoked';
  return 'pending';
}

export function narrowVerifyStatus(s: string): ChannelVerifyStatus {
  switch (s) {
    case 'ok':
    case 'bot_not_admin':
    case 'missing_post_permission':
    case 'chat_not_found':
    case 'bot_blocked':
    case 'network':
    case 'unauthorized':
      return s;
    default:
      return 'unknown';
  }
}
