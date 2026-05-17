import { describe, expect, it, vi } from 'vitest';
import { AIProviderError } from '@postdash/ai';
import { Dispatcher } from '../dispatcher.js';

/**
 * Dispatcher unit tests — exercise the routing + retry-classification logic
 * without spinning a real Postgres client. We pass a stub pool whose
 * client/db are vi.fn()s and assert call shape.
 */

interface StubPool {
  pool: import('@postdash/db').Pool;
  queries: string[];
  /**
   * For each tagged-template call, the interpolated parameter values
   * captured by the mock. `failTask` interpolates the JS-side
   * `${isPermanent}::boolean` truth value as the first parameter on the
   * `UPDATE tasks` statement — tests assert on that so a single CASE-rich
   * UPDATE (rather than two separate branches) still proves the right
   * retry kind reached the queue layer.
   */
  paramValues: unknown[][];
}

function makeStubPool(): StubPool {
  const queries: string[] = [];
  const paramValues: unknown[][] = [];
  // The completeTask / failTask helpers call client`SQL...` (tagged-template).
  // We mimic with a function that records the strings + interpolated values
  // and returns a thenable. The lease-guarded UPDATE in failTask returns
  // `attempts, max_attempts, exhausted` — derive `exhausted` from the
  // interpolated isPermanent flag so the second (task_runs) UPDATE picks the
  // right status. attempts<max_attempts in this stub, so transient kinds
  // route to 'failed' / 'pending', permanent to 'failed_permanent'.
  const client = vi
    .fn()
    .mockImplementation((strings: TemplateStringsArray | string, ...values: unknown[]) => {
      queries.push(typeof strings === 'string' ? strings : strings.join('?'));
      paramValues.push(values);
      // The new failTask UPDATE interpolates ${isPermanent}::boolean as the
      // first param; report `exhausted` matching that JS-side decision.
      const exhausted = values[0] === true;
      return Promise.resolve([{ attempts: 1, max_attempts: 3, id: 't-stub', exhausted }]);
    }) as unknown as { (...args: unknown[]): Promise<unknown> };
  return {
    pool: { client, db: {} as unknown } as unknown as import('@postdash/db').Pool,
    queries,
    paramValues,
  };
}

const noopLogger = {
  child: () => noopLogger,
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as import('pino').Logger;

const stubAiConfig = {
  dedupeCosineThreshold: 0.15,
  dedupeWindowHours: 48,
  matchingMinCosine: 0.05,
  autoDraftScoreThreshold: 5.0,
};

/**
 * Helper: collapse the failTask UPDATE truth-table for assertions. The
 * dispatcher tests care about classification (permanent vs transient), not
 * the exact SQL shape — `isPermanent` shows up as the interpolated first
 * parameter on the `UPDATE tasks SET ... CASE WHEN ${isPermanent}` call.
 */
function failTaskUpdateIsPermanent(paramValues: unknown[][]): boolean | null {
  // The failTask UPDATE is the first call that interpolates a boolean
  // (completeTask uses no booleans). Find it.
  for (const params of paramValues) {
    if (params.length > 0 && typeof params[0] === 'boolean') {
      return params[0];
    }
  }
  return null;
}

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
      lockedBy: 'worker-stub',
    };
    await d.dispatch(task, pool, ai, noopLogger, { aiConfig: stubAiConfig });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('marks task failed_permanent when no handler is registered', async () => {
    const d = new Dispatcher();
    const { pool, queries, paramValues } = makeStubPool();
    const ai = { name: 'template' } as unknown as import('@postdash/ai').AIProvider;
    const task = {
      id: 't2',
      type: 'fetch_source' as const,
      payload: {},
      attempts: 1,
      maxAttempts: 3,
      workspaceId: null,
      sourceId: 's1',
      lockedBy: 'worker-stub',
    };
    await d.dispatch(task, pool, ai, noopLogger, { aiConfig: stubAiConfig });
    // failTask runs a single CASE-rich UPDATE; both 'pending' and
    // 'failed_permanent' literals always appear in the SQL. The classification
    // truth is the interpolated `${isPermanent}::boolean` param.
    expect(queries.some((q) => q.toLowerCase().includes('update tasks'))).toBe(true);
    expect(failTaskUpdateIsPermanent(paramValues)).toBe(true);
  });

  it('classifies thrown error with kind=permanent as failed_permanent', async () => {
    const d = new Dispatcher();
    d.register('fetch_source', async () => {
      const e: Error & { kind?: string } = new Error('boom');
      e.kind = 'permanent';
      throw e;
    });
    const { pool, paramValues } = makeStubPool();
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
        lockedBy: 'worker-stub',
      },
      pool,
      ai,
      noopLogger,
      { aiConfig: stubAiConfig },
    );
    expect(failTaskUpdateIsPermanent(paramValues)).toBe(true);
  });

  it('default failure kind is transient (retries within max_attempts)', async () => {
    const d = new Dispatcher();
    d.register('fetch_source', async () => {
      throw new Error('network blip');
    });
    const { pool, paramValues } = makeStubPool();
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
        lockedBy: 'worker-stub',
      },
      pool,
      ai,
      noopLogger,
      { aiConfig: stubAiConfig },
    );
    // attempts=1 < max_attempts=3 → CASE picks 'pending' branch. The
    // interpolated isPermanent must be false for the transient kind.
    expect(failTaskUpdateIsPermanent(paramValues)).toBe(false);
  });

  it('AIProviderError code=auth_error classifies as permanent', async () => {
    const d = new Dispatcher();
    d.register('fetch_source', async () => {
      throw new AIProviderError('bad creds', 'auth_error');
    });
    const { pool, paramValues } = makeStubPool();
    const ai = { name: 'template' } as unknown as import('@postdash/ai').AIProvider;
    await d.dispatch(
      {
        id: 't5',
        type: 'fetch_source',
        payload: {},
        attempts: 1,
        maxAttempts: 3,
        workspaceId: null,
        sourceId: 's1',
        lockedBy: 'worker-stub',
      },
      pool,
      ai,
      noopLogger,
      { aiConfig: stubAiConfig },
    );
    expect(failTaskUpdateIsPermanent(paramValues)).toBe(true);
  });

  it('AIProviderError code=rate_limit classifies as transient (retries to pending)', async () => {
    const d = new Dispatcher();
    d.register('fetch_source', async () => {
      throw new AIProviderError('slow down', 'rate_limit');
    });
    const { pool, paramValues } = makeStubPool();
    const ai = { name: 'template' } as unknown as import('@postdash/ai').AIProvider;
    await d.dispatch(
      {
        id: 't6',
        type: 'fetch_source',
        payload: {},
        attempts: 1,
        maxAttempts: 3,
        workspaceId: null,
        sourceId: 's1',
        lockedBy: 'worker-stub',
      },
      pool,
      ai,
      noopLogger,
      { aiConfig: stubAiConfig },
    );
    expect(failTaskUpdateIsPermanent(paramValues)).toBe(false);
  });

  it('AIProviderError code=parse_error classifies as permanent', async () => {
    const d = new Dispatcher();
    d.register('fetch_source', async () => {
      throw new AIProviderError('bad json', 'parse_error');
    });
    const { pool, paramValues } = makeStubPool();
    const ai = { name: 'template' } as unknown as import('@postdash/ai').AIProvider;
    await d.dispatch(
      {
        id: 't7',
        type: 'fetch_source',
        payload: {},
        attempts: 1,
        maxAttempts: 3,
        workspaceId: null,
        sourceId: 's1',
        lockedBy: 'worker-stub',
      },
      pool,
      ai,
      noopLogger,
      { aiConfig: stubAiConfig },
    );
    expect(failTaskUpdateIsPermanent(paramValues)).toBe(true);
  });
});
