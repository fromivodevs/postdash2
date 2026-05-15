/**
 * Unit tests for the channel-connection wire schemas and deep-link helper.
 *
 * The Zod schemas defined in `channel-projection.ts` are the cross-module
 * contract between `apps/api/src/routes/channels-projection.ts` and
 * `apps/miniapp/src/api/channels.ts`. A drift between the two ends would
 * surface only at runtime in the Mini App, so we exercise both the happy
 * path (representative records) and a representative rejection (invalid
 * status enum) to make the contract a compile-time AND parse-time guarantee.
 *
 * `buildConnectDeepLink` is the single source of truth for the format of the
 * `https://t.me/<bot>?start=connect_<code>` URL. The bot-side handler
 * (`apps/api/src/bot/handlers/start-connect.ts`) and the Mini App display
 * both depend on this format — a silent off-by-one in the prefix would
 * break the connect flow end-to-end without any error visible in logs.
 */

import { describe, expect, it } from 'vitest';
import {
  ChannelProjectionSchema,
  ConnectCodeProjectionSchema,
  buildConnectDeepLink,
  type ChannelProjection,
  type ConnectCodeProjection,
} from '../channel-projection.js';

describe('buildConnectDeepLink', () => {
  it('builds the canonical deep-link from a bare bot username', () => {
    expect(buildConnectDeepLink('postdash_bot', 'K7XQAR9F')).toBe(
      'https://t.me/postdash_bot?start=connect_K7XQAR9F',
    );
  });

  it('throws when botUsername has a leading @ (callers must strip it)', () => {
    expect(() => buildConnectDeepLink('@postdash_bot', 'X')).toThrowError(
      /must not be empty or start with @/,
    );
  });

  it('throws when botUsername is empty', () => {
    expect(() => buildConnectDeepLink('', 'CODE')).toThrowError(
      /must not be empty or start with @/,
    );
  });

  it('throws when code is empty', () => {
    expect(() => buildConnectDeepLink('postdash_bot', '')).toThrowError(/code must not be empty/);
  });
});

describe('ChannelProjectionSchema', () => {
  const validConnectedRecord: ChannelProjection = {
    id: '11111111-1111-4111-8111-111111111111',
    workspace_id: '22222222-2222-4222-8222-222222222222',
    content_channel_id: '33333333-3333-4333-8333-333333333333',
    platform: 'telegram',
    external_id: '-1001234567890',
    title: 'My Test Channel',
    username: 'my_test_channel',
    photo_url: 'https://t.me/i/userpic/320/my_test_channel.jpg',
    type: 'channel',
    status: 'connected',
    can_post_messages: true,
    last_verify_status: 'ok',
    last_verify_error: null,
    last_verified_at: '2026-05-15T10:00:00.000Z',
    connected_at: '2026-05-15T09:59:00.000Z',
  };

  it('parses a representative connected channel record', () => {
    const parsed = ChannelProjectionSchema.parse(validConnectedRecord);
    expect(parsed).toEqual(validConnectedRecord);
  });

  it('parses a record with nullable fields cleared (e.g. pending state)', () => {
    const pending: ChannelProjection = {
      ...validConnectedRecord,
      status: 'pending',
      username: null,
      photo_url: null,
      can_post_messages: null,
      last_verify_status: null,
      last_verify_error: null,
      last_verified_at: null,
      connected_at: null,
    };
    expect(ChannelProjectionSchema.parse(pending)).toEqual(pending);
  });

  it('rejects an invalid status value', () => {
    const bad = { ...validConnectedRecord, status: 'invalid_status' };
    expect(() => ChannelProjectionSchema.parse(bad)).toThrow();
  });

  it('rejects an invalid platform value', () => {
    const bad = { ...validConnectedRecord, platform: 'discord' };
    expect(() => ChannelProjectionSchema.parse(bad)).toThrow();
  });
});

describe('ConnectCodeProjectionSchema', () => {
  it('parses a fresh code record returned by POST /channels/connect-code', () => {
    const fresh: ConnectCodeProjection = {
      id: '44444444-4444-4444-8444-444444444444',
      code: 'K7XQAR9F',
      deep_link: 'https://t.me/postdash_bot?start=connect_K7XQAR9F',
      expires_at: '2026-05-15T10:15:00.000Z',
    };
    expect(ConnectCodeProjectionSchema.parse(fresh)).toEqual(fresh);
  });

  it('rejects a deep_link that is not a URL', () => {
    const bad = {
      id: '44444444-4444-4444-8444-444444444444',
      code: 'K7XQAR9F',
      deep_link: 'not-a-url',
      expires_at: '2026-05-15T10:15:00.000Z',
    };
    expect(() => ConnectCodeProjectionSchema.parse(bad)).toThrow();
  });

  it('rejects a non-uuid id', () => {
    const bad = {
      id: 'not-a-uuid',
      code: 'K7XQAR9F',
      deep_link: 'https://t.me/postdash_bot?start=connect_K7XQAR9F',
      expires_at: '2026-05-15T10:15:00.000Z',
    };
    expect(() => ConnectCodeProjectionSchema.parse(bad)).toThrow();
  });
});
