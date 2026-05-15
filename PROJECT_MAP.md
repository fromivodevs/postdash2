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
  - `src/screens/` — 5 tab placeholders + `onboarding/` 3-step wizard skeleton (§9)
  - `scripts/check-bundle-size.mjs` — gzip bundle budget gate (§5/§13), `.bundle-size-baseline.json`
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
- `packages/shared/` — общий код между backend и Mini App
  - `src/telegram-format.ts` — `TELEGRAM_POST_MAX_LENGTH = 4096` constant + `fitsTelegramPostLimit(text)` helper; Phase 6: full parser
  - `src/index.ts` — re-exports `TELEGRAM_POST_MAX_LENGTH`, `fitsTelegramPostLimit`
  - `src/__tests__/telegram-format.test.ts` — 4 tests for `fitsTelegramPostLimit`
- `packages/channel-adapters/` — Telegram (Phase 2+) / VK / Discord (future)
  - `README.md` — architectural rule: channel-agnostic core; adapter scope documented
- `packages/commands/` — command handlers + idempotency (Phase 1+)
- `packages/policies/` — auth, role, integrity checks (Phase 1+)
- `packages/domain/` — pure business types (Phase 1+)
- `packages/sources/` — RSS fetchers + URL canonicalization (Phase 3+)

### Plan
- `tg_mvp_plan/` — 14 markdown-документов (entrypoint: `tg_mvp_plan/README.md`)
- `architecture/_TEMPLATE.md` — per-system architecture doc template

### Claude Code setup
- `.claude/` — portable agent kit (skills, agents, hooks, commands, settings)
- `kit/` — kit source bundle v1.0.0 (для переустановки)

## Systems index

См. `ARCHITECTURE.md`.

- `architecture/channel-connection.md` — Phase 2 channel-connection system. *In design.* Planned files (not yet implemented):
  - `packages/db/migrations/0002_phase2.sql` + `.down.sql`
  - `packages/db/src/schema.ts` (additions: `contentChannels`, `channelConnections`, `channelConnectCodes`)
  - `packages/domain/src/channel.ts`
  - `packages/commands/src/{create-connect-code,connect-telegram-channel,connect-code-helpers,policies}.ts`
  - `packages/channel-adapters/src/telegram/{index,types,errors,api-client,verify-connection}.ts`
  - `apps/api/src/routes/{channels,channels-projection}.ts`
  - `apps/api/src/bot/handlers/start-connect.ts`
  - `apps/miniapp/src/screens/ChannelScreen.tsx` (rewrite of Phase 1 placeholder)
  - `apps/miniapp/src/api/channels.ts`
  - `apps/miniapp/src/components/CopyButton.tsx`
  - `packages/shared/src/channel-projection.ts`

## Recent changes (last 10)

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
