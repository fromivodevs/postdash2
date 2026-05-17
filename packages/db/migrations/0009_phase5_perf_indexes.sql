-- Phase 5 perf indexes — align hot-path indexes with the actual queries.
--
-- 1. listRadarMatches orders by `score DESC NULLS LAST`. The Phase 5 index
--    `workspace_news_matches_workspace_status_score_idx` was created as
--    `(workspace_id, status, score DESC)` (NULLS FIRST default for DESC), so
--    the planner cannot satisfy the ORDER BY directly and falls back to a sort
--    on the seq result. Recreate with NULLS LAST.
--
-- 2. scheduler.slowTick scans `topic_profiles WHERE status='active' AND
--    embedding_status='pending'` every 5 minutes. No index covers this
--    predicate today — sequential scan. Add a partial index covering only the
--    candidate rows.
--
-- Drizzle's `index().on().where()` builder cannot currently express
-- `DESC NULLS LAST` cleanly, so the schema.ts mirror keeps the column without
-- sort direction. Parity is maintained via this migration (search
-- "parity-by-migration" in schema.ts for the convention).
--
-- See architecture/matching-and-scoring.md "Files" + "Invariants".

-- =============================================================================
-- workspace_news_matches: re-create the (workspace, status, score) index with
-- NULLS LAST so it can satisfy the radar ORDER BY directly.
-- =============================================================================
DROP INDEX IF EXISTS workspace_news_matches_workspace_status_score_idx;
CREATE INDEX IF NOT EXISTS workspace_news_matches_workspace_status_score_idx
  ON workspace_news_matches (workspace_id, status, score DESC NULLS LAST);

-- =============================================================================
-- topic_profiles: partial index for scheduler.slowTick recompute scan.
-- =============================================================================
CREATE INDEX IF NOT EXISTS topic_profiles_pending_embedding_idx
  ON topic_profiles (embedding_status, status)
  WHERE embedding_status = 'pending' AND status = 'active';
