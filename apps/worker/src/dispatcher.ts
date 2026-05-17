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
  async dispatch(task: PollResult, pool: Pool, ai: AIProvider, logger: Logger): Promise<void> {
    const handler = this.handlers.get(task.type);
    if (!handler) {
      logger.error({ taskId: task.id, type: task.type }, 'no handler registered for task type');
      await failTask(pool.client, task.id, {
        kind: 'permanent',
        message: `no handler for ${task.type}`,
      });
      return;
    }
    const childLogger = logger.child({ taskId: task.id, type: task.type, attempt: task.attempts });
    const ctx: TaskHandlerCtx = {
      db: pool.db,
      client: pool.client,
      ai,
      logger: childLogger,
      enqueue: (input) => enqueueTask(pool.db, input),
    };
    try {
      await handler(task, ctx);
      await completeTask(pool.client, task.id);
      childLogger.info('task completed');
    } catch (err) {
      const kind = classifyFailure(err);
      const message = err instanceof Error ? err.message : String(err);
      childLogger.warn({ kind, err: message }, 'task failed');
      try {
        await failTask(pool.client, task.id, { kind, message });
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
    if (code === 'parse_error' || code === 'not_implemented' || code === 'budget_exceeded') {
      return 'permanent';
    }
  }
  return 'transient';
}
