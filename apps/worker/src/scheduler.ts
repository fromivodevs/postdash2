/**
 * In-process scheduler.
 *
 * Two ticks:
 *   - **fast tick (1/min)** — enqueue `fetch_source` for every source whose
 *     `last_fetched_at + fetch_interval_minutes < now()` (or NULL = never fetched).
 *     Idempotent via the partial unique index `tasks_unique_active_fetch_per_source`:
 *     INSERT ... ON CONFLICT (source_id) WHERE ... DO NOTHING collapses
 *     duplicates when scheduler fires twice within one fetch_interval.
 *   - **slow tick (5/min)** — enqueue housekeeping tasks: janitor (release
 *     stuck running tasks) and refresh_iam_token if expiry < 1h away.
 *
 * Why in-process: see architecture/global-ingestion.md "Decision: in-process
 * scheduler". The partial unique indexes mean we don't need leader election
 * even across N worker replicas — concurrent scheduler ticks land on the
 * same DO NOTHING / DO NOTHING.
 *
 * Catch-up suppression: we never enqueue a backfill series after downtime.
 * One tick = one fetch task per due source = one current-state fetch.
 */

import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Database } from '@postdash/db';
import { enqueueTask } from '@postdash/tasks';

export interface SchedulerOptions {
  db: Database;
  logger: Logger;
  /** Set both intervals to 0 to disable ticks (tests). */
  fastTickMs: number;
  slowTickMs: number;
  /** Inject for tests; defaults to `Date.now()`. */
  now?: () => number;
}

export class Scheduler {
  private fastTimer: NodeJS.Timeout | null = null;
  private slowTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly opts: SchedulerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.opts.fastTickMs > 0) {
      this.scheduleFast();
    }
    if (this.opts.slowTickMs > 0) {
      this.scheduleSlow();
    }
    this.opts.logger.info(
      { fastTickMs: this.opts.fastTickMs, slowTickMs: this.opts.slowTickMs },
      'scheduler started',
    );
  }

  stop(): void {
    this.running = false;
    if (this.fastTimer) {
      clearTimeout(this.fastTimer);
      this.fastTimer = null;
    }
    if (this.slowTimer) {
      clearTimeout(this.slowTimer);
      this.slowTimer = null;
    }
  }

  private scheduleFast(): void {
    if (!this.running) return;
    this.fastTimer = setTimeout(() => {
      this.fastTick().finally(() => this.scheduleFast());
    }, this.opts.fastTickMs);
  }

  private scheduleSlow(): void {
    if (!this.running) return;
    this.slowTimer = setTimeout(() => {
      this.slowTick().finally(() => this.scheduleSlow());
    }, this.opts.slowTickMs);
  }

  /**
   * Enqueue fetch_source for every due source. "Due" means:
   *   - status='active' AND its configured fetch_interval_minutes has elapsed, OR
   *   - status='error' AND at least 60 minutes have elapsed since the last
   *     attempt (regardless of fetch_interval_minutes).
   *
   * The 'error' branch is what makes the handler-driven recovery path
   * (fetch-source flips error→active on a successful fetch) actually
   * reachable. Without it, an error source is never enqueued, the handler
   * never runs, and the source stays in 'error' forever until an operator
   * manually unflips it. The 60-minute floor keeps the retry budget under
   * control: a permanently broken feed costs at most one fetch per hour
   * instead of one fetch per fetch_interval (which could be 5 minutes).
   *
   * The 60-minute interval is hardcoded for the MVP; promotable to an env
   * var (e.g. `SOURCES_ERROR_RETRY_INTERVAL_MINUTES`) later if operators
   * need different cadences per environment — tracked in
   * architecture/global-ingestion.md "Known follow-ups".
   *
   * Exposed for tests (no setTimeout dependency).
   */
  async fastTick(): Promise<{ enqueued: number }> {
    let enqueued = 0;
    try {
      // Single-statement bulk enqueue. The previous loop did N+1 round-trips
      // (one SELECT + N INSERTs); at ~hundreds of due sources per tick the
      // RTT cost dominated the tick. The CTE-then-INSERT collapses that to
      // one statement and preserves the anti-dupe semantics via the existing
      // partial UNIQUE `tasks_unique_active_fetch_per_source` (defined in
      // 0005_phase4.sql). LIMIT 500 caps the per-tick batch — if more than
      // 500 are due, the next tick (1 minute later) picks up the remainder;
      // this bounds the worst-case INSERT footprint and the tail latency of
      // any single tick.
      //
      // The ON CONFLICT clause names the partial-index target explicitly
      // (`(source_id) WHERE type='fetch_source' AND status IN (...)`) instead
      // of the looser unqualified `ON CONFLICT DO NOTHING`. Behaviour is
      // identical for this row shape, but the explicit target lets the
      // planner pick the exact partial unique without enumerating every
      // tasks-table constraint — same hint as `ON CONFLICT (col) WHERE ...`
      // upserts elsewhere in the codebase.
      const inserted = (await this.opts.db.execute(sql`
        WITH due AS (
          SELECT id FROM sources
          WHERE type = 'rss'
            AND (
              (status = 'active' AND (
                last_fetched_at IS NULL
                OR last_fetched_at + (fetch_interval_minutes * interval '1 minute') < now()
              ))
              OR
              (status = 'error' AND (
                last_fetched_at IS NULL
                OR last_fetched_at + interval '60 minutes' < now()
              ))
            )
          LIMIT 500
        )
        INSERT INTO tasks (type, priority, source_id, payload, status, scheduled_at)
        SELECT 'fetch_source', 40, id, '{}'::jsonb, 'pending', now()
        FROM due
        ON CONFLICT (source_id) WHERE type = 'fetch_source' AND status IN ('pending', 'running') DO NOTHING
        RETURNING id
      `)) as Array<{ id: string }>;
      enqueued = inserted.length;
      // Always emit fastTick heartbeat (even when enqueued=0) so ops can grep
      // for last-success timestamp — Phase 4 has no /health endpoint yet
      // (Phase 8 follow-up), so this log line is the only signal that the
      // scheduler is alive. See apps/worker/RUNBOOK.md.
      this.opts.logger.info({ enqueued, tick: 'fast' }, 'scheduler fastTick complete');
    } catch (err) {
      this.opts.logger.error({ err }, 'scheduler fastTick failed');
    }
    return { enqueued };
  }

  /**
   * Enqueue housekeeping tasks. Exposed for tests.
   */
  async slowTick(): Promise<{ janitorEnqueued: boolean; iamRefreshEnqueued: boolean }> {
    let janitorEnqueued = false;
    let iamRefreshEnqueued = false;
    try {
      const j = await enqueueTask(this.opts.db, { type: 'janitor_release_stuck_tasks' });
      janitorEnqueued = j.created;

      // Enqueue refresh_iam_token if expiry is within 1h. Reads system_state
      // directly so a missing row (cold-start) also triggers enqueue.
      const rows = (await this.opts.db.execute(sql`
        SELECT expires_at FROM system_state WHERE key = 'ya_iam_token' LIMIT 1
      `)) as Array<{ expires_at: Date | null }>;
      const row = rows[0];
      const nowMs = (this.opts.now ?? Date.now)();
      const expiresMs = row?.expires_at ? row.expires_at.getTime() : 0;
      const REFRESH_LEAD_MS = 60 * 60 * 1000;
      if (expiresMs - REFRESH_LEAD_MS < nowMs) {
        const r = await enqueueTask(this.opts.db, { type: 'refresh_iam_token' });
        iamRefreshEnqueued = r.created;
      }
      // Same heartbeat pattern as fastTick — single log line per tick so ops
      // can confirm the slow scheduler is alive without a /health endpoint.
      this.opts.logger.info(
        { janitorEnqueued, iamRefreshEnqueued, tick: 'slow' },
        'scheduler slowTick complete',
      );
    } catch (err) {
      this.opts.logger.error({ err }, 'scheduler slowTick failed');
    }
    return { janitorEnqueued, iamRefreshEnqueued };
  }
}
