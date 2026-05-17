-- Rollback for 0007_phase4_perf_security.sql.
--
-- Documented rollback artifact. The migrate runner intentionally skips
-- `*.down.sql` files during forward apply — this file is run manually
-- (`psql < 0007_phase4_perf_security.down.sql`) when a rollback is needed.

BEGIN;

ALTER TABLE system_state DROP CONSTRAINT IF EXISTS system_state_key_allowlist;

DROP INDEX IF EXISTS tasks_unique_active_cluster_per_item;

DROP INDEX IF EXISTS tasks_polling_idx;
CREATE INDEX tasks_polling_idx
  ON tasks (status, scheduled_at, priority DESC)
  WHERE status = 'pending';

DELETE FROM _migrations WHERE name = '0007_phase4_perf_security.sql';

COMMIT;
