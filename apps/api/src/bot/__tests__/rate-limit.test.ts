import { describe, expect, it, vi } from 'vitest';
import { RateLimiter } from '../rate-limit.js';

describe('RateLimiter', () => {
  it('accepts up to maxPerWindow then rejects', () => {
    const nowMs = 1_000_000;
    const limiter = new RateLimiter({
      windowMs: 60_000,
      maxPerWindow: 3,
      now: () => nowMs,
    });
    const user = 42n;
    expect(limiter.consume(user)).toBe(true);
    expect(limiter.consume(user)).toBe(true);
    expect(limiter.consume(user)).toBe(true);
    expect(limiter.consume(user)).toBe(false);
    expect(limiter.consume(user)).toBe(false);
  });

  it('resets the bucket after the window elapses', () => {
    let nowMs = 1_000_000;
    const limiter = new RateLimiter({
      windowMs: 60_000,
      maxPerWindow: 2,
      now: () => nowMs,
    });
    const user = 7n;
    expect(limiter.consume(user)).toBe(true);
    expect(limiter.consume(user)).toBe(true);
    expect(limiter.consume(user)).toBe(false);
    nowMs += 60_000;
    expect(limiter.consume(user)).toBe(true);
  });

  it('tracks per-user state independently', () => {
    const limiter = new RateLimiter({ maxPerWindow: 1 });
    expect(limiter.consume(1n)).toBe(true);
    expect(limiter.consume(2n)).toBe(true);
    expect(limiter.consume(1n)).toBe(false);
    expect(limiter.consume(2n)).toBe(false);
  });

  it('sweep() drops elapsed buckets to bound memory', () => {
    let nowMs = 0;
    const limiter = new RateLimiter({
      windowMs: 10_000,
      maxPerWindow: 5,
      now: () => nowMs,
    });
    limiter.consume(1n);
    limiter.consume(2n);
    expect(limiter.size()).toBe(2);
    nowMs += 10_000;
    limiter.sweep();
    expect(limiter.size()).toBe(0);
  });

  it('evicts the oldest bucket when maxBuckets is exceeded by a distinct-id flood', () => {
    const nowMs = 1_000_000;
    const limiter = new RateLimiter({
      windowMs: 60_000,
      maxPerWindow: 10,
      maxBuckets: 3,
      now: () => nowMs,
    });
    // All four ids consume within the same (non-elapsed) window, so sweep()
    // frees nothing and the oldest-window bucket must be evicted instead.
    limiter.consume(1n);
    limiter.consume(2n);
    limiter.consume(3n);
    expect(limiter.size()).toBe(3);
    limiter.consume(4n);
    // Still capped at 3, and the oldest (user 1) was evicted.
    expect(limiter.size()).toBe(3);
    // User 1's bucket is gone: a fresh consume re-creates it (returns true),
    // which would not happen had its count survived past maxPerWindow.
    expect(limiter.consume(1n)).toBe(true);
    expect(limiter.size()).toBe(3);
  });

  it('evicts an already-over-limit bucket before a near-limit legitimate one', () => {
    const nowMs = 1_000_000;
    const limiter = new RateLimiter({
      windowMs: 60_000,
      maxPerWindow: 3,
      maxBuckets: 2,
      now: () => nowMs,
    });
    // User 1: a legitimate near-limit user (2 of 3 used) — inserted first, so
    // pure insertion-order eviction would wrongly pick them.
    limiter.consume(1n);
    limiter.consume(1n);
    // User 2: a spammer, already AT the limit (3 of 3 used, next would reject).
    limiter.consume(2n);
    limiter.consume(2n);
    limiter.consume(2n);
    expect(limiter.consume(2n)).toBe(false); // user 2 is rate-limited
    expect(limiter.size()).toBe(2);

    // A fresh id arrives at capacity: the over-limit user 2 must be evicted,
    // NOT the near-limit user 1.
    limiter.consume(3n);
    expect(limiter.size()).toBe(2);
    // User 1 survived with their count intact: they get exactly ONE more
    // accept before the limit, proving their counter was not reset.
    expect(limiter.consume(1n)).toBe(true);
    expect(limiter.consume(1n)).toBe(false);
  });

  it('fires onLastResortEviction only when an in-window, not-rate-limited bucket is evicted', () => {
    const nowMs = 1_000_000;
    const onLastResortEviction = vi.fn();
    const limiter = new RateLimiter({
      windowMs: 60_000,
      maxPerWindow: 10,
      maxBuckets: 2,
      now: () => nowMs,
      onLastResortEviction,
    });
    // Two legitimate, in-window, under-limit users fill capacity.
    limiter.consume(1n);
    limiter.consume(2n);
    expect(onLastResortEviction).not.toHaveBeenCalled();
    // A third distinct id arrives: sweep frees nothing, no bucket is
    // rate-limited, so the last-resort branch evicts an in-window bucket.
    limiter.consume(3n);
    expect(onLastResortEviction).toHaveBeenCalledOnce();
  });

  it('does NOT fire onLastResortEviction when an already-rate-limited bucket is the victim', () => {
    const nowMs = 1_000_000;
    const onLastResortEviction = vi.fn();
    const limiter = new RateLimiter({
      windowMs: 60_000,
      maxPerWindow: 3,
      maxBuckets: 2,
      now: () => nowMs,
      onLastResortEviction,
    });
    // User 1 under-limit (1 of 3); user 2 driven AT the limit (3 of 3) — a
    // safe, "free" victim the eviction logic prefers over user 1.
    limiter.consume(1n);
    limiter.consume(2n);
    limiter.consume(2n);
    limiter.consume(2n);
    // A third id at capacity: user 2 (already rate-limited) is evicted, so the
    // last-resort branch is never reached.
    limiter.consume(3n);
    expect(onLastResortEviction).not.toHaveBeenCalled();
  });

  it('prefers an opportunistic sweep over eviction when buckets have elapsed', () => {
    let nowMs = 0;
    const limiter = new RateLimiter({
      windowMs: 10_000,
      maxPerWindow: 10,
      maxBuckets: 2,
      now: () => nowMs,
    });
    limiter.consume(1n);
    limiter.consume(2n);
    expect(limiter.size()).toBe(2);
    // Advance past the window so both existing buckets are sweep-eligible.
    nowMs = 20_000;
    limiter.consume(3n);
    // sweep() cleared the two elapsed buckets; only user 3 remains — no
    // forced eviction of a live bucket was needed.
    expect(limiter.size()).toBe(1);
  });

  it('starts auto-sweep when sweepIntervalMs is provided and stop() clears it', async () => {
    let nowMs = 0;
    const limiter = new RateLimiter({
      windowMs: 50,
      maxPerWindow: 5,
      sweepIntervalMs: 20,
      now: () => nowMs,
    });
    limiter.consume(1n);
    expect(limiter.size()).toBe(1);
    // Advance the simulated clock past the window so sweep can drop the bucket.
    nowMs = 100;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(limiter.size()).toBe(0);
    limiter.stop();
    // Subsequent stop() should be a no-op.
    limiter.stop();
  });
});
