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
- `.env.example` — каталог env-vars (см. `tg_mvp_plan/11-AI-PROVIDER.md §13`)
- `.gitattributes` — Windows-aware EOL правила
- `.gitignore` — Node/Python/secrets/runtime artifacts
- `.nvmrc` — Node 22 LTS pinned
- `CLAUDE.md` — encoding rules + workflow conventions
- `README.md` — quick start для разработчика
- `ARCHITECTURE.md` — индекс per-system docs (см. `architecture/`)

### Apps
- `apps/api/` — Fastify HTTP API + Telegram webhook (Phase 1+)
  - `src/index.ts` — entry, listen
  - `src/app.ts` — Fastify factory (sensible + routes)
  - `src/env.ts` — zod env validation
  - `src/routes/health.ts` — `GET /health`
  - `src/__tests__/health.test.ts` — smoke (2 tests)
- `apps/miniapp/` — Vite + React 18 + Telegram SDK Mini App
  - `vite.config.ts`, `index.html`
  - `src/main.tsx`, `src/App.tsx`, `src/env.ts`, `src/index.css`
- `apps/worker/` — task polling, IAM refresh, AI calls (Phase 4+)
  - `src/index.ts` — entry, pino logger
  - `src/loop.ts` — `WorkerLoop` class (Phase 0: no-op tick)
  - `src/env.ts` — zod env validation

### Packages
- `packages/ai/` — AIProvider interface + Yandex DeepSeek + Template fallback
  - `src/provider.ts` — zod schemas + `AIProvider` interface + `AIProviderError`
  - `src/providers/template.ts` — `TemplateProvider` (Format A fallback)
  - `src/providers/yandex.ts` — `YandexAIStudioDeepSeekProvider` skeleton
  - `src/iam-token.ts` — `IAMTokenCache` (refresh stub до Phase 4)
  - `src/env.ts` — zod AI env validation
  - `src/__tests__/template.test.ts` — smoke (5 tests)
- `packages/db/` — Drizzle ORM + Postgres pool + migrations
  - `drizzle.config.ts` — config для `drizzle-kit generate`
  - `src/pool.ts` — `createPool(url)` через postgres-js
  - `src/schema.ts` — placeholder (Phase 1+)
  - `src/migrate.ts` — простой SQL migrator
  - `src/env.ts` — `DATABASE_URL` validation
  - `migrations/0000_init.sql` — `CREATE EXTENSION vector`
- `packages/shared/` — общий код между backend и Mini App
  - `src/telegram-format.ts` — Telegram message format utils (Phase 6: full parser)
- `packages/channel-adapters/` — Telegram (Phase 2+) / VK / Discord (future)
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

См. `ARCHITECTURE.md`. Активных systems пока нет — реальные системы появятся с Phase 1 (см. `tg_mvp_plan/08-IMPLEMENTATION-ROADMAP.md`).

## Recent changes (last 10)

- 2026-05-13: Phase 0 — foundation + AI scaffolding (11 workspace projects, 7 smoke tests, pnpm install OK, typecheck OK).
- 2026-05-13: Phase-aware `stage-complete-detector.ps1` hook + "Roadmap progress" convention.
- 2026-05-13: 14-документный план зафиксирован (включая 11-AI-PROVIDER, 12-EDGE-CASES, 13-MINIAPP-DESIGN-SYSTEM).
- 2026-05-13: Initial commit + GitHub repo `fromivodevs/postdash2` connected.
- 2026-05-13: Portable agent kit v1.0.0 установлен в `.claude/`.
