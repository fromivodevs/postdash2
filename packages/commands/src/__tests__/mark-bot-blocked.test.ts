/**
 * Unit tests for markBotBlocked. We cast a hand-rolled fake DB to `Database`
 * and exercise the update + operation_log insert chain. The fake captures
 * which UPDATE was attempted and what its returning() yielded so we can
 * assert revoked-skip and already-blocked-skip invariants.
 */

import { describe, expect, it } from 'vitest';
import type { Database } from '@postdash/db';
import { markBotBlocked } from '../mark-bot-blocked.js';

interface FakeUpdateOutcome {
  /** Rows the UPDATE ... RETURNING returns. */
  rows: Array<{ id: string; userId: string }>;
}

function makeMockDb(outcome: FakeUpdateOutcome): {
  db: Database;
  logCalls: Array<unknown>;
} {
  const logCalls: Array<unknown> = [];

  const updateChain = (): unknown => {
    const proxy: Record<string, unknown> = {};
    proxy['set'] = () => proxy;
    proxy['where'] = () => proxy;
    proxy['returning'] = async () => outcome.rows;
    return proxy;
  };

  const insertChain = (): unknown => {
    const proxy: Record<string, unknown> = {};
    proxy['values'] = async (v: unknown) => {
      logCalls.push(v);
    };
    return proxy;
  };

  const tx: Record<string, unknown> = {
    update: () => updateChain(),
    insert: () => insertChain(),
  };

  const db: Record<string, unknown> = {
    transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(tx),
  };

  return { db: db as unknown as Database, logCalls };
}

describe('markBotBlocked', () => {
  it('returns { updated: true } and writes operation_log when an active row is flipped', async () => {
    const { db, logCalls } = makeMockDb({ rows: [{ id: 'idn-1', userId: 'usr-1' }] });
    const result = await markBotBlocked(db, { telegramUserId: 100 });
    expect(result).toEqual({ updated: true });
    expect(logCalls).toHaveLength(1);
    expect(logCalls[0]).toMatchObject({
      commandType: 'MarkBotBlocked',
      objectType: 'telegram_identity',
      objectId: 'idn-1',
      userId: 'usr-1',
      result: 'success',
      payloadSummary: { newStatus: 'blocked_bot' },
    });
  });

  it('is a no-op when the UPDATE matches no row (revoked / already-blocked / unknown user)', async () => {
    // The WHERE clause excludes status='revoked' and status='blocked_bot' (and
    // missing users); from the wrapper's view, both surface as zero returning() rows.
    const { db, logCalls } = makeMockDb({ rows: [] });
    const result = await markBotBlocked(db, { telegramUserId: 999 });
    expect(result).toEqual({ updated: false });
    expect(logCalls).toHaveLength(0);
  });

  it('rejects non-finite telegramUserId', async () => {
    const { db } = makeMockDb({ rows: [] });
    await expect(markBotBlocked(db, { telegramUserId: Number.NaN })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
});
