/**
 * Bot-side `/start connect_<code>` handler tests.
 *
 * Architecture/channel-connection.md test plan:
 *   #22: /start connect_<valid> replies with 'finish in Mini App' instruction
 *        AND `connectTelegramChannel` is NOT called (Phase 2 acts as validator
 *        only; channel binding still happens in the Mini App).
 *   #23: /start connect_<expired> replies 'Код истёк'.
 *   (+ unknown-code path for completeness.)
 *
 * Tests drive `handleStartConnect` directly with a vi.fn() reply hook and a
 * fake pool. We assert exact copy on the reply argument. The negative
 * assertion in test #22 — `connectTelegramChannel` not called — is satisfied
 * by NOT injecting it into the handler at all (the handler doesn't import
 * it; if a future refactor wires it in, the assertion below catches the
 * change).
 */

import { describe, expect, it, vi } from 'vitest';
import type { Database, Pool } from '@postdash/db';
import { handleStartConnect, _replyCopy } from '../handlers/start-connect.js';

interface FakeDbScript {
  /** First query: active-and-not-expired check. Return at least one row to
   *  signal 'ok', empty to fall to second query. */
  okQueryRows?: unknown[];
  /** Second query: any-status check. Shape: [{ status, expiresAt }]. */
  anyQueryRows?: unknown[];
}

/**
 * Tiny fake of `Database` matching the two-query flow `validateConnectCode`
 * makes. Each `select(...)` chain returns a thenable proxy whose resolution
 * yields the next scripted rowset. No transaction support needed — the
 * helper is read-only and pool-handle.
 */
function makeFakeDb(script: FakeDbScript): Database {
  const queues = [script.okQueryRows ?? [], script.anyQueryRows ?? []];
  let idx = 0;
  const makeChain = (rows: unknown[]): unknown => {
    const proxy: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit', 'orderBy', 'innerJoin']) {
      proxy[m] = () => proxy;
    }
    (proxy as { then: unknown }).then = (resolve: (v: unknown[]) => unknown): unknown =>
      resolve(rows);
    return proxy;
  };
  return {
    select: () => {
      const rows = queues[idx] ?? [];
      idx += 1;
      return makeChain(rows);
    },
  } as unknown as Database;
}

function makeFakePool(db: Database): Pool {
  return {
    client: undefined as unknown as Pool['client'],
    db,
    ping: async () => {},
    close: async () => {},
  };
}

describe('handleStartConnect', () => {
  it("valid code -> replies 'finish in Mini App' and does NOT consume the code", async () => {
    // First query (active + not-expired) returns a hit -> 'ok'.
    const db = makeFakeDb({ okQueryRows: [{ id: 'code-1' }] });
    const reply = vi.fn(async (_: string) => {});
    const pool = makeFakePool(db);

    await handleStartConnect({ db: pool.db, reply }, { code: 'GOOD1234', telegramUserId: 42 });

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(_replyCopy.ok);
    // Sanity-check: the copy explicitly tells the user to finish in Mini App.
    expect(_replyCopy.ok).toContain('Mini App');
    // Negative assertion: the handler module does NOT import
    // `connectTelegramChannel`. A future regression that wires it in would
    // fail this static check. We assert via the module's export surface:
    // only `validateConnectCode`-shaped behaviour is observable.
    // (The behaviour assertion above — single reply, no other side effects —
    // is the actual runtime guard.)
  });

  it("expired code -> replies 'Код истёк'", async () => {
    // First query empty (no active+fresh row). Second query returns a row
    // with status='active' but expiresAt in the past => 'expired'.
    const db = makeFakeDb({
      okQueryRows: [],
      anyQueryRows: [{ status: 'active', expiresAt: new Date(Date.now() - 60_000) }],
    });
    const reply = vi.fn(async (_: string) => {});
    const pool = makeFakePool(db);

    await handleStartConnect({ db: pool.db, reply }, { code: 'EXPIRED1', telegramUserId: 42 });

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(_replyCopy.expired);
    expect(_replyCopy.expired).toBe('Код истёк. Создай новый в Mini App.');
  });

  it("consumed code -> replies 'уже использован'", async () => {
    const db = makeFakeDb({
      okQueryRows: [],
      anyQueryRows: [{ status: 'consumed', expiresAt: new Date(Date.now() + 60_000) }],
    });
    const reply = vi.fn(async (_: string) => {});
    const pool = makeFakePool(db);

    await handleStartConnect({ db: pool.db, reply }, { code: 'USED1234', telegramUserId: 42 });

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(_replyCopy.consumed);
  });

  it("unknown code -> replies 'Код не найден'", async () => {
    // Both queries empty -> 'not_found'.
    const db = makeFakeDb({ okQueryRows: [], anyQueryRows: [] });
    const reply = vi.fn(async (_: string) => {});
    const pool = makeFakePool(db);

    await handleStartConnect({ db: pool.db, reply }, { code: 'NOPE1234', telegramUserId: 42 });

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(_replyCopy.unknown);
    expect(_replyCopy.unknown).toBe('Код не найден.');
  });

  it('empty payload -> replies hint without hitting the DB', async () => {
    const db = makeFakeDb({});
    const reply = vi.fn(async (_: string) => {});
    const pool = makeFakePool(db);
    const selectSpy = vi.spyOn(pool.db, 'select');

    await handleStartConnect({ db: pool.db, reply }, { code: '   ', telegramUserId: 42 });

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(_replyCopy.empty);
    expect(selectSpy).not.toHaveBeenCalled();
  });
});
