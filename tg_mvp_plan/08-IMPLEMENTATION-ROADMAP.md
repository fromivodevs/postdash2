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

- Local dev and phase validation: ordinary Docker Postgres via
  `docker compose up -d postgres`.
- Shared preview/staging/prod: Neon Postgres by default, because its database
  branches can mirror Git phase branches and preview branches.
- Phase-specific remote checks must use a matching Neon branch/database or a
  disposable DB. Do not run migrations from multiple phase branches against one
  long-lived remote DB unless intentionally upgrading it forward.
- Supabase is allowed when we need Supabase Auth, Storage, Realtime, or its
  dashboard. Render/Railway are allowed for simple hosting. Native Windows
  Postgres is allowed but Docker remains the default local path.
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
- `ConnectTelegramChannelCommand` через bot `/start connect_<code>` payload **И** через ручной ввод в Mini App;
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
- канал виден connected.

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
MVP готов для 10–30 early users.

### Tasks
- table `notification_events` с UNIQUE `(workspace_id, user_id, kind, related_object_id)`;
- notifications opt-in (default off);
- coalesce notification ("5 новых high-score за час");
- throttle: 1 notification / workspace / 30 min;
- handling bot blocked → `telegram_identities.status='blocked_bot'`, `notification_events.status='blocked'`;
- deep-link в notifications: `?startapp=draft_<id>` / `?startapp=radar_filter_<id>`;
- Mini App cache-busting (`?v=<commit_sha>` в bot URL);
- "Проверить сейчас" кнопка на source → `fetch_source` task с priority=80;
- source health UI:
  - last_fetched_at relative;
  - last_fetch_status / error;
  - ETA next fetch;
- empty states polish;
- error states polish (graceful "draft no longer available", и т.д.);
- offline indicator + disable mutation buttons;
- basic admin/debug page (read-only): tasks pending, failed_permanent, ai_usage_events daily sum, publish failures;
- setup docs (`README.md` operational руководство, env-vars list);
- rate-limit polish:
  - max sources per workspace;
  - max manual fetches per hour;
  - max rewrites per draft per hour;
- AI fallback verification:
  - chaos test: убить Yandex endpoint в env → TemplateProvider работает;
  - cost cap reached → user видит баннер с countdown.

### Tests
- duplicate notification (тот же kind+related_id) → unique constraint;
- bot blocked → `blocked_bot` status, не пытаемся retry;
- coalesce: 20 high-score за час → 1 notification;
- cache-bust работает после deploy (URL содержит новый sha);
- source check now → task immediately picked up workers;
- offline state в Mini App → publish disabled;
- daily admin dashboard queries возвращают correct counts.

### Done when
- продукт даём первым 10–30 users без developer intervention;
- ошибки не ломают flow;
- AI costs bounded by guard;
- onboarding понятен;
- source health visible;
- notifications не флудят.

### Commit
`phase-8-mvp-hardening`

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
- запущен `/step-perfect-loop with full 5x5 depth` (см. "Roadmap progress" ниже), вернул PERFECT или GOOD с принятыми trade-off.

(Чек-боксы намеренно без `[ ]` — это не runtime-чек-лист, а human-readable acceptance criteria. Runtime gate — это step-perfect-loop в конце фазы.)

---

## Roadmap progress

Единственный чек-лист с `- [x]` во всём проекте. Когда фаза закрыта (commit + tests + acceptance checklist), ставь `- [x]` рядом с ней — хук подскажет запустить `/step-perfect-loop` с full 5×5 depth для phase-level validation.

- [x] Phase 0 — Project foundation + AI scaffolding
- [x] Phase 1 — Identity, workspace, Telegram Mini App auth
- [ ] Phase 2 — Channel connection
- [ ] Phase 3 — Topics and sources
- [ ] Phase 4 — Task system, global ingestion, embeddings
- [ ] Phase 5 — Matching and scoring
- [ ] Phase 6 — AI draft generation, editor, cost guard
- [ ] Phase 7 — Safe publishing
- [ ] Phase 8 — MVP hardening, notifications, source health
