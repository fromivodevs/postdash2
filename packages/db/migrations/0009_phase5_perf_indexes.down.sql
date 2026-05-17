-- Rollback for 0009_phase5_perf_indexes.sql.
-- Drops the partial topic_profiles index and re-creates the original
-- workspace_news_matches index (without NULLS LAST).

DROP INDEX IF EXISTS topic_profiles_pending_embedding_idx;

DROP INDEX IF EXISTS workspace_news_matches_workspace_status_score_idx;
CREATE INDEX IF NOT EXISTS workspace_news_matches_workspace_status_score_idx
  ON workspace_news_matches (workspace_id, status, score DESC);
