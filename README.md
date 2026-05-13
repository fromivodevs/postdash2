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
- Postgres 16 с pgvector — либо через `docker compose up -d postgres`, либо локальная инсталляция

Если Docker нет — поставить Postgres 16 локально и установить расширение pgvector (см. https://github.com/pgvector/pgvector#installation).

## Quick start

```bash
# 1. Установить зависимости
pnpm install

# 2. Поднять Postgres + pgvector (если используешь Docker)
pnpm db:up

# 3. Скопировать env
cp .env.example .env

# 4. Применить миграции
pnpm db:migrate

# 5. Запустить (в трёх терминалах)
pnpm dev:api      # http://localhost:3000/health
pnpm dev:miniapp  # http://localhost:5173
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
