/**
 * Scripted mock of the Drizzle `Database` for unit tests.
 *
 * The real `Database` type is large and its query builder produces opaque SQL
 * expression objects we cannot introspect in a unit test. Instead, this mock
 * ignores `.where()`/`.from()`/etc. predicates entirely and returns *scripted*
 * rowsets in call order — one entry per `insert`, `select`, `update`, `delete`
 * chain. Tests assert behaviour by controlling what each chain "returns".
 *
 * `transaction(cb)` invokes `cb` with the same mock, so `tx` === `db` and the
 * scripted queues are shared — matching how the commands use a single handle.
 */

import type { Database } from '@postdash/db';

/**
 * A scripted chain outcome: either a rowset to resolve with, or an `Error` to
 * throw. Throwing lets a test simulate a DB-level failure (e.g. a unique
 * violation `{ code: '23505' }`) at a specific insert in the call sequence.
 */
export type MockResult = unknown[] | Error;

export interface MockDbScript {
  /** Outcomes of successive `insert(...)....returning()` chains (rowset or throw). */
  insertResults?: MockResult[];
  /** Outcomes of successive `select()...` chains (rowset or throw). */
  selectResults?: MockResult[];
  /** Outcomes of successive `update(...)....returning()` chains (rowset or throw). */
  updateResults?: MockResult[];
}

export interface MockDb {
  db: Database;
  /** Records: 'insert' | 'select' | 'update' | 'delete' | 'transaction' in call order. */
  calls: string[];
  insertCount: number;
  selectCount: number;
  updateCount: number;
  deleteCount: number;
}

export function makeMockDb(script: MockDbScript = {}): MockDb {
  const state = {
    calls: [] as string[],
    insertCount: 0,
    selectCount: 0,
    updateCount: 0,
    deleteCount: 0,
  };
  const insertResults = script.insertResults ?? [];
  const selectResults = script.selectResults ?? [];
  const updateResults = script.updateResults ?? [];

  // A scripted outcome resolves to a rowset, or — if the script entry is an
  // `Error` — throws it, simulating a DB-level failure mid-chain.
  const settle = (outcome: MockResult | undefined): unknown[] => {
    if (outcome instanceof Error) throw outcome;
    return outcome ?? [];
  };

  // A thenable proxy: every builder method returns the same proxy, and
  // `await`-ing it (or calling `.returning()`) resolves to the scripted rowset
  // (or rejects with the scripted error).
  const makeChain = (resolveRows: () => unknown[]): unknown => {
    const proxy: Record<string, unknown> = {};
    const passthrough = [
      'from',
      'where',
      'set',
      'values',
      'onConflictDoNothing',
      'innerJoin',
      'orderBy',
      'limit',
    ];
    for (const m of passthrough) proxy[m] = () => proxy;
    proxy['returning'] = async () => resolveRows();
    (proxy as { then: unknown }).then = (
      resolve: (v: unknown[]) => unknown,
      reject?: (e: unknown) => unknown,
    ): unknown => {
      try {
        return resolve(resolveRows());
      } catch (err) {
        if (reject) return reject(err);
        throw err;
      }
    };
    return proxy;
  };

  const handle: Record<string, unknown> = {
    insert: () => {
      state.calls.push('insert');
      const idx = state.insertCount;
      state.insertCount += 1;
      return makeChain(() => settle(insertResults[idx]));
    },
    select: () => {
      state.calls.push('select');
      const idx = state.selectCount;
      state.selectCount += 1;
      return makeChain(() => settle(selectResults[idx]));
    },
    update: () => {
      state.calls.push('update');
      const idx = state.updateCount;
      state.updateCount += 1;
      return makeChain(() => settle(updateResults[idx]));
    },
    delete: () => {
      state.calls.push('delete');
      state.deleteCount += 1;
      return makeChain(() => []);
    },
    transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
      state.calls.push('transaction');
      return work(handle);
    },
  };

  return {
    db: handle as unknown as Database,
    get calls() {
      return state.calls;
    },
    get insertCount() {
      return state.insertCount;
    },
    get selectCount() {
      return state.selectCount;
    },
    get updateCount() {
      return state.updateCount;
    },
    get deleteCount() {
      return state.deleteCount;
    },
  };
}
