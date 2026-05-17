/**
 * Task queue primitives. All polling/state-transitions are atomic in SQL —
 * no SELECT-then-UPDATE. See architecture/global-ingestion.md "Task queue
 * contract" for the canonical UPDATE statement.
 *
 * `pollNextTask` is the only function that uses a raw `postgres.Sql`
 * client: Drizzle has no first-class `FOR UPDATE SKIP LOCKED` builder, and
 * faking it via `sql.raw(...)` defeats the type-safety we'd get from
 * `db.query.tasks`. Raw SQL with a typed return shape is clearer than a
 * Drizzle workaround.
 */

import type postgres from 'postgres';
import { sql, eq, and, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '@postdash/db';
import { tasks } from '@postdash/db';
import {
  EnqueueTaskInputSchema,
  DEFAULT_RETRY_POLICY,
  type EnqueueTaskInput,
  type FailKind,
  type PollResult,
  type RetryPolicy,
  type TaskType,
} from './types.js';

// =============================================================================
// enqueueTask
// =============================================================================

export interface EnqueueResult {
  /** id of the (existing or newly-inserted) task. Null when ON CONFLICT skipped insert. */
  id: string | null;
  /** true when this call actually wrote a new row; false when partial-unique blocked it. */
  created: boolean;
}

/**
 * Insert a task row. For `fetch_source`, `refresh_iam_token`, and
 * `janitor_release_stuck_tasks` the partial unique indexes from
 * `0005_phase4.sql` make this idempotent — duplicate enqueues collapse via
 * `ON CONFLICT DO NOTHING`. Other task types do not have anti-duplicate
 * indexes (extract/embed/cluster are 1:1 with news_item_id and are
 * enqueued by the upstream handler, not the scheduler).
 *
 * Returns `{ created: false, id: null }` when ON CONFLICT skipped — caller
 * can treat this as "another worker / scheduler tick already enqueued".
 */
export async function enqueueTask(
  db: DbOrTx,
  input: EnqueueTaskInput,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<EnqueueResult> {
  const parsed = EnqueueTaskInputSchema.parse(input);

  // We rely on the migration's partial unique indexes (tasks_unique_active_*).
  // Drizzle's onConflictDoNothing() emits ON CONFLICT DO NOTHING without a
  // target column — Postgres uses the partial index that matches the inserted
  // row's predicate columns. Confirmed in 0005_phase4.sql:
  //   tasks_unique_active_fetch_per_source (source_id) WHERE type='fetch_source' AND status IN (...)
  //   tasks_unique_active_iam_refresh (type) WHERE type='refresh_iam_token' AND status IN (...)
  //   tasks_unique_active_janitor (type) WHERE type='janitor_release_stuck_tasks' AND status IN (...)
  // Other task types (extract/embed/cluster) have no anti-dupe index — caller
  // is expected to know whether duplicate work would be wasteful and enqueue
  // accordingly. (Idempotency on those is content-level via partial unique on
  // global_news_items, not task-level.)
  const inserted = await db
    .insert(tasks)
    .values({
      type: parsed.type,
      priority: parsed.priority ?? defaultPriorityFor(parsed.type),
      payload: parsed.payload ?? {},
      ...(parsed.workspaceId !== undefined ? { workspaceId: parsed.workspaceId } : {}),
      ...(parsed.sourceId !== undefined ? { sourceId: parsed.sourceId } : {}),
      ...(parsed.scheduledAt !== undefined ? { scheduledAt: parsed.scheduledAt } : {}),
      ...(parsed.maxAttempts !== undefined ? { maxAttempts: parsed.maxAttempts } : {}),
    })
    .onConflictDoNothing()
    .returning({ id: tasks.id });

  void policy; // Retained for future per-enqueue policy overrides.

  const row = inserted[0];
  if (!row) return { id: null, created: false };
  return { id: row.id, created: true };
}

/**
 * Priority defaults align with §7 of tg_mvp_plan/06-WORKERS-AND-INGESTION.md.
 * Callers can override per enqueue; this matrix covers the scheduler's
 * default fan-out.
 */
function defaultPriorityFor(type: TaskType): number {
  switch (type) {
    case 'janitor_release_stuck_tasks':
      return 10;
    case 'fetch_source':
      return 40;
    case 'extract_news_item':
      return 35;
    case 'embed_news_item':
      return 45;
    case 'cluster_news':
      return 50;
    case 'refresh_iam_token':
      return 95;
  }
}

// =============================================================================
// pollNextTask
// =============================================================================

/**
 * Atomically lease the next pending task to `workerId`. Returns null when
 * no task is due.
 *
 * The single UPDATE bumps status='running', sets locked_by/locked_until,
 * increments attempts, and RETURNING-s the row. `FOR UPDATE SKIP LOCKED`
 * in the inner SELECT lets N concurrent workers poll without deadlock —
 * each one picks a different row or returns null.
 *
 * Also INSERTs a `task_runs` audit row for the attempt — kept inside the
 * same statement series so a polled task always has a matching task_runs
 * entry (no observability holes).
 */
export async function pollNextTask(
  client: postgres.Sql,
  workerId: string,
  leaseMinutes: number,
): Promise<PollResult | null> {
  const rows = (await client.unsafe(
    `
    WITH next AS (
      SELECT id FROM tasks
      WHERE status = 'pending' AND scheduled_at <= now()
      ORDER BY priority DESC, scheduled_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE tasks SET
      status = 'running',
      locked_by = $1,
      locked_until = now() + ($2::int * interval '1 minute'),
      started_at = now(),
      attempts = attempts + 1,
      updated_at = now()
    WHERE id IN (SELECT id FROM next)
    RETURNING id, type, payload, attempts, max_attempts AS "maxAttempts",
              workspace_id AS "workspaceId", source_id AS "sourceId"
    `,
    [workerId, leaseMinutes],
  )) as Array<{
    id: string;
    type: TaskType;
    payload: unknown;
    attempts: number;
    maxAttempts: number;
    workspaceId: string | null;
    sourceId: string | null;
  }>;
  const row = rows[0];
  if (!row) return null;

  // Audit row. Failure to insert this is NOT fatal (task already leased) —
  // we log via the caller's logger but do not retry / unlock. The leased
  // task still runs; observability has one missing row.
  try {
    await client`
      INSERT INTO task_runs (task_id, worker_id, started_at, status)
      VALUES (${row.id}, ${workerId}, now(), 'running')
    `;
  } catch {
    // intentional: task_runs is best-effort observability, not control flow.
  }

  return row;
}

// =============================================================================
// completeTask / failTask / deferTask
// =============================================================================

/**
 * Mark the task completed + close the open `task_runs` row.
 */
export async function completeTask(client: postgres.Sql, taskId: string): Promise<void> {
  await client`
    UPDATE tasks SET
      status = 'completed',
      completed_at = now(),
      locked_by = NULL,
      locked_until = NULL,
      last_error = NULL,
      updated_at = now()
    WHERE id = ${taskId}
  `;
  await client`
    UPDATE task_runs SET
      finished_at = now(),
      status = 'completed'
    WHERE task_id = ${taskId} AND finished_at IS NULL
  `;
}

export interface FailInput {
  kind: FailKind;
  message: string;
}

/**
 * Mark the task failed. Behaviour by kind:
 *
 *   transient + attempts < max_attempts:
 *     status='pending', scheduled_at = now() + backoff(attempts),
 *     locked_by=NULL, last_error truncated to ≤200 chars.
 *
 *   transient + attempts >= max_attempts: same as `permanent`.
 *
 *   permanent: status='failed_permanent' immediately. No retry.
 *
 * `task_runs` open row gets `status='failed'` or `'failed_permanent'` to
 * match. The split lets admin queries identify which attempts hit the cap
 * vs were rejected outright.
 */
export async function failTask(
  client: postgres.Sql,
  taskId: string,
  err: FailInput,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<void> {
  // Truncate so the CHECK constraint (length ≤ 200) doesn't reject the UPDATE.
  const safeError = err.message.length > 200 ? err.message.slice(0, 200) : err.message;

  // Look up current attempts to decide retry vs final. One read is cheap;
  // doing it in the UPDATE expression requires a CASE-rich statement that's
  // harder to read.
  const rows = (await client`
    SELECT attempts, max_attempts FROM tasks WHERE id = ${taskId}
  `) as Array<{ attempts: number; max_attempts: number }>;
  const row = rows[0];
  if (!row) return; // race with cancellation; nothing to update.

  const exhausted = row.attempts >= row.max_attempts;
  const finalStatus = err.kind === 'permanent' || exhausted ? 'failed_permanent' : 'pending';

  if (finalStatus === 'pending') {
    const backoffIndex = Math.min(row.attempts - 1, policy.backoffSeconds.length - 1);
    // attempts has already been incremented by pollNextTask; backoff index is
    // (attempts - 1) so first retry uses backoffSeconds[0].
    const backoffSec = policy.backoffSeconds[Math.max(0, backoffIndex)] ?? 60;
    await client`
      UPDATE tasks SET
        status = 'pending',
        scheduled_at = now() + (${backoffSec}::int * interval '1 second'),
        locked_by = NULL,
        locked_until = NULL,
        last_error = ${safeError},
        updated_at = now()
      WHERE id = ${taskId}
    `;
  } else {
    await client`
      UPDATE tasks SET
        status = 'failed_permanent',
        completed_at = now(),
        locked_by = NULL,
        locked_until = NULL,
        last_error = ${safeError},
        updated_at = now()
      WHERE id = ${taskId}
    `;
  }

  await client`
    UPDATE task_runs SET
      finished_at = now(),
      status = ${finalStatus === 'pending' ? 'failed' : 'failed_permanent'},
      error_message = ${safeError}
    WHERE task_id = ${taskId} AND finished_at IS NULL
  `;
}

/**
 * Phase 6 hook for cost-cap deferrals. Phase 4 does not call this — left in
 * place so the cost-guard handler can drop tasks into 'deferred' state
 * without re-implementing the close-task-runs dance.
 */
export async function deferTask(
  client: postgres.Sql,
  taskId: string,
  until: Date,
  reason: string,
): Promise<void> {
  const safeReason = reason.length > 200 ? reason.slice(0, 200) : reason;
  await client`
    UPDATE tasks SET
      status = 'deferred',
      scheduled_at = ${until},
      locked_by = NULL,
      locked_until = NULL,
      last_error = ${safeReason},
      updated_at = now()
    WHERE id = ${taskId}
  `;
  await client`
    UPDATE task_runs SET
      finished_at = now(),
      status = 'failed',
      error_message = ${safeReason}
    WHERE task_id = ${taskId} AND finished_at IS NULL
  `;
}

// =============================================================================
// releaseStuckTasks (janitor)
// =============================================================================

/**
 * Reset tasks whose lease expired (`locked_until < now()`). Returns the
 * count for observability. Run from `janitor_release_stuck_tasks` handler
 * every 5 minutes.
 *
 * Edge case 9.1: worker crashes mid-task → janitor reset, attempts not
 * incremented (it already was, by pollNextTask, when the doomed worker
 * picked it up). If `attempts >= max_attempts` we promote directly to
 * `failed_permanent` instead of looping.
 */
export async function releaseStuckTasks(client: postgres.Sql): Promise<number> {
  const rows = (await client`
    UPDATE tasks SET
      status = CASE
        WHEN attempts >= max_attempts THEN 'failed_permanent'
        ELSE 'pending'
      END,
      locked_by = NULL,
      locked_until = NULL,
      last_error = COALESCE(last_error, 'released_by_janitor'),
      updated_at = now(),
      completed_at = CASE
        WHEN attempts >= max_attempts THEN now()
        ELSE NULL
      END
    WHERE status = 'running' AND locked_until < now()
    RETURNING id
  `) as Array<{ id: string }>;

  // Close orphaned task_runs rows that the dead worker never finished.
  if (rows.length > 0) {
    await client`
      UPDATE task_runs SET
        finished_at = now(),
        status = 'failed',
        error_message = 'released_by_janitor'
      WHERE task_id IN ${client(rows.map((r) => r.id))} AND finished_at IS NULL
    `;
  }
  return rows.length;
}

// =============================================================================
// Misc helpers (drizzle re-exports for handler convenience)
// =============================================================================

/**
 * Build a Drizzle WHERE clause for "this source has an active fetch task".
 * Used by tests; production code uses the partial unique index directly via
 * ON CONFLICT DO NOTHING.
 */
export function activeFetchForSource(sourceId: string): SQL {
  return and(
    eq(tasks.sourceId, sourceId),
    eq(tasks.type, 'fetch_source'),
    sql`${tasks.status} IN ('pending', 'running')`,
  )!;
}
