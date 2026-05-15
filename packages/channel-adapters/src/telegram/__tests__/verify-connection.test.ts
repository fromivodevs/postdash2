/**
 * Tests for `verifyConnection` — pure logic, no HTTP.
 *
 * Covers architecture/channel-connection.md test plan §11-15 plus
 * private_chat → missing_post_permission and Risk #2 (`externalId`
 * numeric returned even when input is `@username`).
 *
 * All tests stub the injected `callBotApi` — they don't touch fetch.
 */

import { describe, expect, it, vi } from 'vitest';
import { verifyConnection } from '../verify-connection.js';
import type { CallBotApiFn } from '../verify-connection.js';
import type { CallBotApiResult } from '../api-client.js';

const BOT_USER_ID = 999;

/**
 * Build a scripted `callBotApi` that returns `getChatResult` for the first
 * call (getChat) and `getMemberResult` for the second (getChatMember).
 * Tests that only need getChat can omit the second argument.
 */
function scriptedCall(
  getChatResult: CallBotApiResult,
  getMemberResult?: CallBotApiResult,
): { call: CallBotApiFn; calls: { method: string; params: Record<string, unknown> }[] } {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const call: CallBotApiFn = vi.fn(async (method, params) => {
    calls.push({ method, params });
    if (method === 'getChat') return getChatResult;
    if (method === 'getChatMember') {
      if (!getMemberResult) {
        throw new Error('test setup: getChatMember called but no result scripted');
      }
      return getMemberResult;
    }
    throw new Error(`test setup: unexpected method ${method}`);
  });
  return { call, calls };
}

describe('verifyConnection — test plan #11 (getChat 400 → chat_not_found)', () => {
  it('returns { ok:false, errorCode:chat_not_found } when getChat reports 400', async () => {
    const { call } = scriptedCall({
      ok: false,
      errorCode: 'chat_not_found',
      detail: 'telegram: chat not found',
    });
    const out = await verifyConnection(
      { callBotApi: call, botUserId: BOT_USER_ID },
      { externalChatId: '@nope' },
    );
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.errorCode).toBe('chat_not_found');
      expect(out.detail).toContain('getChat');
    }
  });
});

describe('verifyConnection — test plan #12 (getChatMember member → bot_not_admin)', () => {
  it('returns bot_not_admin when bot is a plain member', async () => {
    const { call } = scriptedCall(
      { ok: true, result: { id: -1001, type: 'channel', title: 'Test' } },
      { ok: true, result: { status: 'member' } },
    );
    const out = await verifyConnection(
      { callBotApi: call, botUserId: BOT_USER_ID },
      { externalChatId: '-1001' },
    );
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.errorCode).toBe('bot_not_admin');
    }
  });

  it('returns bot_not_admin when bot is "left"', async () => {
    const { call } = scriptedCall(
      { ok: true, result: { id: -1001, type: 'channel', title: 'Test' } },
      { ok: true, result: { status: 'left' } },
    );
    const out = await verifyConnection(
      { callBotApi: call, botUserId: BOT_USER_ID },
      { externalChatId: '-1001' },
    );
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.errorCode).toBe('bot_not_admin');
    }
  });
});

describe('verifyConnection — test plan #13 (channel + can_post_messages=false → missing_post_permission)', () => {
  it('rejects a channel where admin lacks can_post_messages', async () => {
    const { call } = scriptedCall(
      { ok: true, result: { id: -1001, type: 'channel', title: 'NoPost' } },
      { ok: true, result: { status: 'administrator', can_post_messages: false } },
    );
    const out = await verifyConnection(
      { callBotApi: call, botUserId: BOT_USER_ID },
      { externalChatId: '-1001' },
    );
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.errorCode).toBe('missing_post_permission');
    }
  });

  it('rejects a channel where admin status has can_post_messages undefined', async () => {
    // For channels we REQUIRE the flag to be explicitly true.
    const { call } = scriptedCall(
      { ok: true, result: { id: -1001, type: 'channel', title: 'X' } },
      { ok: true, result: { status: 'administrator' } },
    );
    const out = await verifyConnection(
      { callBotApi: call, botUserId: BOT_USER_ID },
      { externalChatId: '-1001' },
    );
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.errorCode).toBe('missing_post_permission');
    }
  });
});

describe('verifyConnection — test plan #14 (supergroup + admin + can_post_messages undefined → ok)', () => {
  it('accepts a supergroup where bot is admin and can_post_messages is undefined', async () => {
    const { call } = scriptedCall(
      { ok: true, result: { id: -100777, type: 'supergroup', title: 'SG', username: 'sg_alias' } },
      { ok: true, result: { status: 'administrator' } },
    );
    const out = await verifyConnection(
      { callBotApi: call, botUserId: BOT_USER_ID },
      { externalChatId: '-100777' },
    );
    expect(out.ok).toBe(true);
    if (out.ok === true) {
      expect(out.chatType).toBe('supergroup');
      expect(out.externalId).toBe('-100777');
      expect(out.username).toBe('sg_alias');
      expect(out.canPostMessages).toBe(true);
    }
  });

  it('accepts a group where bot is admin', async () => {
    const { call } = scriptedCall(
      { ok: true, result: { id: -123, type: 'group', title: 'G' } },
      { ok: true, result: { status: 'administrator' } },
    );
    const out = await verifyConnection(
      { callBotApi: call, botUserId: BOT_USER_ID },
      { externalChatId: '-123' },
    );
    expect(out.ok).toBe(true);
    if (out.ok === true) {
      expect(out.chatType).toBe('group');
    }
  });

  it('rejects a supergroup where can_post_messages is explicitly false', async () => {
    const { call } = scriptedCall(
      { ok: true, result: { id: -100777, type: 'supergroup', title: 'SG' } },
      { ok: true, result: { status: 'administrator', can_post_messages: false } },
    );
    const out = await verifyConnection(
      { callBotApi: call, botUserId: BOT_USER_ID },
      { externalChatId: '-100777' },
    );
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.errorCode).toBe('missing_post_permission');
    }
  });
});

describe('verifyConnection — test plan #15 (fetch timeout → network errorCode, no throw)', () => {
  it('returns errorCode:network when callBotApi reports a timeout, no exception', async () => {
    const { call } = scriptedCall({ ok: false, errorCode: 'network', detail: 'timeout' });
    // No throw — and the verify wrapper preserves the network errorCode.
    const out = await verifyConnection(
      { callBotApi: call, botUserId: BOT_USER_ID },
      { externalChatId: '@x' },
    );
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.errorCode).toBe('network');
      expect(out.detail).toContain('timeout');
    }
  });

  it('also surfaces network on getChatMember timeout (second hop)', async () => {
    const { call } = scriptedCall(
      { ok: true, result: { id: -1001, type: 'channel', title: 'X' } },
      { ok: false, errorCode: 'network', detail: 'timeout' },
    );
    const out = await verifyConnection(
      { callBotApi: call, botUserId: BOT_USER_ID },
      { externalChatId: '-1001' },
    );
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.errorCode).toBe('network');
    }
  });
});

describe('verifyConnection — private_chat → missing_post_permission', () => {
  it('rejects a Telegram private chat (mapped from type=private)', async () => {
    // Telegram's enum value is `'private'`; we map it to our `'private_chat'`
    // and reject it before even calling getChatMember.
    const { call, calls } = scriptedCall({
      ok: true,
      result: { id: 42, type: 'private', first_name: 'Adrian' },
    });
    const out = await verifyConnection(
      { callBotApi: call, botUserId: BOT_USER_ID },
      { externalChatId: '42' },
    );
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.errorCode).toBe('missing_post_permission');
      expect(out.detail).toContain('private_chat');
    }
    // Confirm we short-circuited before getChatMember.
    expect(calls.map((c) => c.method)).toEqual(['getChat']);
  });
});

describe('verifyConnection — Risk #2: externalId is canonical numeric even for @username input', () => {
  it('returns String(getChat.result.id), not the user-typed @username', async () => {
    const { call } = scriptedCall(
      {
        ok: true,
        result: { id: -1001234567890, type: 'channel', title: 'My Channel', username: 'mychannel' },
      },
      { ok: true, result: { status: 'administrator', can_post_messages: true } },
    );
    const out = await verifyConnection(
      { callBotApi: call, botUserId: BOT_USER_ID },
      { externalChatId: '@mychannel' },
    );
    expect(out.ok).toBe(true);
    if (out.ok === true) {
      // Canonical numeric id — NOT '@mychannel'.
      expect(out.externalId).toBe('-1001234567890');
      expect(typeof out.externalId).toBe('string');
      expect(out.username).toBe('mychannel');
      expect(out.title).toBe('My Channel');
      expect(out.chatType).toBe('channel');
    }
  });

  it('handles bigint id from JSON parsers that preserve large ints', async () => {
    // Defensive: some JSON parsers (`json-bigint`) return BigInt for large
    // numbers. Our adapter doesn't use such a parser today, but the logic
    // is shaped to survive one if introduced later.
    const { call } = scriptedCall(
      {
        ok: true,
        result: { id: BigInt('-1001234567890'), type: 'channel', title: 'BigInt Chan' },
      },
      { ok: true, result: { status: 'administrator', can_post_messages: true } },
    );
    const out = await verifyConnection(
      { callBotApi: call, botUserId: BOT_USER_ID },
      { externalChatId: '-1001234567890' },
    );
    expect(out.ok).toBe(true);
    if (out.ok === true) {
      expect(out.externalId).toBe('-1001234567890');
    }
  });
});

describe('verifyConnection — creator status is allowed', () => {
  it('treats creator as authorized to post in channels', async () => {
    const { call } = scriptedCall(
      { ok: true, result: { id: -1001, type: 'channel', title: 'Owned' } },
      // Creator implies all rights — we don't require can_post_messages.
      { ok: true, result: { status: 'creator' } },
    );
    const out = await verifyConnection(
      { callBotApi: call, botUserId: BOT_USER_ID },
      { externalChatId: '-1001' },
    );
    expect(out.ok).toBe(true);
    if (out.ok === true) {
      expect(out.canPostMessages).toBe(true);
    }
  });
});

describe('verifyConnection — defensive: malformed responses', () => {
  it('returns errorCode:unknown when getChat result is not an object', async () => {
    const { call } = scriptedCall({ ok: true, result: 'definitely not a chat' });
    const out = await verifyConnection(
      { callBotApi: call, botUserId: BOT_USER_ID },
      { externalChatId: '@x' },
    );
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.errorCode).toBe('unknown');
    }
  });

  it('returns errorCode:unknown when chat.type is an unrecognized string', async () => {
    const { call } = scriptedCall({
      ok: true,
      result: { id: -1001, type: 'forum', title: 'Future Telegram thing' },
    });
    const out = await verifyConnection(
      { callBotApi: call, botUserId: BOT_USER_ID },
      { externalChatId: '-1001' },
    );
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.errorCode).toBe('unknown');
    }
  });

  it('returns errorCode:unknown when getChat omits chat.id', async () => {
    const { call } = scriptedCall({
      ok: true,
      result: { type: 'channel', title: 'No ID' },
    });
    const out = await verifyConnection(
      { callBotApi: call, botUserId: BOT_USER_ID },
      { externalChatId: '@x' },
    );
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.errorCode).toBe('unknown');
    }
  });

  it('username defaults to null when absent on the chat', async () => {
    const { call } = scriptedCall(
      { ok: true, result: { id: -1001, type: 'channel', title: 'Private channel' } },
      { ok: true, result: { status: 'administrator', can_post_messages: true } },
    );
    const out = await verifyConnection(
      { callBotApi: call, botUserId: BOT_USER_ID },
      { externalChatId: '-1001' },
    );
    expect(out.ok).toBe(true);
    if (out.ok === true) {
      expect(out.username).toBeNull();
      expect(out.photoUrl).toBeNull();
    }
  });
});
