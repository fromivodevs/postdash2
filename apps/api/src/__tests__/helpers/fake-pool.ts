/**
 * Scripted fake `Pool` for route-level integration tests.
 *
 * The real `Pool` needs a live Postgres. Route tests instead drive the actual
 * HTTP handlers (`buildApp(...).inject(...)`) with a fake pool whose `db`
 * returns *scripted* rowsets in call order — the same approach as
 * `packages/commands/src/__tests__/_mock-db.ts`, lifted here so the api
 * package can exercise `authenticateTelegram` / `readCurrentUser` through the
 * route boundary without a database.
 *
 * The query builder is a thenable proxy: every builder method
 * (`from`/`where`/`values`/`onConflictDoNothing`/...) returns the same proxy,
 * and `await`-ing it (or calling `.returning()`) resolves to the next scripted
 * rowset for that operation kind. `transaction(cb)` runs `cb` with the same
 * handle, so `tx` === `db` and the scripted queues are shared — matching how
 * the commands use a single handle inside and outside the transaction.
 */

import type { Database, Pool } from '@postdash/db';

export interface FakeDbScript {
  /** Rowsets returned by successive `insert(...)` chains, in call order. */
  insertResults?: unknown[][];
  /** Rowsets returned by successive `select()` chains, in call order. */
  selectResults?: unknown[][];
  /** Rowsets returned by successive `update(...)` chains, in call order. */
  updateResults?: unknown[][];
}

export interface FakePool {
  pool: Pool;
  /** Operation kinds recorded in call order. */
  calls: string[];
}

export function makeFakePool(script: FakeDbScript = {}): FakePool {
  const state = {
    calls: [] as string[],
    insertCount: 0,
    selectCount: 0,
    updateCount: 0,
  };
  const insertResults = script.insertResults ?? [];
  const selectResults = script.selectResults ?? [];
  const updateResults = script.updateResults ?? [];

  const makeChain = (resolveRows: () => unknown[]): unknown => {
    const proxy: Record<string, unknown> = {};
    const passthrough = [
      'from',
      'where',
      'set',
      'values',
      'onConflictDoNothing',
      'onConflictDoUpdate',
      'innerJoin',
      'leftJoin',
      'rightJoin',
      'fullJoin',
      'groupBy',
      'having',
      'orderBy',
      'limit',
      'offset',
      'for',
    ];
    for (const m of passthrough) proxy[m] = () => proxy;
    proxy['returning'] = async () => resolveRows();
    (proxy as { then: unknown }).then = (resolve: (v: unknown[]) => unknown): unknown =>
      resolve(resolveRows());
    return proxy;
  };

  const handle: Record<string, unknown> = {
    insert: () => {
      state.calls.push('insert');
      const idx = state.insertCount;
      state.insertCount += 1;
      return makeChain(() => insertResults[idx] ?? []);
    },
    select: () => {
      state.calls.push('select');
      const idx = state.selectCount;
      state.selectCount += 1;
      return makeChain(() => selectResults[idx] ?? []);
    },
    update: () => {
      state.calls.push('update');
      const idx = state.updateCount;
      state.updateCount += 1;
      return makeChain(() => updateResults[idx] ?? []);
    },
    delete: () => {
      state.calls.push('delete');
      return makeChain(() => []);
    },
    transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
      state.calls.push('transaction');
      return work(handle);
    },
  };

  const pool: Pool = {
    client: undefined as unknown as Pool['client'],
    db: handle as unknown as Database,
    ping: async () => {
      /* always healthy in route tests */
    },
    close: async () => {
      /* nothing to close */
    },
  };

  return {
    pool,
    get calls() {
      return state.calls;
    },
  };
}
