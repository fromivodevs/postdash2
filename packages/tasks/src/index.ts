/**
 * Task queue primitives for the Phase 4 worker pool.
 *
 * Pure data layer: enqueue, atomic poll, complete/fail/defer + retry/backoff
 * policy. Handler logic lives in `apps/worker/src/handlers/*`. The split
 * keeps `packages/tasks` testable without spinning up any handler.
 *
 * See architecture/global-ingestion.md.
 */

export {
  TASK_TYPES,
  TASK_STATUSES,
  type TaskType,
  type TaskStatus,
  type EnqueueTaskInput,
  type PollResult,
  type FailKind,
  type RetryPolicy,
  DEFAULT_RETRY_POLICY,
} from './types.js';

export {
  enqueueTask,
  pollNextTask,
  completeTask,
  failTask,
  deferTask,
  releaseStuckTasks,
} from './queue.js';
