import { describe, expect, it, vi } from 'vitest';
import { runIdempotent, type IdempotentWork } from '../idempotency.js';
import { CommandError } from '../errors.js';
import { makeMockDb } from './_mock-db.js';

const CTX = { commandType: 'TestCommand', idempotencyKey: 'key-1' };

function makeWork(): IdempotentWork<{ value: string }> & {
  executeMock: ReturnType<typeof vi.fn>;
  loadMock: ReturnType<typeof vi.fn>;
} {
  const executeMock = vi.fn(async () => ({
    objectType: 'user',
    objectId: 'usr-1',
    result: { value: 'fresh' },
  }));
  const loadMock = vi.fn(async () => ({ value: 'loaded' }));
  return {
    execute: executeMock,
    loadFromPointer: loadMock,
    executeMock,
    loadMock,
  };
}

describe('runIdempotent', () => {
  it('acquires a fresh slot, runs work + success-UPDATE in one transaction', async () => {
    const mock = makeMockDb({
      insertResults: [[{ id: 'slot-1' }]], // owns the slot
      updateResults: [[{ id: 'slot-1' }]], // success UPDATE affects the row
    });
    const work = makeWork();
    const out = await runIdempotent(mock.db, CTX, work);
    expect(out).toEqual({ replayed: false, result: { value: 'fresh' } });
    expect(work.executeMock).toHaveBeenCalledOnce();
    expect(work.loadMock).not.toHaveBeenCalled();
    // The success-UPDATE now runs INSIDE the work transaction (crash-safety:
    // the slot transition commits atomically with the work's rows).
    expect(mock.calls).toEqual(['insert', 'transaction', 'update']);
  });

  it('replays a cached success via loadFromPointer', async () => {
    const mock = makeMockDb({
      insertResults: [[]], // conflict — someone else owns it
      selectResults: [[{ status: 'success', resultObjectType: 'user', resultObjectId: 'usr-1' }]],
    });
    const work = makeWork();
    const out = await runIdempotent(mock.db, CTX, work);
    expect(out).toEqual({ replayed: true, result: { value: 'loaded' } });
    expect(work.executeMock).not.toHaveBeenCalled();
    expect(work.loadMock).toHaveBeenCalledOnce();
  });

  it('throws idempotency_replay_in_progress for an unexpired pending slot', async () => {
    const future = new Date(Date.now() + 60_000);
    const mock = makeMockDb({
      insertResults: [[]],
      selectResults: [[{ status: 'pending', expiresAt: future }]],
    });
    await expect(runIdempotent(mock.db, CTX, makeWork())).rejects.toMatchObject({
      code: 'idempotency_replay_in_progress',
    });
  });

  it('reclaims an expired pending slot and retries once', async () => {
    const past = new Date(Date.now() - 60_000);
    const mock = makeMockDb({
      // 1st insert: conflict. 2nd insert (after reclaim): owns slot.
      insertResults: [[], [{ id: 'slot-2' }]],
      selectResults: [[{ id: 'slot-old', status: 'pending', expiresAt: past }]],
      updateResults: [[{ id: 'slot-2' }]],
    });
    const work = makeWork();
    const out = await runIdempotent(mock.db, CTX, work);
    expect(out).toEqual({ replayed: false, result: { value: 'fresh' } });
    expect(mock.deleteCount).toBe(1); // reclaimed the stale pending row
    expect(work.executeMock).toHaveBeenCalledOnce();
  });

  it('reclaims an expired pending slot, then replays when a racer won the retry', async () => {
    // Two callers race the SAME expired pending slot. This caller reclaims it
    // (DELETE filtered by id+status='pending'), but by the time it retries the
    // INSERT, the racing reclaimer has already re-acquired the slot AND run the
    // work to completion. The retry INSERT therefore conflicts again, and the
    // now-'success' row must be replayed via loadFromPointer — not re-executed.
    const past = new Date(Date.now() - 60_000);
    const mock = makeMockDb({
      // 1st insert: conflict (stale pending row exists).
      // 2nd insert (after reclaim): conflict again — the racer re-acquired it.
      insertResults: [[], []],
      selectResults: [
        [{ id: 'slot-old', status: 'pending', expiresAt: past }],
        // After our reclaim+retry, the racer's run is already 'success'.
        [{ status: 'success', resultObjectType: 'user', resultObjectId: 'usr-1' }],
      ],
    });
    const work = makeWork();
    const out = await runIdempotent(mock.db, CTX, work);
    expect(out).toEqual({ replayed: true, result: { value: 'loaded' } });
    expect(mock.deleteCount).toBe(1); // we reclaimed the stale row once
    expect(work.executeMock).not.toHaveBeenCalled(); // racer did the work
    expect(work.loadMock).toHaveBeenCalledOnce();
  });

  it('throws conflict when the success-UPDATE matches 0 rows after reclaim+retry', async () => {
    // This caller reclaims an expired pending slot and re-acquires it on retry,
    // runs work() — but a second reclaimer deleted our freshly-owned slot
    // underneath the execute(). The success-UPDATE (filtered by id+status) then
    // matches 0 rows and the conflict is raised from inside the transaction so
    // the work's writes roll back.
    const past = new Date(Date.now() - 60_000);
    const mock = makeMockDb({
      insertResults: [[], [{ id: 'slot-2' }]], // conflict, then own on retry
      selectResults: [[{ id: 'slot-old', status: 'pending', expiresAt: past }]],
      updateResults: [[]], // success UPDATE matched 0 rows — slot reclaimed again
    });
    const work = makeWork();
    await expect(runIdempotent(mock.db, CTX, work)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(work.executeMock).toHaveBeenCalledOnce();
    // One DELETE for our reclaim of the stale row, one for the failure-path
    // slot release after the conflict.
    expect(mock.deleteCount).toBe(2);
  });

  it('throws internal when reclaim depth is exceeded', async () => {
    const past = new Date(Date.now() - 60_000);
    const mock = makeMockDb({
      // Both inserts conflict; both selects show an expired pending row.
      insertResults: [[], []],
      selectResults: [
        [{ id: 'slot-old', status: 'pending', expiresAt: past }],
        [{ id: 'slot-old', status: 'pending', expiresAt: past }],
      ],
    });
    await expect(runIdempotent(mock.db, CTX, makeWork())).rejects.toMatchObject({
      code: 'internal',
    });
  });

  it('throws conflict when the slot is reclaimed underneath a slow execute()', async () => {
    const mock = makeMockDb({
      insertResults: [[{ id: 'slot-1' }]], // owns slot
      updateResults: [[]], // success UPDATE matched 0 rows — slot was reclaimed
    });
    const work = makeWork();
    await expect(runIdempotent(mock.db, CTX, work)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(work.executeMock).toHaveBeenCalledOnce();
  });

  it('releases the slot (DELETE) and rethrows when work() fails', async () => {
    const mock = makeMockDb({ insertResults: [[{ id: 'slot-1' }]] });
    const boom = new CommandError('validation_failed', 'boom');
    const work: IdempotentWork<{ value: string }> = {
      execute: async () => {
        throw boom;
      },
      loadFromPointer: async () => ({ value: 'never' }),
    };
    await expect(runIdempotent(mock.db, CTX, work)).rejects.toBe(boom);
    expect(mock.deleteCount).toBe(1);
  });

  it('throws internal when a conflicting row vanishes after ON CONFLICT DO NOTHING', async () => {
    const mock = makeMockDb({
      insertResults: [[]], // conflict
      selectResults: [[]], // ...but the row is gone
    });
    await expect(runIdempotent(mock.db, CTX, makeWork())).rejects.toMatchObject({
      code: 'internal',
    });
  });

  // Crash-safety regression (priority fix #2): the work's writes — including
  // the operation_log insert a real command performs — and the slot's
  // success-UPDATE must commit in ONE transaction. If they were two separate
  // commits, a crash in between would leave the slot 'pending' with the
  // operation_log row already committed; a PENDING_TTL reclaim would then
  // re-run the work and write a SECOND operation_log row for one logical call.
  it('runs work() and the success-UPDATE inside the same transaction', async () => {
    const mock = makeMockDb({
      insertResults: [[{ id: 'slot-1' }]],
      updateResults: [[{ id: 'slot-1' }]],
    });
    let txHandlePassedToWork: unknown;
    let executeRanInsideTransaction = false;
    const work: IdempotentWork<{ value: string }> = {
      execute: async (tx) => {
        txHandlePassedToWork = tx;
        // The mock records a 'transaction' call before invoking the work, so
        // by the time execute() runs the transaction is already open.
        executeRanInsideTransaction = mock.calls.includes('transaction');
        return { objectType: 'user', objectId: 'usr-1', result: { value: 'fresh' } };
      },
      loadFromPointer: async () => ({ value: 'never' }),
    };
    const out = await runIdempotent(mock.db, CTX, work);
    expect(out).toEqual({ replayed: false, result: { value: 'fresh' } });
    // work.execute() received a DB handle and ran inside the open transaction.
    expect(txHandlePassedToWork).toBeDefined();
    expect(executeRanInsideTransaction).toBe(true);
    // Slot INSERT first, then a single transaction wrapping the work and the
    // success-UPDATE. No DB write happens outside that transaction.
    expect(mock.calls).toEqual(['insert', 'transaction', 'update']);
  });

  // If the slot was reclaimed by a successor mid-execution, the success-UPDATE
  // matches 0 rows. The conflict must be raised from INSIDE the transaction so
  // the work's writes roll back — nothing may commit under a slot we lost.
  it('rolls back the work transaction when the slot was reclaimed mid-execution', async () => {
    const mock = makeMockDb({
      insertResults: [[{ id: 'slot-1' }]],
      updateResults: [[]], // success UPDATE matched 0 rows — slot reclaimed
    });
    const work = makeWork();
    await expect(runIdempotent(mock.db, CTX, work)).rejects.toMatchObject({
      code: 'conflict',
    });
    // The conflict surfaced from within the transaction (it ran), and the
    // failure path then released the slot row we still nominally owned.
    expect(mock.calls).toContain('transaction');
    expect(mock.deleteCount).toBe(1);
  });
});
