import type { AIProvider } from '@postdash/ai';
import type { Pool } from '@postdash/db';
import type { Logger } from 'pino';

export interface WorkerLoopOptions {
  concurrency: number;
  pollIntervalMs: number;
  logger: Logger;
  pool?: Pool;
  ai?: AIProvider;
}

/**
 * Task polling loop.
 *
 * Phase 0: только структура, no-op loop. Реальный polling — Phase 4:
 * - FOR UPDATE SKIP LOCKED атомарный pull tasks;
 * - lease через locked_until (TASK_LEASE_MINUTES);
 * - dispatch по task.type;
 * - janitor cron (см. tg_mvp_plan/06-WORKERS-AND-INGESTION.md §16).
 */
export class WorkerLoop {
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: WorkerLoopOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.opts.logger.info(
      { concurrency: this.opts.concurrency, pollIntervalMs: this.opts.pollIntervalMs },
      'worker loop started (Phase 0: no tasks polled yet)',
    );
    this.schedule();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.opts.logger.info('worker loop stopped');
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.tick();
    }, this.opts.pollIntervalMs);
  }

  private tick(): void {
    // Phase 4: pull next pending task with FOR UPDATE SKIP LOCKED, dispatch by type.
    this.schedule();
  }
}
