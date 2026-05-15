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
  - `src/routes/error-mapping.ts` — Phase 2 `CHANNEL_DETAILS_TABLE` (expired_code / reused_code / channel_taken / bot_not_admin / missing_post_permission / chat_not_found / bot_blocked / unauthorized / cross_workspace_replay)
  - `src/bot/bot.ts` — start-payload routing to `handleStartConnect`
  - `src/bot/handlers/start-connect.ts` — `/start connect_<code>` flow
  - `src/bot/__tests__/parse-start-payload.test.ts` — 7 tests
  - `src/__tests__/routes-auth.test.ts` — auth route tests
  - `src/__tests__/routes-webhook.test.ts` — webhook route tests
  - `src/__tests__/telegram-webhook-hardening.test.ts` — webhook hardening tests
  - `src/__tests__/helpers/` — shared test helpers
  - Total API tests: 82
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
  - Total miniapp tests: 104 (incl. ChannelScreen 23, channels api 15)
- `apps/worker/` — task polling, IAM refresh, AI calls (Phase 4+)
  - `src/index.ts` — entry, pino logger
  - `src/loop.ts` — `WorkerLoop` class (Phase 0: no-op tick)
  - `src/env.ts` — zod env validation (friendly ZodError wrapper)

### Packages
- `packages/ai/` — AIProvider interface + Yandex DeepSeek + Template fallback
  - `src/provider.ts` — zod schemas + `AIProvider` interface + `AIProviderError`; `DraftOutputSchema.post_text` channel-agnostic (no max cap; see Phase 9/13)
  - `src/providers/template.ts` — `TemplateProvider` (Format A fallback); code-point-safe truncation via `[...rawText].slice()`
  - `src/providers/yandex.ts` — `YandexAIStudioDeepSeekProvider` skeleton
  - `src/iam-token.ts` — `IAMTokenCache` (refresh stub до Phase 4)
  - `src/env.ts` — zod AI env validation (friendly ZodError wrapper)
  - `src/index.ts` — `createAIProvider`: placeholder-detect + prod hard-fail (opt-out via `AI_FALLBACK_TO_TEMPLATE=true`)
  - `src/__tests__/template.test.ts` — 6 tests (incl. surrogate-pair-safe truncation)
  - `src/__tests__/factory.test.ts` — ~9 tests (placeholder-detect, prod-fail, opt-in)
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
- `packages/shared/` — общий код между backend и Mini App
  - `src/telegram-format.ts` — `TELEGRAM_POST_MAX_LENGTH = 4096` constant + `fitsTelegramPostLimit(text)` helper; Phase 6: full parser
  - `src/channel-projection.ts` — Phase 2: wire types (`ChannelProjection`, `ConnectCodeProjection`) + `buildConnectDeepLink`
  - `src/index.ts` — re-exports `TELEGRAM_POST_MAX_LENGTH`, `fitsTelegramPostLimit`, channel-projection
  - `src/__tests__/telegram-format.test.ts` — 4 tests for `fitsTelegramPostLimit`
  - `src/__tests__/` — 33 tests total (incl. channel-projection 11)
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
  - `src/__tests__/` — 36 tests total
- `packages/policies/` — auth, role, integrity checks (Phase 1+)
- `packages/domain/` — pure business types (Phase 1+)
  - `src/identity.ts` — identity types
  - `src/channel.ts` — Phase 2: `ContentChannel`, `ChannelConnection`, `ChannelConnectCode` pure types + `narrow*` helpers + `MAX_EXTERNAL_CHAT_ID_LEN`
  - `src/index.ts` — re-exports all domain types
- `packages/sources/` — RSS fetchers + URL canonicalization (Phase 3+)

### Plan
- `tg_mvp_plan/` — 14 markdown-документов (entrypoint: `tg_mvp_plan/README.md`)
- `architecture/_TEMPLATE.md` — per-system architecture doc template

### Claude Code setup
- `.claude/` — portable agent kit (skills, agents, hooks, commands, settings)
- `kit/` — kit source bundle v1.0.0 (для переустановки)

## Systems index

См. `ARCHITECTURE.md`.

- `architecture/channel-connection.md` — Phase 2 channel-connection system. *Active.* 3 DB tables, 2 commands (`create-connect-code`, `connect-telegram-channel`), Telegram channel adapter (33 tests), 4-state Mini App screen. Closed tag: `phase-2-perfect`.

## Recent changes (last 10)

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
