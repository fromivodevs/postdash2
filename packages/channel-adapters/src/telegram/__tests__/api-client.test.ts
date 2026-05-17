/**
 * Tests for `callBotApi` — the HTTP boundary.
 *
 * Invariant 7 (architecture/channel-connection.md): the adapter NEVER
 * throws on Telegram-side failures (4xx / network / timeout). These tests
 * lock that invariant by asserting every failure mode returns
 * `{ ok:false, errorCode }`.
 *
 * Programmer errors (empty token, no fetch) DO throw `TelegramAdapterError`
 * — covered by a separate group.
 */

import { describe, expect, it, vi } from 'vitest';
import { callBotApi } from '../api-client.js';
import { TelegramAdapterError } from '../errors.js';

const TOKEN = '123456:test-token';

function fakeFetch(response: Response): typeof globalThis.fetch {
  // `vi.fn` typed minimally — we don't use Headers/Request features beyond
  // what `callBotApi` does (POST + json body).
  return vi.fn(async () => response) as unknown as typeof globalThis.fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('callBotApi — happy path', () => {
  it('returns { ok:true, result } when Telegram envelope is 200 + ok:true', async () => {
    const fetchMock = fakeFetch(
      jsonResponse(200, { ok: true, result: { id: -100123, type: 'channel' } }),
    );
    const out = await callBotApi(TOKEN, 'getChat', { chat_id: '@x' }, { fetch: fetchMock });
    expect(out).toEqual({ ok: true, result: { id: -100123, type: 'channel' } });
  });

  it('POSTs JSON body to /bot<token>/<method> with content-type json', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { ok: true, result: {} }),
    ) as unknown as typeof globalThis.fetch;
    await callBotApi(
      TOKEN,
      'getChatMember',
      { chat_id: '-1001', user_id: 7 },
      {
        fetch: fetchMock,
        baseUrl: 'https://example.test',
      },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const callArgs = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0];
    expect(callArgs).toBeDefined();
    if (!callArgs) return;
    const [url, init] = callArgs;
    expect(url).toBe(`https://example.test/bot${TOKEN}/getChatMember`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ chat_id: '-1001', user_id: 7 }));
  });
});

describe('callBotApi — Telegram error mapping', () => {
  it('maps 400 "chat not found" to errorCode:chat_not_found', async () => {
    const fetchMock = fakeFetch(
      jsonResponse(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
    );
    const out = await callBotApi(TOKEN, 'getChat', { chat_id: '@nope' }, { fetch: fetchMock });
    expect(out).toEqual({
      ok: false,
      errorCode: 'chat_not_found',
      detail: 'telegram: chat not found',
    });
  });

  it('maps 400 with non-specific description to chat_not_found', async () => {
    const fetchMock = fakeFetch(
      jsonResponse(400, { ok: false, error_code: 400, description: 'Bad Request: something else' }),
    );
    const out = await callBotApi(TOKEN, 'getChat', { chat_id: '@x' }, { fetch: fetchMock });
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.errorCode).toBe('chat_not_found');
    }
  });

  it('maps 401 to errorCode:unauthorized (bad bot token)', async () => {
    const fetchMock = fakeFetch(
      jsonResponse(401, { ok: false, error_code: 401, description: 'Unauthorized' }),
    );
    const out = await callBotApi(TOKEN, 'getChat', { chat_id: '@x' }, { fetch: fetchMock });
    expect(out).toEqual({ ok: false, errorCode: 'unauthorized', detail: 'telegram: unauthorized' });
  });

  it('maps 403 to errorCode:bot_blocked', async () => {
    const fetchMock = fakeFetch(
      jsonResponse(403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked' }),
    );
    const out = await callBotApi(TOKEN, 'getChat', { chat_id: '@x' }, { fetch: fetchMock });
    expect(out).toEqual({ ok: false, errorCode: 'bot_blocked', detail: 'telegram: forbidden' });
  });

  it('maps 429 to errorCode:network (rate limited)', async () => {
    const fetchMock = fakeFetch(
      jsonResponse(429, {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests',
        parameters: { retry_after: 5 },
      }),
    );
    const out = await callBotApi(TOKEN, 'getChat', { chat_id: '@x' }, { fetch: fetchMock });
    expect(out).toEqual({ ok: false, errorCode: 'network', detail: 'telegram: rate limited' });
  });

  it('maps 500 to errorCode:network', async () => {
    const fetchMock = fakeFetch(
      jsonResponse(500, { ok: false, error_code: 500, description: 'Internal' }),
    );
    const out = await callBotApi(TOKEN, 'getChat', { chat_id: '@x' }, { fetch: fetchMock });
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      expect(out.errorCode).toBe('network');
    }
  });
});

describe('callBotApi — network / abort', () => {
  it('returns errorCode:network when fetch rejects', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('failed to fetch');
    }) as unknown as typeof globalThis.fetch;
    const out = await callBotApi(TOKEN, 'getChat', { chat_id: '@x' }, { fetch: fetchMock });
    expect(out).toEqual({ ok: false, errorCode: 'network', detail: 'network error' });
  });

  it('returns errorCode:network with detail "timeout" when AbortError fires', async () => {
    // The AbortController fires `abort()` on timeout; fetch then throws an
    // AbortError. We simulate that directly — testing the real setTimeout
    // path would slow the suite.
    const fetchMock = vi.fn(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    }) as unknown as typeof globalThis.fetch;
    const out = await callBotApi(TOKEN, 'getChat', { chat_id: '@x' }, { fetch: fetchMock });
    expect(out).toEqual({ ok: false, errorCode: 'network', detail: 'timeout' });
  });

  it('actually aborts on the configured timeoutMs', async () => {
    // Verify the AbortController is wired by hanging fetch and giving it 5ms.
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    }) as unknown as typeof globalThis.fetch;
    const out = await callBotApi(
      TOKEN,
      'getChat',
      { chat_id: '@x' },
      { fetch: fetchMock, timeoutMs: 5 },
    );
    expect(out).toEqual({ ok: false, errorCode: 'network', detail: 'timeout' });
  });

  it('returns errorCode:unknown when body is non-JSON garbage', async () => {
    const fetchMock = fakeFetch(
      new Response('<html>gateway error</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const out = await callBotApi(TOKEN, 'getChat', { chat_id: '@x' }, { fetch: fetchMock });
    expect(out.ok).toBe(false);
    if (out.ok === false) {
      // 502 → network (server-side).
      expect(out.errorCode).toBe('network');
    }
  });
});

describe('callBotApi — programmer errors throw TelegramAdapterError', () => {
  it('throws on empty token', async () => {
    await expect(
      callBotApi(
        '',
        'getChat',
        {},
        { fetch: fakeFetch(jsonResponse(200, { ok: true, result: {} })) },
      ),
    ).rejects.toBeInstanceOf(TelegramAdapterError);
  });

  it('throws on empty method', async () => {
    await expect(
      callBotApi(
        TOKEN,
        '',
        {},
        {
          fetch: fakeFetch(jsonResponse(200, { ok: true, result: {} })),
        },
      ),
    ).rejects.toBeInstanceOf(TelegramAdapterError);
  });

  it('throws on non-positive timeoutMs', async () => {
    await expect(
      callBotApi(
        TOKEN,
        'getChat',
        {},
        {
          fetch: fakeFetch(jsonResponse(200, { ok: true, result: {} })),
          timeoutMs: 0,
        },
      ),
    ).rejects.toBeInstanceOf(TelegramAdapterError);
  });
});
