import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { IAMTokenCache, type IAMTokenStore } from '../iam-token.js';
import { AIProviderError } from '../provider.js';

/**
 * Helper: build a Yandex-shaped SA JSON. RSA-2048 keypair is generated in-test
 * so the JWT signing path actually executes without external fixtures.
 */
function makeServiceAccountKey(): string {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return JSON.stringify({
    id: 'key-id-test',
    service_account_id: 'sa-id-test',
    private_key: privateKey,
  });
}

function mockFetchOk(): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        iamToken: 'test-token-abc',
        expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  ) as unknown as typeof globalThis.fetch;
}

describe('IAMTokenCache', () => {
  it('returns cached token while >1h remains until expiry', async () => {
    const cache = new IAMTokenCache(makeServiceAccountKey());
    const expires = Date.now() + 6 * 60 * 60 * 1000;
    cache._setForTest('cached-tok', expires);
    expect(await cache.getToken()).toBe('cached-tok');
  });

  it('refreshes via IAM endpoint on cache miss', async () => {
    const fetchImpl = mockFetchOk();
    const cache = new IAMTokenCache(makeServiceAccountKey(), { fetch: fetchImpl });
    const tok = await cache.getToken();
    expect(tok).toBe('test-token-abc');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent getToken calls', async () => {
    const fetchImpl = mockFetchOk();
    const cache = new IAMTokenCache(makeServiceAccountKey(), { fetch: fetchImpl });
    const results = await Promise.all([cache.getToken(), cache.getToken(), cache.getToken()]);
    expect(new Set(results).size).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses store before falling back to IAM exchange', async () => {
    const fetchImpl = mockFetchOk();
    const store: IAMTokenStore = {
      read: vi.fn().mockResolvedValue({
        token: 'store-tok',
        expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
      }),
      write: vi.fn(),
    };
    const cache = new IAMTokenCache(makeServiceAccountKey(), { fetch: fetchImpl, store });
    const tok = await cache.getToken();
    expect(tok).toBe('store-tok');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.read).toHaveBeenCalled();
  });

  it('writes back to store after a successful exchange', async () => {
    const fetchImpl = mockFetchOk();
    const store: IAMTokenStore = {
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue(undefined),
    };
    const cache = new IAMTokenCache(makeServiceAccountKey(), { fetch: fetchImpl, store });
    await cache.getToken();
    expect(store.write).toHaveBeenCalledWith('test-token-abc', expect.any(Date));
  });

  it('rejects when SA JSON missing private_key', async () => {
    const bad = JSON.stringify({ id: 'x', service_account_id: 'y' });
    const cache = new IAMTokenCache(bad);
    await expect(cache.getToken()).rejects.toBeInstanceOf(AIProviderError);
  });

  it('rejects when private_key is not valid PEM', async () => {
    const bad = JSON.stringify({ id: 'x', service_account_id: 'y', private_key: 'not-a-key' });
    const cache = new IAMTokenCache(bad);
    await expect(cache.getToken()).rejects.toBeInstanceOf(AIProviderError);
  });

  it('rejects empty SA JSON', async () => {
    const cache = new IAMTokenCache('');
    await expect(cache.getToken()).rejects.toBeInstanceOf(AIProviderError);
  });

  it('surfaces 401 from IAM as auth_error', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 401 })) as unknown as typeof globalThis.fetch;
    const cache = new IAMTokenCache(makeServiceAccountKey(), { fetch: fetchImpl });
    await expect(cache.getToken()).rejects.toMatchObject({ code: 'auth_error' });
  });

  it('surfaces 5xx from IAM as server_error', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 503 })) as unknown as typeof globalThis.fetch;
    const cache = new IAMTokenCache(makeServiceAccountKey(), { fetch: fetchImpl });
    await expect(cache.getToken()).rejects.toMatchObject({ code: 'server_error' });
  });

  it('rejects malformed response body (missing iamToken)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ foo: 'bar' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof globalThis.fetch;
    const cache = new IAMTokenCache(makeServiceAccountKey(), { fetch: fetchImpl });
    await expect(cache.getToken()).rejects.toMatchObject({ code: 'parse_error' });
  });

  it('forceRefresh skips the in-memory cache', async () => {
    const fetchImpl = mockFetchOk();
    const cache = new IAMTokenCache(makeServiceAccountKey(), { fetch: fetchImpl });
    cache._setForTest('stale-tok', Date.now() + 6 * 60 * 60 * 1000);
    const tok = await cache.forceRefresh();
    expect(tok).toBe('test-token-abc');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
