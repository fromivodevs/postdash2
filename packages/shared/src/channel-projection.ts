/**
 * Wire-format contract for channel-connection reads — the single typed source
 * of truth shared by the API (apps/api/src/routes/channels-projection.ts) and
 * the Mini App (apps/miniapp/src/api/types.ts).
 *
 * Defining the shape (and validating it with Zod) in one place removes the
 * drift risk that comes with hand-mirroring DTOs across server and client.
 * Field naming follows the existing snake_case wire style established by
 * `auth-projection.ts` and the `telegram-initdata` parser, which is also what
 * Postgres column names are already projected to.
 *
 * Layer note: this module belongs to `@postdash/shared`, the leaf utility
 * package. It MUST NOT import `@postdash/db` or `@postdash/commands` — Mini
 * App clients depend on these types, and pulling in the db/command layer
 * would either break the browser build or leak server-only code into it.
 *
 * Plaintext-code policy: `ConnectCodeProjection.code` is included only on the
 * fresh response to `POST /channels/connect-code`. Subsequent reads of a code
 * (if any are ever exposed) MUST NOT include the plaintext. The wire schema
 * still requires it because no read path other than the issuance response is
 * permitted to project it.
 */

import { z } from 'zod';

export const ConnectCodeProjectionSchema = z.object({
  id: z.string().uuid(),
  /** Plaintext code; shown once after creation. NEVER in subsequent reads. */
  code: z.string(),
  /** Full deep-link constructed by API: `https://t.me/<bot>?start=connect_<code>`. */
  deep_link: z.string().url(),
  /** ISO-8601 timestamp. */
  expires_at: z.string(),
});
export type ConnectCodeProjection = z.infer<typeof ConnectCodeProjectionSchema>;

export const ChannelProjectionSchema = z.object({
  id: z.string().uuid(), // channel_connections.id
  workspace_id: z.string().uuid(),
  content_channel_id: z.string().uuid(),
  platform: z.literal('telegram'),
  external_id: z.string(), // numeric chat_id as string
  title: z.string(),
  username: z.string().nullable(),
  photo_url: z.string().nullable(),
  type: z.enum(['channel', 'supergroup', 'group', 'private_chat']),
  status: z.enum(['pending', 'connected', 'broken', 'revoked']),
  can_post_messages: z.boolean().nullable(),
  last_verify_status: z
    .enum([
      'ok',
      'bot_not_admin',
      'missing_post_permission',
      'chat_not_found',
      'bot_blocked',
      'network',
      'unauthorized',
      'unknown',
    ])
    .nullable(),
  last_verify_error: z.string().nullable(),
  last_verified_at: z.string().nullable(), // ISO-8601 or null
  connected_at: z.string().nullable(),
});
export type ChannelProjection = z.infer<typeof ChannelProjectionSchema>;

export const ChannelListProjectionSchema = z.object({
  items: z.array(ChannelProjectionSchema),
});
export type ChannelListProjection = z.infer<typeof ChannelListProjectionSchema>;

/**
 * Builds the Telegram deep-link URL for a freshly created connect code.
 *
 * Used by the API projection layer when forming the `POST /channels/connect-code`
 * response and by the Mini App when rendering the "Open in Telegram" button.
 * Centralized here so server and client can never disagree on the format of
 * the deep-link (a mismatch would silently break the bot-side `/start
 * connect_<code>` handler).
 *
 * `botUsername` must be the canonical bot username WITHOUT the leading `@`
 * (e.g. `'postdash_bot'`). Callers are expected to strip `@` upstream — this
 * helper rejects the `@` form rather than silently normalizing it, so a
 * misconfigured caller fails loudly at boot rather than producing a broken
 * link at runtime.
 */
export function buildConnectDeepLink(botUsername: string, code: string): string {
  if (!botUsername || botUsername.startsWith('@')) {
    throw new Error('botUsername must not be empty or start with @');
  }
  if (!code) {
    throw new Error('code must not be empty');
  }
  return `https://t.me/${botUsername}?start=connect_${code}`;
}
