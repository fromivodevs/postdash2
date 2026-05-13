# Workers and Source-centric Ingestion

## 1. Main principle

Не запускать поиск отдельно для каждого пользователя, если источники пересекаются.

Корректная модель:

```text
Sources are global.
Subscriptions are per workspace.
Fetching is global.
Matching is per workspace.
Draft generation is per workspace.
Publishing is per channel.
```

## 2. Why source-centric ingestion

Если 100 workspaces подписаны на Product Hunt, fetch'им его один раз, не 100.

Benefits:
- cheaper;
- faster;
- less rate-limit risk;
- better dedupe;
- source reputation analytics;
- proper scaling.

## 3. Pipeline overview

```text
Scheduler
  v
fetch_source tasks
  v
SourceWorker (fetch + parse + canonicalize)
  v
global_news_items (raw)
  v
extract_news_item tasks (text extraction)
  v
embed_news_item tasks (Yandex embeddings)
  v
news_clusters (semantic dedup)
  v
match_news_to_workspaces tasks
  v
score_workspace_match tasks (DeepSeek scoring + cost guard)
  v
workspace_news_matches
  v
generate_post_draft tasks for high score (с cost guard)
  v
post_drafts + post_draft_versions
  v
Mini App radar/editor
  v
publish_post tasks (с idempotency + re-checks)
  v
publish_events
```

## 4. Task types MVP

```text
fetch_source
extract_news_item
embed_news_item
cluster_news
recompute_topic_embedding
match_news_to_workspaces
score_workspace_match
generate_post_draft
rewrite_post_draft
publish_post
janitor_release_stuck_tasks
janitor_promote_deferred
janitor_finalize_pending_publishes
refresh_iam_token
```

Для MVP некоторые могут быть объединены, но keep task types explicit.

## 5. Worker model

Worker pool, не permanent worker per source.

Корректно:
- 5–10 worker processes;
- workers поллят `tasks` таблицу;
- worker лочит task через atomic UPDATE;
- task имеет priority;
- source fetch имеет source-level lock (через partial unique или `source_fetch_locks`).

Polling pattern:

```sql
UPDATE tasks
SET status='running',
    locked_by=$worker_id,
    locked_until=now() + interval '5 minutes',
    started_at=now()
WHERE id = (
  SELECT id FROM tasks
  WHERE status='pending' AND scheduled_at <= now()
  ORDER BY priority DESC, scheduled_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

`FOR UPDATE SKIP LOCKED` — ключ к concurrent worker'ам без deadlock.

## 6. Source-level lock

Гарантия:

> Только один активный fetch на source.

Реализация MVP — через partial unique index на `tasks`:

```sql
CREATE UNIQUE INDEX tasks_unique_active_fetch_per_source
  ON tasks (source_id)
  WHERE type='fetch_source' AND status IN ('pending','running');
```

Это блокирует scheduler от создания дубль-задачи. Параллельно worker имеет 5-min lease через `locked_until`.

Альтернатива — Postgres advisory locks (`pg_try_advisory_xact_lock(hashtext(source_id))`).

## 7. Task priority

```text
100 publish_post
95  janitor_finalize_pending_publishes
90  rewrite_post_draft
80  user_requested_fetch / user_research (later)
70  recompute_topic_embedding
60  generate_post_draft
55  score_workspace_match
50  match_news_to_workspaces
45  embed_news_item
40  fetch_source (scheduled)
35  extract_news_item
20  cleanup / background
10  janitor_release_stuck_tasks
```

User-actions не должны ждать background fetch'а.

## 8. Scheduler

Scheduler responsibilities:
- найти active sources, которые due для fetch'а;
- создать fetch tasks (с защитой от duplicate через partial unique);
- respect source `fetch_interval_minutes`;
- respect global rate limits;
- не создавать catch-up серий после downtime (одна fetch-task с current state).

Pseudo:

```text
for source in active sources where now() - last_fetched_at > fetch_interval_minutes:
    INSERT INTO tasks (type='fetch_source', source_id=source.id, ...)
    ON CONFLICT DO NOTHING  -- partial unique index ловит дубли
```

Cron-jobs scheduler'а:
- `* * * * *` — основной tick (1 раз в минуту).
- `0 0 * * *` (00:00 UTC) — promote deferred tasks → pending (cost guard reset).
- `*/5 * * * *` — janitor: stuck `running` tasks, expired source_fetch_locks, pending publishes.

## 9. URL canonicalization

Перед UPSERT в `global_news_items` URL канонизируется. Это **критично** для dedup — без канонизации `?utm=x` версия и чистая попадут как разные items.

Правила MVP (`packages/sources/canonicalize.ts`):

1. **Scheme**: всегда `https://` (страны без HTTPS — out of scope).
2. **Host**: lowercase, strip leading `www.` (но `m.example.com` оставлять — это другой site).
3. **Path**: strip trailing slash (кроме `/`).
4. **Query**: 
   - удалить `utm_*`, `fbclid`, `gclid`, `yclid`, `mc_cid`, `mc_eid`, `_hsenc`, `_hsmi`, `ref`, `ref_src`, `igshid`, `si`;
   - оставшиеся params отсортировать alphabetically;
   - сохранить параметры, которые меняют контент (`id`, `p`, `slug`, `date`, и т.п.).
5. **Fragment**: всегда удалять `#fragment`.
6. **Specific overrides**:
   - `news.ycombinator.com` → `https://news.ycombinator.com/item?id=<id>`;
   - `reddit.com/r/.../comments/<id>/<slug>/` → `https://reddit.com/comments/<id>`;
   - `twitter.com/...` и `x.com/...` → нормализовать на `https://x.com/<user>/status/<id>` (или skip — out of MVP).
7. **Redirect resolution**: при создании source URL резолвится один раз через HEAD/GET с `redirect:'follow'`, хранится final canonical.

`canonicalization_rule_version` в `sources` хранит версию правил. При bump'е — backfill task пересчитывает canonical_url'ы.

## 10. Fetch worker

Для каждого `fetch_source` task'а:

1. `verify lock` (locked_by, locked_until ok).
2. fetch data:
   - RSS: parse via `rss-parser` или `fast-xml-parser`;
   - HTML scraping: только если RSS отсутствует — out of MVP unless необходимо;
   - API endpoints: per-source adapters (Phase 4+ если нужно).
3. Парсинг title/url/date/summary.
4. Volume cap: take first `min(items.length, source.max_items_per_fetch)`. Остаток помечается `skipped_volume_cap`.
5. Для каждого item:
   - canonicalize url;
   - compute `content_hash` (sha256 of normalized title+summary+published_at);
   - UPSERT `global_news_items (source_id, canonical_url)`:
     - если existing с тем же content_hash → skip;
     - если existing с разным content_hash → `was_updated=true`, `last_updated_in_source_at=now()`, update text/summary, optional re-score (if similarity < 0.9);
     - иначе INSERT.
6. Создать downstream tasks:
   - `extract_news_item` если extracted_text нужен и его нет;
   - `embed_news_item` если embedding нужен;
   - `match_news_to_workspaces` для каждой workspace_source_subscription.
7. `UPDATE source SET last_fetched_at=now(), last_fetch_status='ok', last_fetch_error=null`.
8. Mark task `completed`.

На fail:
- `attempts++`;
- если `attempts >= max_attempts` → `status='failed_permanent'`, `source.status='error'`, surface UI.

## 11. Deduplication

### 11.1 Структурный dedup (Phase 4)

- `canonical_url` unique constraint;
- `content_hash` matching.

### 11.2 Семантический dedup (Phase 4)

После extraction:
1. `embed_news_item` task получает embedding (256-dim) от YandexGPT Embeddings (`text-search-doc`).
2. Запрос ближайших соседей в окне `AI_DEDUPE_WINDOW_HOURS` (default 48h):
   ```sql
   SELECT id, embedding <=> $1 AS distance
   FROM global_news_items
   WHERE published_at > now() - interval '48 hours'
     AND embedding_status = 'ok'
   ORDER BY embedding <=> $1
   LIMIT 5;
   ```
3. Если `min(distance) < AI_DEDUPE_COSINE_THRESHOLD` (default 0.15) — линкуется в существующий `news_cluster`. Иначе — новый cluster.

### 11.3 Cluster management

- `news_clusters.sources_count` инкрементируется при добавлении item'а из нового source;
- `centroid_embedding` пересчитывается как average всех item-embeddings cluster'а;
- main_url выбирается по `source.reliability_score`.

## 12. Matching

`match_news_to_workspaces` task для (news_item, workspace) pair.

### 12.1 Cluster-level matching

Если новость принадлежит cluster'у (`news_cluster_items` linked), matching работает на **cluster-level**, не item-level.

Это критично: одна и та же новость из 5 источников = 5 `news_items` в одном cluster'е. Без cluster-level matching workspace получит 5 entries в `workspace_news_matches` → 5 дублей в Radar.

Алгоритм:
1. Если cluster_id есть — проверяем, есть ли уже `workspace_news_matches (workspace_id, cluster_id)`. Если да — skip.
2. Если cluster_id нет — проверяем `(workspace_id, news_item_id)` (для не-кластеризованных новостей).
3. UPSERT с обоими `news_item_id` И `cluster_id` (item — конкретный representative, cluster — группа).

Partial unique indexes из `03-DATABASE-SCHEMA.md` обеспечивают атомарность.

При появлении нового источника той же новости — cluster пополняется, но workspace_news_match остаётся одна (idempotent).

### 12.2 Matching steps

Inputs:
- news title, summary, extracted_text, embedding;
- workspace topics, keywords, negative_keywords, language, source subscription rules;
- topic_profile embedding.

Steps:
1. **Cluster dedup**: см. 12.1 — если match уже есть, skip.
2. **Pre-filter**: hit negative_keyword (case-insensitive whole-word) → `status='filtered_negative'`, skip scoring.
3. **Language gate**: `news.language != topic_profile.language` И profile запрещает cross-lang → skip.
4. **Semantic pre-score**: cosine similarity между `news.embedding` и `topic_profile.embedding`. Если < `MATCHING_MIN_COSINE` (env, default 0.05) → `status='hidden'`, skip.
5. **AI score**: enqueue `score_workspace_match` task (если cost guard позволяет).

Если cost guard отказал — `status='candidate'` без score, surface в UI как "pending scoring".

### 12.3 Sharing model: что глобально, что per workspace

Это decision-fixation для будущих фаз.

**Глобально (общее между workspace'ами):**
- fetch, text extraction;
- embedding (`text-search-doc`);
- semantic dedup (cluster building);
- `global_quality_score` (одна LLM-обработка качества per news, см. `07-AI-SCORING-AND-DRAFTS.md §2.1`).

**Per workspace (не шарится никогда):**
- `workspace_news_matches.score` — зависит от topic_profile, keywords, audience;
- `relevance_reason` — explanation для конкретного workspace;
- `post_drafts` и `post_draft_versions` — **дословно шарить нельзя**, риск дублей-постов в разных каналах с пересекающейся аудиторией.

Промежуточный слой ("neutral news card") как глобальный pre-digest для удешевления draft-генерации — рассмотрен как Phase MVP+1 в `10-FUTURE-EXPANSION.md §15`.

## 13. Draft generation threshold

Не генерируем draft для каждого match.

MVP rules:

```text
score >= 7.5 -> create generate_post_draft task (если cost guard позволяет)
score 5.0-7.4 -> show candidate без auto-draft (user может вручную создать draft)
score < 5.0  -> hidden (или low priority в UI)
```

Threshold tunable через env `AUTO_DRAFT_SCORE_THRESHOLD`.

## 14. Rewrite tasks

Rewrite — high priority (user ждёт).

Каждый rewrite:
- читает current draft version (snapshot на момент scheduling);
- проверяет cost guard;
- применяет instruction через `AIProvider.rewriteDraft`;
- создаёт новую `post_draft_version`;
- обновляет `current_version_id`, если в это время не было manual edit'а.

Concurrent rewrite на одном draft → `post_drafts.status='rewriting'` блокирует второй, 409 ответ.

Manual edit пока rewrite в queue: AI создаёт новую версию на основе snapshot'а, `current_version_id` остаётся на manual.

## 15. Failure handling

Каждый task:

```text
attempts (default 0)
max_attempts (default 3)
last_error text nullable
status (pending / running / completed / failed / failed_permanent / deferred / skipped_volume_cap)
```

Retry policy:
- transient (5xx, network, timeout): exponential backoff (10s, 30s, 90s), retry до `max_attempts`;
- permanent (4xx, validation, refused): mark `failed_permanent` сразу;
- after `max_attempts` → `failed_permanent`, surface в admin/log;
- `deferred` (cost cap) — janitor promotes → `pending` в next reset window.

## 16. Janitor cron jobs

Запускаются каждые 5 минут:

### 16.1 Release stuck running tasks

```sql
UPDATE tasks
SET status='pending', locked_by=NULL, locked_until=NULL
WHERE status='running' AND locked_until < now();
```

### 16.2 Finalize pending publishes

`publish_events` с `status='pending'` старше 5 минут:
- попытаться reconcile через Telegram API (если был external_message_id где-то retained — но MVP его нет до success);
- иначе `status='unknown'`, surface в admin UI для manual review;
- НЕ retry автоматически (риск двойной публикации).

### 16.3 Promote deferred at 00:00 UTC

```sql
UPDATE tasks
SET status='pending'
WHERE status='deferred';
```

Затем reset `ai_budget_state` — он реализован через `(workspace_id, day)`, новый день = новая запись, ничего удалять не нужно.

### 16.4 Source_fetch_locks cleanup

```sql
DELETE FROM source_fetch_locks WHERE locked_until < now();
```

## 17. MVP worker service

Start simple:
- один worker service binary / process;
- concurrency через env;
- handles all task types;
- task priority polling.

Env:

```text
WORKER_CONCURRENCY=10
TASK_POLL_INTERVAL_MS=1000
TASK_LEASE_MINUTES=5
MAX_ITEMS_PER_FETCH_DEFAULT=50
AUTO_DRAFT_SCORE_THRESHOLD=7.5
MATCHING_MIN_COSINE=0.05
AI_DEDUPE_COSINE_THRESHOLD=0.15
AI_DEDUPE_WINDOW_HOURS=48
```

Later:
- split fetch workers, AI workers;
- dedicated queue если станет узким.

## 18. Observability MVP

Log per task:
- start;
- complete;
- fail;
- duration;
- source_id, workspace_id, task_id.

Basic metrics:
- tasks pending count (per type);
- tasks failed_permanent count;
- fetch duration p50/p95;
- AI duration p50/p95;
- AI failures count;
- AI cost (RUB) sum per day per workspace;
- publish failures count.

MVP — просто SQL-queries из `tasks`, `task_runs`, `ai_usage_events`, `publish_events`.

## 19. Source health UI

В Mini App "Источники" показывать:
- `sources.last_fetched_at` — relative ("5 минут назад");
- `sources.last_fetch_status` (ok / error);
- `sources.last_fetch_error` (если есть);
- ETA next fetch (`last_fetched_at + fetch_interval_minutes`);
- кнопка "Проверить сейчас" — создаёт `fetch_source` task с priority=80.

Helps user понять, почему news не появляются.
