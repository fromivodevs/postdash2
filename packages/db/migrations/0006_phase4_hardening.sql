-- Phase 4 hardening: anti-duplicate guards on the per-news-item task types.
-- See architecture/global-ingestion.md "Known follow-ups" — extract/embed
-- tasks did not previously have a per-news-item anti-dupe index, so a
-- re-enqueue (e.g. from a future backfill admin job, or from fetch_source
-- re-firing for a was_updated item) could pile up duplicate work for the
-- same global_news_items.id. The partial UNIQUE indexes below let INSERT
-- ON CONFLICT DO NOTHING collapse the duplicates at the DB layer, mirroring
-- the pattern in 0005_phase4.sql for fetch_source / refresh_iam_token /
-- janitor_release_stuck_tasks.
--
-- NO explicit BEGIN/COMMIT here on purpose: the migrate runner wraps this
-- whole file in one transaction. Rollback artifact: 0006_phase4_hardening.down.sql.

CREATE UNIQUE INDEX IF NOT EXISTS tasks_unique_active_embed_per_item
  ON tasks ((payload->>'news_item_id'))
  WHERE type = 'embed_news_item' AND status IN ('pending', 'running');

CREATE UNIQUE INDEX IF NOT EXISTS tasks_unique_active_extract_per_item
  ON tasks ((payload->>'news_item_id'))
  WHERE type = 'extract_news_item' AND status IN ('pending', 'running');
