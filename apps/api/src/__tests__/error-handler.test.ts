import { AIProviderError, type AIProviderErrorCode } from '@postdash/ai';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { testEnv as apiEnv } from './helpers/test-env.js';

async function appThrowing(code: AIProviderErrorCode) {
  const app = await buildApp(apiEnv, {});
  app.get('/__throw', () => {
    throw new AIProviderError(`test message: ${code}`, code);
  });
  return app;
}

describe('setErrorHandler — AIProviderError mapping', () => {
  let teardown: () => Promise<void> = async () => {};
  afterEach(async () => {
    await teardown();
    teardown = async () => {};
  });

  const cases: Array<[AIProviderErrorCode, number]> = [
    ['budget_exceeded', 402],
    ['refused', 422],
    ['rate_limit', 503],
    ['server_error', 503],
    ['auth_error', 503],
    ['parse_error', 503],
    ['not_implemented', 503],
    ['unknown', 503],
  ];

  for (const [code, expectedStatus] of cases) {
    it(`maps code=${code} to HTTP ${expectedStatus}`, async () => {
      const app = await appThrowing(code);
      teardown = () => app.close();

      const res = await app.inject({ method: 'GET', url: '/__throw' });
      expect(res.statusCode).toBe(expectedStatus);

      const body = res.json() as Record<string, unknown>;
      expect(body['error']).toBe('AIProviderError');
      expect(body['code']).toBe(code);
      expect(body['statusCode']).toBe(expectedStatus);
      expect(typeof body['message']).toBe('string');
    });
  }

  it('leaves non-AIProviderError to default Fastify handling', async () => {
    const app = await buildApp(apiEnv, {});
    app.get('/__plain', () => {
      throw new Error('plain boom');
    });
    teardown = () => app.close();

    const res = await app.inject({ method: 'GET', url: '/__plain' });
    expect(res.statusCode).toBe(500);
    const body = res.json() as Record<string, unknown>;
    expect(body['error']).not.toBe('AIProviderError');
  });
});
