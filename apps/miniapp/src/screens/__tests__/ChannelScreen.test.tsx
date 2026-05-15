/**
 * ChannelScreen view-model tests (Phase 2).
 *
 * The miniapp tests are pure-logic only — there is no jsdom or
 * @testing-library wired up (see screens/onboarding/__tests__/wizardSteps.test.ts
 * for the established pattern). To stay on that pattern we keep the screen's
 * decision logic in a separate pure module (`channelView.ts`) and test the
 * mapping inputs -> view directly, which is exactly what the architecture's
 * test plan #24-25 wants: "renders X view for state Y".
 *
 * The `.tsx` extension is preserved per the task spec; the file is still pure
 * TypeScript at runtime.
 */

import { describe, expect, it } from 'vitest';
import {
  channelErrorCopy,
  isDeadCodeError,
  parseConnectCodeFromSearch,
  selectChannelView,
  verifyStatusCopy,
} from '../channelView.ts';
import type { ChannelListProjection, ChannelProjection, ConnectCodeProjection } from '../../api/types.ts';

function buildChannel(overrides: Partial<ChannelProjection> = {}): ChannelProjection {
  return {
    id: '00000000-0000-0000-0000-000000000010',
    workspace_id: '00000000-0000-0000-0000-000000000020',
    content_channel_id: '00000000-0000-0000-0000-000000000030',
    platform: 'telegram',
    external_id: '-1001234567890',
    title: 'My Channel',
    username: 'mychan',
    photo_url: null,
    type: 'channel',
    status: 'connected',
    can_post_messages: true,
    last_verify_status: 'ok',
    last_verify_error: null,
    last_verified_at: '2026-05-15T12:00:00.000Z',
    connected_at: '2026-05-15T12:00:00.000Z',
    ...overrides,
  };
}

function buildList(items: ChannelProjection[]): ChannelListProjection {
  return { items };
}

function buildCode(code: string): ConnectCodeProjection {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    code,
    deep_link: `https://t.me/postdash_bot?start=connect_${code}`,
    expires_at: '2026-05-15T12:30:00.000Z',
  };
}

describe('selectChannelView', () => {
  it('renders NotConnectedView when GET /channels returns empty and there is no fresh code', () => {
    const view = selectChannelView({ channels: buildList([]), codeOverride: null });
    expect(view.kind).toBe('not_connected');
  });

  it('renders NotConnectedView when channels payload has not arrived yet', () => {
    // Boot-loading state (`channels === null`) and no override -> not_connected is
    // a safe default; the screen wraps this branch with an `isLoading` Spinner
    // before reaching the view, but the selector still has to return *some*
    // view so the rendering surface is total.
    const view = selectChannelView({ channels: null, codeOverride: null });
    expect(view.kind).toBe('not_connected');
  });

  it('renders PendingView with the fresh code right after create-code success', () => {
    const code = buildCode('K7XQAR9F');
    const view = selectChannelView({ channels: buildList([]), codeOverride: code });
    expect(view.kind).toBe('pending');
    if (view.kind === 'pending') {
      expect(view.code).toEqual(code);
      expect(view.channel).toBeNull();
    }
  });

  it('renders PendingView when the channel row exists with status=pending and surfaces the fresh code', () => {
    // Rare in Phase 2 (the connect command does not currently insert a pending
    // row, but the schema allows it for Phase 9) — make sure the selector
    // still threads the in-memory code through to the view.
    const code = buildCode('K7XQAR9F');
    const channel = buildChannel({ status: 'pending', last_verify_status: null });
    const view = selectChannelView({ channels: buildList([channel]), codeOverride: code });
    expect(view.kind).toBe('pending');
    if (view.kind === 'pending') {
      expect(view.channel).toEqual(channel);
      expect(view.code).toEqual(code);
    }
  });

  it('renders ConnectedView when status=connected', () => {
    const channel = buildChannel({ status: 'connected' });
    const view = selectChannelView({ channels: buildList([channel]), codeOverride: null });
    expect(view.kind).toBe('connected');
    if (view.kind === 'connected') {
      expect(view.channel).toEqual(channel);
    }
  });

  it('renders BrokenView when status=broken', () => {
    const channel = buildChannel({
      status: 'broken',
      last_verify_status: 'bot_not_admin',
      last_verify_error: 'bot was demoted',
    });
    const view = selectChannelView({ channels: buildList([channel]), codeOverride: null });
    expect(view.kind).toBe('broken');
    if (view.kind === 'broken') {
      expect(view.channel.last_verify_error).toBe('bot was demoted');
    }
  });

  it('renders BrokenView when status=revoked (Phase 9 lookahead but already mapped today)', () => {
    const channel = buildChannel({ status: 'revoked', last_verify_status: null });
    const view = selectChannelView({ channels: buildList([channel]), codeOverride: null });
    expect(view.kind).toBe('broken');
  });

  it('a fresh codeOverride does NOT override a connected channel (avoids hiding success)', () => {
    // After a successful connect the screen clears codeOverride; this asserts
    // the selector's safety net in case the clear is delayed by a render: a
    // connected channel must keep showing ConnectedView.
    const channel = buildChannel({ status: 'connected' });
    const code = buildCode('STALE');
    const view = selectChannelView({ channels: buildList([channel]), codeOverride: code });
    expect(view.kind).toBe('connected');
  });
});

describe('parseConnectCodeFromSearch (deep-link prefill)', () => {
  it('extracts the code from a normalised deep-link query', () => {
    expect(parseConnectCodeFromSearch('?code=K7XQAR9F')).toBe('K7XQAR9F');
  });

  it('handles a bare query string without the leading ?', () => {
    expect(parseConnectCodeFromSearch('code=ABC')).toBe('ABC');
  });

  it('returns null for an empty / missing query', () => {
    expect(parseConnectCodeFromSearch('')).toBeNull();
    expect(parseConnectCodeFromSearch('?')).toBeNull();
  });

  it('returns null when there is no code param', () => {
    expect(parseConnectCodeFromSearch('?other=1')).toBeNull();
  });

  it('returns null for an over-long code (mirrors the routing 64-char cap)', () => {
    const tooLong = 'a'.repeat(65);
    expect(parseConnectCodeFromSearch(`?code=${tooLong}`)).toBeNull();
  });
});

describe('channelErrorCopy', () => {
  it('maps bot_not_admin to the Russian "сделай бота администратором" banner', () => {
    const copy = channelErrorCopy('bot_not_admin');
    expect(copy?.header).toBe('Бот не админ');
    expect(copy?.description).toContain('администратором');
  });

  it('maps missing_post_permission to the posting-permission banner', () => {
    const copy = channelErrorCopy('missing_post_permission');
    expect(copy?.description).toContain('Posting');
  });

  it('maps chat_not_found to the "проверь @username" banner', () => {
    const copy = channelErrorCopy('chat_not_found');
    expect(copy?.description).toContain('@username');
  });

  it('maps channel_taken to the "уже подключён к другому workspace" banner', () => {
    const copy = channelErrorCopy('channel_taken');
    expect(copy?.description).toContain('workspace');
  });

  it('returns null for dead-code errors so the screen renders the "create new code" branch instead', () => {
    expect(channelErrorCopy('expired_code')).toBeNull();
    expect(channelErrorCopy('reused_code')).toBeNull();
  });

  it('returns null for unknown codes', () => {
    expect(channelErrorCopy(undefined)).toBeNull();
    expect(channelErrorCopy('totally_new')).toBeNull();
  });
});

describe('isDeadCodeError', () => {
  it('is true for expired_code and reused_code', () => {
    expect(isDeadCodeError('expired_code')).toBe(true);
    expect(isDeadCodeError('reused_code')).toBe(true);
  });

  it('is false for everything else', () => {
    expect(isDeadCodeError('bot_not_admin')).toBe(false);
    expect(isDeadCodeError(undefined)).toBe(false);
  });
});

describe('verifyStatusCopy (BrokenView fallback)', () => {
  it('returns a tailored Russian sentence per known status', () => {
    expect(verifyStatusCopy('bot_not_admin')).toContain('админ');
    expect(verifyStatusCopy('missing_post_permission')).toContain('постить');
    expect(verifyStatusCopy('network')).toContain('Telegram');
  });

  it('falls back to a generic message for unknown / null statuses', () => {
    expect(verifyStatusCopy(null)).toBeTruthy();
    expect(verifyStatusCopy('something_new')).toBeTruthy();
  });
});
