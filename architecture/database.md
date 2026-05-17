# Database (Postgres provider policy)

## Purpose
Single source of truth for "where does our Postgres live". One provider across all environments to eliminate drift between local dev, phase validation, staging, and production.

## Decision

**Neon Postgres everywhere.** Local dev, phase validation, staging, production — all run against Neon.

No Docker Postgres, no Supabase, no Railway/Render-managed Postgres in this project. Anyone setting up a new env or validating a phase points `DATABASE_URL` at Neon (their own branch).

## Why Neon (vs alternatives)

| Criterion | Neon | Docker local | Supabase / Render / Railway |
|---|---|---|---|
| `pgvector` works out of the box | yes (free tier, enabled via Console → Extensions) | yes via `pgvector/pgvector` image | mixed (Supabase: UI toggle; RDS: needs param group; Render: yes) |
| DB branching matches our `phase/N-*` Git branches | yes (free-tier branches map 1:1) | no | no |
| Cold start tax | ~5–15s on free tier idle | none | varies |
| Cost at MVP scale | free | free but eats laptop RAM | varies; some need paid plan for pgvector |
| Multi-machine consistency | one DB, all team members see same state | each laptop has its own data | one DB |
| Migration runner compatibility | yes (direct connection string) | yes | yes |
| Setup steps for a new contributor | 1 (paste connection string) | 4 (install Docker, run compose, wait, run migrate) | varies |

The DB-branching argument is the decisive one: our cumulative `phase/N-*` Git branches need matching data isolation. Neon branches do this in one click; Docker requires a fresh volume per branch.

## Concrete rules

### 1. Every developer + CI environment uses a Neon DB
- Personal Neon account is fine; share a project at the team level for shared state (preview / staging).
- Free tier is enough for MVP.

### 2. DATABASE_URL is always a Neon connection string
- Direct connection (NOT pooled) for: migrations, local dev, tests.
- Pooled connection only when the app has a documented reason to use it (Phase 8+ if we add a high-RPS hot path). Today there is none — direct everywhere.
- Always include `?sslmode=require`.

### 3. One Neon branch per active Git phase branch
- Neon project main branch ↔ Git `main`.
- Working on `phase/N-<slug>`? Create Neon branch `phase-N-<slug>` from main, use its connection string.
- Closing a phase: merge data shape forward by re-running migrations on main Neon branch from the next phase's Git branch. Don't try to delete a branch's data history — branches are cheap, just stop using old ones.
- Discarding an exploration: delete the Neon branch.

### 4. pgvector
- Enable once per Neon project (Console → Extensions → `vector` → Enable). Idempotent — safe to click again.
- Migration `0000_init.sql` runs `CREATE EXTENSION IF NOT EXISTS vector` — needs role permission to succeed. Neon's default role has it.

### 5. Cold start expectation
- First request after ~5 min idle wakes the compute (~5–15s). Apps must tolerate this.
- `packages/db/src/migrate.ts` has `waitForDb` retry built in (3 attempts, 5/10/15s backoff = 30s total).
- `/ready` endpoint may legitimately return 503 once during cold start; treat as transient, retry.
- For test suites that hammer the DB, expect the first test to be slow.

### 6. No Docker Postgres in this repo
- Don't add `docker compose up -d postgres` instructions.
- If `docker-compose.yml` exists from earlier Phase 0 scaffolding, treat it as deprecated — kept for reference, not for use.
- Do not introduce a "use Docker for local, Neon for shared" split. That's exactly the drift this doc exists to prevent.

## Operational consequences

- **Tests that need DB** run against Neon. For live phase validation set `RUN_DB_TESTS=1` plus `TEST_DATABASE_URL` or `DATABASE_URL`; for offline/pure checks set `SKIP_DB_TESTS=1`. Per-test schema isolation (`_db-helpers.ts`) prevents cross-test pollution but eats Neon connection slots. On free tier (10 max connections) run test suites sequentially:
  ```bash
  pnpm --filter @postdash/commands test --pool=forks --poolOptions.forks.singleFork
  pnpm --filter @postdash/api test --pool=forks --poolOptions.forks.singleFork
  ```
- **CI** uses its own Neon branch (or a disposable one created at job start). Never points at main.
- **Phase validation** (step-perfect-loop) runs against a Neon branch matching the Git phase branch. Phase 2 validation = `phase-2-channel-connection` Neon branch.

## What to fix if you see drift

If you find an instruction or .env example pointing at `localhost:5432`, `docker compose`, Supabase, or any non-Neon provider — fix it to reference Neon. This doc is the canonical reference; link to it (`architecture/database.md`) in PR descriptions and code comments.

## Files
- `.env.example` — DATABASE_URL placeholder with Neon-shaped comment.
- `packages/db/drizzle.config.ts` — reads DATABASE_URL.
- `packages/db/src/pool.ts` — `createPool(DATABASE_URL)` via postgres-js.
- `packages/db/src/migrate.ts` — runner with cold-start retry.
- `packages/db/migrations/*.sql` — schema. `0000_init.sql` includes `CREATE EXTENSION vector`.
- `README.md` — quick start references this doc.

## Status
Active. Authoritative since 2026-05-16.

## Last touched
2026-05-16
