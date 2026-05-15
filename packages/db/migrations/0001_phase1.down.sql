-- Rollback for 0001_phase1.sql.
--
-- Documented rollback artifact. The migrate runner (packages/db/src/migrate.ts)
-- intentionally skips `*.down.sql` files during forward apply — this file is
-- run manually (`psql < 0001_phase1.down.sql`) when a Phase 1 rollback is
-- needed. Tables are dropped in reverse-FK order so no DROP is blocked by a
-- dependent; CASCADE additionally clears indexes/constraints and is a safety
-- net against any FK added after this file was written.

BEGIN;

DROP TABLE IF EXISTS workspace_members CASCADE;
DROP TABLE IF EXISTS command_idempotency CASCADE;
DROP TABLE IF EXISTS operation_log CASCADE;
DROP TABLE IF EXISTS telegram_identities CASCADE;
DROP TABLE IF EXISTS workspaces CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- Removes the migration ledger entry so a subsequent forward `migrate` re-applies
-- 0001. On a double-rollback (this file run twice) the row is already gone and
-- this DELETE silently matches 0 rows — a harmless no-op, not an error. The
-- DROP TABLE IF EXISTS statements above are likewise idempotent, so re-running
-- the whole file is safe.
DELETE FROM _migrations WHERE name = '0001_phase1.sql';

COMMIT;
