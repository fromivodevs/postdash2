-- Rollback for 0005_phase4.sql.
--
-- Documented rollback artifact. The migrate runner intentionally skips
-- `*.down.sql` files during forward apply — this file is run manually
-- (`psql < 0005_phase4.down.sql`) when a Phase 4 rollback is needed.
-- Tables are dropped in reverse-FK order; CASCADE clears indexes and any
-- FK added after this file was written.

BEGIN;

-- Reverse-FK order: news_cluster_items → news_clusters / global_news_items;
-- global_news_items → sources; task_runs → tasks; tasks → sources/workspaces;
-- system_state is standalone.
DROP TABLE IF EXISTS news_cluster_items CASCADE;
DROP TABLE IF EXISTS news_clusters CASCADE;
DROP TABLE IF EXISTS global_news_items CASCADE;
DROP TABLE IF EXISTS task_runs CASCADE;
DROP TABLE IF EXISTS tasks CASCADE;
DROP TABLE IF EXISTS system_state CASCADE;

DELETE FROM _migrations WHERE name = '0005_phase4.sql';

COMMIT;
