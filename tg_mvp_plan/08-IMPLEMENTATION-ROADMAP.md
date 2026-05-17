# Implementation Roadmap with Clear Checkpoints

Этот roadmap рассчитан на длинные Claude Code / Codex сессии.

После каждой фазы:
- commit changes (tag `phase-N-<slug>`);
- run tests;
- update docs (`PROJECT_MAP.md`, `ARCHITECTURE.md/architecture/*`);
- **отметить фазу в "Roadmap progress" ниже** — хук `stage-complete-detector` подскажет запустить `/step-perfect-loop` с полной 5×5 глубиной;
- clear context;
- start next phase с focused prompt'ом.

Acceptance: каждый чекпоинт включает edge cases из `12-EDGE-CASES.md §15` для соответствующей фазы.

## Convention: чек-боксы только на уровне фаз

- Sub-tasks внутри секции **Tasks** каждой фазы — это обычные bullet points (`-`), без `[ ]/[x]`. Не ставь чек-боксы на каждом микро-таске — это создаёт шум хуков и предложений `/step-perfect-loop` после каждого мелкого изменения.
- Единственный чек-лист с чек-боксами — секция "Roadmap progress" в конце этого документа. Один `[x]` = одна завершённая фаза.
- Когда ставишь `- [x] Phase N`, хук `stage-complete-detector` детектит ключевое слово "Phase N" и предлагает: запусти `/step-perfect-loop with full 5x5 depth` — фаза валидируется через lean core + `pl-plan-keeper` (проверка соответствия обещанию плана) + git diff всей фазы.

## Phase Closure Discipline (NON-NEGOTIABLE)

> Добавлено после Phase 5 closure (`phase-5-perfect-r3`), где step-perfect-loop
> второй раз подряд закрылся не на PERFECT, а на ⚠ **UNREACHABLE_10 reason (a)**
> ("scaffold-phase scope objectively caps below 10"). Корень: Phase 4 и Phase 5
> откладывали ops-items на абстрактный "Phase 8+", вместо чего этот документ
> теперь требует **именованных** future-phases для каждого deferred item.

Закрытие фазы = step-perfect-loop возвращает **PERFECT (MIN=10)**. Не GOOD,
не "GOOD с принятым trade-off", не UNREACHABLE_10. Если loop не достигает 10,
фаза не закрывается — выбираем один из трёх вариантов:

1. **Доделать в этой же фазе** до MIN=10 (предпочтительно, пока pl-implementer
   ещё держит контекст).
2. **Перенести конкретный item в named later phase** (например, "→ Phase 7,
   bullet 'connect-time IP pinning'"). Откладывание без указания конкретной
   фазы и конкретного bullet'а — запрещено.
3. **Откатить `- [x]` обратно в `- [ ]`**, если синтезатор loop'а сообщает о
   regression'е, который нельзя исправить локально, и доделать на следующей
   итерации loop'а.

**Правило именования deferred items.** Каждый bullet в "Known follow-ups"
секции `architecture/<system>.md` ОБЯЗАН иметь parallel bullet в `Tasks`
секции конкретной будущей фазы этого документа. Vague формулировки
"Phase 8+ ops", "after MVP", "когда-нибудь" — запрещены: они и были
cap-источником для Phase 4/5.

**Acceptance checklist (см. ниже)** обновлён: финальная строка теперь требует
PERFECT (MIN=10). GOOD без upgrade-в-PERFECT — не зачёт.

## Production Readiness Gates (per-phase template)

Каждая фаза включает в свою `Tasks` секцию пункты из четырёх блоков ниже —
даже если в этой фазе блок тривиальный (тогда один bullet "N/A в этой фазе —
покрыто в Phase X bullet Y"). Это явная поверхность для pl-pessimist /
pl-architect / pl-security-auditor / pl-ux-critic в step-perfect-loop:
каждый зеркалит свой блок, и MIN=10 становится достижим без "scaffold scope
ceiling".

- **Resilience (pl-pessimist surface).** Что происходит при сбое внешней
  зависимости, при краше процесса, при медленной/нестабильной сети.
  Минимум на фазу: явная circuit-breaker / retry / max-attempts политика
  для каждого нового внешнего вызова; graceful shutdown (SIGTERM drain) для
  каждого нового daemon-процесса; chaos-test или regression-test "что
  происходит, если эта зависимость недоступна 5 минут".
- **Observability (pl-architect + admin/debug surface).** Что видит оператор,
  когда сломалось. Минимум на фазу: structured-логи с trace-id для каждого
  нового handler'а, метрики ключевых очередей / endpoint'ов, `/health` и
  `/ready` probes для каждого нового daemon, append-only audit-запись для
  каждой новой команды.
- **Operational hygiene (migration-guard + dead-code-finder surface).**
  Retention sweep для каждой новой append-only таблицы, периодическая
  REINDEX/VACUUM политика для каждого нового горячего индекса (особенно
  ivfflat), backup-rotation для каждого нового источника секретов,
  encryption-at-rest для любой persisted credentials, env-var catalog в
  `11-AI-PROVIDER.md` обновлён, "stranded-state reaper" для каждой новой
  машины состояний (`status='pending' → permanent stuck`).
- **UX polish (pl-ux-critic + design-system §15).** Design-system gate
  пройден полностью: dark/light, 3 платформы, slow 4G, a11y APG (focus
  rings, arrow-key navigation, aria-live), bundle delta в пределах §5.
  Иллюстрации/skeleton'ы из §12 design-system'а **нарисованы в этой же
  фазе** (не отложены "потом"); slow-network warning баннер показан для
  каждого нового read endpoint'а.

> ⚠ Если фаза честно не нуждается в одном из блоков, всё равно явно
> запиши "N/A: <причина>" — это сигнал ревьюверам, что блок РАССМОТРЕН, а
> не забыт.

## Phase branches and commit boundaries

This repository keeps phases recoverable as cumulative branches.

- Branch naming:
  - `phase/base` - baseline before Phase 0 implementation, when available.
  - `phase/0-foundation` - Phase 0 only.
  - `phase/1-identity` - Phase 0 plus Phase 1.
  - `phase/N-<slug>` - all phases `0..N`, and no later phase.
- Phase-only diff rule:
  - Phase 0 artifact: `git diff phase/base..phase/0-foundation`.
  - Phase N artifact: `git diff phase/(N-1)-<slug>..phase/N-<slug>`.
  - `step-perfect-loop` must validate only this phase-only diff, not a mixed `main` diff.
- Commit boundary rule:
  - Every phase commit subject starts with one of:
    - `[phase N]`
    - `[phase N fix]`
    - `[phase N loop]`
    - `[phase N docs]`
  - On closure, add immutable tags:
    - `phase-N-start` at the previous phase branch head.
    - `phase-N-perfect` at the validated phase branch head.
    - If a later correction changes the branch, add `phase-N-perfect-r2`, `phase-N-perfect-r3`, etc.; do not move old tags.
- Rollback and old-phase validation:
  - To inspect or validate Phase K after later work exists, checkout `phase/K-<slug>` first.
  - Run `/step-perfect-loop with full 5x5 depth` against the Phase K diff only.
  - Never run a Phase K loop from a branch that already contains Phase `K+1` unless the artifact is explicitly limited to the branch diff above.
- Forward propagation rule:
  - If Phase K receives a fix after Phase 5 already exists, commit the fix on `phase/K-<slug>` first.
  - Then propagate the same logical fix forward into every cumulative branch that includes Phase K: `phase/(K+1)-<slug>`, `phase/(K+2)-<slug>`, ..., current phase branch, and `main`.
  - Do not propagate the fix backward into branches for phases `< K`.
  - After propagation, rerun the Phase K loop on `phase/K-<slug>`. Rerun later phase checks only if propagation produced conflicts or changed that later phase's own branch diff.

## Database provider policy

All phases use Postgres-compatible storage. pgvector lives inside Postgres; do
not introduce SQLite, in-memory persistence, document DB storage, or a vector
database as the product database.

**Provider: Neon Postgres everywhere** — dev, phase validation, staging, prod.
Authoritative policy: `architecture/database.md`. No Docker / Supabase / RDS.

- Working on `phase/N-<slug>` Git branch? Create a matching Neon branch and use
  its connection string. Phase-data isolation in one click.
- Phase branches must not share one persistent remote database by accident.
- Direct connection string for migrations (not pooled — PgBouncer breaks
  transactions + advisory locks). `?sslmode=require` always.
- Cold-start tax (~5–15s on free tier) is expected and tolerated by
  `waitForDb` in the migrator.
- Use `pnpm db:migrate` as the schema source of truth. For Neon migrations,
  prefer the direct connection string; introduce a separate runtime pool URL
  only when the app has code-level support for it.

## Phase 0 — Project foundation + AI scaffolding

### Goal
Стабильная структура проекта, базовая архитектура, заготовка AI provider.

### Tasks
- repo structure:
  - `apps/api`, `apps/miniapp`, `apps/worker`;
  - `packages/domain`, `packages/db`, `packages/commands`, `packages/policies`, `packages/channel-adapters`, `packages/ai`, `packages/sources`, `packages/shared`;
- TypeScript + lint + format;
- env config + secret-store wiring;
- Postgres connection + миграционная система (Prisma или Drizzle);
- `pgvector` extension включён в миграции (нужен с Phase 4);
- `/health` endpoint;
- `AIProvider` interface (`packages/ai/src/provider.ts`) с типами:
  - `score`, `generateDraft`, `rewriteDraft`, `embed`;
- `TemplateProvider` стаб (без AI, для unit-test'ов);
- `YandexAIStudioDeepSeekProvider` скелет (HTTP-клиент, IAM auth flow, но без полной имплементации);
- env-vars catalog из `11-AI-PROVIDER.md §13`;
- README с local dev setup.

### Done when
- проект запускается локально;
- DB подключена, миграции работают;
- `/health` возвращает OK;
- Mini App dev server открывается;
- `AIProvider` interface определён, два provider'а зарегистрированы (template + stub Yandex);
- `npm test` зелёный (smoke test'ы пустые ок).

### Commit
`phase-0-foundation`

---

## Phase 1 — Identity, workspace, Telegram Mini App auth

### Goal
Backend идентифицирует Telegram users и создаёт workspace.

### Tasks
- Telegram WebApp initData verification (HMAC от bot token);
- **auth_date < 24h check** (replay protection);
- `/start` bot command + inline button "Открыть панель";
- `/start <payload>` parsing (для будущего deep-link, payload игнорируется в Phase 1, но parser готов);
- bot rate-limit middleware (10 msg/min/user) — `12-EDGE-CASES.md §13.10`;
- Mini App stack setup: Vite + React + TS + `@telegram-apps/sdk-react` + `@telegram-apps/telegram-ui` (см. `13-MINIAPP-DESIGN-SYSTEM.md §1`);
- design tokens через Telegram theme variables (§2), spacing scale, typography defaults;
- baseline components: layout (`Section`, `Cell`), navigation (`TabBar`), feedback (`Snackbar`, `Banner`);
- routing через `wouter` (§10);
- onboarding wizard skeleton (§9) — 3 шага, "Пропустить" доступен;
- native Telegram chrome integration: `WebApp.expand()`, `BackButton`, `MainButton`, theme listener (§4);
- error UX taxonomy infrastructure (toast/banner/modal/field-error components) — §7;
- performance budget baseline в CI (bundle-size check) — §5;
- tables: `users` (с `last_active_workspace_id`), `telegram_identities`, `workspaces`, `workspace_members`;
- table `command_idempotency` (структура готова, используется с Phase 7);
- table `operation_log` (с MVP пишем все важные команды);
- endpoint `POST /auth/telegram`;
- endpoint `GET /me` (current user, telegram identity, default workspace);
- Mini App: загрузка current user/workspace при открытии;
- если нет workspace → автосоздание default;
- Mini App theme support (`themeParams`, dark/light);
- update `telegram_identities.username/first_name/last_name` на каждом auth-вызове;
- handling `blocked_bot` status.

### Tests
- expired initData (>24h) → 401;
- missing initData → 401;
- valid initData → user created + workspace created + 200;
- bot rate-limit срабатывает после 10 запросов/мин;
- `CreateWorkspaceCommand` идемпотентен (double-click → один workspace).

### Done when
- пользователь открывает Mini App из бота;
- backend верифицирует identity;
- user + workspace созданы;
- Mini App показывает workspace name + user info;
- theme переключается с Telegram.

### Commit
`phase-1-identity-workspace`

---

## Phase 2 — Channel connection

### Goal
Пользователь безопасно подключает Telegram-канал.

### Tasks
- tables: `content_channels`, `channel_connections`, `channel_connect_codes`;
- UNIQUE `(platform, external_id)` на `channel_connections`;
- `CreateConnectCodeCommand` (idempotent through `command_idempotency`):
  - TTL 30 минут;
  - one-time use;
- `ConnectTelegramChannelCommand` через ручной ввод в Mini App; bot `/start connect_<code>` валидирует код (replyies with status) и роутит пользователя в Mini App для завершения. См. `architecture/channel-connection.md` Decision 6 — Telegram does not deliver channel chat_id в private /start updates, поэтому фактический bind всегда происходит в Mini App после ввода `@username` или numeric chat_id.
- Telegram adapter `verifyConnection`:
  - `getChatMember` для bot;
  - проверка `can_post_messages=true`;
  - сохранение `last_verify_status`;
- Mini App screen "Канал":
  - states: not connected / pending / connected / broken;
  - кнопка "Скопировать deep-link" (`https://t.me/<bot>?start=connect_<code>`);
- error UX:
  - expired code → 410 + "создай новый";
  - reused code → 409;
  - channel занят другим workspace → 409;
  - bot без post-permission → 400 с указанием поля.

### Tests
- expired code → 410;
- reused code → 409;
- bot без post-permission → 400 с specific error;
- channel уже linked → 409;
- private channel с bot admin → success;
- deep-link `/start connect_<code>` корректно вызывает connect flow.

### Done when
- user может создать connect code;
- добавить бота админом и activate code через bot OR Mini App;
- канал виден connected (после завершения в Mini App).

### Commit
`phase-2-channel-connection`

---

## Phase 3 — Topics and sources

### Goal
Пользователь конфигурирует темы и source subscriptions.

### Tasks
- tables: `topic_profiles` (с embedding-колонкой, embedding fill в Phase 4), `sources`, `workspace_source_subscriptions`;
- URL canonicalization rules (`packages/sources/canonicalize.ts`):
  - см. `06-WORKERS-AND-INGESTION.md §9`;
  - tests для каждого правила (strip utm, sort params, redirect resolve, specific overrides);
- redirect resolution при создании source (один раз);
- endpoints:
  - CRUD `/topics`;
  - `POST/GET/PATCH/DELETE /sources` (создание глобальное, subscription per workspace);
  - source URL → canonical at insert;
- Mini App screens: Settings (topics, tone), Sources (list, add, enable/disable);
- single-default topic_profile per workspace (UI ограничение);
- source health подготовка (поля заполняются с Phase 4).

### Tests
- canonicalization кейсы (10+ тестов);
- two URLs с разными query → одинаковый canonical;
- redirect chain резолвится один раз;
- subscription per workspace, source — global;
- bulk add (20 sources) работает.

### Done when
- user добавляет темы;
- добавляет RSS / manual source;
- subscription сохранена per workspace;
- source хранится глобально (один canonical_url).

### Commit
`phase-3-topics-sources`

---

## Phase 4 — Task system, global ingestion, embeddings

### Goal
Система fetch'ит источники глобально, эмбеддит новости, дедуплицирует семантически.

### Tasks
- table `tasks` (с partial unique index для `fetch_source`);
- table `task_runs`;
- `system_state` table для IAM-token cache;
- atomic task polling (`FOR UPDATE SKIP LOCKED`);
- task lease (`locked_until`, 5 minutes default);
- scheduler cron:
  - 1/min: find due sources, create `fetch_source` tasks;
  - 5/min: janitor (release stuck tasks, cleanup source_fetch_locks);
- task types implemented:
  - `fetch_source`;
  - `extract_news_item`;
  - `embed_news_item`;
  - `cluster_news`;
  - `janitor_release_stuck_tasks`;
  - `refresh_iam_token`;
- worker pool с concurrency=10;
- table `global_news_items` (с `embedding vector(256)`, `embedding_status`);
- table `news_clusters` + `news_cluster_items`;
- `pgvector` index (ivfflat) на embedding;
- RSS parser;
- volume cap per fetch (`max_items_per_fetch`, default 50);
- структурный dedup (canonical_url + content_hash);
- семантический dedup через embeddings (cosine threshold + 48h window);
- YandexAIStudioDeepSeekProvider полная имплементация `embed`;
- IAM-token refresh-loop (`refresh_iam_token` task каждые 10h);
- update `sources.last_fetched_at`, `last_fetch_status`, `last_fetch_error`.

### Tests
- two workers одновременно поллят — task достаётся одному;
- worker crash mid-task → janitor reset через 5 минут;
- duplicate `fetch_source` task → ON CONFLICT (partial unique);
- volume cap: 500 items → 50 ingested, 450 skipped;
- feed updated existing item → was_updated=true, текст updated;
- embedding 5xx → embedding_status='failed', retry janitor'ом;
- две одинаковые новости в разных источниках → один cluster;
- mixed-language news → embedding работает, cluster корректный.

### Done when
- scheduler создаёт fetch tasks;
- workers выполняют fetch;
- global_news_items + news_clusters заполняются;
- один источник не fetch'ится конкурентно дважды;
- embeddings генерируются автоматически;
- semantic dedup объединяет похожие новости.

### Commit
`phase-4-global-ingestion-embeddings`

---

## Phase 5 — Matching and scoring

### Goal
Global news матчится на workspace topics и появляется в Radar.

### Tasks
- table `workspace_news_matches` с `score`, `relevance_reason`, `risk_flags`, `status`;
- UNIQUE `(workspace_id, news_item_id)`;
- task `recompute_topic_embedding` (срабатывает на `UpdateTopicProfileCommand`);
- task `match_news_to_workspaces`:
  - pre-filter negative_keywords;
  - language gate;
  - semantic pre-score (cosine) — skip ниже `MATCHING_MIN_COSINE`;
  - enqueue `score_workspace_match` если cosine ok;
- task `score_workspace_match`:
  - cost guard check (с Phase 6 — пока stub, всегда proceed);
  - DeepSeek LLM call через `AIProvider.score`;
  - zod validation;
  - repair-attempt при parse error;
  - fallback на TemplateProvider при failure;
  - INSERT в `workspace_news_matches`;
- composition: final score = weighted_avg (LLM + cosine + freshness + reliability);
- endpoint `GET /radar` (filter by status, score range, with pagination);
- Mini App "Радар" screen с cards (score, source, reason, status badge);
- empty state UX.

### Tests
- empty topics → user видит warning баннер;
- negative keyword match → status='filtered_negative';
- score out of range → clamped;
- invalid JSON output → repair → fallback;
- refused content → `ai_refused` status;
- re-score same item → blocked unique constraint;
- **cluster-level dedup**: одна история в 5 source'ах → одна `workspace_news_matches` row, не 5;
- cluster пополнился новым source после matching → match остаётся одна, `news_clusters.sources_count` инкрементируется.

### Done when
- новости из global table появляются в workspace Radar;
- score + relevance reason видны;
- статусы (`candidate`, `filtered_negative`, `ai_refused`, `hidden`) корректны;
- empty state с инструкцией.

### Commit
`phase-5-matching-scoring`

---

## Phase 6 — AI draft generation, editor, cost guard

### Goal
Пользователь создаёт, редактирует, переписывает drafts. Cost guard защищает от расходов.

### Tasks
- table `post_drafts` (с `parent_draft_id`, `status='rewriting'`);
- table `post_draft_versions` (с `prompt_version`, `ai_provider`, `ai_model`);
- table `ai_usage_events`;
- table `ai_budget_state` + atomic UPDATE;
- `GenerateDraftCommand` (idempotent через `command_idempotency`);
- task `generate_post_draft`:
  - cost guard check → deferred at cap;
  - `AIProvider.generateDraft`;
  - zod validation;
  - markdown entity parser validation;
  - repair-attempt → template fallback;
- task `rewrite_post_draft`:
  - `post_drafts.status='rewriting'` лок;
  - snapshot текущей версии при scheduling;
  - rewrite через `AIProvider.rewriteDraft`;
  - три варианта при `instruction='three_variants'`;
  - manual edit пока в queue → версия сохраняется, current_version_id остаётся на manual;
- promote `deferred` → `pending` cron на 00:00 UTC;
- Mini App editor screen:
  - textarea + counter (X / 4096);
  - rewrite buttons (shorter, more_expert, simpler, remove_fluff, add_hook, three_variants);
  - version history dropdown;
  - **preview-render через общий `packages/shared/telegram-format.ts`**;
  - iOS viewport handling (`WebApp.expand()`);
- two-language prompts (ru/en) в `packages/ai/prompts/`;
- prompt versioning + `CHANGELOG.md`;
- system_state for IAM refresh используется реально (Phase 4 был stub, теперь полный flow).

#### Catchup from Phase 4/5 ops follow-ups (mandatory before closure)

Эти items были помечены deferred при closure Phase 4 / Phase 5 и привязаны
к Phase 6 в этой ревизии плана (вместо vague "Phase 8+"):

- **`ai_usage_events` token plumbing** — score / generate / rewrite handlers
  должны записывать parsed `input_tokens` / `output_tokens` из Yandex usage
  response (сегодня в Phase 5 пишутся 0/0). Это база для cost guard ниже.
- **`ai_usage_events.error_message` truncation hardening** — поднять truncation
  на shared util (один helper, один CHECK), убрать drift между обработчиками.
- **Yandex circuit breaker** — на трёх consecutive 5xx / network failures
  для Yandex endpoint'а провайдер переходит в open-state на N минут и
  немедленно роутит `score` / `generate` / `rewrite` в TemplateProvider
  (без таймаутного ожидания). Closed-state восстанавливается через
  half-open probe. Срабатывает в score / generate / rewrite handler'ах.
- **`score-workspace-match` 4-SELECT → JOIN consolidation** — handler сегодня
  делает 4 отдельных SELECT (news / topic / source / cluster) перед LLM
  call'ом; объединить в один JOIN-запрос для снижения round-trip cost.
- **`topic_profile_id` в `score_workspace_match` payload** — matcher выбирает
  конкретный topic_profile при fan-out, но scorer повторяет тот же resolve
  через subscription JOIN (асимметрия → потенциально другой profile при
  гонке). Snapshot'нуть `topic_profile_id` в payload при enqueue.
- **`GET /radar` rate-limit** — добавить per-user / per-workspace IP-rate-limit
  (например, 60 req/min), surface как 429 + `Retry-After`.
- **Worker `/health` + `/ready` endpoints** — Phase 4 deferred. Render expects
  `/health`; worker daemon-процесс должен expose оба + ответить 503 во время
  SIGTERM drain.
- **SIGTERM drain для worker** — blocks new polls и awaits in-flight
  dispatches до `WORKER_DRAIN_TIMEOUT_MS` (default 30s), затем exit.
  Eliminates "task fall to janitor 5 min later on every deploy" pattern.

#### Production Readiness Gates (Phase 6 surface)

- **Resilience.** Circuit-breaker policy для каждого нового AI call'а (см.
  catchup выше); cost-guard cap = circuit-breaker по бюджету; rewrite-lock
  таймаут (`status='rewriting'` → автоматический unlock через N минут);
  TemplateProvider fallback тестируется chaos-режимом ("убей Yandex env").
- **Observability.** `ai_usage_events` теперь с реальными tokens + cost (см.
  catchup); structured logs на каждом AI call'е (prompt_version, model,
  duration_ms, status, fallback_reason); metric counter "AI calls deferred
  by cost guard" surfaceится в admin/debug.
- **Operational hygiene.** Daily retention sweep для `ai_usage_events`
  (>90 дней) в scheduler.slowTick (parallel с task_runs sweep, см. Phase 7);
  prompt versioning в `CHANGELOG.md` ревьюится как часть release; cost-guard
  pricing env vars документированы в `11-AI-PROVIDER.md §13`.
- **UX polish.** Editor screen полностью по `13-MINIAPP-DESIGN-SYSTEM.md`:
  skeleton placeholder на 5 строк во время AI rewrite, "Сеть медленная..."
  баннер при >3s response time, отдельный empty-state для "no drafts yet",
  focus rings + arrow-key nav на rewrite-button бар, iOS keyboard viewport
  fix реально протестирован на устройстве.

### Tests
- cost cap reached → task deferred + UI banner;
- 00:00 UTC promote deferred → pending;
- concurrent rewrite same draft → 409;
- manual edit во время rewrite → current_version_id = manual, AI создаёт версию-сноску;
- three_variants → 3 версии в одной task'е;
- broken markdown в output → repair → fallback;
- token cost recorded точно;
- pricing change через env-var → новые вызовы используют новую цену.

### Done when
- user создаёт draft из новости;
- редактирует текст;
- запускает rewrite;
- видит версии;
- preview совпадает с Telegram render;
- cost guard блокирует after cap.

### Commit
`phase-6-drafts-editor-cost-guard`

---

## Phase 7 — Safe publishing

### Goal
Пользователь публикует draft в подключённый Telegram канал. Идемпотентно, безопасно.

### Tasks
- table `publish_events` (с `idempotency_key`, `command_idempotency_id`, `status='pending'`);
- partial unique `(post_draft_id) WHERE status='success'`;
- `PublishPostCommand` (idempotent через `command_idempotency`):
  - все policy checks (см. `05-SECURITY-AND-ACCOUNTS.md §11.1`);
  - cross-workspace integrity invariant test;
  - re-check bot admin rights via `getChatMember`;
  - INSERT `publish_events(status='pending')` ДО Telegram call;
  - Telegram adapter `publishPost`;
  - UPDATE status='success' or 'failed' + external_message_id;
- task `janitor_finalize_pending_publishes`:
  - pending > 5min → `status='unknown'`;
  - surface в admin UI;
- Mini App publish button + confirmation modal;
- preview снова перед publish;
- update `post_drafts.status='published'`;
- operation_log entry;
- error handling:
  - Telegram 429 → respect `retry_after`;
  - Telegram 400 entity → status='failed', UX clear error;
  - bot lost admin → status='failed', UX banner;
  - channel deleted → channel_connections.status='broken'.

#### Catchup from Phase 4 ops follow-ups (mandatory before closure)

Эти items были помечены deferred при closure Phase 4 и привязаны к Phase 7
в этой ревизии плана (вместо vague "Phase 8+"):

- **Stranded `global_news_items` reaper** — periodic task который сканирует
  `status='embedded'` rows старше N часов и re-enqueue'ит `cluster_news`
  плюс backfill `embedding_status='failed'` → retry. Новый task type +
  CHECK migration + scheduler tick + rate-limiting (no thundering herd).
- **`cluster_news` orphan-cluster window fix** — `SELECT ... FOR UPDATE` на
  nearest-neighbour's cluster row внутри одного `client.begin()`, чтобы
  concurrent matchers не INSERT'или два разных `news_clusters` row'а для
  одного и того же neighbour.
- **`task_runs` retention** — daily `DELETE FROM task_runs WHERE finished_at
  < now() - interval '30 days'` в scheduler.slowTick (или hot/cold table
  partition, если volume оправдает).
- **`ai_usage_events` retention** — параллельный sweep на 90 дней (Phase 5
  follow-up).
- **`ivfflat` REINDEX policy** — autoselect `lists = sqrt(n)` для
  `news_clusters.centroid` и `global_news_items.embedding` индексов; cron job
  раз в неделю проверяет n vs lists и REINDEX'ит, если drift > 2x.
- **`sources.status='error'` retry cadence env var** — promote hardcoded
  60-min interval в `scheduler.fastTick` до `SOURCES_ERROR_RETRY_INTERVAL_MINUTES`.
- **Connect-time IP pinning** для fetch — custom `https.Agent({ lookup })`
  (или undici `connect.lookup`) который pins IPs возвращённые SSRF guard'ом,
  закрывая TOCTOU между resolve и TCP connect.
- **`system_state` token encryption-at-rest** — writethrough callback
  encrypt'ит IAM token перед persist (минимум через app-level symmetric key
  из env; полный Vault/KMS — Phase 12 billing блок).
- **`global_news_items.url` CHECK constraint** — `CHECK (url ~ '^https?://')`
  + migration backfill / cleanup для существующих rows.
- **Integration test harness (`RUN_DB_TESTS=1`)** для всех scaffold-фаз 0..7:
  transient Postgres + mock Yandex, end-to-end сценарии из § Tests каждой
  предыдущей фазы. Это закрывает gap "unit-тесты проходят, wiring-drift
  невидим", который был общим breaker'ом во всех phase loops.

#### Production Readiness Gates (Phase 7 surface)

- **Resilience.** Telegram 429 → respect `retry_after`; bot lost admin → graceful
  channel.status='broken' + UX banner; janitor для `publish_events.status='pending'`
  старше 5 min уже в основном scope — здесь же chaos-test "Telegram API down".
- **Observability.** Publish-funnel метрики (queued / pending / success / failed /
  unknown) с trace-id; admin/debug page surfaceит `publish_events.status='unknown'`
  для оператора (catchup item ниже из Phase 8); structured-логи на каждой
  Telegram API operation с rate-limit headers.
- **Operational hygiene.** Retention sweeps добавлены в scheduler.slowTick
  (см. catchup выше); ivfflat REINDEX policy задокументирована в
  `architecture/global-ingestion.md`; env-var каталог в
  `11-AI-PROVIDER.md` обновлён всеми новыми переменными из catchup'а.
- **UX polish.** Publish confirmation modal по `13-MINIAPP-DESIGN-SYSTEM.md`
  (focus trap, escape-to-close, primary/destructive action contrast);
  "channel deleted" / "bot lost admin" banner'ы — не toast'ы (persistent,
  с action-кнопкой "Reconnect"); preview перед publish использует тот же
  `packages/shared/telegram-format.ts`, что и editor (Phase 6).

### Tests
- happy path: draft → publish → message in channel;
- double-click → один publish_event;
- cross-workspace publish (malicious frontend) → 403;
- bot потерял admin → fail с clear UX;
- channel deleted → channel.status='broken';
- network failure mid-publish (mocked) → publish_event stays pending → janitor → unknown;
- second publish того же draft → 409 (partial unique);
- Telegram 429 → retry honoring retry_after.

### Done when
- user публикует пост;
- нельзя опубликовать чужой draft;
- все publish actions в operation_log;
- идемпотентность работает;
- janitor подбирает stuck pending'и.

### Commit
`phase-7-safe-publishing`

---

## Phase 8 — MVP hardening, notifications, source health

### Goal
MVP готов для 10–30 early users. Структурирован в четыре под-блока (8a–8d),
каждый закрывает свой "ops-debt" слой. Все четыре сделаны до закрытия фазы
(MIN=10 = все четыре PERFECT).

---

### 8a — Notifications + source health (продуктовый scope)

#### Tasks
- table `notification_events` с UNIQUE `(workspace_id, user_id, kind, related_object_id)`;
- notifications opt-in (default off);
- coalesce notification ("5 новых high-score за час");
- throttle: 1 notification / workspace / 30 min;
- handling bot blocked → `telegram_identities.status='blocked_bot'`, `notification_events.status='blocked'`;
- deep-link в notifications: `?startapp=draft_<id>` / `?startapp=radar_filter_<id>`;
- Mini App cache-busting (`?v=<commit_sha>` в bot URL);
- "Проверить сейчас" кнопка на source → `fetch_source` task с priority=80;
- source health UI: last_fetched_at relative, last_fetch_status / error, ETA next fetch;
- rate-limit polish: max sources per workspace, max manual fetches per hour, max rewrites per draft per hour;
- AI fallback verification chaos-test: убить Yandex endpoint в env → TemplateProvider работает; cost cap reached → user видит баннер с countdown.

#### Tests
- duplicate notification (тот же kind+related_id) → unique constraint;
- bot blocked → `blocked_bot` status, не пытаемся retry;
- coalesce: 20 high-score за час → 1 notification;
- cache-bust работает после deploy (URL содержит новый sha);
- source check now → task immediately picked up workers.

---

### 8b — Observability + admin/debug (operator scope)

#### Tasks
- basic admin/debug page (read-only): tasks pending / failed_permanent counts, `ai_usage_events` daily sum (with новые tokens columns из Phase 6 catchup), publish failures, `publish_events.status='unknown'` queue, scheduler last-tick timestamps, Yandex circuit-breaker state;
- per-workspace tunables UI: `MATCHING_MIN_COSINE` / `AUTO_DRAFT_SCORE_THRESHOLD` override per workspace (Phase 5 follow-up — было vague "Phase 8 admin UI hook");
- composite weight env-var promotion: `AI_SCORE_WEIGHT_LLM` / `_COSINE` / `_FRESHNESS` / `_RELIABILITY` (Phase 5 follow-up);
- source `reliability_score` backfill job на основе `sources.last_fetch_status` history (Phase 5 follow-up);
- re-score on topic_profile update — task `re_score_workspace` enqueue'ит UpdateTopicProfileCommand, переоценивает existing `workspace_news_matches` rows (Phase 5 follow-up);
- setup docs (`README.md` operational руководство, env-vars list) — финальный pass после 6/7/8a/8b catchup'а.

#### Tests
- daily admin dashboard queries возвращают correct counts;
- per-workspace tunable override применяется к новым match задачам (existing — не трогает);
- re_score_workspace на UpdateTopicProfileCommand → existing matches переоценены;
- composite weight env-var override применяется без миграции.

---

### 8c — UI polish per design-system §6 / §12 (UX completion scope)

#### Tasks
- иллюстрации для empty-states (§12.1) — все Radar / Sources / Topics / Drafts экраны имеют illustrated empty state (mini-svg в `apps/miniapp/src/assets/`);
- slow-network warning баннер (§6) — `<3G || >3s response` показывает "Сеть медленная..." на Radar / Editor / Publish экранах;
- skeleton placeholders (§12.2) — Radar 5-row skeleton (вместо текущего spinner), Editor textarea-shaped skeleton, drafts list-row skeleton;
- `risk_flags` cap — UI показывает максимум 3 badge'а + "+N more" tooltip (Phase 5 follow-up — uncapped риск списка ломает layout);
- offline indicator + disable mutation buttons (§7) — globally inferred из `navigator.onLine` + WebApp.platform offline event;
- empty states polish — отдельный UX для "no drafts yet" vs "no drafts matching filter" (Phase 5 паттерн уже применён для Radar — распространить на Drafts/Sources);
- error states polish — "draft no longer available", "publish target removed", "topic deleted while editing" — все имеют clear recovery action;
- a11y APG pass: focus rings + arrow-key navigation на каждом composite виджете нового scope (tabs, filter chips, version dropdown, rewrite-button bar);
- bundle delta verification: §5 budget'ы не превышены после всех Phase 6–8 экранов;
- Lighthouse mobile ≥ 90 final pass.

#### Tests
- design-review checklist `13-MINIAPP-DESIGN-SYSTEM.md §15` пройден полностью (dark/light, 3 платформы, slow 4G, a11y);
- bundle-size CI gate зелёный;
- visual regression tests на 4 illustrated empty states.

---

### 8d — Resilience completion (last-mile reliability scope)

#### Tasks
- offline state в Mini App — publish / generate / rewrite кнопки disabled, queued operations replay при reconnect;
- circuit-breaker dashboard в admin/debug (Yandex circuit state, Telegram channel-broken count);
- cost guard countdown banner — точный время reset (next 00:00 UTC) + сумма deferred задач;
- final chaos pass: убить DB connection mid-publish, mid-rewrite, mid-fetch — ни одна операция не должна оставить inconsistent state (всё либо завершается, либо janitor подбирает).

#### Tests
- offline state в Mini App → publish disabled, queued op replay'ится после reconnect;
- DB chaos: kill connection mid-publish → janitor finalize_pending_publishes подхватывает;
- cost cap countdown точен (mock'ом дату);
- circuit-breaker open → новые AI calls немедленно идут в TemplateProvider без таймаут-ожидания.

---

### Done when (Phase 8 as a whole)
- продукт даём первым 10–30 users без developer intervention;
- ошибки не ломают flow (8a + 8d покрывают);
- AI costs bounded by guard + circuit breaker (8d);
- onboarding понятен (8c illustrated empty states);
- source health visible (8a);
- notifications не флудят (8a coalesce + throttle);
- operator видит здоровье системы в одном месте (8b admin/debug);
- per-workspace tunables работают (8b);
- design-system gate §15 пройден полностью (8c);
- chaos passes зелёные (8d).

### Commit
`phase-8-mvp-hardening` (один tag на финальный pass; промежуточные коммиты
с префиксами `[phase 8a]` / `[phase 8b]` / `[phase 8c]` / `[phase 8d]`).

---

## After MVP

Следующие фазы (рекомендуемый порядок):

1. **Phase 9 — Multi-channel support**: один workspace → несколько каналов; UI switcher.
2. **Phase 10 — Scheduling**: post scheduled-publish (через `scheduled_at` в publish_events).
3. **Phase 11 — Research agent**: saved prompts + custom search rules.
4. **Phase 12 — Billing**: plans, subscriptions, usage_limits.
5. **Phase 13 — Multi-platform**: VK adapter (новый `ChannelAdapter`).
6. **Phase 14 — Autopublish**: rules + whitelist + thresholds (см. `10-FUTURE-EXPANSION.md §4`).
7. **Phase 15 — Web dashboard**: для agency / power users.
8. **Phase 16 — Agency**: team roles, client approval flows.

См. `10-FUTURE-EXPANSION.md` для детального плана.

---

## Acceptance checklist per phase

Перед каждым commit'ом фазы:
- все tasks из секции "Tasks" завершены;
- все tests из секции "Tests" зелёные;
- commit subject uses the phase prefix: `[phase N]`, `[phase N fix]`, `[phase N loop]`, or `[phase N docs]`;
- changes are committed on the matching cumulative branch `phase/N-<slug>`;
- phase-only diff is cleanly defined by `phase/(N-1)-<slug>..phase/N-<slug>` (or `phase/base..phase/0-foundation` for Phase 0);
- edge cases из `12-EDGE-CASES.md §15` для этой фазы покрыты;
- для phase'ов с UI: design-review checklist `13-MINIAPP-DESIGN-SYSTEM.md §15` пройден (dark/light, 3 платформы, slow 4G, a11y, bundle delta);
- `PROJECT_MAP.md` обновлён (новые files и systems);
- `architecture/<system>.md` создан для каждой новой подсистемы;
- миграции применяются на чистой БД и rollback'ом не ломают;
- env-vars catalog в `11-AI-PROVIDER.md` обновлён, если добавлены;
- нет hardcoded бренд-имён в domain layer;
- нет direct Telegram API calls вне `channel-adapters/telegram`;
- нет direct LLM SDK calls вне `packages/ai`;
- нет hardcoded цветов / spacing вне design tokens из §2 doc 13;
- Lighthouse mobile ≥ 90 для Mini App (с Phase 6);
- bundle size в пределах budget'а §5 doc 13;
- `npm test` / `pytest` / `tsc --noEmit` зелёные;
- все четыре Production Readiness Gates блока (Resilience / Observability / Operational hygiene / UX polish) явно перечислены в `Tasks` секции фазы — либо с реальными bullet'ами, либо с "N/A: <причина>" (см. "Production Readiness Gates" в начале документа);
- каждый item из "Known follow-ups" секции `architecture/<system>.md` этой фазы либо закрыт здесь же, либо перенесён в `Tasks` секцию КОНКРЕТНОЙ named-later-phase (см. "Phase Closure Discipline");
- запущен `/step-perfect-loop with full 5x5 depth` (см. "Roadmap progress" ниже), вернул **PERFECT (MIN=10)**. GOOD / UNREACHABLE_10 — не зачёт; см. "Phase Closure Discipline" в начале документа.

(Чек-боксы намеренно без `[ ]` — это не runtime-чек-лист, а human-readable acceptance criteria. Runtime gate — это step-perfect-loop в конце фазы.)

---

## Roadmap progress

Единственный чек-лист с `- [x]` во всём проекте. Когда фаза закрыта (commit + tests + acceptance checklist), ставь `- [x]` рядом с ней — хук подскажет запустить `/step-perfect-loop` с full 5×5 depth для phase-level validation.

- [x] Phase 0 — Project foundation + AI scaffolding
- [x] Phase 1 — Identity, workspace, Telegram Mini App auth
- [x] Phase 2 — Channel connection
- [x] Phase 3 — Topics and sources
- [x] Phase 4 — Task system, global ingestion, embeddings
- [x] Phase 5 — Matching and scoring
- [ ] Phase 6 — AI draft generation, editor, cost guard (включает Phase 4/5 catchup: ai_usage_events tokens, Yandex circuit breaker, worker /health + SIGTERM drain, score-handler JOIN consolidation, /radar rate-limit, topic_profile_id в payload)
- [ ] Phase 7 — Safe publishing (включает Phase 4 catchup: stranded items reaper, cluster_news orphan-cluster fix, task_runs / ai_usage_events retention, ivfflat REINDEX, connect-time IP pinning, system_state encryption, global_news_items.url CHECK, sources.error retry env var, RUN_DB_TESTS=1 integration harness)
- [ ] Phase 8a — Notifications + source health (продуктовый scope)
- [ ] Phase 8b — Observability + admin/debug + per-workspace tunables + composite weights + re-score + reliability backfill (operator scope; включает Phase 5 catchup)
- [ ] Phase 8c — UI polish per design-system §6 / §12 (illustrated empty states, slow-network warning, skeletons, risk_flags cap, a11y APG pass, bundle/lighthouse final gate)
- [ ] Phase 8d — Resilience completion (offline mode, chaos passes, circuit-breaker dashboard, cost guard countdown)
