-- Phase 4 perf + security follow-up:
--   1. Re-create tasks_polling_idx with column order that matches the actual
--      ORDER BY in pollNextTask. The 0005 index used
--      `(status, scheduled_at, priority DESC)` but pollNextTask orders
--      `priority DESC, scheduled_at ASC`. Postgres can still use the old
--      index for the filter, but the planner cannot collapse the sort and
--      ends up doing a sort on top — at scale this lights up the polling
--      path. New order: `(priority DESC, scheduled_at ASC)` partial on
--      `status='pending'`, matching the SELECT exactly.
--   2. Per-news-item partial UNIQUE for `cluster_news`. 0006 shipped the same
--      guard for extract/embed; cluster_news was missed. Without it, a
--      re-enqueue (e.g. the embed handler firing twice on a flaky retry, or
--      the stranded-cluster reaper backfill) can produce duplicate cluster
--      work for the same news_item_id, and concurrent runs can both reach the
--      "no cluster exists" branch.
--   3. system_state.key allowlist. Today only `ya_iam_token` is written; the
--      CHECK keeps additions a deliberate migration step instead of letting
--      system_state quietly become a generic kv store.
--
-- NO explicit BEGIN/COMMIT here on purpose: the migrate runner wraps this
-- whole file in one transaction. Rollback artifact: 0007_phase4_perf_security.down.sql.

DROP INDEX IF EXISTS tasks_polling_idx;
CREATE INDEX IF NOT EXISTS tasks_polling_idx
  ON tasks (priority DESC, scheduled_at ASC)
  WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS tasks_unique_active_cluster_per_item
  ON tasks ((payload->>'news_item_id'))
  WHERE type = 'cluster_news' AND status IN ('pending', 'running');

-- system_state.key allowlist: the table is intentionally a singleton-style
-- key/value store for cross-process state (currently only `ya_iam_token`
-- written by packages/ai/iam-token.ts via the worker's IAMTokenStore adapter).
-- Without an explicit allowlist, a typo or stray write could drift the schema
-- semantics into a generic kv table. CHECK keeps additions a deliberate
-- migration step: extend this list AND the systemState `check()` in
-- packages/db/src/schema.ts together (schema.ts <-> migration parity).
ALTER TABLE system_state ADD CONSTRAINT system_state_key_allowlist
  CHECK (key IN ('ya_iam_token'));
