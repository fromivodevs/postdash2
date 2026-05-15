/**
 * In-memory fixed-window rate limiter per Telegram user.
 *
 * Phase 1 default: 10 messages / minute / user. Above that, the bot middleware
 * silently drops the update (per 12-EDGE-CASES.md §13.10 — "silently drop",
 * don't reply with spam).
 *
 * It is a fixed-window counter, not a sliding window: a user can send up to
 * `maxPerWindow` just before a window boundary and `maxPerWindow` again just
 * after, i.e. a ~2x burst across the boundary. That is acceptable for a bot
 * anti-spam guard at Phase 1 scale; a sliding window or token bucket can
 * replace this when abuse patterns justify the extra state.
 *
 * SINGLE-PROCESS ASSUMPTION (operational caveat): persistence is in-memory
 * only, and the counters live in THIS process's heap. The limiter is therefore
 * correct only when exactly one bot process is running (the Phase 1 deployment
 * topology). Run N bot processes behind the same bot token and each keeps its
 * own independent counters — the effective limit becomes N x `maxPerWindow`.
 * Horizontal scaling needs shared counters: Phase 8+ would move them to
 * Postgres or Redis. Until then, do not scale the bot process out.
 */

export interface RateLimitConfig {
  /** Window length in ms. Default 60_000 (one minute). */
  windowMs?: number;
  /** Max messages per window. Default 10. */
  maxPerWindow?: number;
  /** Override "now" for tests. */
  now?: () => number;
  /**
   * If set, RateLimiter starts a self-sweeping interval (ms) on construction.
   * Pass 0 or omit to leave the caller responsible for invoking sweep().
   * The interval is `.unref()`ed so it never holds the event loop open.
   */
  sweepIntervalMs?: number;
  /**
   * Hard ceiling on the number of tracked per-user buckets. The periodic
   * sweep already evicts elapsed windows, but between sweeps a flood of
   * distinct user ids (a spoofed-update storm) could grow the Map without
   * bound. On `consume`, if the cap is hit we first run an opportunistic
   * `sweep()`; if still at the cap, the oldest-window bucket is evicted to
   * make room. Default 50_000 — far above any realistic single-process bot
   * load, but a firm memory bound. Pass 0 to disable the cap.
   */
  maxBuckets?: number;
  /**
   * Invoked when `evictForCapacity` falls through to its last-resort branch —
   * evicting an in-window, not-yet-rate-limited bucket. That only happens under
   * a genuine distinct-id flood AND with every tracked bucket still active, so
   * it is an operational signal worth surfacing (a metric / warn log). The
   * earlier, "free" eviction branches (stale window, already-rate-limited) do
   * NOT fire this — they are normal steady-state behaviour.
   */
  onLastResortEviction?: () => void;
}

interface BucketState {
  count: number;
  windowStartMs: number;
}

/**
 * Fixed-window per-user rate limiter. In-memory and single-process only — see
 * the module doc-comment's SINGLE-PROCESS ASSUMPTION caveat: running more than
 * one bot process multiplies the effective limit, because each process counts
 * in its own heap.
 */
export class RateLimiter {
  private readonly buckets = new Map<bigint, BucketState>();
  private readonly windowMs: number;
  private readonly maxPerWindow: number;
  private readonly maxBuckets: number;
  private readonly now: () => number;
  private readonly onLastResortEviction: (() => void) | undefined;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: RateLimitConfig = {}) {
    this.windowMs = config.windowMs ?? 60_000;
    this.maxPerWindow = config.maxPerWindow ?? 10;
    this.maxBuckets = config.maxBuckets ?? 50_000;
    this.now = config.now ?? (() => Date.now());
    this.onLastResortEviction = config.onLastResortEviction;
    if (config.sweepIntervalMs && config.sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), config.sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  /** Stop the auto-sweep timer (idempotent). Call on app shutdown. */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Returns true if the message is allowed; false if rate-limited.
   * Increments the counter on accept; on reject the counter remains
   * (so a flood doesn't reset the window).
   */
  consume(telegramUserId: bigint): boolean {
    const nowMs = this.now();
    const bucket = this.buckets.get(telegramUserId);

    if (!bucket || nowMs - bucket.windowStartMs >= this.windowMs) {
      // Allocating a NEW bucket — enforce the hard cap so a storm of distinct
      // ids cannot grow the Map unboundedly between periodic sweeps.
      if (this.maxBuckets > 0 && this.buckets.size >= this.maxBuckets) {
        this.evictForCapacity();
      }
      this.buckets.set(telegramUserId, { count: 1, windowStartMs: nowMs });
      return true;
    }

    if (bucket.count >= this.maxPerWindow) {
      return false;
    }

    bucket.count += 1;
    return true;
  }

  /** Number of tracked buckets (for diagnostics). */
  size(): number {
    return this.buckets.size;
  }

  /** Drop buckets whose window has fully elapsed. Call periodically to bound memory. */
  sweep(): void {
    const nowMs = this.now();
    for (const [userId, bucket] of this.buckets) {
      if (nowMs - bucket.windowStartMs >= this.windowMs) {
        this.buckets.delete(userId);
      }
    }
  }

  /**
   * Make room when the bucket Map is at capacity: first try an opportunistic
   * sweep of elapsed windows; if that frees nothing (every bucket is still
   * inside its window — a genuine distinct-id flood), evict one bucket.
   *
   * Victim selection is NOT pure insertion order. A flood of fresh ids would
   * otherwise keep evicting the *oldest* bucket — which is the most likely to
   * belong to a legitimate near-limit user, handing the flood a way to reset
   * a real user's counter. So we prefer, in order:
   *   1. a bucket whose window has already elapsed (stale — losing it is free),
   *   2. a bucket already at/over maxPerWindow (the user is rate-limited
   *      anyway; dropping it at worst grants them a fresh window early, which
   *      is no worse than the window naturally rolling over),
   *   3. only failing both, the oldest in-window bucket as a last resort.
   * Exactness is not required; the goal is a firm memory bound that a flood
   * cannot weaponise against a legitimate user.
   */
  private evictForCapacity(): void {
    const sizeBefore = this.buckets.size;
    this.sweep();
    if (this.buckets.size < sizeBefore) return;

    const nowMs = this.now();
    let oldestInWindow: bigint | null = null;
    for (const [userId, bucket] of this.buckets) {
      if (nowMs - bucket.windowStartMs >= this.windowMs) {
        // Stale window — best possible victim, evict immediately.
        this.buckets.delete(userId);
        return;
      }
      if (bucket.count >= this.maxPerWindow) {
        // Already rate-limited — a safe victim, evict immediately.
        this.buckets.delete(userId);
        return;
      }
      // Track the longest-tracked in-window bucket as the last-resort victim.
      if (oldestInWindow === null) oldestInWindow = userId;
    }
    if (oldestInWindow !== null) {
      this.buckets.delete(oldestInWindow);
      // Last-resort eviction: a real flood with every bucket still in-window.
      // Surface it so operators see the pressure (the callback never throws
      // back into consume() — it is a fire-and-forget observability hook).
      this.onLastResortEviction?.();
    }
  }
}
