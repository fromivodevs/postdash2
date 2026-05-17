-- Rollback for 0006_phase4_hardening.sql.
--
-- Documented rollback artifact. The migrate runner intentionally skips
-- `*.down.sql` files during forward apply — this file is run manually
-- (`psql < 0006_phase4_hardening.down.sql`) when a rollback is needed.

BEGIN;

DROP INDEX IF EXISTS tasks_unique_active_extract_per_item;
DROP INDEX IF EXISTS tasks_unique_active_embed_per_item;

DELETE FROM _migrations WHERE name = '0006_phase4_hardening.sql';

COMMIT;
