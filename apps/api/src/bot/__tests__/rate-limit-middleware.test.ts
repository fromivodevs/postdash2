/**
 * Tests the grammy rate-limit middleware path (not just the RateLimiter class).
 *
 * The plan promised "bot rate-limit fires after 10 requests/min". The unit
 * tests in rate-limit.test.ts cover the counter; this covers the middleware
 * wiring: an over-limit update must NOT call `next()` (the update is silently
 * dropped), while updates without a from-user always pass through.
 */

import { describe, expect, it } from 'vitest';
import type { Context } from 'grammy';
import { createRateLimitMiddleware } from '../bot.js';
import { RateLimiter } from '../rate-limit.js';
import type { BotLogger } from '../bot.js';

const silentLogger: BotLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
};

/** Minimal fake Context: only `from.id` is read by the middleware. */
function fakeContext(fromId: number | undefined): Context {
  return { from: fromId === undefined ? undefined : { id: fromId } } as unknown as Context;
}

describe('createRateLimitMiddleware', () => {
  it('drops the 11th message from one user (does not call next)', async () => {
    const nowMs = 1_000_000;
    const limiter = new RateLimiter({ windowMs: 60_000, maxPerWindow: 10, now: () => nowMs });
    const mw = createRateLimitMiddleware(limiter, () => silentLogger);
    const ctx = fakeContext(42);

    let nextCalls = 0;
    const next = async (): Promise<void> => {
      nextCalls += 1;
    };

    for (let i = 0; i < 10; i++) {
      await mw(ctx, next);
    }
    expect(nextCalls).toBe(10);

    // 11th within the same window: dropped, next() not called.
    await mw(ctx, next);
    expect(nextCalls).toBe(10);
  });

  it('lets a different user through after another user is limited', async () => {
    const nowMs = 1_000_000;
    const limiter = new RateLimiter({ windowMs: 60_000, maxPerWindow: 1, now: () => nowMs });
    const mw = createRateLimitMiddleware(limiter, () => silentLogger);

    let nextCalls = 0;
    const next = async (): Promise<void> => {
      nextCalls += 1;
    };

    await mw(fakeContext(1), next); // user 1: allowed
    await mw(fakeContext(1), next); // user 1: dropped
    await mw(fakeContext(2), next); // user 2: independent bucket, allowed
    expect(nextCalls).toBe(2);
  });

  it('always passes through updates without a from-user', async () => {
    const limiter = new RateLimiter({ maxPerWindow: 1 });
    const mw = createRateLimitMiddleware(limiter, () => silentLogger);

    let nextCalls = 0;
    const next = async (): Promise<void> => {
      nextCalls += 1;
    };

    // No from-user: channel post / system update — never rate-limited.
    await mw(fakeContext(undefined), next);
    await mw(fakeContext(undefined), next);
    await mw(fakeContext(undefined), next);
    expect(nextCalls).toBe(3);
  });
});
