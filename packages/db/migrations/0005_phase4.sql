-- Phase 4 schema: task system + global news layer + embeddings + system_state.
-- See architecture/global-ingestion.md.
--
-- Mirrors packages/db/src/schema.ts. See tg_mvp_plan/03-DATABASE-SCHEMA.md.
--
-- NO explicit BEGIN/COMMIT here on purpose: the migrate runner
-- (packages/db/src/migrate.ts) wraps this whole file AND its `_migrations`
-- ledger INSERT in one `client.begin(...)` transaction.
-- Rollback artifact: 0005_phase4.down.sql.

-- CHECK-edit caveat: every CREATE TABLE below uses IF NOT EXISTS, so editing a
-- CHECK constraint in place is a no-op on a DB that already ran this file. A
-- future CHECK change needs its own ALTER TABLE migration.

-- =============================================================================
-- system_state: key-value cross-worker shared state (IAM token cache, etc).
-- =============================================================================
-- Не критичная persistence: при потере данных worker'ы заново вычислят
-- (e.g. refresh IAM token). Хранение в БД нужно чтобы N concurrent worker'ов
-- при cold-start не сделали N concurrent IAM-refresh requests.
CREATE TABLE IF NOT EXISTS system_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS system_state_expires_at_idx
  ON system_state (expires_at)
  WHERE expires_at IS NOT NULL;

-- =============================================================================
-- tasks: persistent task queue с atomic polling (FOR UPDATE SKIP LOCKED).
-- =============================================================================
-- Status state machine (см. architecture/global-ingestion.md):
--   pending → running → completed
--                     → failed → pending (retry with backoff) → failed_permanent
--                     → failed_permanent
--   pending → deferred (Phase 6 cost cap; не используется в Phase 4)
--   pending → skipped_volume_cap (Phase 4 volume cap для items, не для tasks)
--   pending → cancelled (admin action; не используется в Phase 4)
--
-- payload jsonb — handler-specific input. Например, fetch_source: {} (source_id колонка),
-- embed_news_item: { news_item_id: uuid }. Schemas валидируются в packages/tasks/types.ts.
--
-- locked_by/locked_until — 5-minute lease (TASK_LEASE_MINUTES env, default 5).
-- janitor_release_stuck_tasks resets running tasks where locked_until < now().
CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  priority integer NOT NULL DEFAULT 50,
  status text NOT NULL DEFAULT 'pending',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id uuid REFERENCES sources(id) ON DELETE CASCADE,
  locked_by text,
  locked_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tasks_type_check CHECK (type IN (
    'fetch_source',
    'extract_news_item',
    'embed_news_item',
    'cluster_news',
    'janitor_release_stuck_tasks',
    'refresh_iam_token'
  )),
  CONSTRAINT tasks_status_check CHECK (status IN (
    'pending', 'running', 'completed',
    'failed', 'failed_permanent',
    'deferred', 'skipped_volume_cap', 'cancelled'
  )),
  CONSTRAINT tasks_priority_check CHECK (priority >= 0 AND priority <= 100),
  CONSTRAINT tasks_attempts_nonneg CHECK (attempts >= 0),
  CONSTRAINT tasks_max_attempts_pos CHECK (max_attempts > 0),
  -- Short, log-safe error label only — never a stack trace. Mirrors
  -- sources.last_fetch_error and channel_connections.last_verify_error.
  CONSTRAINT tasks_last_error_length_check
    CHECK (last_error IS NULL OR length(last_error) <= 200)
);

-- Polling-critical index: workers pull `WHERE status='pending' AND scheduled_at <= now()
-- ORDER BY priority DESC, scheduled_at ASC LIMIT 1`. Composite matches the predicate
-- + ordering. status filter inline (most tasks are 'completed'/'failed_permanent',
-- only 'pending' is interesting for the poller).
CREATE INDEX IF NOT EXISTS tasks_polling_idx
  ON tasks (status, scheduled_at, priority DESC)
  WHERE status = 'pending';

-- Janitor query: "all running tasks whose lease has expired".
CREATE INDEX IF NOT EXISTS tasks_stuck_running_idx
  ON tasks (locked_until)
  WHERE status = 'running';

-- Reverse-lookup indexes for source / workspace introspection.
CREATE INDEX IF NOT EXISTS tasks_source_status_idx
  ON tasks (source_id, status)
  WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_workspace_status_idx
  ON tasks (workspace_id, status)
  WHERE workspace_id IS NOT NULL;

-- Edge case 9.3: prevent duplicate fetch_source tasks. The partial UNIQUE makes
-- INSERT ... ON CONFLICT (source_id) WHERE ... DO NOTHING idempotent at the
-- scheduler tick: if a previous fetch is still pending OR running, the new
-- INSERT is a no-op. Only after the task transitions to completed/failed/
-- failed_permanent can a fresh fetch be enqueued.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_unique_active_fetch_per_source
  ON tasks (source_id)
  WHERE type = 'fetch_source' AND status IN ('pending', 'running');

-- Same anti-duplicate guard for the singleton refresh_iam_token task. The
-- scheduler enqueues it from the 5-minute janitor tick; without this index,
-- a slow refresh could pile up. There is exactly one such task in flight.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_unique_active_iam_refresh
  ON tasks (type)
  WHERE type = 'refresh_iam_token' AND status IN ('pending', 'running');

-- Same anti-duplicate guard for the janitor task itself.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_unique_active_janitor
  ON tasks (type)
  WHERE type = 'janitor_release_stuck_tasks' AND status IN ('pending', 'running');

-- =============================================================================
-- task_runs: per-attempt log (audit + debugging).
-- =============================================================================
-- Каждый pollNextTask + complete/fail вставляет одну row. Полезно для отладки
-- "почему task застрял" (retry count, worker_id, error trace).
CREATE TABLE IF NOT EXISTS task_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  worker_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  error_message text,
  CONSTRAINT task_runs_status_check CHECK (status IN (
    'running', 'completed', 'failed', 'failed_permanent'
  )),
  CONSTRAINT task_runs_error_length_check
    CHECK (error_message IS NULL OR length(error_message) <= 200)
);
CREATE INDEX IF NOT EXISTS task_runs_task_started_idx
  ON task_runs (task_id, started_at DESC);

-- =============================================================================
-- global_news_items: канонический per-source slot для каждой новости.
-- =============================================================================
-- UNIQUE (source_id, canonical_url) — структурный dedup на уровне одного
-- source'а. Семантический dedup (cosine) живёт в news_clusters.
--
-- embedding nullable: заполняется embed_news_item task'ом (Phase 4). До этого
-- момента строки видны (status='new'), но не участвуют в clustering / matching.
CREATE TABLE IF NOT EXISTS global_news_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  title text NOT NULL,
  url text NOT NULL,
  canonical_url text NOT NULL,
  -- sha256 hex over normalized (title|summary|published_at). Detects feed
  -- updates: same (source_id, canonical_url) with different content_hash →
  -- was_updated=true, refresh extracted_text.
  content_hash text NOT NULL,
  extracted_text text,
  summary text,
  published_at timestamptz,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  -- 'ru' | 'en' | 'other'. Heuristic in fetcher (cyrillic vs latin вычисляется
  -- по title; mixed-language news → одно из двух, embedding всё равно работает).
  language text,
  -- pgvector(256) — Yandex text-search-doc output dim. NULL until embed task
  -- fills it. Validate in handler: vector.length === AI_EMBEDDING_DIM.
  embedding vector(256),
  embedding_status text NOT NULL DEFAULT 'pending',
  embedding_updated_at timestamptz,
  last_updated_in_source_at timestamptz,
  was_updated boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'new',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT global_news_items_embedding_status_check
    CHECK (embedding_status IN ('pending', 'ok', 'failed')),
  CONSTRAINT global_news_items_status_check
    CHECK (status IN ('new', 'extracted', 'embedded', 'clustered', 'ignored', 'ai_refused', 'error')),
  CONSTRAINT global_news_items_language_check
    CHECK (language IS NULL OR language IN ('ru', 'en', 'other')),
  CONSTRAINT global_news_items_source_canonical_unique
    UNIQUE (source_id, canonical_url)
);
-- Phase 5 matching query: "list items by language + recency".
CREATE INDEX IF NOT EXISTS global_news_items_language_published_idx
  ON global_news_items (language, published_at DESC);
-- Worker query: "items needing embedding".
CREATE INDEX IF NOT EXISTS global_news_items_pending_embedding_idx
  ON global_news_items (embedding_status, fetched_at DESC)
  WHERE embedding_status = 'pending';
-- pgvector ivfflat: approximate nearest-neighbour. lists=100 is a safe MVP
-- default for ≤100k vectors; raise to sqrt(rows) when corpus grows.
-- The index is partial — only embedded rows participate. Without WHERE
-- the index would have to allocate dummy slots for NULLs, wasting space.
CREATE INDEX IF NOT EXISTS global_news_items_embedding_ivfflat_idx
  ON global_news_items USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- =============================================================================
-- news_clusters: семантический dedup — одна "история" из N источников.
-- =============================================================================
-- centroid_embedding пересчитывается при каждом добавлении item'а как простое
-- среднее всех embedding'ов cluster'а. sources_count помогает UI ("эта новость
-- появилась в 5 источниках").
CREATE TABLE IF NOT EXISTS news_clusters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_title text NOT NULL,
  main_url text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  sources_count integer NOT NULL DEFAULT 1,
  centroid_embedding vector(256),
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT news_clusters_status_check CHECK (status IN ('active', 'merged', 'archived')),
  CONSTRAINT news_clusters_sources_count_check CHECK (sources_count >= 1)
);
-- Phase 5 query: "recent active clusters".
CREATE INDEX IF NOT EXISTS news_clusters_last_seen_idx
  ON news_clusters (last_seen_at DESC)
  WHERE status = 'active';

-- N:M between global_news_items and news_clusters. UNIQUE prevents the same
-- item being attached to a cluster twice (cluster handler is idempotent on
-- re-enqueue).
CREATE TABLE IF NOT EXISTS news_cluster_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id uuid NOT NULL REFERENCES news_clusters(id) ON DELETE CASCADE,
  news_item_id uuid NOT NULL REFERENCES global_news_items(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT news_cluster_items_unique UNIQUE (cluster_id, news_item_id),
  -- One news_item belongs to at most one cluster (otherwise cluster-level
  -- matching in Phase 5 explodes into N matches per workspace per item).
  CONSTRAINT news_cluster_items_news_item_unique UNIQUE (news_item_id)
);
CREATE INDEX IF NOT EXISTS news_cluster_items_cluster_idx
  ON news_cluster_items (cluster_id);
