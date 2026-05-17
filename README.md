# PostDash

AI-радар инфоповодов для Telegram-каналов: находит новости по теме, оценивает важность, готовит черновики постов через DeepSeek 3.2 (Yandex AI Studio), публикует после одобрения.

Полный план продукта — `tg_mvp_plan/` (см. `tg_mvp_plan/README.md`).

## Stack

- **Runtime**: Node 22 LTS + TypeScript 5 (strict, ESM)
- **Monorepo**: pnpm workspaces
- **API + bot**: Fastify + grammy (с Phase 1)
- **Mini App**: Vite + React 18 + `@telegram-apps/sdk-react` + `@telegram-apps/telegram-ui` + wouter
- **DB**: Postgres 16 + pgvector 0.7+ + Drizzle ORM
- **AI**: Yandex AI Studio (DeepSeek 3.2 + YandexGPT Embeddings)
- **Tests**: vitest
- **Lint/format**: eslint 9 (flat config) + prettier

## Prerequisites

- Node 22+ (`.nvmrc` указывает 22)
- pnpm 9+
- **Neon Postgres** аккаунт (https://neon.tech, free tier). Detailed policy: [`architecture/database.md`](architecture/database.md).

## Database policy

**Neon everywhere.** Local dev, phase validation, staging, production — all run against Neon. No Docker Postgres, no Supabase, no RDS — see [`architecture/database.md`](architecture/database.md) for rationale and operational rules.

Quick setup:
1. neon.tech → create project → Console → Extensions → enable `vector`.
2. Copy the **direct** connection string (not pooled). Always keep `?sslmode=require`.
3. Paste into `.env` as `DATABASE_URL`.
4. Working on a `phase/N-*` Git branch? Create a matching Neon branch and use its connection string to keep phase data isolated.
5. `pnpm db:migrate` — applies `0000_init.sql` (pgvector) + `0001_phase1.sql` + `0002_phase2.sql`. Idempotent; cold-start retry built in.

## Quick start (в одну кнопку)

```text
1. cp .env.example .env
2. Открой .env и пропиши DATABASE_URL=<твоя connection string>
3. Двойной клик на start.bat   (или в терминале: .\start.bat)
```

`start.bat` сделает:
1. Проверит pnpm + .env + node_modules (запустит `pnpm install`, если нет).
2. Применит миграции (`pnpm db:migrate`, идемпотентно — повторный запуск безопасен).
3. Запустит api + worker + miniapp в одном окне через `concurrently` (output префиксирован: `[api]`, `[worker]`, `[miniapp]`).

Ctrl+C один раз останавливает всех.

Адреса после старта:
- API: http://localhost:3000/health
- Mini App: http://localhost:5173
- Worker логи: в том же окне с префиксом `[worker]`

## Manual start (если нужен только один сервис)

```bash
pnpm install
pnpm db:migrate        # applied once; идемпотентно при повторе
pnpm dev               # api + worker + miniapp через concurrently
# либо по отдельности:
pnpm dev:api           # http://localhost:3000/health
pnpm dev:miniapp       # http://localhost:5173
pnpm dev:worker
```

## Common commands

```bash
pnpm test          # vitest across all packages; DB suites require Neon DATABASE_URL
SKIP_DB_TESTS=1 pnpm test  # offline/pure test pass without a DB
pnpm typecheck     # tsc --noEmit во всех workspace'ах
pnpm lint          # eslint .
pnpm format        # prettier --write .
pnpm build         # production build (Phase 8+)
```

## Structure

```
apps/
  api/                 Fastify HTTP API + Telegram webhook (с Phase 1)
  miniapp/             React Mini App (Phase 1+)
  worker/              Background worker (Phase 4+)
packages/
  ai/                  AIProvider interface + Yandex DeepSeek + Template fallback
  channel-adapters/    Telegram adapter (Phase 2+)
  commands/            Command handlers + idempotency (Phase 1+)
  db/                  Drizzle schema + migrations + pool
  domain/              Pure business types
  policies/            Auth, role, integrity checks (Phase 1+)
  shared/              Telegram-format parser, zod schemas
  sources/             RSS fetchers + URL canonicalization (Phase 3+)
tg_mvp_plan/           Полный план продукта (14 документов)
.claude/               Portable agent setup (kit v1.0.0)
kit/                   Source bundle для kit (на случай переустановки)
architecture/          Per-system документация (создаётся при росте)
```

## Phases

Roadmap: `tg_mvp_plan/08-IMPLEMENTATION-ROADMAP.md`.
Текущая: **Phase 0 — foundation + AI scaffolding** ✓

Acceptance criteria phase'ы — в roadmap. Запуск `/step-perfect-loop with full 5x5 depth` после `- [x] Phase N` валидирует целую фазу против обещаний плана.

Phase branches are cumulative and are the source of truth for rollback and
phase-only validation: `phase/0-foundation` contains only Phase 0,
`phase/1-identity` contains Phase 0 plus Phase 1, and so on. Run
`step-perfect-loop` from the matching phase branch and compare only
`phase/(N-1)-<slug>..phase/N-<slug>`; for Phase 0 use
`phase/base..phase/0-foundation`.

## Operational notes

- **Bot rate limiter is single-process.** `apps/api/src/bot/rate-limit.ts` keeps
  per-user message counters in-memory. It is correct only with exactly one bot
  process running; scaling the bot out horizontally multiplies the effective
  limit (each process counts independently). Shared counters
  (Postgres/Redis) are a Phase 8+ change — do not scale the bot process out
  before then.

## Conventions

Project-specific agent rules live in `PROJECT_RULES.md`; `AGENTS.md` and
`CLAUDE.md` are runtime-specific shims.

См. `CLAUDE.md` (encoding rules, AI = adapter, idempotency, cost guard) и `tg_mvp_plan/09-CODEX-CLAUDE-INSTRUCTIONS.md` (правила реализации для кодинг-агентов).

## Documentation

- `tg_mvp_plan/02-ARCHITECTURE.md` — non-negotiable rules (10 штук)
- `tg_mvp_plan/03-DATABASE-SCHEMA.md` — таблицы и constraints
- `tg_mvp_plan/11-AI-PROVIDER.md` — contract Yandex AI Studio + DeepSeek 3.2
- `tg_mvp_plan/12-EDGE-CASES.md` — каталог edge cases (per-phase checklist)
- `tg_mvp_plan/13-MINIAPP-DESIGN-SYSTEM.md` — design tokens, performance budget, a11y
