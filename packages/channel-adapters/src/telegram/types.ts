/**
 * Public types for the Telegram channel adapter.
 *
 * Discriminated by `ok`. On `ok:true` we carry everything the command layer
 * needs to upsert a `content_channels` row + write a `channel_connections`
 * row in one go. On `ok:false` we carry a small enum + free-form detail
 * string for logging (no secrets — no tokens, no user input echoed back).
 *
 * NOTE on `externalId` (Risk #2 in architecture/channel-connection.md):
 *   The CALLER passes `externalChatId` verbatim — could be `@username` or
 *   a numeric `-1001234567890`. Telegram's `getChat` accepts both and ALWAYS
 *   returns the canonical numeric `id`. The adapter therefore returns that
 *   canonical numeric id as `externalId` (stringified) — and THAT is what
 *   the command writes to `content_channels.external_id`. Storing the
 *   user-typed `@username` would defeat the platform-unique `(platform,
 *   external_id)` key the moment a channel renames its public username.
 */

export interface VerifyConnectionInput {
  /**
   * Whatever the user pasted: `@channel_username`, `channel_username`, or
   * a numeric `-1001234567890`. Passed through verbatim to Telegram.
   */
  externalChatId: string;
}

/** Maps 1:1 to `content_channels.type` CHECK constraint. */
export type ChannelType = 'channel' | 'supergroup' | 'group' | 'private_chat';

/** Stable, public enum surfaced to the command layer. */
export type VerifyConnectionErrorCode =
  | 'bot_not_admin'
  | 'missing_post_permission'
  | 'chat_not_found'
  | 'bot_blocked'
  | 'unauthorized'
  | 'network'
  | 'unknown';

export type VerifyConnectionResult =
  | {
      ok: true;
      /**
       * Canonical numeric chat_id from `getChat.result.id`, stringified.
       * E.g. '-1001234567890'. This is what gets persisted to
       * `content_channels.external_id`, NOT the user-typed @username.
       */
      externalId: string;
      title: string;
      username: string | null;
      /**
       * Phase 2: always `null`. Telegram's `chat.photo.small_file_id` is a
       * file_id, not a URL; resolving it requires a separate `getFile` call
       * + a CDN URL build step. Deferred to Phase 8 polish.
       */
      photoUrl: string | null;
      chatType: ChannelType;
      /** `true` by construction: ok-path implies post permission was checked. */
      canPostMessages: true;
    }
  | {
      ok: false;
      errorCode: VerifyConnectionErrorCode;
      /** Safe-to-log diagnostic. ASCII, no tokens, no PII. */
      detail: string;
    };
