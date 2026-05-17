/**
 * Task dispatcher: routes a leased task to its registered handler.
 *
 * Pure registry — handlers live in `handlers/*`. The `WorkerLoop` polls
 * tasks via `pollNextTask` and feeds them to `dispatch()`. On handler
 * success → `completeTask`; on throw → `failTask` with kind classification.
 *
 * Handler error contract: throw `Error` with `(err as { kind?: FailKind }).kind`
 * set to 'permanent' for non-retryable failures (4xx, validation, refused).
 * Default `transient` triggers retry-with-backoff up to max_attempts.
 */

import type { Logger } from 'pino';
import type { AIProvider } from '@postdash/ai';
import type { Database, Pool } from '@postdash/db';
import type postgres from 'postgres';
import {
  completeTask,
  enqueueTask,
  failTask,
  type EnqueueTaskInput,
  type FailKind,
  type PollResult,
  type TaskType,
} from '@postdash/tasks';

export interface TaskHandlerCtx {
  db: Database;
  client: postgres.Sql;
  ai: AIProvider;
  logger: Logger;
  enqueue(input: EnqueueTaskInput): Promise<{ id: string | null; created: boolean }>;
  /**
   * Provider-specific IAM refresh hook. Set by `loop.ts` only when the active
   * AI provider exposes a force-refresh seam (Yandex). TemplateProvider leaves
   * this undefined and the `refresh_iam_token` handler treats it as a no-op.
   * Keeping the seam on `ctx` (rather than monkey-patching the AIProvider) keeps
   * the AIProvider interface free of cache-specific methods.
   */
  iamRefresh?: () => Promise<void>;
  /**
   * Phase 4 dedup tunables, surfaced via ctx so handlers don't re-parse env on
   * every dispatch (module-level `parseAIEnv()` would also leak side effects
   * across vitest workers). `loop.ts` parses env once at construction time.
   */
  aiConfig: {
    dedupeCosineThreshold: number;
    dedupeWindowHours: number;
  };
}

export type TaskHandler = (task: PollResult, ctx: TaskHandlerCtx) => Promise<void>;

export class Dispatcher {
  private readonly handlers = new Map<TaskType, TaskHandler>();

  register(type: TaskType, handler: TaskHandler): this {
    this.handlers.set(type, handler);
    return this;
  }

  registered(type: TaskType): boolean {
    return this.handlers.has(type);
  }

  /**
   * Run the handler for `task`. Returns once the task has been transitioned
   * to a terminal state (`completed` or `failed*`). Never throws.
   */
  async dispatch(
    task: PollResult,
    pool: Pool,
    ai: AIProvider,
    logger: Logger,
    opts: {
      iamRefresh?: () => Promise<void>;
      aiConfig: TaskHandlerCtx['aiConfig'];
    },
  ): Promise<void> {
    const handler = this.handlers.get(task.type);
    if (!handler) {
      logger.error({ taskId: task.id, type: task.type }, 'no handler registered for task type');
      await failTask(
        pool.client,
        task.id,
        {
          kind: 'permanent',
          message: `no handler for ${task.type}`,
        },
        task.lockedBy,
      );
      return;
    }
    const childLogger = logger.child({ taskId: task.id, type: task.type, attempt: task.attempts });
    const ctx: TaskHandlerCtx = {
      db: pool.db,
      client: pool.client,
      ai,
      logger: childLogger,
      enqueue: (input) => enqueueTask(pool.db, input),
      aiConfig: opts.aiConfig,
      ...(opts.iamRefresh ? { iamRefresh: opts.iamRefresh } : {}),
    };
    try {
      await handler(task, ctx);
      await completeTask(pool.client, task.id, task.lockedBy);
      childLogger.info('task completed');
    } catch (err) {
      const kind = classifyFailure(err);
      const message = err instanceof Error ? err.message : String(err);
      childLogger.warn({ kind, err: message }, 'task failed');
      try {
        await failTask(pool.client, task.id, { kind, message }, task.lockedBy);
      } catch (failErr) {
        childLogger.error({ err: failErr }, 'failTask itself failed; task may be stuck');
      }
    }
  }
}

function classifyFailure(err: unknown): FailKind {
  if (err && typeof err === 'object' && 'kind' in err) {
    const k = (err as { kind?: unknown }).kind;
    if (k === 'permanent' || k === 'transient') return k;
  }
  // Map AIProviderError codes to retry kinds.
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    // Permanent: handler will not succeed without operator intervention
    // (invalid creds, no implementation, validation failure, budget cap).
    if (
      code === 'parse_error' ||
      code === 'not_implemented' ||
      code === 'budget_exceeded' ||
      code === 'auth_error'
    ) {
      return 'permanent';
    }
    // Rate limit is worth backing off (default 'transient' already does this,
    // but we surface the case explicitly so a future policy change can branch
    // on it without re-reading the matrix).
    if (code === 'rate_limit') {
      return 'transient';
    }
  }
  return 'transient';
}
