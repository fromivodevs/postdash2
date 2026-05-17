-- Rollback for 0008_phase5_matching_scoring.sql.
-- Drops Phase 5 tables and shrinks tasks.type CHECK back to Phase 4 set.

DROP INDEX IF EXISTS ai_usage_events_action_status_idx;
DROP INDEX IF EXISTS ai_usage_events_workspace_created_idx;
DROP INDEX IF EXISTS ai_usage_events_created_at_idx;
DROP TABLE IF EXISTS ai_usage_events;

DROP INDEX IF EXISTS workspace_news_matches_news_item_idx;
DROP INDEX IF EXISTS workspace_news_matches_workspace_status_score_idx;
DROP INDEX IF EXISTS workspace_news_matches_workspace_item_uniq;
DROP INDEX IF EXISTS workspace_news_matches_workspace_cluster_uniq;
DROP TABLE IF EXISTS workspace_news_matches;

DROP INDEX IF EXISTS tasks_unique_active_recompute_per_topic;
DROP INDEX IF EXISTS tasks_unique_active_score_per_workspace_item;
DROP INDEX IF EXISTS tasks_unique_active_match_per_item;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_type_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_type_check CHECK (type IN (
  'fetch_source',
  'extract_news_item',
  'embed_news_item',
  'cluster_news',
  'janitor_release_stuck_tasks',
  'refresh_iam_token'
));
