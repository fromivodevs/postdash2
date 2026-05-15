/**
 * `verifyConnection`: getChat → getChatMember → map.
 *
 * Pure function over an injected `callBotApi` — no globals, no DB, no
 * side effects beyond the two HTTP calls. The adapter's invariants live
 * here:
 *
 *   - Invariant 3 (architecture/channel-connection.md): no imports from
 *     `@postdash/db`, `@postdash/commands`, `@postdash/domain`. This file
 *     only imports its sibling modules.
 *   - Invariant 7: never throws on Telegram-side errors — including
 *     malformed JSON shapes from getChat / getChatMember. Programmer
 *     errors (empty botToken) are thrown by `callBotApi` itself.
 *   - Risk #2: the user may pass either `@username` or numeric chat_id;
 *     we ALWAYS return the canonical numeric id from getChat as
 *     `externalId: String(result.id)` so the caller persists the
 *     platform-stable identity, not the user-typed alias.
 *
 * Telegram's `chat.type` enum: `'private' | 'group' | 'supergroup' | 'channel'`.
 * We map `'private'` → our `'private_chat'` (the rest match 1:1) and reject
 * private chats with `missing_post_permission` — they aren't a publishable
 * target.
 */

import type {
  ChannelType,
  VerifyConnectionErrorCode,
  VerifyConnectionInput,
  VerifyConnectionResult,
} from './types.js';
import type { CallBotApiResult } from './api-client.js';

/** The slice of `callBotApi` we need — keeps tests trivial to stub. */
export type CallBotApiFn = (
  method: string,
  params: Record<string, unknown>,
) => Promise<CallBotApiResult>;

export interface VerifyConnectionDeps {
  callBotApi: CallBotApiFn;
  botUserId: number;
}

/** Telegram's raw `Chat` shape — only the fields we read. */
interface RawChat {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  username?: unknown;
  first_name?: unknown;
  last_name?: unknown;
}

/** Telegram's raw `ChatMember` shape — only the fields we read. */
interface RawChatMember {
  status?: unknown;
  can_post_messages?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Map Telegram's `chat.type` to our `ChannelType`. Returns `null`
 * if the value is unrecognized — caller treats as `unknown`.
 */
function mapChatType(rawType: unknown): ChannelType | null {
  if (rawType === 'channel') return 'channel';
  if (rawType === 'supergroup') return 'supergroup';
  if (rawType === 'group') return 'group';
  if (rawType === 'private') return 'private_chat';
  return null;
}

function fail(errorCode: VerifyConnectionErrorCode, detail: string): VerifyConnectionResult {
  return { ok: false, errorCode, detail };
}

/**
 * Verify that the bot can post to `externalChatId`.
 *
 * Sequence:
 *  1. `getChat(chat_id)` — resolves the chat, gets canonical numeric id,
 *     title, username, type. 4xx → mapped error code.
 *  2. Reject `private_chat` early with `missing_post_permission` (not a
 *     publishable target by design — see Phase 2 docs).
 *  3. `getChatMember(chat_id, user_id=botUserId)` — checks admin status
 *     and posting permission.
 *  4. Permissions check:
 *      - `status === 'creator'`: always allowed (creator implies all rights).
 *      - `status === 'administrator'`:
 *          - `chatType === 'channel'`: REQUIRE `can_post_messages === true`.
 *          - `chatType === 'supergroup' | 'group'`: bot can send by default;
 *            only reject when `can_post_messages === false`.
 *      - any other status → `bot_not_admin`.
 *  5. Return `{ ok: true, externalId: String(result.id), ... }`.
 */
export async function verifyConnection(
  deps: VerifyConnectionDeps,
  input: VerifyConnectionInput,
): Promise<VerifyConnectionResult> {
  const chatRef = input.externalChatId;

  // 1. getChat.
  const getChatResp = await deps.callBotApi('getChat', { chat_id: chatRef });
  if (!getChatResp.ok) {
    return fail(getChatResp.errorCode, `getChat: ${getChatResp.detail}`);
  }
  if (!isObject(getChatResp.result)) {
    return fail('unknown', 'getChat: malformed result');
  }
  const chat = getChatResp.result as RawChat;

  // Canonical numeric chat_id. Telegram returns this as a `number`
  // (JS-safe range for current chat_ids) but we coerce defensively.
  const rawId = chat.id;
  let canonicalId: string | null = null;
  if (typeof rawId === 'number' && Number.isFinite(rawId)) {
    canonicalId = String(rawId);
  } else if (typeof rawId === 'string' && rawId.length > 0) {
    canonicalId = rawId;
  } else if (typeof rawId === 'bigint') {
    canonicalId = rawId.toString();
  }
  if (canonicalId === null) {
    return fail('unknown', 'getChat: missing chat.id');
  }

  const chatType = mapChatType(chat.type);
  if (chatType === null) {
    return fail('unknown', `getChat: unknown chat.type ${String(chat.type)}`);
  }

  // 2. private_chat is not publishable.
  if (chatType === 'private_chat') {
    return fail('missing_post_permission', 'private_chat is not a publishable target');
  }

  // Compose title. `getChat` on a channel/group returns `title`; on a
  // private_chat it returns `first_name`/`last_name`. We've already
  // bailed on private_chat above, so prefer `title`. Fall back to a
  // composed name for robustness.
  let title = asString(chat.title);
  if (title === null) {
    const fn = asString(chat.first_name);
    const ln = asString(chat.last_name);
    if (fn !== null && ln !== null) {
      title = `${fn} ${ln}`;
    } else if (fn !== null) {
      title = fn;
    } else if (ln !== null) {
      title = ln;
    }
  }
  if (title === null) {
    return fail('unknown', 'getChat: missing title');
  }

  const username = asString(chat.username);

  // 3. getChatMember(bot).
  const getMemberResp = await deps.callBotApi('getChatMember', {
    chat_id: chatRef,
    user_id: deps.botUserId,
  });
  if (!getMemberResp.ok) {
    return fail(getMemberResp.errorCode, `getChatMember: ${getMemberResp.detail}`);
  }
  if (!isObject(getMemberResp.result)) {
    return fail('unknown', 'getChatMember: malformed result');
  }
  const member = getMemberResp.result as RawChatMember;

  const status = member.status;
  if (status !== 'administrator' && status !== 'creator') {
    return fail('bot_not_admin', `bot status=${String(status)}`);
  }

  // 4. Permissions check (creator always allowed; administrator depends
  // on can_post_messages for channels).
  if (status === 'administrator') {
    if (chatType === 'channel') {
      if (member.can_post_messages !== true) {
        return fail('missing_post_permission', 'channel: can_post_messages not granted');
      }
    } else {
      // supergroup/group: only reject when explicitly false.
      if (member.can_post_messages === false) {
        return fail('missing_post_permission', 'group: can_post_messages=false');
      }
    }
  }

  return {
    ok: true,
    externalId: canonicalId,
    title,
    username,
    photoUrl: null,
    chatType,
    canPostMessages: true,
  };
}
