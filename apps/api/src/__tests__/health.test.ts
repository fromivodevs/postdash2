import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

const app = await buildApp({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  API_HOST: '0.0.0.0',
  API_PORT: 0,
});

afterAll(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('returns ok status with service identifier', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['status']).toBe('ok');
    expect(body['service']).toBe('postdash-api');
    expect(typeof body['version']).toBe('string');
    expect(typeof body['uptime_sec']).toBe('number');
  });

  it('returns ISO time string', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json() as { time: string };
    expect(() => new Date(body.time).toISOString()).not.toThrow();
  });
});
