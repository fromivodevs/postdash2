-- Phase 5 schema: workspace_news_matches (per-workspace radar items)
-- + ai_usage_events (per-call accounting) + extended tasks.type CHECK.
-- See architecture/matching-and-scoring.md.
--
-- Mirrors packages/db/src/schema.ts. See tg_mvp_plan/03-DATABASE-SCHEMA.md +
-- tg_mvp_plan/07-AI-SCORING-AND-DRAFTS.md §2-3.
--
-- NO explicit BEGIN/COMMIT here on purpose: the migrate runner
-- (packages/db/src/migrate.ts) wraps this whole file AND its `_migrations`
-- ledger INSERT in one `client.begin(...)` transaction.
-- Rollback artifact: 0008_phase5_matching_scoring.down.sql.

-- =============================================================================
-- tasks.type CHECK: extend with Phase 5 task types.
-- =============================================================================
-- ALTER TABLE drops the old constraint and re-adds the new one in one shot.
-- 0005_phase4.sql created `tasks_type_check` listing the Phase 4 set; Phase 5
-- adds three task types implemented by apps/worker/src/handlers/*:
--   - match_news_to_workspaces: per-news-item fan-out into subscribed workspaces
--   - score_workspace_match:    LLM relevance score for (workspace, news_item)
--   - recompute_topic_embedding: re-embed a topic_profile after content edit
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_type_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_type_check CHECK (type IN (
  'fetch_source',
  'extract_news_item',
  'embed_news_item',
  'cluster_news',
  'janitor_release_stuck_tasks',
  'refresh_iam_token',
  'match_news_to_workspaces',
  'score_workspace_match',
  'recompute_topic_embedding'
));

-- =============================================================================
-- Anti-duplicate guards for the Phase 5 task types.
-- =============================================================================
-- Pattern mirrors 0006_phase4_hardening.sql / 0007_phase4_perf_security.sql:
-- partial UNIQUE on the payload field that defines a single unit of work,
-- so INSERT ... ON CONFLICT DO NOTHING collapses re-enqueues at the DB layer.

-- match_news_to_workspaces is enqueued by cluster_news (one per item it just
-- attached). A re-enqueue (e.g. from a future backfill) for the same
-- news_item_id should not pile up duplicate fan-out work.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_unique_active_match_per_item
  ON tasks ((payload->>'news_item_id'))
  WHERE type = 'match_news_to_workspaces' AND status IN ('pending', 'running');

-- score_workspace_match is enqueued per (workspace, news_item) pair after a
-- successful match_news_to_workspaces fan-out. Two concurrent
-- match_news_to_workspaces handlers for the same item could otherwise both
-- enqueue duplicate scorings for the same workspace. Composite key:
-- (workspace_id, payload->>'news_item_id').
CREATE UNIQUE INDEX IF NOT EXISTS tasks_unique_active_score_per_workspace_item
  ON tasks (workspace_id, (payload->>'news_item_id'))
  WHERE type = 'score_workspace_match' AND status IN ('pending', 'running');

-- recompute_topic_embedding is enqueued by createTopicProfile / updateTopicProfile
-- (commands package) on content change. Multiple rapid PATCHes from the same
-- workspace must collapse to one in-flight recompute — the latest enqueue is
-- sufficient because the handler reads current topic_profiles content at run
-- time. Partial UNIQUE on (payload->>'topic_profile_id') achieves that.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_unique_active_recompute_per_topic
  ON tasks ((payload->>'topic_profile_id'))
  WHERE type = 'recompute_topic_embedding' AND status IN ('pending', 'running');

-- =============================================================================
-- workspace_news_matches: per-workspace radar entries.
-- =============================================================================
-- One row per (workspace, news_item_OR_cluster) — the partial UNIQUEs below
-- enforce cluster-level dedup per §12.1 of tg_mvp_plan/06-WORKERS-AND-INGESTION.md.
--
-- score is the final composite (LLM 50% + cosine 30% + freshness 10% +
-- reliability 10%), clamped to [0,10] in the application layer before INSERT.
-- score_components keeps the breakdown for UI tooltip / audit ("why 8.4?").
-- ai_provider / used_model / prompt_version tie the row to the AI call for
-- A/B and observability.
--
-- status state machine (read-only enum at the DB layer):
--   candidate         — scored, visible in Radar (>= MATCHING_MIN_COSINE)
--   filtered_negative — pre-filter hit on topic_profile.negative_keywords
--   hidden            — semantic pre-score below MATCHING_MIN_COSINE (skip LLM)
--   ai_refused        — LLM refused via safety filter (risk_flags=['refused'])
--   low_score         — scored < AUTO_DRAFT_SCORE_THRESHOLD, demoted in UI
--   suppressed        — user hid this match (Phase 6+ UX)
CREATE TABLE IF NOT EXISTS workspace_news_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  news_item_id uuid NOT NULL REFERENCES global_news_items(id) ON DELETE CASCADE,
  -- cluster_id is NULL when the news item is not (yet) attached to a cluster.
  -- Cluster-level dedup uses the partial UNIQUE below; item-level dedup uses
  -- the other partial UNIQUE. Both are necessary because cluster_id can flip
  -- from NULL to a value asynchronously (cluster_news runs after embed).
  cluster_id uuid REFERENCES news_clusters(id) ON DELETE SET NULL,
  score numeric(4, 2),
  relevance_reason text,
  should_create_draft boolean NOT NULL DEFAULT false,
  risk_flags text[] NOT NULL DEFAULT '{}'::text[],
  -- Breakdown of the composite score; the UI can render a tooltip without
  -- re-computing from scratch. Keys: llm, cosine, freshness, reliability, weighted.
  score_components jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_provider text,
  used_model text,
  prompt_version text,
  status text NOT NULL DEFAULT 'candidate',
  scored_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_news_matches_status_check CHECK (status IN (
    'candidate', 'filtered_negative', 'hidden', 'ai_refused', 'low_score', 'suppressed'
  )),
  CONSTRAINT workspace_news_matches_score_range_check
    CHECK (score IS NULL OR (score >= 0 AND score <= 10)),
  -- 280 chars matches ScoreOutputSchema.relevance_reason cap in
  -- packages/ai/src/provider.ts. Enforced at the DB so an off-by-one in a
  -- future provider can't bloat the row.
  CONSTRAINT workspace_news_matches_reason_length_check
    CHECK (relevance_reason IS NULL OR length(relevance_reason) <= 280)
);

-- Cluster-level dedup (§12.1): one match per (workspace, cluster).
-- Without this, the same story arriving via 5 different sources would create
-- 5 workspace_news_matches rows per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_news_matches_workspace_cluster_uniq
  ON workspace_news_matches (workspace_id, cluster_id)
  WHERE cluster_id IS NOT NULL;

-- Item-level dedup for not-yet-clustered items: one match per (workspace, item).
-- Once the item is attached to a cluster (cluster_news handler), the row's
-- cluster_id is set and the cluster-level UNIQUE takes over.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_news_matches_workspace_item_uniq
  ON workspace_news_matches (workspace_id, news_item_id)
  WHERE cluster_id IS NULL;

-- Radar listing: workspace + status + score order. Covers
--   "WHERE workspace_id=? AND status='candidate' ORDER BY score DESC LIMIT N".
CREATE INDEX IF NOT EXISTS workspace_news_matches_workspace_status_score_idx
  ON workspace_news_matches (workspace_id, status, score DESC);

-- Reverse lookup: "which workspaces have a match for this news item?" — used
-- when a cluster pulls in a new item and we need to update sources_count
-- reflections in match rows (Phase 5+ optional).
CREATE INDEX IF NOT EXISTS workspace_news_matches_news_item_idx
  ON workspace_news_matches (news_item_id);

-- =============================================================================
-- ai_usage_events: per-AI-call accounting (cost, tokens, status).
-- =============================================================================
-- Append-only. Phase 5 writes from score handler; Phase 6 will add generate +
-- rewrite. Phase 4 embed currently does NOT write here (would inflate row
-- count with the per-item fan-out and embeddings are uncapped per §10);
-- Phase 8 admin UI may opt-in for embed observability via env flag.
--
-- workspace_id is nullable: scoring rows always have it, but future embed-
-- bookkeeping would not (embed is global). task_id is nullable as a safety
-- valve in case the event is logged outside a task context.
CREATE TABLE IF NOT EXISTS ai_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  -- task_id is FK-free on purpose: tasks rows get GC'd by retention sweeps
  -- (planned Phase 8 follow-up) and we don't want the audit trail dragged
  -- along. Text uuid keeps query joinability when the task still exists.
  task_id uuid,
  action_type text NOT NULL,
  used_model text NOT NULL,
  prompt_version text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_rub numeric(10, 4) NOT NULL DEFAULT 0,
  duration_ms integer NOT NULL DEFAULT 0,
  status text NOT NULL,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_usage_events_action_check CHECK (action_type IN (
    'score', 'generate', 'rewrite', 'embed'
  )),
  CONSTRAINT ai_usage_events_status_check CHECK (status IN (
    'success', 'failed', 'refused', 'parse_error', 'fallback'
  )),
  CONSTRAINT ai_usage_events_tokens_nonneg CHECK (input_tokens >= 0 AND output_tokens >= 0),
  CONSTRAINT ai_usage_events_cost_nonneg CHECK (cost_rub >= 0),
  CONSTRAINT ai_usage_events_duration_nonneg CHECK (duration_ms >= 0),
  CONSTRAINT ai_usage_events_error_length_check
    CHECK (error_message IS NULL OR length(error_message) <= 500)
);

-- Daily-cost dashboard: GROUP BY date_trunc('day', created_at), action_type, status.
CREATE INDEX IF NOT EXISTS ai_usage_events_created_at_idx
  ON ai_usage_events (created_at DESC);
-- Per-workspace cost: "spent_rub by workspace today".
CREATE INDEX IF NOT EXISTS ai_usage_events_workspace_created_idx
  ON ai_usage_events (workspace_id, created_at DESC)
  WHERE workspace_id IS NOT NULL;
-- Failures view: "what AI calls failed today?".
CREATE INDEX IF NOT EXISTS ai_usage_events_action_status_idx
  ON ai_usage_events (action_type, status, created_at DESC);
