/**
 * Phase 4 worker loop: polls `tasks` via packages/tasks and dispatches to
 * registered handlers. Also drives the in-process scheduler that enqueues
 * fetch_source + housekeeping.
 *
 * Single process, concurrency=N (env): each "slot" runs an independent
 * polling loop. When `pollNextTask` returns null, the slot sleeps for
 * `pollIntervalMs` before retrying. When it returns a task, the slot
 * dispatches synchronously, then immediately polls again (no sleep — we
 * want a busy worker to keep moving).
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { AIProvider } from '@postdash/ai';
import type { Pool } from '@postdash/db';
import { pollNextTask } from '@postdash/tasks';
import { Dispatcher } from './dispatcher.js';
import { Scheduler } from './scheduler.js';
import {
  clusterNewsHandler,
  embedNewsItemHandler,
  extractNewsItemHandler,
  fetchSourceHandler,
  janitorReleaseStuckTasksHandler,
  refreshIamTokenHandler,
} from './handlers/index.js';

export interface WorkerLoopOptions {
  concurrency: number;
  pollIntervalMs: number;
  leaseMinutes: number;
  logger: Logger;
  pool: Pool;
  ai: AIProvider;
  /** Set to 0 to disable scheduler ticks (tests). */
  schedulerFastTickMs?: number;
  schedulerSlowTickMs?: number;
}

export class WorkerLoop {
  private running = false;
  private slots: Array<{ id: string; timer: NodeJS.Timeout | null }> = [];
  private dispatcher: Dispatcher;
  private scheduler: Scheduler;
  private readonly workerId: string;

  constructor(private readonly opts: WorkerLoopOptions) {
    this.workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
    this.dispatcher = new Dispatcher()
      .register('fetch_source', fetchSourceHandler)
      .register('extract_news_item', extractNewsItemHandler)
      .register('embed_news_item', embedNewsItemHandler)
      .register('cluster_news', clusterNewsHandler)
      .register('janitor_release_stuck_tasks', janitorReleaseStuckTasksHandler)
      .register('refresh_iam_token', refreshIamTokenHandler);
    this.scheduler = new Scheduler({
      db: opts.pool.db,
      logger: opts.logger.child({ component: 'scheduler' }),
      // Defaults: 60s + 300s. Tests pass 0 to disable.
      fastTickMs: opts.schedulerFastTickMs ?? 60_000,
      slowTickMs: opts.schedulerSlowTickMs ?? 300_000,
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.opts.logger.info(
      {
        workerId: this.workerId,
        concurrency: this.opts.concurrency,
        pollIntervalMs: this.opts.pollIntervalMs,
      },
      'worker loop started',
    );
    for (let i = 0; i < this.opts.concurrency; i++) {
      const slot = { id: `${this.workerId}-${i}`, timer: null as NodeJS.Timeout | null };
      this.slots.push(slot);
      this.tickSlot(slot);
    }
    this.scheduler.start();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.scheduler.stop();
    for (const slot of this.slots) {
      if (slot.timer) {
        clearTimeout(slot.timer);
        slot.timer = null;
      }
    }
    this.opts.logger.info('worker loop stopped');
  }

  private tickSlot(slot: { id: string; timer: NodeJS.Timeout | null }): void {
    if (!this.running) return;
    void this.runOne(slot.id).then((didWork) => {
      if (!this.running) return;
      // No-work poll → back off for pollIntervalMs. Work done → poll again
      // immediately to drain the queue.
      slot.timer = setTimeout(() => this.tickSlot(slot), didWork ? 0 : this.opts.pollIntervalMs);
    });
  }

  private async runOne(slotId: string): Promise<boolean> {
    try {
      const task = await pollNextTask(this.opts.pool.client, slotId, this.opts.leaseMinutes);
      if (!task) return false;
      await this.dispatcher.dispatch(task, this.opts.pool, this.opts.ai, this.opts.logger);
      return true;
    } catch (err) {
      this.opts.logger.error({ err, slotId }, 'unhandled error in worker loop');
      return false;
    }
  }
}
