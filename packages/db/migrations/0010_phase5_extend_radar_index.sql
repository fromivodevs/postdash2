-- Phase 5 perf follow-up: extend the radar listing index with `created_at DESC`
-- so the secondary tie-breaker in listRadarMatches does not force an
-- Incremental Sort on top of the index scan at scale.
--
-- listRadarMatches' ORDER BY is:
--   `score DESC NULLS LAST, created_at DESC`
--
-- 0009_phase5_perf_indexes.sql created the index as
--   (workspace_id, status, score DESC NULLS LAST)
-- which satisfies the primary ORDER BY column but leaves the planner an
-- Incremental Sort for the created_at tie-breaker. Adding `created_at DESC`
-- to the key lets the planner satisfy the full ORDER BY directly.
--
-- See architecture/matching-and-scoring.md "Files" + "Invariants".

DROP INDEX IF EXISTS workspace_news_matches_workspace_status_score_idx;
CREATE INDEX IF NOT EXISTS workspace_news_matches_workspace_status_score_idx
  ON workspace_news_matches (workspace_id, status, score DESC NULLS LAST, created_at DESC);
