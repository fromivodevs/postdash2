-- Rollback for 0002_phase2.sql.
--
-- Documented rollback artifact. The migrate runner (packages/db/src/migrate.ts)
-- intentionally skips `*.down.sql` files during forward apply -- this file is
-- run manually (`psql < 0002_phase2.down.sql`) when a Phase 2 rollback is
-- needed. Tables are dropped in reverse-FK order so no DROP is blocked by a
-- dependent; CASCADE additionally clears indexes/constraints and is a safety
-- net against any FK added after this file was written.

BEGIN;

-- Reverse-FK order: channel_connections depends on content_channels;
-- channel_connect_codes depends on workspaces+users only, so independent.
DROP TABLE IF EXISTS channel_connect_codes CASCADE;
DROP TABLE IF EXISTS channel_connections CASCADE;
DROP TABLE IF EXISTS content_channels CASCADE;

-- Removes the migration ledger entry so a subsequent forward `migrate` re-applies
-- 0002. On a double-rollback (this file run twice) the row is already gone and
-- this DELETE silently matches 0 rows -- a harmless no-op, not an error. The
-- DROP TABLE IF EXISTS statements above are likewise idempotent, so re-running
-- the whole file is safe.
DELETE FROM _migrations WHERE name = '0002_phase2.sql';

COMMIT;
