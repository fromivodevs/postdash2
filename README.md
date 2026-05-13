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
- Postgres 16+ с pgvector. Варианты:
  - **Neon** (рекомендуется, managed) — https://neon.tech, free tier с pgvector;
  - **Supabase** / Railway / Render — managed, аналогично;
  - **Docker локально** — `docker compose up -d postgres` (используется `pgvector/pgvector:pg16`);
  - **Нативный Postgres + pgvector** — сложнее всех на Windows, см. https://github.com/pgvector/pgvector#installation.

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
pnpm test          # vitest across all packages
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

## Conventions

См. `CLAUDE.md` (encoding rules, AI = adapter, idempotency, cost guard) и `tg_mvp_plan/09-CODEX-CLAUDE-INSTRUCTIONS.md` (правила реализации для кодинг-агентов).

## Documentation

- `tg_mvp_plan/02-ARCHITECTURE.md` — non-negotiable rules (10 штук)
- `tg_mvp_plan/03-DATABASE-SCHEMA.md` — таблицы и constraints
- `tg_mvp_plan/11-AI-PROVIDER.md` — contract Yandex AI Studio + DeepSeek 3.2
- `tg_mvp_plan/12-EDGE-CASES.md` — каталог edge cases (per-phase checklist)
- `tg_mvp_plan/13-MINIAPP-DESIGN-SYSTEM.md` — design tokens, performance budget, a11y
