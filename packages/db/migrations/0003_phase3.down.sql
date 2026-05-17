-- Rollback for 0003_phase3.sql.
--
-- Documented rollback artifact. The migrate runner (packages/db/src/migrate.ts)
-- intentionally skips `*.down.sql` files during forward apply -- this file is
-- run manually (`psql < 0003_phase3.down.sql`) when a Phase 3 rollback is
-- needed. Tables are dropped in reverse-FK order so no DROP is blocked by a
-- dependent; CASCADE additionally clears indexes/constraints and is a safety
-- net against any FK added after this file was written.

BEGIN;

-- Reverse-FK order: workspace_source_subscriptions depends on both
-- topic_profiles and sources; topic_profiles + sources depend only on
-- workspaces (and pgvector for the embedding column on topic_profiles).
DROP TABLE IF EXISTS workspace_source_subscriptions CASCADE;
DROP TABLE IF EXISTS sources CASCADE;
DROP TABLE IF EXISTS topic_profiles CASCADE;

-- Removes the migration ledger entry so a subsequent forward `migrate` re-applies
-- 0003. On a double-rollback (this file run twice) the row is already gone and
-- this DELETE silently matches 0 rows -- a harmless no-op, not an error. The
-- DROP TABLE IF EXISTS statements above are likewise idempotent, so re-running
-- the whole file is safe.
DELETE FROM _migrations WHERE name = '0003_phase3.sql';

COMMIT;
