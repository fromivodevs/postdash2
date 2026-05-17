# Architecture

> Оркестратор архитектурных файлов. Каждая система — свой файл
> в `architecture/`. Этот файл — индекс и инструкция как добавлять.

## How to add a new system

1. Скопируй `architecture/_TEMPLATE.md` в `architecture/<system-name>.md`
2. Заполни секции (Purpose, Main state, How it works, Files, Interfaces,
   How to extend, Status, Last touched)
3. Добавь строку ниже в "Active systems"
4. Зафиксируй ссылку из PROJECT_MAP.md (или вызови roadmap-keeper)

## Active systems

- [channel-connection](architecture/channel-connection.md) — Telegram channel binding to workspace (Phase 2): connect codes, bot post-permission verification, deep-link `/start connect_<code>` flow. *Status: Active. Closed: phase-2-perfect.*
- [database](architecture/database.md) — Postgres provider policy: **Neon everywhere**, no Docker / Supabase / RDS. One DB per developer + per phase branch. *Status: Active. Authoritative since 2026-05-16.*
- [topics-and-sources](architecture/topics-and-sources.md) — Phase 3 per-workspace topic profiles + global source registry + per-workspace M:N subscriptions. URL canonicalization + one-time redirect resolution. *Status: Active. Latest closure `phase-3-perfect-r8`.*
- [global-ingestion](architecture/global-ingestion.md) — Phase 4 task queue + source-centric global ingestion + Yandex embeddings + semantic dedup (news_clusters). 6 task handlers (fetch_source / extract / embed / cluster / janitor / refresh_iam_token), in-process scheduler (1/min + 5/min), `packages/tasks` queue primitives, real IAM JWT auth with system_state writethrough, RUNBOOK.md for ops triage. *Status: Active. Latest closure `phase-4-perfect-r4` (fresh step-perfect-loop validation — 8/10 GOOD with UNREACHABLE_10 reason a; 8 deferred items in "Known follow-ups" → Phase 8 hardening).*
- [matching-and-scoring](architecture/matching-and-scoring.md) — Phase 5 per-workspace radar: `workspace_news_matches` table with cluster-level dedup, real `AIProvider.score()` (Yandex DeepSeek 3.2 completion + zod + repair-attempt + TemplateProvider fallback), 3 new task types (`match_news_to_workspaces` / `score_workspace_match` / `recompute_topic_embedding`), composite final score (LLM 50% + cosine 30% + freshness 10% + reliability 10%), `GET /radar` endpoint, Mini App Radar screen with status filter chips. `ai_usage_events` audit table wired (Phase 6 hook for cost guard). *Status: Active. **Latest closure `phase-5-perfect-r4` MIN=10 PERFECT** after roadmap amendment introduced Phase Closure Discipline + Production Readiness Gates + named-phase owners for every Phase 4/5 follow-up (no more vague "Phase 8+ ops" deferrals).*

## Deprecated systems

- (пока пусто)

## Cross-cutting concerns

- Database provider: see [database](architecture/database.md) — Neon Postgres, one branch per Git phase branch.
- Auth: Phase 1 (`packages/commands/src/authenticate-telegram.ts`)
- Logging: pino in apps/api + apps/worker
- Configuration: per-package `env.ts` with zod schemas; friendly ZodError wrapper on boot
