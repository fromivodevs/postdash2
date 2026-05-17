-- Rollback for 0004_phase3_hardening.sql.

BEGIN;

DROP INDEX IF EXISTS workspace_source_subscriptions_default_per_source_uniq;
DROP INDEX IF EXISTS topic_profiles_one_active_per_workspace_uniq;

DELETE FROM _migrations WHERE name = '0004_phase3_hardening.sql';

COMMIT;
