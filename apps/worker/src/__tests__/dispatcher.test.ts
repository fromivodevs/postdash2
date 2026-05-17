import { describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../dispatcher.js';

/**
 * Dispatcher unit tests — exercise the routing + retry-classification logic
 * without spinning a real Postgres client. We pass a stub pool whose
 * client/db are vi.fn()s and assert call shape.
 */

function makeStubPool() {
  const queries: string[] = [];
  // The completeTask / failTask helpers call client`SQL...` (tagged-template).
  // We mimic with a function that records the strings and returns a thenable.
  const client = vi.fn().mockImplementation((strings: TemplateStringsArray | string) => {
    queries.push(typeof strings === 'string' ? strings : strings.join('?'));
    return Promise.resolve([{ attempts: 1, max_attempts: 3 }]);
  }) as unknown as { (...args: unknown[]): Promise<unknown> };
  return {
    pool: { client, db: {} as unknown },
    queries,
  } as unknown as { pool: import('@postdash/db').Pool; queries: string[] };
}

const noopLogger = {
  child: () => noopLogger,
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as import('pino').Logger;

describe('Dispatcher', () => {
  it('routes a task to the registered handler', async () => {
    const d = new Dispatcher();
    const handler = vi.fn().mockResolvedValue(undefined);
    d.register('fetch_source', handler);
    const { pool } = makeStubPool();
    const ai = { name: 'template' } as unknown as import('@postdash/ai').AIProvider;
    const task = {
      id: 't1',
      type: 'fetch_source' as const,
      payload: {},
      attempts: 1,
      maxAttempts: 3,
      workspaceId: null,
      sourceId: 's1',
    };
    await d.dispatch(task, pool, ai, noopLogger);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('marks task failed_permanent when no handler is registered', async () => {
    const d = new Dispatcher();
    const { pool, queries } = makeStubPool();
    const ai = { name: 'template' } as unknown as import('@postdash/ai').AIProvider;
    const task = {
      id: 't2',
      type: 'fetch_source' as const,
      payload: {},
      attempts: 1,
      maxAttempts: 3,
      workspaceId: null,
      sourceId: 's1',
    };
    await d.dispatch(task, pool, ai, noopLogger);
    // failTask should run an UPDATE tasks SET status='failed_permanent' ...
    expect(queries.some((q) => q.toLowerCase().includes('failed_permanent'))).toBe(true);
  });

  it('classifies thrown error with kind=permanent as failed_permanent', async () => {
    const d = new Dispatcher();
    d.register('fetch_source', async () => {
      const e: Error & { kind?: string } = new Error('boom');
      e.kind = 'permanent';
      throw e;
    });
    const { pool, queries } = makeStubPool();
    const ai = { name: 'template' } as unknown as import('@postdash/ai').AIProvider;
    await d.dispatch(
      {
        id: 't3',
        type: 'fetch_source',
        payload: {},
        attempts: 1,
        maxAttempts: 3,
        workspaceId: null,
        sourceId: 's1',
      },
      pool,
      ai,
      noopLogger,
    );
    expect(queries.some((q) => q.toLowerCase().includes('failed_permanent'))).toBe(true);
  });

  it('default failure kind is transient (retries within max_attempts)', async () => {
    const d = new Dispatcher();
    d.register('fetch_source', async () => {
      throw new Error('network blip');
    });
    const { pool, queries } = makeStubPool();
    const ai = { name: 'template' } as unknown as import('@postdash/ai').AIProvider;
    await d.dispatch(
      {
        id: 't4',
        type: 'fetch_source',
        payload: {},
        attempts: 1,
        maxAttempts: 3,
        workspaceId: null,
        sourceId: 's1',
      },
      pool,
      ai,
      noopLogger,
    );
    // attempts=1 < max_attempts=3 → status='pending' (retry), not failed_permanent.
    expect(queries.some((q) => q.includes("status = 'pending'"))).toBe(true);
    expect(queries.some((q) => q.includes("status = 'failed_permanent'"))).toBe(false);
  });
});
