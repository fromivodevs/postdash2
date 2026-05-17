/**
 * Unit tests for the channel-connection API client (Phase 2).
 *
 * Pure fetch mocking — no React, no jsdom. Mirrors the apps/api routes
 * contract via `ChannelApiError` (architecture: error UX must dispatch on a
 * stable wire `code`, not on raw HTTP status, but the status is preserved so
 * the screen can still distinguish 410 expired from 409 reused).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ChannelApiError,
  generateIdempotencyKey,
  getChannels,
  postConnect,
  postConnectCode,
} from '../channels.ts';

const ORIGINAL_FETCH = globalThis.fetch;

interface FakeFetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface FakeFetch {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  readonly calls: readonly FakeFetchCall[];
}

function jsonResponse(body: unknown, status = 200, statusText?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: statusText ?? (status === 200 ? 'OK' : 'Error'),
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build a fetch double that records every call and returns the next queued
 * response. `responses` is consumed in FIFO order — a single test should
 * queue exactly the number of responses it expects to receive.
 */
function buildFetch(responses: Response[]): FakeFetch {
  const calls: FakeFetchCall[] = [];
  const fn = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      init,
    });
    const next = responses.shift();
    if (!next) throw new Error('fake fetch: no response queued');
    return Promise.resolve(next);
  };
  return Object.assign(fn, { calls: calls as readonly FakeFetchCall[] });
}

function installFetch(fake: FakeFetch): void {
  // Cast to the global type. The fake matches the shape we exercise in apiFetch.
  globalThis.fetch = fake as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  // Each test installs its own fake; this just resets any leak from prior runs.
  globalThis.fetch = ORIGINAL_FETCH;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe('postConnectCode', () => {
  it('POSTs to /channels/connect-codes and returns the parsed projection', async () => {
    const projection = {
      id: '00000000-0000-0000-0000-000000000001',
      code: 'K7XQAR9F',
      deep_link: 'https://t.me/postdash_bot?start=connect_K7XQAR9F',
      expires_at: '2026-05-15T12:00:00.000Z',
    };
    const fake = buildFetch([jsonResponse(projection)]);
    installFetch(fake);

    const result = await postConnectCode('INIT_DATA');

    expect(result).toEqual(projection);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.url).toMatch(/\/channels\/connect-codes$/);
    expect(call.init?.method).toBe('POST');
    const headers = call.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('tma INIT_DATA');
    expect(headers['Content-Type']).toBe('application/json');
    expect(call.init?.body).toBe(JSON.stringify({}));
  });

  it('wraps a 403 forbidden into ChannelApiError', async () => {
    const fake = buildFetch([
      jsonResponse({ error: 'CommandError', code: 'forbidden', message: 'no role' }, 403),
    ]);
    installFetch(fake);

    await expect(postConnectCode('INIT_DATA')).rejects.toMatchObject({
      name: 'ChannelApiError',
      httpStatus: 403,
      code: 'forbidden',
    });
  });
});

describe('postConnect', () => {
  it('POSTs to /channels/connect with body and an Idempotency-Key header', async () => {
    const channel = {
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
    };
    const fake = buildFetch([jsonResponse(channel)]);
    installFetch(fake);

    const result = await postConnect('INIT_DATA', {
      code: 'K7XQAR9F',
      external_chat_id: '@mychan',
    });

    expect(result).toEqual(channel);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.url).toMatch(/\/channels\/connect$/);
    expect(call.init?.method).toBe('POST');
    const headers = call.init?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-fA-F-]{30,}$/);
    expect(headers['Authorization']).toBe('tma INIT_DATA');
    expect(call.init?.body).toBe(JSON.stringify({ code: 'K7XQAR9F', external_chat_id: '@mychan' }));
  });

  it('honours a caller-supplied idempotencyKey so retries collapse', async () => {
    const fake = buildFetch([jsonResponse({}, 500)]);
    installFetch(fake);
    await expect(
      postConnect('INIT_DATA', {
        code: 'K7XQAR9F',
        external_chat_id: '@x',
        idempotencyKey: 'pinned-key-123',
      }),
    ).rejects.toBeDefined();
    const headers = fake.calls[0]?.init?.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('pinned-key-123');
  });

  it('maps 410 expired_code to ChannelApiError(httpStatus:410, code:expired_code)', async () => {
    const fake = buildFetch([
      jsonResponse(
        { error: 'CommandError', code: 'expired_code', message: 'connect code expired' },
        410,
        'Gone',
      ),
    ]);
    installFetch(fake);

    const err = await postConnect('INIT_DATA', { code: 'X', external_chat_id: '@x' }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ChannelApiError);
    const channelErr = err as ChannelApiError;
    expect(channelErr.httpStatus).toBe(410);
    expect(channelErr.code).toBe('expired_code');
  });

  it('maps 409 reused_code to ChannelApiError(httpStatus:409, code:reused_code)', async () => {
    const fake = buildFetch([
      jsonResponse(
        { error: 'CommandError', code: 'reused_code', message: 'connect code already used' },
        409,
      ),
    ]);
    installFetch(fake);

    const err = (await postConnect('INIT_DATA', { code: 'X', external_chat_id: '@x' }).catch(
      (e: unknown) => e,
    )) as ChannelApiError;
    expect(err).toBeInstanceOf(ChannelApiError);
    expect(err.httpStatus).toBe(409);
    expect(err.code).toBe('reused_code');
  });

  it('maps 409 channel_taken to ChannelApiError(httpStatus:409, code:channel_taken)', async () => {
    const fake = buildFetch([
      jsonResponse({ error: 'CommandError', code: 'channel_taken', message: 'channel taken' }, 409),
    ]);
    installFetch(fake);

    const err = (await postConnect('INIT_DATA', { code: 'X', external_chat_id: '@x' }).catch(
      (e: unknown) => e,
    )) as ChannelApiError;
    expect(err).toBeInstanceOf(ChannelApiError);
    expect(err.httpStatus).toBe(409);
    expect(err.code).toBe('channel_taken');
  });

  it('maps 400 missing_post_permission to ChannelApiError(httpStatus:400, code:missing_post_permission)', async () => {
    const fake = buildFetch([
      jsonResponse(
        {
          error: 'CommandError',
          code: 'missing_post_permission',
          message: 'bot cannot post',
        },
        400,
      ),
    ]);
    installFetch(fake);

    const err = (await postConnect('INIT_DATA', { code: 'X', external_chat_id: '@x' }).catch(
      (e: unknown) => e,
    )) as ChannelApiError;
    expect(err).toBeInstanceOf(ChannelApiError);
    expect(err.httpStatus).toBe(400);
    expect(err.code).toBe('missing_post_permission');
  });

  it('maps 400 bot_not_admin to ChannelApiError(httpStatus:400, code:bot_not_admin)', async () => {
    const fake = buildFetch([
      jsonResponse({ error: 'CommandError', code: 'bot_not_admin', message: 'no admin' }, 400),
    ]);
    installFetch(fake);

    const err = (await postConnect('INIT_DATA', { code: 'X', external_chat_id: '@x' }).catch(
      (e: unknown) => e,
    )) as ChannelApiError;
    expect(err).toBeInstanceOf(ChannelApiError);
    expect(err.code).toBe('bot_not_admin');
  });

  it('leaves an unknown wire code as undefined so screens fall back to generic copy', async () => {
    const fake = buildFetch([
      jsonResponse({ error: 'CommandError', code: 'totally_new_code', message: 'x' }, 400),
    ]);
    installFetch(fake);

    const err = (await postConnect('INIT_DATA', { code: 'X', external_chat_id: '@x' }).catch(
      (e: unknown) => e,
    )) as ChannelApiError;
    expect(err.code).toBeUndefined();
    expect(err.httpStatus).toBe(400);
  });
});

describe('getChannels', () => {
  it('GETs /channels and returns the parsed list', async () => {
    const list = { items: [] };
    const fake = buildFetch([jsonResponse(list)]);
    installFetch(fake);

    const result = await getChannels('INIT_DATA');

    expect(result).toEqual(list);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.url).toMatch(/\/channels$/);
    expect(call.init?.method).toBe('GET');
  });

  it('wraps a 500 internal into ChannelApiError so screens can show retry', async () => {
    const fake = buildFetch([
      jsonResponse({ error: 'CommandError', code: 'internal', message: 'boom' }, 500),
    ]);
    installFetch(fake);

    const err = await getChannels('INIT_DATA').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelApiError);
    expect((err as ChannelApiError).httpStatus).toBe(500);
  });
});

describe('generateIdempotencyKey', () => {
  it('produces a non-empty string of UUID-ish shape', () => {
    const key = generateIdempotencyKey();
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThanOrEqual(32);
  });

  it('produces a fresh value on each call', () => {
    const a = generateIdempotencyKey();
    const b = generateIdempotencyKey();
    expect(a).not.toBe(b);
  });

  it('falls back to the Math.random RFC4122 path when crypto.randomUUID is absent', () => {
    const originalCrypto = globalThis.crypto;
    // Forcing the fallback by replacing crypto with a version that lacks
    // randomUUID. The fallback string still has UUID v4 shape.
    Object.defineProperty(globalThis, 'crypto', {
      value: {},
      configurable: true,
    });
    try {
      const key = generateIdempotencyKey();
      expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        configurable: true,
      });
    }
  });
});

// Silence the "vi is unused" lint hint when the test file imports vi for the
// fetch-fallback test variant above. Vitest re-exports `vi`; keep the import
// so future tests can add spies without re-adding the symbol.
void vi;
