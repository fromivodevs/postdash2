# Global Ingestion + Task System + Embeddings (Phase 4)

## Purpose

Глобальный fetch источников один раз (не по разу за workspace), извлечение текста новостей, генерация embedding'ов (Yandex `text-search-doc`, 256-dim), и семантический dedup в `news_clusters`. Phase 4 — это инфраструктурный слой между Phase 3 (источники сконфигурированы) и Phase 5 (matching/scoring per workspace).

## Boundaries

**In scope:**
- Постоянный task queue (`tasks` + `task_runs`) с atomic polling (`FOR UPDATE SKIP LOCKED`).
- Scheduler cron: 1/min (enqueue due `fetch_source` tasks) + 5/min (janitor: stuck-task release, IAM refresh trigger).
- 6 task handlers: `fetch_source`, `extract_news_item`, `embed_news_item`, `cluster_news`, `janitor_release_stuck_tasks`, `refresh_iam_token`.
- RSS parser (`packages/sources/rss-parser.ts`).
- Real Yandex IAM token refresh (JWT → Bearer) с writethrough в `system_state`.
- Real Yandex Embeddings (`AIProvider.embed` через Foundation Models textEmbedding endpoint, 256-dim).
- Глобальные таблицы: `global_news_items`, `news_clusters`, `news_cluster_items`, `system_state`.

**Out of scope (явно):**
- Matching на workspace topics — Phase 5 (`workspace_news_matches`, `score_workspace_match`).
- Score / generate / rewrite — Phase 5/6 (`AIProvider.score`/`generateDraft`/`rewriteDraft` остаются stubs).
- Cost guard (`ai_budget_state`) — Phase 6. Embeddings вне cap по политике (§10).
- Publishing — Phase 7.

## Main state

Шесть новых таблиц в `packages/db/migrations/0005_phase4.sql`, mirrored в `packages/db/src/schema.ts`:

- **`tasks`** — очередь. Колонки: `id, type, priority, status, payload jsonb, workspace_id?, source_id?, locked_by?, locked_until?, attempts, max_attempts, scheduled_at, started_at?, completed_at?, last_error?, created_at, updated_at`. Партиальные UNIQUE: `(source_id) WHERE type='fetch_source' AND status IN ('pending','running')` — защита от duplicate fetch tasks (edge 9.3).
- **`task_runs`** — per-attempt лог. `id, task_id FK, worker_id, started_at, finished_at?, status, error_message?`.
- **`system_state`** — key-value cross-worker (IAM token cache). `key text PK, value jsonb, expires_at?, updated_at`.
- **`global_news_items`** — общая лента после fetch. `id, source_id FK, title, url, canonical_url, content_hash, extracted_text?, summary?, published_at?, fetched_at, language?, embedding vector(256)?, embedding_status, embedding_updated_at?, last_updated_in_source_at?, was_updated, status`. UNIQUE `(source_id, canonical_url)` — структурный dedup в рамках одного source. ivfflat index на embedding.
- **`news_clusters`** — semantic dedup, одна "история" из N источников. `id, canonical_title, main_url?, first_seen_at, last_seen_at, sources_count, cluster_hash UNIQUE?, centroid_embedding vector(256)?, status`.
- **`news_cluster_items`** — N:M между `global_news_items` и `news_clusters`. UNIQUE `(cluster_id, news_item_id)`.

`tasks.status` enum: `pending | running | completed | failed | failed_permanent | deferred | skipped_volume_cap | cancelled`. `tasks.type` enum-like via CHECK: ровно 6 значений MVP.

## How it works

```
Scheduler (in-process cron)               Worker pool (concurrency=10)
       │                                          │
       │ 1/min: scan due sources                  │ atomic poll (FOR UPDATE SKIP LOCKED)
       │   INSERT tasks(fetch_source)             │   → lease 5 min via locked_until
       │   ON CONFLICT DO NOTHING                 │   → dispatch by type
       │     (partial unique blocks dupes)        │   → on success: complete; on fail: retry
       │                                          │     with backoff or failed_permanent
       │ 5/min: janitor                           │
       │   - release stuck running                │
       │   - enqueue refresh_iam_token if needed  │
       v                                          v

fetch_source (source_id)
  → http GET RSS
  → parse (rss-parser) → items[]
  → take first min(N, max_items_per_fetch); rest = skipped_volume_cap
  → for each item:
      canonicalize(url)
      content_hash = sha256(title+summary+published_at_iso)
      INSERT global_news_items ON CONFLICT (source_id, canonical_url) DO ...
        if content_hash matches: skip
        if differs: UPDATE was_updated=true, last_updated_in_source_at=now()
  → enqueue extract_news_item for each new/updated item
  → UPDATE sources SET last_fetched_at=now(), last_fetch_status='ok'

extract_news_item (news_item_id)
  → currently: use RSS summary as extracted_text (HTML scraping is Phase 4+)
  → enqueue embed_news_item

embed_news_item (news_item_id)
  → ai.embed({ text: title + " " + extracted_text, kind: 'doc' })
  → validate vector.length === AI_EMBEDDING_DIM (256)
  → UPDATE global_news_items SET embedding=$1, embedding_status='ok'
  → enqueue cluster_news

cluster_news (news_item_id)
  → SELECT nearest neighbours
       WHERE published_at > now() - 48h AND embedding_status='ok'
       ORDER BY embedding <=> $1 LIMIT 5
  → if min(distance) < AI_DEDUPE_COSINE_THRESHOLD (0.15):
       attach to existing cluster (INSERT news_cluster_items; sources_count++; recompute centroid)
     else:
       INSERT news_clusters; INSERT news_cluster_items

janitor_release_stuck_tasks  (no payload)
  → UPDATE tasks SET status='pending', locked_by=NULL, locked_until=NULL,
                     attempts=attempts+1
                 WHERE status='running' AND locked_until < now()
                 RETURNING id

refresh_iam_token  (no payload)
  → if system_state.expires_at - 60min > now(): no-op
  → mint JWT signed with YA_SA_KEY_JSON private key
  → POST iam.api.cloud.yandex.net/iam/v1/tokens with {jwt}
  → INSERT/UPDATE system_state (key='ya_iam_token', value, expires_at)
```

### Task queue contract

Atomic poll (single SQL statement):

```sql
UPDATE tasks SET
  status = 'running',
  locked_by = $worker_id,
  locked_until = now() + ($lease_minutes || ' minutes')::interval,
  started_at = now(),
  attempts = attempts + 1,
  updated_at = now()
WHERE id = (
  SELECT id FROM tasks
  WHERE status = 'pending' AND scheduled_at <= now()
  ORDER BY priority DESC, scheduled_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

`FOR UPDATE SKIP LOCKED` гарантирует, что два worker'а в той же миллисекунде получат разные tasks или null. Lease (`locked_until = now() + 5 min`) — recovery после crash (janitor подбирает через 5 минут).

Retry policy (`completeTask`/`failTask` в `packages/tasks/queue.ts`):

| Outcome | Action |
|---|---|
| handler returned ok | status='completed', completed_at=now() |
| handler threw transient (5xx/network/timeout) | attempts < max_attempts → status='pending', scheduled_at=now()+backoff, locked_by=null; иначе → status='failed_permanent' |
| handler threw permanent (4xx/validation/refused) | status='failed_permanent' немедленно |
| handler threw "deferred" (cost cap) | status='deferred' (Phase 6 hook; Phase 4 не использует) |

Backoff: 10s → 30s → 90s (exponential ×3).

### IAM token lifecycle

`packages/ai/iam-token.ts.IAMTokenCache`:

- In-memory + writethrough cache в `system_state(key='ya_iam_token')`.
- `getToken()` — если in-memory свеж (≥1h до expiry) → return; иначе → `refresh()`.
- `refresh()` — JWT signed RS256 ключом из SA JSON, POST iam.api.cloud.yandex.net. Single-flight (concurrent calls share promise).
- Writethrough: после refresh — `INSERT INTO system_state ... ON CONFLICT (key) DO UPDATE`.
- Cold-start (новый worker) сначала читает из `system_state`; если найден неистёкший токен — использует его, refresh пропускается.
- `refresh_iam_token` task — proactive refresh каждые 10 часов (token живёт 12h). Worker сам делает refresh on-demand при 401 от Foundation Models API; task — резерв на случай долгого простоя.

### Embeddings

`YandexAIStudioDeepSeekProvider.embed(input)`:

- POST `https://llm.api.cloud.yandex.net/foundationModels/v1/textEmbedding`
- Body: `{ modelUri, text }`. `modelUri` выбирается по `kind` (`'doc' | 'query'`) → `YA_EMBED_DOC_MODEL_URI` / `YA_EMBED_QUERY_MODEL_URI`.
- Bearer: `await iamToken.getToken()`.
- Response: `{ embedding: number[], numTokens: string, modelVersion: string }`.
- Validate `embedding.length === AI_EMBEDDING_DIM` (256). Mismatch → `AIProviderError('dim_mismatch', 'parse_error')`.
- 5xx + AbortError → throw `AIProviderError(..., 'server_error')` — `embed_news_item` handler ловит, retries via task queue (max_attempts=3). После exhaust → `embedding_status='failed'` (janitor retry'ит позже на отдельном backfill task'е, упрощённо: повторный enqueue из ручного admin job — out of MVP).
- 401 → force IAM refresh + retry one раз.

### Clustering algorithm

Pure SQL (no app-side cosine):

```sql
SELECT id, cluster_id, embedding <=> $1::vector AS distance
FROM global_news_items
LEFT JOIN news_cluster_items ON news_cluster_items.news_item_id = global_news_items.id
WHERE published_at > now() - interval '48 hours'
  AND embedding_status = 'ok'
  AND global_news_items.id != $2
ORDER BY embedding <=> $1::vector
LIMIT 5;
```

Если `min(distance) < AI_DEDUPE_COSINE_THRESHOLD` (0.15) — берём `cluster_id` ближайшего соседа (или создаём cluster из этой пары если у соседа cluster_id IS NULL). Иначе — новый cluster.

Centroid пересчёт — простое усреднение всех embedding'ов cluster'а в момент добавления:

```sql
UPDATE news_clusters SET
  centroid_embedding = (
    SELECT AVG(embedding) FROM global_news_items g
    JOIN news_cluster_items ci ON ci.news_item_id = g.id
    WHERE ci.cluster_id = news_clusters.id AND g.embedding_status='ok'
  ),
  sources_count = (
    SELECT COUNT(DISTINCT g.source_id)
    FROM global_news_items g
    JOIN news_cluster_items ci ON ci.news_item_id = g.id
    WHERE ci.cluster_id = news_clusters.id
  ),
  last_seen_at = now()
WHERE id = $cluster_id;
```

Cross-language merge работает за счёт robustness Yandex embedding к языку (см. edge 11.6, 5.5).

## Module decomposition

- **`packages/tasks`** (new) — task queue primitives: enqueue, atomic poll, complete/fail/defer, retry/backoff policy. Pure data layer, no business logic.
- **`packages/sources/rss-parser.ts`** — fetch + parse RSS/Atom feed, return normalized `ParsedItem[]`. Wraps `rss-parser` dependency.
- **`packages/sources/content-hash.ts`** — `contentHash(title, summary, publishedAt)` → sha256 hex.
- **`packages/ai/iam-token.ts`** — full IAM JWT refresh + system_state writethrough.
- **`packages/ai/providers/yandex.ts`** — implement real `embed()`. score/generate/rewrite остаются stubs (Phase 5/6).
- **`apps/worker/src/dispatcher.ts`** — task type → handler routing.
- **`apps/worker/src/handlers/*.ts`** — 6 handler файлов, по одному на task type.
- **`apps/worker/src/scheduler.ts`** — in-process cron (1/min + 5/min).
- **`apps/worker/src/loop.ts`** — orchestrates dispatcher + scheduler.

## Interface contracts

### `packages/tasks`

```ts
export type TaskType =
  | 'fetch_source'
  | 'extract_news_item'
  | 'embed_news_item'
  | 'cluster_news'
  | 'janitor_release_stuck_tasks'
  | 'refresh_iam_token';

export type TaskStatus =
  | 'pending' | 'running' | 'completed'
  | 'failed' | 'failed_permanent'
  | 'deferred' | 'skipped_volume_cap' | 'cancelled';

export interface EnqueueTaskInput {
  type: TaskType;
  payload?: Record<string, unknown>;
  workspaceId?: string;
  sourceId?: string;
  priority?: number;
  scheduledAt?: Date;
  maxAttempts?: number;
}

export async function enqueueTask(db: DbOrTx, input: EnqueueTaskInput):
  Promise<{ id: string; created: boolean }>;     // false = ON CONFLICT DO NOTHING

export interface PollResult {
  id: string; type: TaskType; payload: unknown;
  attempts: number; maxAttempts: number;
  workspaceId: string | null; sourceId: string | null;
}
export async function pollNextTask(client: Sql, workerId: string, leaseMinutes: number):
  Promise<PollResult | null>;

export async function completeTask(client: Sql, taskId: string): Promise<void>;

export type FailKind = 'transient' | 'permanent';
export async function failTask(client: Sql, taskId: string, err: { kind: FailKind; message: string }):
  Promise<void>;

export async function deferTask(client: Sql, taskId: string, until: Date, reason: string):
  Promise<void>;

export async function releaseStuckTasks(client: Sql): Promise<number>;
```

### `packages/sources/rss-parser.ts`

```ts
export interface ParsedItem {
  title: string;
  link: string;
  summary?: string;
  publishedAt?: Date;
  language?: string;
}
export interface FetchOptions {
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  maxItems?: number;
}
export type FetchStatus = 'ok' | '4xx' | '5xx' | 'parse_error' | 'timeout';
export interface FetchResult {
  status: FetchStatus;
  items: ParsedItem[];
  rawCount: number;     // pre-cap, for skipped_volume_cap accounting
  error?: string;       // ≤200 chars
}
export async function fetchRssSource(url: string, opts?: FetchOptions): Promise<FetchResult>;
```

### `packages/sources/content-hash.ts`

```ts
export function contentHash(input: {
  title: string;
  summary?: string;
  publishedAt?: Date;
}): string;     // sha256 hex over `${title}|${summary}|${publishedAt.toISOString()}`
```

### `apps/worker/src/dispatcher.ts`

```ts
export interface TaskHandlerCtx {
  db: Database; client: Sql; ai: AIProvider; logger: Logger;
  enqueue: typeof enqueueTask;
}
export type TaskHandler = (task: PollResult, ctx: TaskHandlerCtx) => Promise<void>;

export class Dispatcher {
  register(type: TaskType, handler: TaskHandler): void;
  dispatch(task: PollResult, ctx: TaskHandlerCtx): Promise<void>;
}
```

## Data flow

```
                                ┌──────────────────┐
                                │ scheduler tick   │
                                │ (1/min, 5/min)   │
                                └─────────┬────────┘
                                          │ enqueueTask(fetch_source, source_id)
                                          ▼
sources rows ────────────────► tasks (status='pending')
                                          │
                                          │ pollNextTask  (FOR UPDATE SKIP LOCKED)
                                          ▼
                              ┌─────────────────────────┐
                              │  Dispatcher             │
                              │  (apps/worker)          │
                              └──┬───┬───┬───┬───┬───┬──┘
                                 │   │   │   │   │   │
              ┌──────────────────┘   │   │   │   │   └──────────────────┐
              │  fetch_source      extract embed cluster  janitor    refresh_iam_token
              ▼                       │   │   │   │
   ┌────────────────────┐             │   │   │   │
   │ rss-parser         │             │   │   │   │
   │ fetchRssSource     │             │   │   │   │
   └─────────┬──────────┘             │   │   │   │
             │  ParsedItem[]          │   │   │   │
             ▼                        │   │   │   │
     canonicalize + contentHash       │   │   │   │
             │                        │   │   │   │
             ▼                        │   │   │   │
   global_news_items (UPSERT)  ─────► extract ─── embed (ai.embed) ──► cluster_news
   tasks (UPDATE last_fetched_at)                       │                  │
                                                        ▼                  ▼
                                              global_news_items   news_clusters +
                                              (UPDATE embedding)  news_cluster_items
```

## Dependency graph

```
apps/worker
  → packages/tasks                  (enqueue, poll, complete/fail, releaseStuck)
  → packages/sources                (fetchRssSource, canonicalize, contentHash)
  → packages/ai                     (AIProvider.embed, IAMTokenCache)
  → packages/db                     (Pool, Database, schema tables)
  → @postdash/shared                (logging helpers)

packages/tasks
  → packages/db                     (Database, DbOrTx, tasks/task_runs tables)
  → drizzle-orm                     (sql template, conditions)

packages/sources (Phase 4 additions)
  → rss-parser  (new dep)
  → node:crypto (sha256)
  → existing canonicalize / redirect-resolver

packages/ai (Phase 4 additions)
  → node:crypto                     (JWT RS256 signing for IAM)
  → packages/db (optional)          (system_state writethrough — INJECTED via callback to avoid cycle)
```

`packages/ai` НЕ импортирует `packages/db` напрямую — writethrough в `system_state` идёт через инжектируемый `IAMTokenStore` interface, реализация которого живёт в worker'е. Это сохраняет правило "ai is an adapter, не зависит от persistence".

## Integration points

- Reads from Phase 3 `sources` (FK `tasks.source_id`); writes `last_fetched_at`, `last_fetch_status`, `last_fetch_error`.
- Reads from Phase 3 `workspace_source_subscriptions` для будущего fan-out per workspace (Phase 5 enqueue'ит `match_news_to_workspaces`).
- Writes `system_state(key='ya_iam_token')`. Phase 6 score/draft handlers будут читать тот же key.
- Не трогает `topic_profiles.embedding` (Phase 5 `recompute_topic_embedding` task).
- Не трогает `workspace_news_matches`, `post_drafts`, `publish_events` (Phase 5/6/7).

## Invariants

- **Один активный fetch per source.** Партиальная UNIQUE на `tasks(source_id) WHERE type='fetch_source' AND status IN ('pending','running')` — на DB layer. Scheduler полагается на `INSERT ... ON CONFLICT DO NOTHING`.
- **Atomic task acquisition.** Любой polling — через `FOR UPDATE SKIP LOCKED`. Никаких `SELECT ... then UPDATE`-двух-шагов.
- **Embedding dim — 256, всегда.** Validate в `embed()`, reject на runtime если model вернул другую длину. CHECK `cardinality(embedding) = 256` на DB layer (pgvector сам enforce'ит через `vector(256)`).
- **Structural dedup по (source_id, canonical_url).** UNIQUE constraint. Один и тот же URL в одном source — одна row.
- **Semantic dedup window — 48h по `published_at`.** Cluster lookups не идут глубже чем `now() - 48h` (защита от unbounded query cost).
- **No cross-package DB writes from ai/.** `packages/ai` не импортирует `packages/db`. Writethrough в system_state — через инжектируемый callback.
- **Workers crash-safe.** Lease 5 минут гарантирует, что janitor подберёт зависшую task. На каждый `attempts++` — если max_attempts достигнут → failed_permanent (без бесконечных retry).
- **No catch-up storm после downtime.** Scheduler смотрит на `last_fetched_at` и enqueue'ит ОДИН fetch (current state), не серию historical pulls (edge 9.8).

## Decision log

### Decision: новая отдельная packages/tasks (не часть packages/db)

**Considered:** засунуть всё в `packages/db/src/tasks/*`, либо сделать отдельный package.
**Chosen:** отдельный `packages/tasks`.
**Why:** task primitives (enqueue, poll, complete/fail/defer + retry policy) — это бизнес-семантика очереди, не низкоуровневая SQL-инфра. У них есть state machine (`pending → running → completed | failed | failed_permanent | deferred`) и retry policy с backoff'ом. Держать рядом со schema raw definitions смешивало бы концепции. Отдельный package — это путь, который воспроизводят все три consumer'а (worker, api для admin-debug в Phase 8, scheduler) без рекурсивных импортов.
**Tradeoff:** ещё один workspace package, дополнительный pnpm install. Не критично.

### Decision: in-process scheduler (НЕ внешний cron)

**Considered:** OS-level cron / external scheduler (Render scheduler, Kubernetes CronJob), node-cron, separate scheduler service.
**Chosen:** in-process tick в `apps/worker` (setInterval с jitter).
**Why:** один worker процесс MVP-уровня; scheduler tick — простая SQL-операция (scan due sources, INSERT ... ON CONFLICT). Atomic via leader-election не нужен потому что `INSERT ... ON CONFLICT DO NOTHING` на partial unique гарантирует idempotency даже при N concurrent ticks. Внешний cron создаёт оперативную сложность (синхронизация деплоя, два разных runtime'а) без ROI на MVP.
**Tradeoff:** если worker процесс упал — scheduler паузится до перезапуска. Janitor (через `releaseStuckTasks`) подбирает зависшие tasks при следующем старте. Health-check мониторит worker процесс.

### Decision: cluster_news через SQL (a не in-memory clustering)

**Considered:** загрузить все embeddings в worker memory, кластеризовать через JS-библиотеку (`density-clustering`, k-means).
**Chosen:** в SQL через pgvector `embedding <=> $1::vector`.
**Why:** pgvector с ivfflat индексом → O(log N) поиск ближайших соседей; в memory было бы O(N) при каждом item'е. Кроме того, in-memory model плохо ведёт себя с растущим объёмом (рестарт worker'а = потеря state). SQL делает join + sort + limit без round-trip'ов.
**Tradeoff:** cosine distance threshold нужно тюнить через env (`AI_DEDUPE_COSINE_THRESHOLD`), без ML-tunable метрик. Acceptable trade-off.

### Decision: IAM writethrough в system_state с in-memory cache

**Considered:** только in-memory (без persistence); только system_state (без cache); внешний secret-store (Vault).
**Chosen:** in-memory + writethrough в `system_state`.
**Why:** in-memory спасает от 100% RPS hit на iam.api.cloud.yandex.net; system_state нужен потому что worker процессов может быть >1, и не хочется N concurrent IAM-token-refresh requests при cold-start (cache miss × N). Writethrough хранит токен в БД с `expires_at`; cold-start читает оттуда, не дёргает IAM endpoint.
**Tradeoff:** plaintext token в БД (но с expires_at и БД защищена не хуже чем app secret в env). Vault — over-engineering для MVP.

### Decision: HTML extraction отложена

**Considered:** real HTML content extraction через `@mozilla/readability` или `cheerio`.
**Chosen:** в Phase 4 `extracted_text` = RSS `summary` field. Real HTML scraping — Phase 4+.
**Why:** RSS обычно содержит достаточно контента в summary/description. HTML scraping добавляет крупную зависимость + edge cases (paywall, JS-rendered, anti-bot). Лучше выпустить рабочий ingestion и добавить scraping по требованию реальных источников.
**Tradeoff:** для source'ов с минимальными RSS summary embeddings будут менее качественные. UI surface'нет это как low-content badge в Phase 5+.

## Known follow-ups (named owners in amended plan)

> Все items ниже теперь имеют named-phase owner в
> `tg_mvp_plan/08-IMPLEMENTATION-ROADMAP.md` per "Phase Closure Discipline"
> (запрет vague "Phase 8+ ops"). Cross-references показывают конкретную фазу +
> bullet. Phase 4 scope больше не несёт эти items как открытые gap'ы — они
> bounded и tracked downstream.

- **Stranded `global_news_items` reaper.** Periodic task сканирует
  `status='embedded'` rows старше N часов, re-enqueue'ит `cluster_news`,
  плюс backfill `embedding_status='failed'` → retry. Needs new task type +
  CHECK migration + scheduler tick + rate-limiting. → **Phase 7 Catchup
  bullet "Stranded `global_news_items` reaper"**.
- **`task_runs` retention.** Unbounded audit table; daily DELETE на 30
  дней или partition. → **Phase 7 Catchup bullet "`task_runs` retention"**.
- **`ivfflat` REINDEX policy.** `lists = 100` сайзится для ≤100k vectors;
  past that требуется `lists = sqrt(n)`. `SET LOCAL ivfflat.probes = 10`
  per transaction остаётся recall floor, не substitute for REINDEX.
  → **Phase 7 Catchup bullet "`ivfflat` REINDEX policy"** (autoselect
  `lists = sqrt(n)` + weekly REINDEX-if-drift cron).
- **Worker `/health` endpoint + SIGTERM drain.** Render expects
  `/health` responses; SIGTERM exit без drain ронит leased tasks janitor'у
  на 5 минут. → **Phase 6 Catchup bullet "Worker `/health` + `/ready`
  endpoints"** + **"SIGTERM drain для worker"** (`WORKER_DRAIN_TIMEOUT_MS`).
- **`system_state` token encryption-at-rest.** IAM token живёт plaintext'ом
  в `system_state.value` (Phase 4 trade-off). → **Phase 7 Catchup bullet
  "`system_state` token encryption-at-rest"** (app-level symmetric key из
  env; полный Vault/KMS — Phase 12 billing scope).
- **Integration test harness для plan-promised scenarios.** Unit tests
  покрывают handler'ы в изоляции; end-to-end harness против transient
  Postgres + mock Yandex catches wiring drift. → **Phase 7 Catchup bullet
  "Integration test harness (`RUN_DB_TESTS=1`)"** (общая harness для всех
  0..7 scaffold phases — закрывает gap "unit-тесты проходят, wiring drift
  невидим", который был общим breaker'ом во всех phase loops).
- **Per-news-item task partial UNIQUE indexes** для `extract_news_item` и
  `embed_news_item` уже shipped в `0006_phase4_hardening.sql`
  (anti-duplicate ON `(payload->>'news_item_id')`). Schema.ts mirror —
  comment-only stub (Drizzle `.on()` не принимает SQL expressions). **Не
  follow-up: уже done; оставлено как documentation of choice.**
- **`sources.status='error'` retry cadence env var.** Hardcoded 60 min
  в `scheduler.fastTick`. Hour может быть too aggressive / too lax
  по operator feedback. → **Phase 7 Catchup bullet "`sources.status='error'`
  retry cadence env var"** (`SOURCES_ERROR_RETRY_INTERVAL_MINUTES`).
- **Connect-time IP pinning для fetch.** `fetch-source.ts` re-runs
  `resolveRedirect` для SSRF defence; `fetch()`'s TCP connect делает свой
  DNS lookup → TOCTOU между guard и connect. Custom `https.Agent({ lookup })`
  или undici `connect.lookup` пins IPs guard'а. → **Phase 7 Catchup bullet
  "Connect-time IP pinning"** (Phase 4 risk-acceptance: detective resolver,
  bounded blast radius, no body surface; Phase 7 закрывает preventive).
- **`cluster_news` orphan-cluster window.** Handler runs lookup + create +
  attach + recompute внутри одного `client.begin(...)`, но два concurrent
  workers могут оба INSERT'нуть `news_clusters` row для одного и того же
  neighbour. `news_cluster_items.UNIQUE(news_item_id)` prevents membership
  tear; orphan-cluster row просто leak'ается. Fix: `SELECT ... FOR UPDATE`
  на nearest neighbour's cluster row для сериализации concurrent writers.
  → **Phase 7 Catchup bullet "`cluster_news` orphan-cluster window fix"**
  + reaper из bullet выше covers cleanup существующих orphans.
- **`global_news_items.url` CHECK constraint.** `CHECK (url ~ '^https?://')`
  + migration backfill / cleanup для existing rows. → **Phase 7 Catchup
  bullet "`global_news_items.url` CHECK constraint"**.

## Files

- `packages/db/migrations/0005_phase4.sql` + `.down.sql` — 6 таблиц + индексы + pgvector ivfflat.
- `packages/db/migrations/0006_phase4_hardening.sql` + `.down.sql` — partial UNIQUE indexes on `(payload->>'news_item_id')` for `extract_news_item` and `embed_news_item` (anti-dupe).
- `packages/db/migrations/0007_phase4_perf_security.sql` + `.down.sql` — re-creates `tasks_polling_idx` with `(priority DESC, scheduled_at ASC)` column order (matches polling ORDER BY) and adds `cluster_news` partial UNIQUE on `(payload->>'news_item_id')`.
- `packages/db/src/schema.ts` — mirror новых таблиц.
- `packages/tasks/` — новый package: `src/queue.ts`, `src/types.ts`, `src/__tests__/queue.test.ts`, `package.json`, `tsconfig.json`.
- `packages/sources/src/rss-parser.ts` — fetch + parse RSS.
- `packages/sources/src/content-hash.ts` — sha256 helper.
- `packages/sources/src/__tests__/rss-parser.test.ts` + `content-hash.test.ts`.
- `packages/ai/src/iam-token.ts` — full IAM JWT refresh.
- `packages/ai/src/providers/yandex.ts` — real `embed()`.
- `packages/ai/src/__tests__/iam-token.test.ts` + `yandex-embed.test.ts`.
- `apps/worker/src/dispatcher.ts` — handler registry + dispatch.
- `apps/worker/src/handlers/{fetch-source,extract-news-item,embed-news-item,cluster-news,janitor-release-stuck-tasks,refresh-iam-token}.ts` — 6 task handlers.
- `apps/worker/src/scheduler.ts` — in-process cron.
- `apps/worker/src/loop.ts` — orchestration.
- `apps/worker/src/__tests__/*.test.ts` — handler unit tests.

## How to extend

**Новый task type:**
1. Добавить значение в `TaskType` enum в `packages/tasks/src/types.ts`.
2. Расширить CHECK constraint в новой migration (`ALTER TABLE tasks DROP CONSTRAINT tasks_type_check; ADD CONSTRAINT ...`).
3. Создать handler в `apps/worker/src/handlers/<task-type>.ts`.
4. Зарегистрировать в `loop.ts`: `dispatcher.register('new_type', handleNewType)`.
5. Добавить priority в таблицу `06-WORKERS-AND-INGESTION.md §7`.

**Новый source type (Atom, JSON-feed):**
1. Расширить `sources.type` CHECK + `SourceType` enum (`packages/domain/src/source.ts`).
2. Добавить parser в `packages/sources/src/<type>-parser.ts` экспортирующий тот же `FetchResult` shape.
3. Расширить dispatch в `fetch-source.ts` handler по `source.type`.

**Новый AI provider:**
- См. `architecture/topics-and-sources.md` (existing pattern). `packages/ai/src/providers/<name>.ts` implements `AIProvider`. Factory в `createAIProvider`.

## Status

Active. Closed at tag `phase-4-perfect-r4`. Phase 4+ ops follow-ups tracked in section above.

## Last touched

2026-05-17
