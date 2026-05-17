import { z } from 'zod';

/**
 * Exhaustive list of task types implemented in Phase 4. The DB CHECK
 * constraint in 0005_phase4.sql mirrors this set — `tasks_type_check` MUST
 * stay in lockstep. Adding a new type requires (1) a new constant here, (2)
 * an ALTER TABLE migration extending the CHECK, (3) a handler in
 * `apps/worker/src/handlers/*`, (4) registration in `apps/worker/loop.ts`.
 */
export const TASK_TYPES = [
  'fetch_source',
  'extract_news_item',
  'embed_news_item',
  'cluster_news',
  'janitor_release_stuck_tasks',
  'refresh_iam_token',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/**
 * State machine for task rows. Transitions enforced by the queue helpers
 * below; the CHECK constraint in `tasks_status_check` enforces the value
 * set at the DB layer.
 *
 *   pending → running → completed
 *                     → failed → pending (retry with backoff) → failed_permanent
 *                     → failed_permanent (4xx, validation, refused, exhausted)
 *   pending → deferred (Phase 6 cost cap; Phase 4 does not use this)
 *   pending → skipped_volume_cap (handler decision, not a transition we drive)
 *   pending → cancelled (admin action; not used in Phase 4)
 */
export const TASK_STATUSES = [
  'pending',
  'running',
  'completed',
  'failed',
  'failed_permanent',
  'deferred',
  'skipped_volume_cap',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface EnqueueTaskInput {
  type: TaskType;
  /** Free-form discriminator bag. Handlers parse via their own zod schema. */
  payload?: Record<string, unknown>;
  workspaceId?: string;
  sourceId?: string;
  priority?: number;
  scheduledAt?: Date;
  maxAttempts?: number;
}

export const EnqueueTaskInputSchema = z.object({
  type: z.enum(TASK_TYPES),
  payload: z.record(z.string(), z.unknown()).optional(),
  workspaceId: z.string().uuid().optional(),
  sourceId: z.string().uuid().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  scheduledAt: z.date().optional(),
  maxAttempts: z.number().int().positive().optional(),
});

export interface PollResult {
  id: string;
  type: TaskType;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  workspaceId: string | null;
  sourceId: string | null;
  /**
   * `workerId` that owns the current lease on this task. Mirrors the value
   * the caller passed to `pollNextTask` — surfaced on the result so the
   * dispatcher can pass it back into `completeTask`/`failTask` for the
   * lease-guarded UPDATE (`WHERE locked_by = $worker_id`). Without this round-
   * trip a janitor-released-then-re-leased task could be marked completed by
   * the original (now lost-lease) worker.
   */
  lockedBy: string;
}

/**
 * `transient` → retry with backoff up to `max_attempts`, then `failed_permanent`.
 * `permanent` → mark `failed_permanent` immediately (validation, 4xx, refused).
 *
 * Handlers throw `Error` with `(err as { kind?: FailKind }).kind` set to one
 * of these values; failTask reads it. Missing kind defaults to `transient`
 * (safer: a network hiccup shouldn't burn the task on the first try).
 */
export type FailKind = 'transient' | 'permanent';

export interface RetryPolicy {
  /** Backoff in seconds at attempt N (1-indexed). Index past the array re-uses the last value. */
  backoffSeconds: number[];
}

/**
 * Default exponential backoff: 10s → 30s → 90s. Matches §15 of
 * tg_mvp_plan/06-WORKERS-AND-INGESTION.md. With max_attempts=3, the third
 * failure flips to failed_permanent without a fourth retry.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  backoffSeconds: [10, 30, 90],
};
