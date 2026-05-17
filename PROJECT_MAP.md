# Project Map

> Карта проекта. Обновляется при создании файлов и систем.
> Не редактировать вручную без причины — следующий запуск roadmap-keeper'а может переписать.

## Quick navigation

### Root configs
- `package.json` — pnpm workspace root, scripts (dev/test/build/typecheck)
- `pnpm-workspace.yaml` — workspace patterns (apps/* + packages/*)
- `tsconfig.base.json` — общие TS опции (strict + ESM)
- `eslint.config.js` — eslint 9 flat config
- `.prettierrc.json` / `.prettierignore` — prettier
- `docker-compose.yml` — Postgres 16 + pgvector локально
- `.env.example` — каталог env-vars (см. `tg_mvp_plan/11-AI-PROVIDER.md §13`) + DB provider notes
- `.gitattributes` — Windows-aware EOL правила
- `.gitignore` — Node/Python/secrets/runtime artifacts
- `.nvmrc` — Node 22 LTS pinned
- `PROJECT_RULES.md` — single source of truth for PostDash-specific agent/project rules
- `CLAUDE.md` — encoding rules + workflow conventions
- `README.md` — quick start для разработчика
- `ARCHITECTURE.md` — индекс per-system docs (см. `architecture/`)

### Apps
- `apps/api/` — Fastify HTTP API + Telegram webhook (Phase 1+)
  - `src/index.ts` — entry, listen
  - `src/app.ts` — Fastify factory (sensible + routes)
  - `src/env.ts` — zod env validation (friendly ZodError wrapper)
  - `src/routes/health.ts` — `GET /health`; `resolveVersion()` (APP_VERSION → COMMIT_SHA → RENDER_GIT_COMMIT → npm), `sanitizeVersion()` exported
  - `src/routes/ready.ts` — `GET /ready` pool ping
  - `src/__tests__/health.test.ts` — 8 tests (3 health + 5 sanitizeVersion)
  - `src/__tests__/ready.test.ts` — 3 tests (pool ping, 503 on fail)
  - `src/__tests__/error-handler.test.ts` — 9 tests (AI error code → HTTP mapping)
  - `src/__tests__/env.test.ts` — 12 tests (env validation edge cases)
  - `src/routes/channels.ts` — `POST /channels`, `GET /channels/:id/connect-code`
  - `src/routes/channels-projection.ts` — `GET /channels/:id` (projection)
  - `src/routes/auth-telegram.ts` — Telegram auth endpoint
  - `src/routes/me.ts` — `GET /me`
  - `src/routes/projection.ts` — shared projection helpers
  - `src/routes/error-mapping.ts` — Phase 2 `CHANNEL_DETAILS_TABLE` (invalid_code / expired_code / reused_code / channel_taken / bot_not_admin / missing_post_permission / chat_not_found / bot_blocked / unauthorized / cross_workspace_code / cross_workspace_replay)
  - `src/bot/bot.ts` — start-payload routing to `handleStartConnect`
  - `src/bot/handlers/start-connect.ts` — `/start connect_<code>` flow
  - `src/bot/__tests__/parse-start-payload.test.ts` — 7 tests
  - `src/__tests__/routes-auth.test.ts` — auth route tests
  - `src/__tests__/routes-webhook.test.ts` — webhook route tests
  - `src/__tests__/telegram-webhook-hardening.test.ts` — webhook hardening tests
  - `src/__tests__/routes-topics.test.ts` — Phase 3 topics route tests (7)
  - `src/__tests__/routes-sources.test.ts` — Phase 3 sources route tests (5)
  - `src/__tests__/helpers/` — shared test helpers
  - `src/routes/topics.ts` — Phase 3 `POST/GET/PATCH/DELETE /topics`
  - `src/routes/sources.ts` — Phase 3 `POST/GET/PATCH/DELETE /sources`
  - `src/routes/topics-projection.ts` — Phase 3 domain → wire projections
  - Total API tests: 95
- `apps/miniapp/` — Vite + React 18 + Telegram SDK Mini App
  - `vite.config.ts`, `index.html`
  - `src/main.tsx` — provider tree (Query / AppRoot / Router / Snackbar / Session)
  - `src/App.tsx` — session-state gate (no-telegram / pending / error / ready)
  - `src/AppShell.tsx` — routed shell (wouter Switch + TabBar + deep-link)
  - `src/env.ts`, `src/index.css`
  - `src/theme/tokens.css` — design tokens (spacing/radius/accent, §2) + reduced-motion
  - `src/telegram/` — WebApp boot, theme listener, AppRoot, BackButton/MainButton hooks
  - `src/routing/` — route table + Telegram `start_param` deep-link mapping (§10)
  - `src/components/` — baseline palette + §7 error taxonomy (Snackbar/Banner/Modal/FieldError/ErrorState)
  - `src/components/CopyButton.tsx` — copy-to-clipboard with visual feedback
  - `src/screens/` — 5 tab placeholders + `onboarding/` 3-step wizard skeleton (§9)
  - `src/screens/ChannelScreen.tsx` — Phase 2 full implementation: 4-state (loading/error/no-code/has-code)
  - `src/screens/channelView.ts` — pure selector for ChannelScreen state
  - `src/api/channels.ts` — channels API client (fetch connect code, channel details)
  - `src/session/` — session context
  - `src/telegram/` — WebApp boot, theme listener, AppRoot, BackButton/MainButton hooks
  - `src/routing/` — route table + Telegram `start_param` deep-link mapping (§10)
  - `scripts/check-bundle-size.mjs` — gzip bundle budget gate (§5/§13), `.bundle-size-baseline.json`
  - `src/api/topics.ts` — Phase 3 topics API client
  - `src/api/sources.ts` — Phase 3 sources API client
  - `src/screens/SettingsScreen.tsx` — Phase 3 topic profile edit form (upsert)
  - `src/screens/SourcesScreen.tsx` — Phase 3 sources list (toggle/delete)
  - `src/screens/AddSourceScreen.tsx` — Phase 3 URL+type add form
  - `src/screens/__tests__/splitTags.test.ts` — 4 tests for tag parsing helper
  - Total miniapp tests: 109 (incl. ChannelScreen 24, channels api 15, splitTags 4)
- `apps/worker/` — task polling, IAM refresh, AI calls (Phase 4+)
  - `src/index.ts` — entry, pino logger, wires IAM store + AIProvider into WorkerLoop
  - `src/loop.ts` — `WorkerLoop`: N polling slots + scheduler
  - `src/env.ts` — zod env validation (friendly ZodError wrapper)
  - `src/dispatcher.ts` — Dispatcher + task-type → handler routing + failure classification
  - `src/scheduler.ts` — in-process cron: fastTick (1/min: enqueue fetch_source) + slowTick (5/min: janitor + iam refresh)
  - `src/system-state-store.ts` — `IAMTokenStore` adapter backed by `system_state` table (keeps `packages/ai` free of DB deps)
  - `src/handlers/fetch-source.ts` — RSS fetch + upsert global_news_items + enqueue downstream
  - `src/handlers/extract-news-item.ts` — Phase 4 MVP: summary → extracted_text + enqueue embed
  - `src/handlers/embed-news-item.ts` — call ai.embed, persist vector, enqueue cluster
  - `src/handlers/cluster-news.ts` — pgvector nearest-neighbour + centroid recompute
  - `src/handlers/janitor-release-stuck-tasks.ts` — call releaseStuckTasks
  - `src/handlers/refresh-iam-token.ts` — invoke `_iamRefresh` on tagged provider
  - `src/handlers/index.ts` — re-exports
  - `src/__tests__/dispatcher.test.ts` — 4 routing/retry-classification tests

### Packages
- `packages/ai/` — AIProvider interface + Yandex DeepSeek + Template fallback
  - `src/provider.ts` — zod schemas + `AIProvider` interface + `AIProviderError`; `DraftOutputSchema.post_text` channel-agnostic (no max cap; see Phase 9/13)
  - `src/providers/template.ts` — `TemplateProvider` (Format A fallback); code-point-safe truncation via `[...rawText].slice()`
  - `src/providers/yandex.ts` — `YandexAIStudioDeepSeekProvider`: real `embed()` (Phase 4) + score/generate/rewrite stubs (Phase 5/6). dim-mismatch reject, single 401-retry-with-forceRefresh.
  - `src/iam-token.ts` — Phase 4 real `IAMTokenCache`: PS256 JWT signed via node:crypto, IAM exchange, in-memory + writethrough store (`IAMTokenStore` injected by worker; preserves "ai не зависит от db" rule), single-flight refresh, forceRefresh on 401.
  - `src/env.ts` — zod AI env validation (friendly ZodError wrapper)
  - `src/index.ts` — `createAIProvider(env, { iamStore?, fetch? })`: placeholder-detect + prod hard-fail (opt-out via `AI_FALLBACK_TO_TEMPLATE=true`); wires store + embeddingDim into Yandex provider
  - `src/__tests__/template.test.ts` — 7 tests (incl. surrogate-pair-safe truncation)
  - `src/__tests__/factory.test.ts` — 7 tests (placeholder-detect, prod-fail, opt-in)
  - `src/__tests__/iam-token.test.ts` — 12 tests (cache, single-flight, store roundtrip, 401, malformed body, forceRefresh)
  - `src/__tests__/yandex-embed.test.ts` — 8 tests (success, doc-vs-query URI, dim mismatch, 5xx/429/4xx, empty text, 401-retry path)
  - `README.md` — architectural rule: channel-agnostic core; TemplateProvider as documented MVP exception
- `packages/db/` — Drizzle ORM + Postgres pool + migrations
  - `drizzle.config.ts` — config для `drizzle-kit generate`
  - `src/pool.ts` — `createPool(url)` via postgres-js + `Pool.ping()` abstraction
  - `src/schema.ts` — placeholder (Phase 1+)
  - `src/migrate.ts` — SQL migrator: advisory lock (`MIGRATION_LOCK_ID`), `lock_timeout='30s'` with 55P03 handling, sha256 checksum drift detection, `MIGRATE_ALLOW_CHECKSUM_DRIFT` semantics, `.down.sql` filter, int8 bounds assertion; `buildDriftPolicy` exported
  - `src/env.ts` — `DATABASE_URL` validation (friendly ZodError wrapper)
  - `src/__tests__/migrate.test.ts` — 6 tests (concurrency, checksum reject, drift filename, drift wildcard, programmatic boolean, no-op warn; skipped via `SKIP_DB_TESTS=1`)
  - `migrations/0000_init.sql` — `CREATE EXTENSION vector`
  - `migrations/0001_phase1.sql` / `0001_phase1.down.sql` — Phase 1 tables
  - `migrations/0002_phase2.sql` / `0002_phase2.down.sql` — Phase 2: `content_channels`, `channel_connections`, `channel_connect_codes`
  - `migrations/0003_phase3.sql` / `0003_phase3.down.sql` — Phase 3: `topic_profiles` (with embedding nullable), `sources` (canonical_url UNIQUE), `workspace_source_subscriptions`
  - `migrations/0005_phase4.sql` / `0005_phase4.down.sql` — Phase 4: `system_state`, `tasks` (+3 partial unique anti-dupe indices), `task_runs`, `global_news_items` (+ivfflat embedding index), `news_clusters`, `news_cluster_items` (UNIQUE news_item_id → one cluster per item)
- `packages/shared/` — общий код между backend и Mini App
  - `src/telegram-format.ts` — `TELEGRAM_POST_MAX_LENGTH = 4096` constant + `fitsTelegramPostLimit(text)` helper; Phase 6: full parser
  - `src/channel-projection.ts` — Phase 2: wire types (`ChannelProjection`, `ConnectCodeProjection`) + `buildConnectDeepLink`
  - `src/index.ts` — re-exports `TELEGRAM_POST_MAX_LENGTH`, `fitsTelegramPostLimit`, channel-projection
  - `src/__tests__/telegram-format.test.ts` — 4 tests for `fitsTelegramPostLimit`
  - `src/__tests__/` — 33 tests total (incl. channel-projection 11)
  - `src/topic-source-projection.ts` — Phase 3 wire schemas: `TopicProfileProjection`, `SourceProjection`, `SourceSubscriptionProjection` + list shapes
- `packages/channel-adapters/` — Telegram (Phase 2+) / VK / Discord (future)
  - `README.md` — architectural rule: channel-agnostic core; adapter scope documented
  - `src/telegram/types.ts` — Telegram adapter types
  - `src/telegram/errors.ts` — adapter-specific errors
  - `src/telegram/api-client.ts` — Telegram Bot API client wrapper
  - `src/telegram/verify-connection.ts` — bot admin + post-permission verification
  - `src/telegram/index.ts` — `TelegramChannelAdapter` export
  - Tests: 33 cases
- `packages/commands/` — command handlers + idempotency (Phase 1+)
  - `src/index.ts` — re-exports all commands
  - `src/errors.ts` — `CommandError` + `details?: Record<string,string>` (Phase 2 extended)
  - `src/idempotency.ts` — idempotency key helpers
  - `src/authenticate-telegram.ts` — Telegram auth command
  - `src/read-current-user.ts` — read user command
  - `src/mark-bot-blocked.ts` — mark bot blocked command
  - `src/row-mappers.ts` — DB row → domain mappers
  - `src/create-connect-code.ts` — Phase 2: generate channel connect code
  - `src/connect-telegram-channel.ts` — Phase 2: bind Telegram chat to workspace
  - `src/connect-code-helpers.ts` — Phase 2: connect code utilities
  - `src/policies.ts` — Phase 2: command-level policy checks
  - `src/topic-profiles.ts` — Phase 3 create/update/delete/list with upsert semantics
  - `src/sources.ts` — Phase 3 create/update/delete/list with redirect+canonicalize+global-source dedup
  - `src/topic-row-mappers.ts` — Phase 3 row → domain mappers
  - `src/__tests__/topic-profiles.test.ts` — 9 tests
  - `src/__tests__/sources.test.ts` — 10 tests
  - `src/__tests__/` — 55 tests total
- `packages/tasks/` — Phase 4 task queue primitives (no business logic)
  - `src/types.ts` — `TASK_TYPES` + `TASK_STATUSES` exhaustive lists (mirror migration CHECK), `EnqueueTaskInputSchema` (zod), `DEFAULT_RETRY_POLICY` (10s/30s/90s backoff matching §15 of WORKERS-AND-INGESTION)
  - `src/queue.ts` — `enqueueTask` (ON CONFLICT DO NOTHING via partial uniques), `pollNextTask` (atomic `FOR UPDATE SKIP LOCKED`), `completeTask`, `failTask` (transient→retry-with-backoff / permanent→failed_permanent), `deferTask` (Phase 6 hook), `releaseStuckTasks` (janitor SQL with attempts-exhausted promotion)
  - `src/index.ts` — re-exports
  - `src/__tests__/types.test.ts` — 7 tests (type/status enum mirrors, zod schema, default policy)
- `packages/policies/` — auth, role, integrity checks (Phase 1+)
- `packages/domain/` — pure business types (Phase 1+)
  - `src/identity.ts` — identity types
  - `src/channel.ts` — Phase 2: `ContentChannel`, `ChannelConnection`, `ChannelConnectCode` pure types + `narrow*` helpers + `MAX_EXTERNAL_CHAT_ID_LEN`
  - `src/topic.ts` — Phase 3: `TopicProfile`, `TopicProfileLanguage`, `ToneProfile`, narrowers
  - `src/source.ts` — Phase 3: `Source`, `WorkspaceSourceSubscription`, `SourceType`, `SourceStatus`, narrowers
  - `src/index.ts` — re-exports all domain types
- `packages/sources/` — RSS fetchers + URL canonicalization + content-hash (Phase 3-4)
  - `src/canonicalize.ts` — Phase 3 `canonicalize(url)` rules per `tg_mvp_plan/06-WORKERS-AND-INGESTION.md §9` + `CANONICALIZATION_RULE_VERSION`
  - `src/redirect-resolver.ts` — Phase 3 one-time HTTP HEAD follow with timeout/max-hop/SSRF/rebinding defence
  - `src/rss-parser.ts` — Phase 4 `fetchRssSource(url, opts)` — AbortController timeout, polite UA, status classification ('ok'|'4xx'|'5xx'|'parse_error'|'timeout'|'network_error'), volume cap (`maxItems`, sorts by published_at DESC before cap), `detectLanguage(text)` helper
  - `src/content-hash.ts` — Phase 4 `contentHash({title, summary?, publishedAt?})` → sha256 hex; whitespace-trimmed, missing→empty (stable), `CONTENT_HASH_RULE_VERSION`
  - `src/__tests__/canonicalize.test.ts` — 23 tests
  - `src/__tests__/redirect-resolver.test.ts` — 35 tests
  - `src/__tests__/rss-parser.test.ts` — 13 tests (parse, cap, sort, 4xx/5xx, parse_error, empty, timeout, missing fields, detectLanguage 4 cases)
  - `src/__tests__/content-hash.test.ts` — 8 tests (identical, title/summary/publishedAt diff, missing-summary == empty, stable for absent publishedAt, whitespace normalization, 64-char hex)

### Plan
- `tg_mvp_plan/` — 14 markdown-документов (entrypoint: `tg_mvp_plan/README.md`)
- `architecture/_TEMPLATE.md` — per-system architecture doc template

### Claude Code setup
- `.claude/` — portable agent kit (skills, agents, hooks, commands, settings)
- `kit/` — kit source bundle v1.0.0 (для переустановки)

## Systems index

См. `ARCHITECTURE.md`.

- `architecture/channel-connection.md` — Phase 2 channel-connection system. *Active.* 3 DB tables, 2 commands (`create-connect-code`, `connect-telegram-channel`), Telegram channel adapter (33 tests), 4-state Mini App screen. Closed tag: `phase-2-perfect`.
- `architecture/topics-and-sources.md` — Phase 3 topics + sources. *Active.* 3 DB tables (`topic_profiles`, `sources`, `workspace_source_subscriptions`), 4 topic commands + 4 source commands, `canonicalize` + `resolveRedirect` in `@postdash/sources`, 8 REST endpoints, 3 Mini App screens (Settings/Sources/AddSource). Latest closure `phase-3-perfect-r8`.
- `architecture/global-ingestion.md` — Phase 4 task system + global ingestion + embeddings. *Active. Latest closure `phase-4-perfect-r4`.* 6 new DB tables (`tasks`, `task_runs`, `system_state`, `global_news_items`, `news_clusters`, `news_cluster_items`), new `packages/tasks` queue, `fetchRssSource` + `contentHash` in `@postdash/sources`, real Yandex IAM (PS256 JWT) + `embed()`, 6 task handlers + in-process scheduler in `apps/worker`. Closes edges 4.1/4.2/4.3/4.4/4.5/4.10/5.5/6.5/9.1/9.2/9.3/9.4/9.5/9.8/10.5/11.x.

## Recent changes (last 10)

- 2026-05-17: Phase 4 fresh step-perfect-loop r4 validation closed on `phase/4-global-ingestion-embeddings` with tag `phase-4-perfect-r4`. No runtime code changes were required after r3. Gates passed: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `SKIP_DB_TESTS=1 pnpm test` (495 passed, 21 skipped), `pnpm build`, Mini App bundle budget (166320 B, +6.38% vs baseline, under 10%), `.codex/kit/diagnose.ps1`, `.claude/kit/diagnose.ps1`, and `git diff --check`. Final status remains 8/10 GOOD with UNREACHABLE_10 reason (a): the remaining caps are Phase 8/live-ops scope (live Neon/Yandex/e2e worker evidence, health/drain/reapers/retention/encryption/IP pinning/REINDEX policy), already documented in `architecture/global-ingestion.md`.

- 2026-05-17: Phase 4 re-validated via step-perfect-loop Mode B memory-injection (proper main/sub-loop structure per updated `perfect-loop` SKILL). Branch tag `phase-4-perfect-r3`. M1 (memory-injection) sub-loops 1-3: fresh agents → MIN 7 → 8 → 8 (calibrated ceiling held by pessimist). M2 (fresh-agent PERFECT_FRESH check) sub-1: pessimist=8 — identical score & reason to mem-inject, confirming the ceiling is scope-limited not anchoring-bias. 7 new blockers fresh agents found that prior anti-pattern run missed: SSRF downgrade in fetch-source (proceeded on non-success non-blocked guard status), tasks_polling_idx column order vs ORDER BY mismatch, cluster_news anti-dupe gap, scheduler.fastTick N+1, AIProvider iamRefresh as instanceof hack, parseEmbedding isFinite gap, doc status drift. New migration `0007_phase4_perf_security.sql` (polling index reorder + cluster_news partial UNIQUE + system_state.key allowlist CHECK). New `apps/worker/RUNBOOK.md` with 5-scenario triage SQL. Scheduler now emits heartbeat logs every tick. Final status: GOOD with UNREACHABLE_10 reason (a) per SKILL — Phase 4 is scaffold-phase deferring ops to Phase 8 per roadmap. 8 documented follow-ups remain in "Known follow-ups (Phase 4+ ops)" section of architecture/global-ingestion.md. Loop report: `.claude/perfect-loop-runs/2026-05-17-phase-4-modeB/REPORT.md`.

- 2026-05-17: Phase 4 closed via step-perfect-loop (rounds 1-5, MIN 5 → 8, tag `phase-4-perfect-r2`). 3 reviewer sub-loops × 7 reviewers (architect, breaker, security, performance, pessimist, plan-keeper, goal-keeper) + 3 implementer passes. Round 1 closed 8 priorities (single IAMTokenCache, lease-guarded UPDATEs, sources.status='error' transition, auth_error→permanent classify, anti-dupe partial UNIQUE on extract/embed, ivfflat planner contract, SSRF re-check, cleanup). Round 3 closed 4 round-2 findings (error-source recovery loop reachable, fetch uses guard.finalUrl, cluster_news tx-wrap, 401-after-refresh classify). Round 5 polish (recomputeCluster CTE, observability log, classifyFailure tests). Final status: GOOD with 8 explicitly accepted Phase 4+ ops follow-ups (stranded-items reaper, embedding backfill, task_runs retention, ivfflat REINDEX policy, worker /health + SIGTERM drain, IAM token encryption-at-rest, integration test harness, connect-time IP pinning) — all properly Phase 8 hardening per roadmap. New migration `0006_phase4_hardening.sql`. Workspace tests now 495 green. Loop report: `.claude/perfect-loop-runs/2026-05-17-phase-4/REPORT.md`.

- 2026-05-17: Phase 4 (Task system + Global ingestion + Embeddings) implemented on `phase/4-global-ingestion-embeddings`. New migration `0005_phase4.sql` (6 tables: system_state, tasks, task_runs, global_news_items+ivfflat, news_clusters, news_cluster_items; 3 partial-unique anti-dupe indices on tasks). New `packages/tasks` queue (atomic `FOR UPDATE SKIP LOCKED` polling, retry-with-backoff, releaseStuckTasks janitor — 7 tests). RSS fetcher + content-hash in `@postdash/sources` (21 new tests). Real Yandex IAM (`packages/ai/iam-token.ts`: PS256 JWT via node:crypto, system_state writethrough via injected `IAMTokenStore`, single-flight refresh, forceRefresh on 401 — 12 tests). Real `YandexAIStudioDeepSeekProvider.embed()` (256-dim validation, dim-mismatch reject, doc/query URI selection — 8 tests). 6 task handlers in `apps/worker/` + Dispatcher (4 tests) + in-process Scheduler (fast 1/min + slow 5/min). Total workspace tests: 492+ (sources 79 + ai 34 + tasks 7 + commands 58 + miniapp 145 + api 95 + worker 4 + channel-adapters 33 + shared 33 + db 4). Architecture: `architecture/global-ingestion.md`.

- 2026-05-17: Phase 3 (Topics + Sources) implemented on `phase/3-topics-sources`. 3 DB tables (`topic_profiles`, `sources`, `workspace_source_subscriptions`), URL canonicalization + redirect resolver in `@postdash/sources` (34 tests), 8 commands (`create/update/delete/list` × topics+sources, 19 tests), 8 REST endpoints (12 route tests), 3 Mini App screens (Settings/Sources/AddSource). Total workspace tests: 365+ (sources 34 + commands 55 + miniapp 109 + api 95 + others). Architecture: `architecture/topics-and-sources.md`.

- 2026-05-15: Phase 2 (Channel Connection) closed and tagged `phase-2-perfect`. 3 DB tables (`content_channels`, `channel_connections`, `channel_connect_codes`), 2 commands (`create-connect-code`, `connect-telegram-channel`), Telegram channel adapter (`packages/channel-adapters/src/telegram/`), 4-state Mini App `ChannelScreen`, `buildConnectDeepLink` in shared. Total workspace: 306 tests.

- 2026-05-15: Centralized project-specific agent rules in `PROJECT_RULES.md`; `AGENTS.md` and `CLAUDE.md` now act as runtime shims. Kit now includes generic `PROJECT_RULES.md` templates, install guidance, diagnose drift checks, and final handoff guidance for loop commands.

- 2026-05-15: Phase 2 architecture designed → `architecture/channel-connection.md` (3 tables, 2 commands, Telegram adapter, 3 routes, bot handler, Mini App screen rewrite). In design — implementation pending.
- 2026-05-15: Added DB provider policy to `AGENTS.md`, `CLAUDE.md`, `README.md`, `.env.example`, and roadmap: local Docker Postgres by default, Neon for shared/prod because DB branches map to Git phase branches, Supabase/Render/Railway as explicit alternatives.
- 2026-05-15: Added phase branch and commit-boundary rules: cumulative `phase/N-<slug>` branches, phase-only diff ranges, phase commit prefixes, immutable closure tags, and forward propagation for older phase fixes.
- 2026-05-15: Phase 0 step-perfect-loop closure — 26 hardening fixes across 4 loop iterations (PERFECT score). Key additions: migrate advisory lock + sha256 checksum drift detection + 6 tests; `createAIProvider` placeholder-detect + prod hard-fail; `TemplateProvider` code-point-safe truncation; `TELEGRAM_POST_MAX_LENGTH` + `fitsTelegramPostLimit` in shared; `resolveVersion`/`sanitizeVersion` in health route; friendly ZodError wrappers in all env modules; `subagent-roadmap-reminder` hook; `.env.example` Observability section.
- 2026-05-13: Phase 0 — foundation + AI scaffolding (11 workspace projects, 7 smoke tests, pnpm install OK, typecheck OK).
- 2026-05-13: Phase-aware `stage-complete-detector.ps1` hook + "Roadmap progress" convention.
- 2026-05-13: 14-документный план зафиксирован (включая 11-AI-PROVIDER, 12-EDGE-CASES, 13-MINIAPP-DESIGN-SYSTEM).
- 2026-05-13: Initial commit + GitHub repo `fromivodevs/postdash2` connected.
- 2026-05-13: Portable agent kit v1.0.0 установлен в `.claude/`.
