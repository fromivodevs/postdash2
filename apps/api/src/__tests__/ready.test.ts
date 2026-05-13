import type { Pool } from '@postdash/db';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

const apiEnv = {
  NODE_ENV: 'test' as const,
  LOG_LEVEL: 'silent' as const,
  API_HOST: '0.0.0.0',
  API_PORT: 0,
};

function makeMockPool(pingImpl: () => Promise<void>): Pool {
  return {
    // For tests we only exercise ping(). client/db are required by the type
    // but never invoked here, so a placeholder satisfies the interface.
    client: {} as Pool['client'],
    db: {} as Pool['db'],
    ping: pingImpl,
    close: async () => {},
  };
}

describe('GET /ready', () => {
  let teardown: () => Promise<void> = async () => {};

  afterEach(async () => {
    await teardown();
    teardown = async () => {};
  });

  it('returns 200 with db:ok when pool ping succeeds', async () => {
    const pool = makeMockPool(async () => {});
    const app = await buildApp(apiEnv, { pool });
    teardown = () => app.close();

    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);

    const body = res.json() as Record<string, unknown>;
    expect(body['status']).toBe('ready');
    expect(body['db']).toBe('ok');
    expect(typeof body['time']).toBe('string');
  });

  it('returns 503 with error message when pool ping throws', async () => {
    const pool = makeMockPool(async () => {
      throw new Error('connection refused');
    });
    const app = await buildApp(apiEnv, { pool });
    teardown = () => app.close();

    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);

    const body = res.json() as Record<string, unknown>;
    expect(body['status']).toBe('not_ready');
    expect(body['db']).toBe('unreachable');
    expect(body['error']).toContain('connection refused');
  });

  it('is not registered when no pool is provided', async () => {
    const app = await buildApp(apiEnv, {});
    teardown = () => app.close();

    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(404);
  });
});
