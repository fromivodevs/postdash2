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
import { type AIProvider, parseAIEnv } from '@postdash/ai';
import { parseWorkerEnv } from './env.js';
import type { Pool } from '@postdash/db';
import { pollNextTask } from '@postdash/tasks';
import { Dispatcher, type TaskHandlerCtx } from './dispatcher.js';
import { Scheduler } from './scheduler.js';
import {
  clusterNewsHandler,
  embedNewsItemHandler,
  extractNewsItemHandler,
  fetchSourceHandler,
  janitorReleaseStuckTasksHandler,
  matchNewsToWorkspacesHandler,
  recomputeTopicEmbeddingHandler,
  refreshIamTokenHandler,
  scoreWorkspaceMatchHandler,
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
  /**
   * Force-refresh hook for the IAM token cache the active provider consults.
   * Resolved once at construction time via the optional `AIProvider.iamRefresh`
   * seam — providers without IAM caching (TemplateProvider) leave the method
   * undefined and refresh_iam_token handler treats undefined as a no-op.
   * Pinning the hook here — instead of letting each task look it up — ensures
   * we operate on THE single IAMTokenCache instance, not a sibling whose
   * state diverges via system_state writethrough.
   */
  private readonly iamRefresh: (() => Promise<void>) | undefined;
  /**
   * AI tunables resolved once at construction time. Handlers consume these
   * via `ctx.aiConfig` rather than calling `parseAIEnv()` themselves, so a
   * handler module doesn't execute env-parsing as a side effect at import.
   */
  private readonly aiConfig: TaskHandlerCtx['aiConfig'];

  constructor(private readonly opts: WorkerLoopOptions) {
    this.workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
    if (typeof opts.ai.iamRefresh === 'function') {
      const refreshFn = opts.ai.iamRefresh.bind(opts.ai);
      this.iamRefresh = refreshFn;
    } else {
      this.iamRefresh = undefined;
    }
    const ai = parseAIEnv();
    const worker = parseWorkerEnv();
    this.aiConfig = {
      dedupeCosineThreshold: ai.AI_DEDUPE_COSINE_THRESHOLD,
      dedupeWindowHours: ai.AI_DEDUPE_WINDOW_HOURS,
      matchingMinCosine: worker.MATCHING_MIN_COSINE,
      autoDraftScoreThreshold: worker.AUTO_DRAFT_SCORE_THRESHOLD,
    };
    this.dispatcher = new Dispatcher()
      .register('fetch_source', fetchSourceHandler)
      .register('extract_news_item', extractNewsItemHandler)
      .register('embed_news_item', embedNewsItemHandler)
      .register('cluster_news', clusterNewsHandler)
      .register('janitor_release_stuck_tasks', janitorReleaseStuckTasksHandler)
      .register('refresh_iam_token', refreshIamTokenHandler)
      .register('match_news_to_workspaces', matchNewsToWorkspacesHandler)
      .register('score_workspace_match', scoreWorkspaceMatchHandler)
      .register('recompute_topic_embedding', recomputeTopicEmbeddingHandler);
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
      await this.dispatcher.dispatch(task, this.opts.pool, this.opts.ai, this.opts.logger, {
        aiConfig: this.aiConfig,
        ...(this.iamRefresh ? { iamRefresh: this.iamRefresh } : {}),
      });
      return true;
    } catch (err) {
      this.opts.logger.error({ err, slotId }, 'unhandled error in worker loop');
      return false;
    }
  }
}
