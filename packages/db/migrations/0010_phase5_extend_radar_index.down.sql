-- Rollback for 0010_phase5_extend_radar_index.sql.
--
-- Unconditional DROP + plain CREATE (no IF EXISTS / IF NOT EXISTS) so the
-- down truly restores the 0009 index shape — per pl-perf's sub-2 note:
-- DROP IF EXISTS + CREATE IF NOT EXISTS together can silently no-op when
-- the index already exists in either shape.

DROP INDEX workspace_news_matches_workspace_status_score_idx;
CREATE INDEX workspace_news_matches_workspace_status_score_idx
  ON workspace_news_matches (workspace_id, status, score DESC NULLS LAST);
