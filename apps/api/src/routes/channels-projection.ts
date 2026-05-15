/**
 * Wire-format projection: DB row -> `ChannelProjection` / `ConnectCodeProjection`.
 *
 * The wire types themselves live in `@postdash/shared` (so the Mini App can
 * import the same schema without pulling in DB code); this module only owns
 * the row-to-DTO mapping used by `apps/api/src/routes/channels.ts`.
 *
 * snake_case field names on the wire mirror the established convention in
 * `auth-projection.ts` and the Postgres column names. ISO-8601 strings for
 * `Date` columns keep the response JSON-stable across timezones — Postgres
 * `timestamptz` is already in UTC, and `Date.toISOString()` is the canonical
 * lossless round-trip the Mini App can parse.
 *
 * Plaintext-code policy (architecture/channel-connection.md Invariant 1): the
 * plaintext code surfaces ONLY in the response to a fresh `POST
 * /channels/connect-codes`. `projectConnectCode` is the one place that emits
 * it. No other read path projects this DTO — by construction, code plaintext
 * never appears elsewhere.
 */

import type { ChannelConnection, ContentChannel } from '@postdash/domain';
import {
  ChannelProjectionSchema,
  ConnectCodeProjectionSchema,
  type ChannelProjection,
  type ConnectCodeProjection,
} from '@postdash/shared';

/**
 * Joined row shape that `projectChannel` consumes. Matches the columns the
 * `GET /channels` SELECT projects: `channel_connections` + `content_channels`.
 * Accepting a plain object keeps this function independent of Drizzle row
 * inference — the route layer can hand either a domain-shaped object (from a
 * command result) or a join row (from the list query) and the shape is the
 * same.
 */
export interface ChannelProjectionInput {
  connection: ChannelConnection;
  contentChannel: ContentChannel;
}

export function projectChannel(input: ChannelProjectionInput): ChannelProjection {
  const out: ChannelProjection = {
    id: input.connection.id,
    workspace_id: input.connection.workspaceId,
    content_channel_id: input.contentChannel.id,
    platform: 'telegram',
    external_id: input.contentChannel.externalId,
    title: input.contentChannel.title,
    username: input.contentChannel.username,
    photo_url: input.contentChannel.photoUrl,
    type: input.contentChannel.type,
    status: input.connection.status,
    can_post_messages: input.connection.canPostMessages,
    last_verify_status: input.connection.lastVerifyStatus,
    last_verify_error: input.connection.lastVerifyError,
    last_verified_at: input.connection.lastVerifiedAt
      ? input.connection.lastVerifiedAt.toISOString()
      : null,
    connected_at: input.connection.connectedAt
      ? input.connection.connectedAt.toISOString()
      : null,
  };
  // Parse-validate at the boundary: a missing/extra field caught here fails
  // the request loudly server-side rather than silently shipping a malformed
  // DTO the Mini App would reject at runtime. The validated value is returned
  // (Zod strips nothing here since the shape is exact) so the type narrows.
  return ChannelProjectionSchema.parse(out);
}

/**
 * Builds the `ConnectCodeProjection` from a fresh `createConnectCode` result
 * plus a deep-link builder. The builder is passed in (rather than calling
 * `buildConnectDeepLink` directly) so the route layer can inject a closure
 * over the runtime `TELEGRAM_BOT_USERNAME` env value and tests can substitute
 * a stable string. The plaintext code surfaces exactly once here; see file
 * header for the surrounding contract.
 */
export interface ConnectCodeProjectionInput {
  connectCodeId: string;
  code: string;
  expiresAt: Date;
}

export type DeepLinkBuilder = (code: string) => string;

export function projectConnectCode(
  input: ConnectCodeProjectionInput,
  buildDeepLink: DeepLinkBuilder,
): ConnectCodeProjection {
  const out: ConnectCodeProjection = {
    id: input.connectCodeId,
    code: input.code,
    deep_link: buildDeepLink(input.code),
    expires_at: input.expiresAt.toISOString(),
  };
  return ConnectCodeProjectionSchema.parse(out);
}
