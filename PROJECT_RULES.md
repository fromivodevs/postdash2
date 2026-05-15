# Project Rules

This file is the source of truth for PostDash project-specific rules.

`AGENTS.md` and `CLAUDE.md` are runtime shims. They may explain how Codex or
Claude should read these rules, but durable project policy belongs here.
Portable kit files must stay project-agnostic.

## Rule Placement

- Put PostDash-specific rules in `PROJECT_RULES.md`.
- Keep portable kit rules generic. Do not put `PostDash`, Neon branch names,
  phase branch names, product architecture, or deployment choices into kit
  templates, kit skills, kit agents, or kit hooks.
- If a rule applies to any project, it may go into kit. If it names this
  product, this repo, this database provider choice, or this roadmap, keep it
  here.
- When changing a project rule, update `PROJECT_MAP.md` recent changes if the
  change affects agent workflow, phase validation, startup, or release flow.

## Startup Entry

This project must stay runnable from one canonical start entrypoint.

- Developer startup goes through `start.bat` on Windows and `start.sh` on
  Unix-like shells.
- The start entrypoint must apply required setup steps, run idempotent DB
  migrations, and start all required dev services for the current phase.
- If a phase adds a required service, env requirement, migration step, or
  runtime prerequisite, update the canonical start entrypoints in the same
  change.
- README may document advanced manual commands, but those commands must not
  become the only working path.
- Do not add a new parallel startup script or hidden command path unless it
  delegates to, or clearly replaces, the canonical entrypoint and updates these
  rules and docs.

## Stage Closure

When a phase or major roadmap step is completed and the agent sends a
closure/status response, explicitly suggest `/clear` or restarting the session
before the next phase. This keeps the next phase from inheriting stale
assumptions, old diffs, or completed-step context.

When closing a phase, include a short next-session handoff:

- current branch and commit/tag;
- what was completed;
- checks that passed and checks that were not run;
- dirty files or uncommitted work, if any;
- the next planned phase/task;
- the first command the next session should run.

## Phase Branches

Phase work must be recoverable by branch and reviewable by phase-only diff.

- Keep one cumulative branch per phase: `phase/0-foundation`,
  `phase/1-identity`, `phase/2-channel-connection`, etc.
- `phase/0-*` contains only Phase 0. `phase/1-*` contains Phase 0 plus Phase 1.
  `phase/N-*` contains all phases `0..N`, and nothing from later phases.
- Keep `phase/base` as the baseline before Phase 0 implementation when
  available. If the old baseline is missing, document the inferred base commit
  in the loop report.
- Phase boundaries are defined by branch diffs, not by the dirty working tree:
  - Phase 0 diff: `phase/base..phase/0-foundation`
  - Phase N diff: `phase/(N-1)-<slug>..phase/N-<slug>`
- Every phase commit subject must start with `[phase N]`, `[phase N fix]`,
  `[phase N loop]`, `[phase N docs]`, or `[phase N kit]`.
- Add immutable closure tags after successful validation: `phase-N-start` at
  the previous phase branch head, and `phase-N-perfect` at the validated phase
  branch head. If a later fix changes the branch, add a new tag such as
  `phase-N-perfect-r2`; do not move old tags.
- Run `step-perfect-loop` only after checking out the matching `phase/N-*`
  branch, and use only the phase diff above as the artifact. Do not validate
  Phase N from `main` if `main` already contains later phases.
- If Phase K needs a fix after later phases exist, apply and commit it first on
  `phase/K-*`, then propagate the same logical fix forward into every branch
  that includes it: `phase/(K+1)-*`, `phase/(K+2)-*`, current phase branch, and
  then `main`. Do not propagate fixes backward into earlier branches that
  should not contain that phase.
- After propagating a fix, rerun the relevant `step-perfect-loop` on
  `phase/K-*`. For later branches, rerun checks only when the propagation caused
  conflicts or changed their phase-only diff.

## Phase Readiness

Before starting Phase N, verify:

- the previous phase has a `phase-(N-1)-perfect` tag;
- `phase-N-start` points at the previous phase branch head;
- the current branch is `phase/N-<slug>`;
- the worktree is clean or dirty files are intentionally part of the new phase;
- the Neon branch/database for the phase exists when remote DB checks are
  needed;
- `lint`, `typecheck`, `test`, `build`, and bundle checks are green or the
  skipped checks are explicitly documented.

## Commit Split

Keep commit boundaries readable for agents and humans:

- `[phase N]` product code;
- `[phase N fix]` targeted fixes before closure;
- `[phase N docs]` README, roadmap, architecture, and rule updates;
- `[phase N kit]` portable kit changes;
- `[phase N loop]` changes made during a perfect/step-perfect loop.

Do not mix product behavior, kit changes, and rule changes in one commit unless
the change is genuinely inseparable.

## Database Provider

The app runtime database is always Postgres-compatible. Do not replace it with
SQLite, in-memory storage, a document DB, or a vector-only database for product
code.

- Local development and phase validation default to ordinary local Postgres via
  `docker compose up -d postgres` (`pgvector/pgvector:pg16`).
- Shared preview, staging, and production default to Neon Postgres. Neon is the
  preferred remote provider because it is managed Postgres, supports pgvector,
  and has database branching that can mirror Git phase or preview branches.
- Phase branches must not share one persistent remote database by accident. If
  a `phase/N-*` branch needs remote testing, use a matching Neon branch/database
  or an explicitly disposable database.
- Neon branch names should mirror Git branch intent, for example
  `phase-1-identity` and `phase-2-channel-connection`.
- Never run migrations from different phases against the same long-lived remote
  DB unless the intent is to upgrade that DB forward.
- `DATABASE_URL` is environment-specific secret config. Do not commit real cloud
  credentials. `.env.example` may contain only local defaults or placeholders.
- Use `pnpm db:migrate` as the schema source of truth. For Neon, use a direct
  connection string for migrations unless the codebase later introduces a
  separate `DATABASE_POOL_URL` for runtime pooling.
- Supabase is acceptable when we intentionally want its Auth, Storage, Realtime,
  or dashboard workflows. Render/Railway are acceptable for simple app-hosted
  deployments. Native Postgres on Windows is allowed but not the default because
  pgvector setup is more fragile than Docker.
- DB integration tests that need a live database must be opt-in with
  `RUN_DB_TESTS=1` and must document which `DATABASE_URL` they target.

## Validation Evidence

Final status reports must distinguish automated checks from live/manual checks.

- If Telegram, Neon, webhook, Mini App, or bot behavior was not tested live,
  say so explicitly.
- If a check was skipped because credentials, tunnel, or external service access
  was missing, report that as a residual validation gap.
- Do not claim a phase is fully live-tested when only unit/build checks ran.

## Project Context

PostDash / Content Radar is a Telegram-first MVP AI radar for content ideas.

- Full plan: `tg_mvp_plan/` (`tg_mvp_plan/README.md` is the entrypoint).
- Architecture rules: `tg_mvp_plan/02-ARCHITECTURE.md` and
  `tg_mvp_plan/09-CODEX-CLAUDE-INSTRUCTIONS.md`.
- Roadmap: `tg_mvp_plan/08-IMPLEMENTATION-ROADMAP.md`.
- Telegram is an adapter, not the core. Core: `content_channel`, `workspace`,
  `source`, `news_item`, `post_draft`, `publish_target`.
- Source-centric ingestion: fetch once globally; matching, scoring, and drafts
  are per workspace.
- All mutations go through command layer plus policy checks. AI rewrite creates
  a new draft version. OperationLog is mandatory.
