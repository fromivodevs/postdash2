# Matching and Scoring (Phase 5)

## Purpose

Превращает per-source global news (Phase 4 `global_news_items` +
`news_clusters`) в per-workspace radar items (`workspace_news_matches`).
Каждая запись — это решение "эта новость релевантна вот этому workspace,
score=X, причина Y, badge'и Z". UI читает один read-only endpoint `GET /radar`
и рендерит карточки в Mini App.

Phase 5 — последний "невидимый" слой перед Phase 6 (генерация draft'ов): без
него Phase 6 не имеет seeds для `generate_post_draft`, а пользователь не
видит зачем нужны источники и темы.

## Boundaries

**In scope:**
- Новая таблица `workspace_news_matches` (per-workspace) с cluster-level
  dedup через partial UNIQUE.
- Новая таблица `ai_usage_events` (per-AI-call cost/token accounting),
  заполняется из score handler. Phase 6 расширит на generate/rewrite.
- Три новых task type: `match_news_to_workspaces`, `score_workspace_match`,
  `recompute_topic_embedding` + соответствующие handler'ы в
  `apps/worker/src/handlers/`.
- Real `AIProvider.score()` на YandexAIStudioDeepSeekProvider (DeepSeek 3.2
  completion endpoint, zod-валидированный JSON output, single repair-attempt
  на parse failure, refused-content surface).
- `GET /radar` HTTP endpoint + Mini App Radar screen (status filter chips,
  score-emphasized cards, empty/loading/error states).
- Scheduler хук, который видит `topic_profiles.embedding_status='pending'`
  (флаг ставит `updateTopicProfile`) и enqueue'ит `recompute_topic_embedding`.

**Out of scope (явно):**
- Draft generation — Phase 6 (`generate_post_draft`, `rewrite_post_draft`).
- Cost guard `ai_budget_state` — Phase 6. Phase 5 содержит stub
  (`checkCostGuardStub` → всегда true).
- User-driven suppress UI — команда `suppressWorkspaceNewsMatch` написана и
  тестирована, но HTTP-роута + Mini App кнопки пока нет (Phase 6+).
- Cross-language matching — отключён в MVP per §12.2 (news.language ≠
  topic.language → status='hidden').
- Per-workspace настройки чувствительности (override
  MATCHING_MIN_COSINE / AUTO_DRAFT_SCORE_THRESHOLD per workspace) —
  Phase 8+ ops follow-up.

## Main state

Две новые таблицы в `packages/db/migrations/0008_phase5_matching_scoring.sql`,
mirrored в `packages/db/src/schema.ts`. Также CHECK constraint `tasks_type_check`
расширен тремя новыми task type, и партиальные UNIQUE индексы добавлены для
anti-dupe enqueue'ов.

### `workspace_news_matches`

Per-workspace radar entry. Колонки:

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `workspace_id` | `uuid FK workspaces` | ON DELETE CASCADE |
| `news_item_id` | `uuid FK global_news_items` | ON DELETE CASCADE |
| `cluster_id` | `uuid FK news_clusters?` | ON DELETE SET NULL |
| `score` | `numeric(4,2)?` | 0..10, null для filtered/hidden/refused |
| `relevance_reason` | `text?` | ≤280 chars (CHECK + zod) |
| `should_create_draft` | `bool` | LLM-driven рекомендация (Phase 6 hook) |
| `risk_flags` | `text[]` | refused / fallback / language_mismatch / etc. |
| `score_components` | `jsonb` | `{llm, cosine, freshness, reliability, weighted}` |
| `ai_provider` | `text?` | "yandex-deepseek" / "template" |
| `used_model` | `text?` | "yandex-deepseek-v3.2" / "template" |
| `prompt_version` | `text?` | "yandex-deepseek-score@v1.0" |
| `status` | `text` | enum (см. ниже) |
| `scored_at` | `timestamptz?` | момент LLM-вызова |

**Status enum:**
- `candidate` — scored, >= AUTO_DRAFT_SCORE_THRESHOLD, виден в Radar.
- `low_score` — scored, ниже порога, демоутится в UI.
- `filtered_negative` — negative_keyword pre-filter сработал, no LLM call.
- `hidden` — semantic pre-score ниже MATCHING_MIN_COSINE OR language mismatch.
- `ai_refused` — LLM отказал (safety filter OR risk_flags=['refused']).
- `suppressed` — user-driven скрытие (Phase 6+ UX).

**Cluster-level dedup** (см. `tg_mvp_plan/06-WORKERS-AND-INGESTION.md` §12.1):

The primary dedup mechanism is the `pg_advisory_xact_lock` + `SELECT FOR
UPDATE` pattern in `upsertWorkspaceNewsMatch` (see Invariants §1). The two
partial UNIQUEs below remain as defence-in-depth at the DB layer:

- `UNIQUE (workspace_id, cluster_id) WHERE cluster_id IS NOT NULL` —
  cluster-level. Одна и та же история из 5 источников → ОДНА match row per
  workspace (не 5).
- `UNIQUE (workspace_id, news_item_id) WHERE cluster_id IS NULL` —
  item-level fallback для not-yet-clustered items. Когда `cluster_news`
  привязывает item к cluster, row's cluster_id flips и cluster-level
  UNIQUE берёт верх.

Index `(workspace_id, status, score DESC)` — основной паттерн запроса для
`GET /radar`. NULLS LAST в ORDER BY гарантируется через `NULLS LAST` в
listRadarMatches.

### `ai_usage_events`

Append-only audit. Phase 5 пишет одну row на каждый score call (success /
failed / refused / fallback / parse_error). Phase 6 добавит generate +
rewrite.

| Column | Type | Notes |
|---|---|---|
| `workspace_id` | `uuid FK workspaces?` | ON DELETE SET NULL |
| `task_id` | `uuid` | **No FK** — пережить retention sweeps |
| `action_type` | `text` | score / generate / rewrite / embed |
| `used_model` | `text` | — |
| `prompt_version` | `text` | — |
| `input_tokens` / `output_tokens` | `integer` | Phase 5 пишет 0/0 (Yandex usage parsing на Phase 6) |
| `cost_rub` | `numeric(10,4)` | Phase 5 пишет 0 (cost guard Phase 6) |
| `duration_ms` | `integer` | wall-clock duration round-trip'а |
| `status` | `text` | success / failed / refused / parse_error / fallback |
| `error_message` | `text?` | ≤500 chars |

Три индекса для дашборда: `(created_at DESC)`, `(workspace_id, created_at DESC)`,
`(action_type, status, created_at DESC)`.

### Расширение `tasks`

CHECK constraint `tasks_type_check` дополнен:

- `match_news_to_workspaces` — fan-out per workspace_source_subscriptions
- `score_workspace_match` — LLM scoring per (workspace, news_item)
- `recompute_topic_embedding` — re-embed topic_profile после content edit

Партиальные UNIQUE (anti-dupe enqueue):

- `tasks_unique_active_match_per_item` ON `(payload->>'news_item_id')`
  WHERE `type='match_news_to_workspaces' AND status IN ('pending','running')`
- `tasks_unique_active_score_per_workspace_item` ON
  `(workspace_id, payload->>'news_item_id')` WHERE
  `type='score_workspace_match' AND status IN ('pending','running')`
- `tasks_unique_active_recompute_per_topic` ON
  `(payload->>'topic_profile_id')` WHERE
  `type='recompute_topic_embedding' AND status IN ('pending','running')`

## How it works

```
cluster_news handler (Phase 4)
  → INSERT news_cluster_items
  → UPDATE news_clusters (centroid, sources_count)
  → enqueue('match_news_to_workspaces', {news_item_id})  [NEW]

match_news_to_workspaces (Phase 5)
  → SELECT global_news_items + LEFT JOIN news_cluster_items → item + cluster_id
  → SELECT subscriptions JOIN topic_profiles (resolve default via COALESCE)
  → for each (workspace, topic):
      → existing match for (workspace, cluster) OR (workspace, item) → skip
      → negative_keyword hit → UPSERT status='filtered_negative'
      → language mismatch → UPSERT status='hidden' (risk: language_mismatch)
      → cosine < MATCHING_MIN_COSINE → UPSERT status='hidden' (risk: below_cosine_threshold)
      → else: enqueue('score_workspace_match', {workspace_id, news_item_id, cosine_pre_score})

score_workspace_match (Phase 5)
  → SELECT news + topic_profile + source
  → cost guard STUB (always proceed)
  → try ai.score(input):
      → refused (AIProviderError code=refused) → UPSERT status='ai_refused', no fallback
      → other AIProviderError → fall back to TemplateProvider.score (5.0, fallback flag)
  → composite: weighted_avg(LLM*0.5 + cosine*0.3 + freshness*0.1 + reliability*0.1)
      (each component normalised to 0..10 before weighting)
  → status = final < AUTO_DRAFT_SCORE_THRESHOLD ? 'low_score' : 'candidate'
  → upsertWorkspaceNewsMatch
  → INSERT ai_usage_events

recompute_topic_embedding (Phase 5)
  → SELECT topic_profile (mainTopics + keywords + status)
  → topic disabled OR empty → no-op (embedding_status stays 'pending')
  → ai.embed(buildTopicText, kind='query')
  → UPDATE topic_profiles SET embedding=$, embedding_status='ok'

Scheduler.slowTick (every 5 min)
  → existing: janitor + iam_refresh
  → NEW: scan topic_profiles WHERE status='active' AND embedding_status='pending'
    → bulk INSERT recompute_topic_embedding tasks (LIMIT 200, ON CONFLICT DO NOTHING)
```

### Composite score (per §3 of `tg_mvp_plan/07-AI-SCORING-AND-DRAFTS.md`)

```
weighted = clamp(0..10,
  0.5*LLM
  + 0.3*cosine_component   # (raw_cosine+1)/2*10; null → 0
  + 0.1*freshness          # exp(-hours_since_published / 24) * 10; null → 5
  + 0.1*reliability        # source.reliability * 10; null → 5
)
status = weighted < AUTO_DRAFT_SCORE_THRESHOLD ? 'low_score' : 'candidate'
```

Components stored in `score_components` jsonb so the UI can render a tooltip
breakdown без перерасчёта.

### AIProvider.score контракт

`packages/ai/src/providers/yandex.ts.YandexAIStudioDeepSeekProvider.score`:

- POST `https://llm.api.cloud.yandex.net/foundationModels/v1/completion`
  with `{modelUri, completionOptions: {stream:false, temperature, maxTokens}, messages: [{role,text}]}`.
- System prompt requests strict JSON output (DeepSeek 3.2 JSON mode).
- Response shape validated by `CompletionResponseSchema`.
  `alternative.status='ALTERNATIVE_STATUS_CONTENT_FILTER'` → `AIProviderError('refused')`.
- Assistant text → `extractJsonObject` (handles markdown fences + leading prose)
  → `ParsedScoreLooseSchema` → `finalizeScore` (clamp to [0,10], truncate
  reason to 280 chars, surface `risk_flags=['refused']` as `AIProviderError('refused')`).
- ONE repair-attempt on parse failure: appends a stricter system message
  ("return ONLY JSON ...") and retries once.
- 401 → IAM force-refresh + retry once (same as embed()).
- 429 → `rate_limit`. 5xx → `server_error`. 4xx → `parse_error`.

## Module decomposition

- **`packages/commands/src/workspace-news-matches.ts`** — три команды
  (`upsertWorkspaceNewsMatch`, `suppressWorkspaceNewsMatch`, `listRadarMatches`)
  + zod input schemas + status enum + `ScoreComponents` type. The upsert
  runs inside `db.transaction` with `pg_advisory_xact_lock(hashtext(
  workspace_id), hashtext(news_item_id))` + `SELECT ... FOR UPDATE`, so
  concurrent matchers for the same (workspace, item) serialize regardless
  of cluster_id state (see "Decision: advisory-lock + SELECT FOR UPDATE").
- **`packages/ai/src/providers/yandex.ts`** — real `score()` + module-level
  helpers (`buildScoreMessages`, `extractJsonObject`, `finalizeScore`).
  `iamRefresh()` and `embed()` unchanged from Phase 4.
- **`packages/shared/src/radar-projection.ts`** — wire schema for
  `RadarMatchProjection` / `RadarListProjection`. Single source of truth
  shared between `apps/api` and `apps/miniapp`.
- **`apps/worker/src/handlers/match-news-to-workspaces.ts`** — fan-out.
  Per-workspace try/catch isolates failures; partial UNIQUE on
  `workspace_news_matches` handles retries.
- **`apps/worker/src/handlers/score-workspace-match.ts`** — LLM scoring +
  composite + TemplateProvider fallback + ai_usage_events write.
- **`apps/worker/src/handlers/recompute-topic-embedding.ts`** — embed
  topic_profile via `ai.embed(kind='query')`.
- **`apps/worker/src/scheduler.ts`** — extended `slowTick` to enqueue
  `recompute_topic_embedding` for `embedding_status='pending'` topics.
- **`apps/api/src/routes/radar.ts`** + **`radar-projection.ts`** —
  `GET /radar` with status / score filters + pagination.
- **`apps/miniapp/src/screens/RadarScreen.tsx`** + **`radarView.ts`** —
  filter chips, score-emphasized cards, loading/error/empty states.

## Interface contracts

### `packages/commands` (Phase 5 export surface)

```ts
export interface UpsertWorkspaceNewsMatchInput { ... }
export async function upsertWorkspaceNewsMatch(db, input):
  Promise<{ id: string; inserted: boolean }>;

export async function suppressWorkspaceNewsMatch(db, input): Promise<void>;

export interface ListRadarMatchesInput {
  workspaceId: string; userId: string;
  status?: WorkspaceNewsMatchStatus | 'all';   // default 'candidate'
  minScore?: number; maxScore?: number;
  page?: number; pageSize?: number;            // defaults: 1 / 20 (max 50)
}
export async function listRadarMatches(db, input): Promise<RadarListResult>;
```

### Score handler payload shape

```ts
// match_news_to_workspaces payload
{ news_item_id: string /* uuid */ }

// score_workspace_match payload
{
  news_item_id: string /* uuid */,
  cosine_pre_score: number | null,
  topic_embedding_updated_at_iso?: string | null  // snapshot at enqueue;
                                                  // score handler drops cosine
                                                  // if topic re-embedded since
}

// recompute_topic_embedding payload
{ topic_profile_id: string /* uuid */ }
```

## Data flow

```
                        ┌─────────────────────┐
                        │ cluster_news        │
                        │ handler (Phase 4)   │
                        └──────────┬──────────┘
                                   │ enqueue('match_news_to_workspaces')
                                   ▼
              ┌─────────────────────────────────────┐
              │ match_news_to_workspaces handler    │
              │   fan-out per workspace_source_sub  │
              │   • negative_keyword pre-filter     │
              │   • language gate                   │
              │   • semantic pre-score              │
              └─────────────┬───────────────────────┘
                            │ enqueue('score_workspace_match')
                            ▼
              ┌─────────────────────────────────────┐
              │ score_workspace_match handler       │
              │   • cost guard STUB                 │
              │   • ai.score (Yandex/Template)      │
              │   • composite final score           │
              │   • UPSERT workspace_news_matches   │
              │   • INSERT ai_usage_events          │
              └─────────────┬───────────────────────┘
                            │
                            ▼
                  workspace_news_matches (per workspace)
                            │
                            ▼  GET /radar
                  RadarListProjection (wire)
                            │
                            ▼
              Mini App RadarScreen (cards + chips + filters)


  topic_profiles changes (commands flip embedding_status='pending')
                            │
                            │ scheduler.slowTick (every 5 min)
                            │   bulk INSERT recompute_topic_embedding
                            ▼
              recompute_topic_embedding handler
                  ai.embed(kind='query')
                  UPDATE topic_profiles
```

## Dependency graph

```
apps/api
  → packages/commands (listRadarMatches)
  → packages/shared   (RadarListProjection wire schema)

apps/worker
  → packages/commands (upsertWorkspaceNewsMatch)  [NEW dep]
  → packages/ai       (score / embed / TemplateProvider)
  → packages/db       (workspaceNewsMatches, aiUsageEvents)
  → packages/tasks    (enqueue)

apps/miniapp
  → packages/shared   (RadarListProjection)

packages/commands
  → packages/db (workspaceNewsMatches, aiUsageEvents)

packages/ai
  → no Phase 5 schema deps (still no @postdash/db import)
```

`apps/worker` теперь depend'ит на `@postdash/commands`. Это не нарушает layer
rules: commands не depend'ят на tasks/worker, и не вносят invariants о
выполнении задач — они exposes pure write helpers (`upsertWorkspaceNewsMatch`)
поверх `@postdash/db`.

`packages/commands` НЕ depend'ит на `@postdash/tasks`: enqueue
`recompute_topic_embedding` отдан scheduler'у, который polls
`topic_profiles.embedding_status='pending'`. Self-healing: permanent failure
оставляет status='pending' и следующий tick re-enqueue'ит.

## Integration points

- Reads from Phase 3 `topic_profiles` + `workspace_source_subscriptions`
  для fan-out.
- Reads from Phase 4 `global_news_items` + `news_clusters` + `news_cluster_items`
  для cluster-level dedup.
- Writes Phase 4 `tasks` через `enqueueTask` (новые 3 task type).
- Writes Phase 4 `topic_profiles.embedding` через `recompute_topic_embedding`.
- Writes `workspace_news_matches` (Phase 5) — единственная новая mutation
  поверхность для UI.
- Writes `ai_usage_events` (Phase 5) — observability ground для Phase 6
  cost guard.
- Не трогает `post_drafts` / `publish_events` (Phase 6/7).

## Invariants

- **Cluster-level dedup гарантирован на DB layer.** Все мутации
  `workspace_news_matches` (через `upsertWorkspaceNewsMatch`) сначала
  acquire'ят `pg_advisory_xact_lock(hashtext(workspace_id), hashtext(
  news_item_id))`, потом делают `SELECT ... FOR UPDATE` по
  `(workspace_id, news_item_id)` — concurrent matchers для одной и той же
  (workspace, item) пары serialize на advisory lock, и второй writer видит
  row первого независимо от того, успел cluster_news flip'нуть cluster_id
  с NULL на не-NULL между запусками. Как complementary safety net,
  pre-cluster item-level match rows (cluster_id IS NULL) мигрируются в
  cluster-level внутри той же transaction'а, что и `news_cluster_items`
  INSERT — это закрывает остаточное окно, где matcher уже committed'нул
  item-level row до того, как cluster был привязан. Два partial UNIQUE
  (`workspace_news_matches_workspace_cluster_uniq` для cluster-level и
  `workspace_news_matches_workspace_item_uniq` для item-level) остаются
  как defence-in-depth, а не первичный dedup-механизм.
- **Score стабильно в [0, 10].** CHECK на DB layer + `Math.max/min` clamp
  в `finalizeScore` (Yandex) и `computeComposite` (worker).
- **Reason ≤ 280 chars.** CHECK на DB layer + zod `.max(280)` в schemas +
  truncation в `finalizeScore`.
- **AI fallback всегда даёт row.** Score handler никогда не возвращает
  pending state — либо real score (Yandex), либо TemplateProvider stub
  (5.0, risk_flags=['fallback']), либо `ai_refused` / `hidden` /
  `filtered_negative`. UI никогда не видит "scoring in progress".
- **Cross-language matching disabled.** `news.language !== topic.language`
  (когда обе известны) → `status='hidden'`. Без этого инвара ru-канал
  начнёт получать английские новости (LLM нормально оценит, но user-confusion).
- **One in-flight task per natural key.** Партиальные UNIQUE на tasks для
  каждого из 3 новых task type collapse'ят дубли enqueue.

## Decision log

### Decision: scheduler poll вместо `commands → tasks` enqueue

**Considered:** добавить `@postdash/tasks` зависимость в `@postdash/commands`
и enqueue'ить `recompute_topic_embedding` прямо из `updateTopicProfile`.
**Chosen:** scheduler.slowTick scans `topic_profiles.embedding_status='pending'`
и bulk-enqueue'ит.
**Why:** commands не должны знать о существовании задач очереди — это
смешивает "domain mutation" с "infrastructure side-effect". Сейчас
`updateTopicProfile` просто flips `embedding_status='pending'` (одна DB
write), а worker сам подхватит. Бонус: self-healing — если recompute
permanently failed, при следующем PATCH или ручном NULL-out scheduler
заново увидит pending.
**Tradeoff:** до 5 минут латентности между PATCH и enqueue'ом. Для MVP-уровня
embeddings (используются для cosine pre-filter) — не критично.

### Decision: TemplateProvider fallback внутри score handler, не в provider

**Considered:** wrap AIProvider in a `FallbackAIProvider` decorator that
swallows the primary failure and tries Template. Then handler просто
зовёт `ai.score()`.
**Chosen:** explicit try/catch в score handler с явным
`new TemplateProvider().score(input)`.
**Why:** разные failure modes требуют разной trace'абельности (`'ai_refused'`
≠ `'fallback'`). Decorator скрывает provider distinction, и
`ai_usage_events.status` теряет detail. С явным try/catch handler пишет
два разных события в зависимости от того, что произошло. Также: refused
specifically NOT-fallback'ится (user должен видеть что AI отказал, а не
получать generic template score).
**Tradeoff:** handler знает о существовании TemplateProvider напрямую.
Acceptable — TemplateProvider это документированный MVP fallback (см.
README `packages/ai`).

### Decision: композитный score — клиентский расчёт, не SQL

**Considered:** считать composite внутри INSERT через CASE/CTE в SQL.
**Chosen:** все 4 компонента нормализуются и взвешиваются в JS
(`computeComposite`).
**Why:** freshness требует `Date.now() - publishedAt`, reliability — `Number(
sources.reliability_score)`, оба плохо встают в pure-SQL без round-trip'а.
Также composite breakdown сохраняется в `score_components` jsonb для UI
tooltip'а — это естественнее формировать в JS.
**Tradeoff:** при изменении весов нужен deploy кода (а не migration).
Tunable через future env-vars если потребуется.

### Decision: advisory-lock + SELECT FOR UPDATE вместо ON CONFLICT split

**Considered:** оставить две `INSERT ... ON CONFLICT DO UPDATE` ветки
(`upsertByCluster` / `upsertByItem`), каждая bound к своей partial UNIQUE.
**Chosen:** один transactional path с `pg_advisory_xact_lock(hashtext(
workspace_id), hashtext(news_item_id))` → `SELECT ... FOR UPDATE` →
UPDATE-or-INSERT.
**Why:** ON CONFLICT split открывал race: matcher A читал cluster_id=NULL,
cluster_news коммитил и flip'ал cluster_id на не-NULL, matcher A пытался
INSERT с cluster_id=NULL — item-level partial UNIQUE
(`WHERE cluster_id IS NULL`) уже не покрывала существующий row, и получался
второй радар-row per (workspace, item). Advisory lock serialize'ит
concurrent matchers до того как они видят cluster_id, а `FOR UPDATE`
закрывает остаточный race с не-matcher writer'ами. Два partial UNIQUE
оставлены как defence-in-depth.
**Tradeoff:** каждый upsert тратит один advisory-lock запрос + один
SELECT FOR UPDATE + один UPDATE/INSERT (3 statements) вместо одного
ON CONFLICT. На матчер-fan-out пути это +O(workspaces) round-trips, но
корректность важнее: дубликаты ломают cluster-level invariant.

### Decision: listRadarMatches page-beyond-last semantics

**Considered:** detect "page > totalPages" in the query and return either an
error or a redirect to page=1.
**Chosen:** `count(*) OVER ()` returns 0 when the LIMIT/OFFSET window is
empty (no rows in the result set → no OVER() row either). The route returns
`{items: [], total: 0, page: N}` and lets the caller interpret.
**Why:** the API stays a thin SQL projection; UI knows which page it asked
for and can disambiguate. Server-side redirect logic would need an extra
COUNT round-trip to compute the "real" total.
**Tradeoff:** UI consumers MUST treat `page > 1 AND total === 0` as "past
last page" (re-request page=1 or show an empty-state with reset), NOT as
"workspace has 0 matches". Mini App `selectRadarView` already covers the
total=0/page=1 onboarding-empty case; consumers paginating past the end
should reset to page=1 rather than render the empty state.

## Known follow-ups (Phase 5+ ops)

- **Cost guard implementation.** `checkCostGuardStub` always returns true.
  Phase 6 должен:
  1. INSERT/UPDATE `ai_budget_state(workspace_id, day)` atomically.
  2. Read current `spent_rub`.
  3. Estimate cost of next call (prompt_tokens_estimate * input_rub + max_tokens * output_rub).
  4. If spent + estimated > daily cap → `deferTask(until=next 00:00 UTC, reason='cost_cap_reached')`.
  5. After successful call, UPDATE `ai_budget_state SET spent_rub += actual_cost`.
  Hook is wired in `score-workspace-match.ts` — search for "cost guard STUB".
- **Yandex usage parsing.** `CompletionResponseSchema` already captures
  `result.usage.{inputTextTokens, completionTokens, totalTokens}` but the
  score handler currently writes 0/0 to `ai_usage_events.input_tokens` /
  `output_tokens`. Phase 6 should plumb the parsed usage through.
- **Suppress UI.** `suppressWorkspaceNewsMatch` command + zod input schema
  + role check + operation_log entry shipped. Missing: HTTP route
  (`PATCH /radar/:id/suppress`) + Mini App button. Phase 6+ when the UX
  contract for "hide / dismiss / archive" is finalised.
- **Per-workspace tunables.** `MATCHING_MIN_COSINE` and
  `AUTO_DRAFT_SCORE_THRESHOLD` are global env vars. A workspace that
  needs aggressive filtering can't override. Phase 8 admin UI hook.
- **Source reliability_score backfill.** All sources currently have
  `reliability_score=null` → component defaults to 5 (neutral). A Phase 8
  ops job should backfill from `sources.last_fetch_status` history
  (high ok-rate → high reliability).
- **ai_usage_events retention.** Same pattern as `task_runs` (deferred in
  Phase 4 follow-ups): unbounded append-only. Daily delete sweep on
  `created_at < now() - interval '90 days'` belongs in scheduler.slowTick.
- **Composite weight tunables.** Today 50/30/10/10 hardcoded in
  `computeComposite`. Promote to env vars (`AI_SCORE_WEIGHT_LLM`, etc.)
  when operators want to A/B test weighting strategies.
- **Re-score on topic_profile update.** Today changing the topic profile
  flips `embedding_status='pending'` (cosine component will be recomputed
  for FUTURE matches), but EXISTING matches keep their old score.
  Phase 8 should enqueue a `re_score_workspace` task on UpdateTopicProfile.

## Files

- `packages/db/migrations/0008_phase5_matching_scoring.sql` + `.down.sql`
  — workspace_news_matches + ai_usage_events + tasks CHECK extension +
  partial UNIQUE indices.
- `packages/db/migrations/0009_phase5_perf_indexes.sql` + `.down.sql`
  — re-create `workspace_news_matches_workspace_status_score_idx` with
  `score DESC NULLS LAST` (matches listRadarMatches ORDER BY); partial
  `topic_profiles_pending_embedding_idx` for scheduler.slowTick recompute scan.
  Drizzle mirror omits sort direction (parity-by-migration).
- `packages/db/src/schema.ts` — mirror of new tables; tasks CHECK extended.
- `packages/tasks/src/types.ts` — 3 new TaskType entries; queue default
  priorities updated for matcher / scorer / recompute.
- `packages/ai/src/providers/yandex.ts` — real `score()` implementation
  + `buildScoreMessages` / `extractJsonObject` / `finalizeScore` helpers
  + `YANDEX_SCORE_PROMPT_VERSION` constant.
- `packages/commands/src/workspace-news-matches.ts` — three commands +
  zod schemas + status enum + `ScoreComponents` type.
- `packages/shared/src/radar-projection.ts` — `RadarMatchProjectionSchema`
  + `RadarListProjectionSchema` (wire contract).
- `apps/worker/src/handlers/match-news-to-workspaces.ts` — fan-out handler.
- `apps/worker/src/handlers/score-workspace-match.ts` — LLM scoring +
  composite + fallback + ai_usage_events.
- `apps/worker/src/handlers/recompute-topic-embedding.ts` — re-embed
  topic_profile.
- `apps/worker/src/handlers/cluster-news.ts` — appended
  `enqueue('match_news_to_workspaces')` after cluster attach.
- `apps/worker/src/scheduler.ts` — `slowTick` enqueues
  `recompute_topic_embedding` for pending topic profiles.
- `apps/worker/src/env.ts` — `MATCHING_MIN_COSINE` +
  `AUTO_DRAFT_SCORE_THRESHOLD` env entries.
- `apps/worker/src/loop.ts` + `dispatcher.ts` — 3 new handlers wired;
  `aiConfig` extended.
- `apps/api/src/routes/radar.ts` + `radar-projection.ts` — `GET /radar`.
- `apps/api/src/app.ts` — registered radarRoute.
- `apps/miniapp/src/api/radar.ts` — `getRadar` client.
- `apps/miniapp/src/api/types.ts` — re-exports Radar wire types.
- `apps/miniapp/src/screens/RadarScreen.tsx` + `radarView.ts` — Radar UI.
- `apps/miniapp/src/index.css` — `.radar-*` styles.

### Test files

- `packages/tasks/src/__tests__/types.test.ts` — extended TASK_TYPES.
- `packages/ai/src/__tests__/yandex-score.test.ts` — 10 tests covering
  success, clamp, truncation, markdown fences, repair-attempt, refused,
  HTTP status mapping, network failure.
- `packages/commands/src/__tests__/workspace-news-matches.test.ts` — 12
  zod schema tests (no DB).
- `apps/worker/src/__tests__/score-composite.test.ts` — 4 composite tests
  (weight math + clamping + neutral defaults + freshness decay).
- `apps/worker/src/__tests__/match-helpers.test.ts` — 15 helper tests
  (negative-keyword match, cosineSim, parseEmbedding, buildTopicText).
- `apps/worker/src/__tests__/dispatcher.test.ts` — `stubAiConfig` extended.
- `apps/api/src/__tests__/routes-radar.test.ts` — 5 route tests
  (happy path, invalid query, status=all + score filters, 401, 503).
- `apps/api/src/__tests__/helpers/fake-pool.ts` — chain passthrough
  extended (offset / groupBy / having / rightJoin / fullJoin).
- `apps/miniapp/src/screens/__tests__/radarView.test.ts` — 17 view-model
  tests (selectRadarView union + formatScore + statusLabel/Tone +
  formatPublishedAt).

## How to extend

**New status value for `workspace_news_matches`:**
1. Add to `WORKSPACE_NEWS_MATCH_STATUSES` in `workspace-news-matches.ts`.
2. Extend the DB CHECK via an ALTER TABLE migration.
3. Extend `RADAR_MATCH_STATUSES` in `radar-projection.ts` (wire schema).
4. Extend `statusLabel` + `statusTone` in `radarView.ts`.
5. Decide whether the new status appears in `RADAR_FILTER_OPTIONS`.

**New AI provider for scoring:**
- Pattern from `packages/ai/README.md`: implement `AIProvider.score()`
  on a sibling class to `YandexAIStudioDeepSeekProvider`. Router in
  `createAIProvider` selects per env. The fallback path in
  `score-workspace-match.ts` doesn't need to know about new providers —
  it always falls back to `TemplateProvider`.

**Tune scoring weights:**
- Today: hardcoded in `computeComposite` (50/30/10/10). To tune:
  1. Either promote to env vars in `apps/worker/src/env.ts` (e.g.
     `AI_SCORE_WEIGHT_LLM=0.5`).
  2. Or override via a per-workspace `topic_profiles.scoring_weights` jsonb
     column (requires migration + UI surface).

## Status

Active. Closed at tag `phase-5-perfect`. Step-perfect-loop validation completed
with final status ⚠ **UNREACHABLE_10 reason (a)** (scaffold-phase scope objectively
caps below 10) — same closure pattern as Phase 4 (`phase-4-perfect-r4`). Best
MIN=8 across both memory-injection mode (main_loop=1) and fresh-agent confirm
(main_loop=2 sub_loop=1). All reviewers reported `blockers=[]` in the steady
state; remaining sub-10 gap concentrates in Phase 6+/Phase 8 ops items
(Yandex circuit breaker, ai_usage_events token plumbing + err.message truncation,
RUN_DB_TESTS=1 cluster-dedup integration tests, §12 mini-svg illustrations,
slow-network warning) — all tracked in "Known follow-ups" above.

Loop iterated 5 sub-loops total (4 in main_loop=1 + 1 fresh-confirm in
main_loop=2) and landed 20 distinct correctness/security/perf/UX fixes across
~35 file edits. Migrations 0009 (NULLS LAST radar index + topic_profiles
partial index) and 0010 (extended radar index with `created_at DESC`) were
introduced during the loop. Full loop report:
`.claude/perfect-loop-runs/2026-05-17-phase-5/REPORT.md`.

## Last touched

2026-05-17
