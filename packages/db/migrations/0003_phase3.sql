-- Phase 3 schema: topics + sources + workspace_source_subscriptions.
-- See architecture/topics-and-sources.md.
--
-- Mirrors packages/db/src/schema.ts. See tg_mvp_plan/03-DATABASE-SCHEMA.md.
--
-- NO explicit BEGIN/COMMIT here on purpose: the migrate runner
-- (packages/db/src/migrate.ts) wraps this whole file AND its `_migrations`
-- ledger INSERT in one `client.begin(...)` transaction, so a mid-run failure
-- (process killed between two CREATE TABLEs) rolls back both the schema and the
-- ledger row — the file is never left applied-but-unrecorded. Adding BEGIN/COMMIT
-- here would nest transactions and split the ledger insert back out of the body.
-- Rollback artifact: 0003_phase3.down.sql.

-- CHECK-edit caveat: every table below uses CREATE TABLE IF NOT EXISTS, so on a
-- DB that has already run this migration, editing a CHECK constraint *in this
-- file* is a no-op -- the table is skipped entirely. A future constraint change
-- (e.g. adding 'discord' to a status allowed values) needs its own new ALTER
-- TABLE migration file, not an in-place edit here.

-- topic_profiles: per-workspace "what kind of news this workspace cares about".
-- MVP UI restricts to one active profile per workspace; the schema allows many
-- so Phase 5+ can extend without a migration. The embedding column is
-- provisioned but stays NULL until Phase 4 (recompute_topic_embedding task
-- backfills it).
CREATE TABLE IF NOT EXISTS topic_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  language text NOT NULL,
  -- Postgres text[] arrays for tag-style fields. Cardinality is small (<=50
  -- per workspace in MVP UX); a separate row-per-tag table would just add
  -- joins for no scaling win at this scale.
  main_topics text[] NOT NULL DEFAULT '{}',
  keywords text[] NOT NULL DEFAULT '{}',
  negative_keywords text[] NOT NULL DEFAULT '{}',
  -- tone_profile: jsonb so the structure can evolve (Phase 6 draft generation
  -- will read it; today it's free-form, the AI prompt converts it to a tone
  -- description on its own).
  tone_profile jsonb,
  -- embedding: pgvector(256). NULL until Phase 4 fills it via
  -- recompute_topic_embedding task. Vector size matches Yandex
  -- text-search-doc output (see tg_mvp_plan/11-AI-PROVIDER.md).
  embedding vector(256),
  embedding_status text NOT NULL DEFAULT 'pending',
  embedding_updated_at timestamptz,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT topic_profiles_language_check CHECK (language IN ('ru', 'en')),
  CONSTRAINT topic_profiles_embedding_status_check
    CHECK (embedding_status IN ('pending', 'ok', 'failed')),
  CONSTRAINT topic_profiles_status_check CHECK (status IN ('active', 'disabled'))
);
-- workspace_id index for the canonical "list this workspace's topics" query.
-- Status filter inline because the active-vs-disabled split is permanent.
CREATE INDEX IF NOT EXISTS topic_profiles_workspace_idx
  ON topic_profiles (workspace_id, status);

-- sources: GLOBAL source registry. One row per canonical_url across ALL
-- workspaces. This is the core invariant of source-centric ingestion (see
-- tg_mvp_plan/06-WORKERS-AND-INGESTION.md §1). Per-workspace state lives in
-- workspace_source_subscriptions.
--
-- The UNIQUE constraint on canonical_url is what makes the "add same feed
-- from two workspaces" dedup work — INSERT ... ON CONFLICT (canonical_url)
-- DO UPDATE in the createSource command returns the existing row's id.
CREATE TABLE IF NOT EXISTS sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  -- url: raw user-provided URL (post-redirect-resolution but pre-canonicalize).
  -- Kept alongside canonical_url for human display ("you added X, we
  -- canonicalized to Y") and for redirect-chain audit.
  url text NOT NULL,
  canonical_url text NOT NULL,
  name text,
  -- fetch_interval_minutes: how often the scheduler should enqueue a
  -- fetch_source task (Phase 4). 60 = hourly is a sane default for RSS.
  fetch_interval_minutes integer NOT NULL DEFAULT 60,
  -- max_items_per_fetch: Phase 4 volume-cap defence against feed-flood.
  -- 50 mirrors MAX_ITEMS_PER_FETCH_DEFAULT in 06-WORKERS-AND-INGESTION.md §17.
  max_items_per_fetch integer NOT NULL DEFAULT 50,
  reliability_score numeric,
  -- Phase 4 fields, filled by the fetch worker. Surface in UI as source health.
  last_fetched_at timestamptz,
  last_fetch_status text,
  last_fetch_error text,
  -- canonicalization_rule_version: stamped at insert time from
  -- CANONICALIZATION_RULE_VERSION in packages/sources/src/canonicalize.ts.
  -- Phase 4+ uses this to detect rows that need re-canonicalization after a
  -- rule change.
  canonicalization_rule_version text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sources_type_check CHECK (type IN ('rss', 'website', 'api', 'manual')),
  CONSTRAINT sources_status_check CHECK (status IN ('active', 'disabled', 'error')),
  CONSTRAINT sources_last_fetch_status_check
    CHECK (last_fetch_status IS NULL OR last_fetch_status IN (
      'ok', '4xx', '5xx', 'parse_error', 'timeout'
    )),
  -- Same length cap as channel_connections.last_verify_error: short, log-safe
  -- error label only. Never a stack trace.
  CONSTRAINT sources_last_fetch_error_length_check
    CHECK (last_fetch_error IS NULL OR length(last_fetch_error) <= 200),
  CONSTRAINT sources_fetch_interval_minutes_check CHECK (fetch_interval_minutes > 0),
  CONSTRAINT sources_max_items_per_fetch_check CHECK (max_items_per_fetch > 0),
  CONSTRAINT sources_canonical_url_unique UNIQUE (canonical_url)
);
-- (status, last_fetched_at) supports the Phase 4 scheduler picking due
-- sources: "WHERE status='active' AND (last_fetched_at IS NULL OR
-- last_fetched_at + interval ... < now())". The index handles the status
-- filter; last_fetched_at sorts within.
CREATE INDEX IF NOT EXISTS sources_status_last_fetched_at_idx
  ON sources (status, last_fetched_at);

-- workspace_source_subscriptions: per-workspace M:N glue between workspaces
-- and global sources. enabled flag lets a workspace pause without unsubscribing
-- (and without affecting other workspaces sharing the same global source).
--
-- topic_profile_id is nullable: most workspaces have a single default profile
-- (MVP UX), and a NULL link means "use the default profile". Phase 5+ multi-
-- profile lets a subscription pin to a specific profile.
CREATE TABLE IF NOT EXISTS workspace_source_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- ON DELETE RESTRICT: a global source shouldn't be hard-deleted while
  -- subscriptions reference it. Removing a source means dropping the
  -- subscription, not the global row (the latter stays for other workspaces).
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
  -- ON DELETE SET NULL: deleting a topic_profile demotes the subscription
  -- back to "default profile" rather than orphaning the subscription itself.
  topic_profile_id uuid REFERENCES topic_profiles(id) ON DELETE SET NULL,
  enabled boolean NOT NULL DEFAULT true,
  -- priority: hint for Phase 5 matching ordering. 50 is neutral; <50 lowers,
  -- >50 raises this source's items relative to others in the same workspace.
  priority integer NOT NULL DEFAULT 50,
  -- custom_rules: free-form jsonb for Phase 5+ per-workspace overrides
  -- (e.g. { "min_score": 7, "skip_categories": [...] }). Empty object today.
  custom_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- UNIQUE includes topic_profile_id so the same workspace+source can have
  -- one subscription per topic_profile (Phase 5+ multi-profile). With
  -- topic_profile_id NULL the constraint dedups "default profile" duplicates
  -- per Postgres NULL semantics: in vanilla Postgres NULLs are distinct so
  -- two NULL rows would both pass. We rely on the application layer
  -- (createSource command) to upsert on (workspace_id, source_id) WHERE
  -- topic_profile_id IS NULL for MVP single-profile UX.
  CONSTRAINT workspace_source_subscriptions_unique
    UNIQUE (workspace_id, source_id, topic_profile_id),
  CONSTRAINT workspace_source_subscriptions_priority_check
    CHECK (priority >= 0 AND priority <= 100)
);
-- Reverse-direction index: "which workspaces subscribe to this source?" used
-- by Phase 4 fetch-fanout when a source completes a fetch and needs to
-- enqueue per-workspace matching tasks.
CREATE INDEX IF NOT EXISTS workspace_source_subscriptions_source_idx
  ON workspace_source_subscriptions (source_id, enabled);
-- Forward-direction: "list this workspace's subscriptions" for GET /sources.
CREATE INDEX IF NOT EXISTS workspace_source_subscriptions_workspace_idx
  ON workspace_source_subscriptions (workspace_id, enabled);
