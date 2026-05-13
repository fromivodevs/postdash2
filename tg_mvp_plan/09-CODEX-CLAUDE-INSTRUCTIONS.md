# Instructions for Codex / Claude Code

You are implementing a Telegram-first MVP for an AI Content Radar.

## Core product

A user connects a Telegram channel, configures topics and sources, receives scored news candidates, generates AI post drafts, edits them in Telegram Mini App, and publishes to their channel.

## Non-negotiable architecture rules

1. Do not hardcode Telegram into core domain.
2. Use `content_channel` and channel adapters.
3. Telegram adapter is the only place that calls Telegram Bot API for publishing.
4. Sources are global; workspace subscriptions are per workspace.
5. Fetch sources once globally; match news per workspace.
6. All mutations go through command handlers.
7. All commands must pass policy checks.
8. Every important command writes OperationLog.
9. Every AI rewrite creates a new draft version.
10. Do not store the whole project/workspace as one giant JSON blob.
11. Do not let UI publish directly.
12. Do not trust Telegram initData on frontend only; backend verifies it (включая `auth_date` freshness < 24h).
13. Prioritize clean boundaries over minimum amount of code.
14. **AI is an adapter** (Rule 9 в `02-ARCHITECTURE.md`): domain core не импортирует LLM SDK напрямую. Все AI-вызовы через `AIProvider` interface из `11-AI-PROVIDER.md`. AI-вызовы происходят только из worker tasks, не из HTTP handlers.
15. **Critical commands are idempotent** (Rule 10): `PublishPost`, `GenerateDraft`, `RewriteDraft`, `CreateConnectCode` принимают `idempotency_key` и хранят результат в `command_idempotency`.
16. **Cost guard с MVP**: каждый generative AI-вызов проходит через `ai_budget_state` per workspace per day.
17. **Edge cases catalog**: перед каждым phase commit'ом проверять покрытие из `12-EDGE-CASES.md §15`.

## Implementation style

Prefer clear modules:
- `packages/domain` — pure business types, no I/O;
- `packages/commands` — command handlers с idempotency support;
- `packages/policies` — policy checks (auth, role, workspace, integrity invariants);
- `packages/db` — schema + migrations + repo;
- `packages/channel-adapters` — Telegram (later VK/Discord);
- `packages/sources` — RSS fetchers, URL canonicalization, parsing;
- `packages/ai` — AIProvider interface + Yandex/template impls + prompts + cost guard;
- `packages/shared` — telegram-format parser (общий с Mini App!), zod schemas;
- `apps/api` — HTTP endpoints;
- `apps/worker` — task polling + scheduler + janitor;
- `apps/miniapp` — React UI.

Do not place all logic in one API route.

Common-code rule: telegram-format parser должен быть в `packages/shared` чтобы Mini App preview и backend publish использовали один код.

## Data safety

Every query for workspace data must check workspace scope.

Publishing must verify:
- user role;
- draft workspace;
- channel workspace;
- draft status;
- channel active;
- bot permissions.

## Worker safety

Workers must:
- lock tasks before running через `FOR UPDATE SKIP LOCKED`;
- avoid concurrent fetch for same source (partial unique index);
- retry failures с exponential backoff (transient errors) и mark `failed_permanent` для 4xx/validation;
- update task status;
- not write UI-only state directly;
- respect cost guard (`ai_budget_state`) перед каждым generative AI-вызовом;
- janitor cron каждые 5 мин: освобождать stuck `running` (locked_until < now), finalize stuck `pending` publishes (>5min → 'unknown'), promote `deferred` на 00:00 UTC;
- refresh IAM-token каждые 10h (живёт 12h).

## AI safety

AI outputs:
- сохраняются как `post_draft_versions` с `prompt_version`, `ai_provider`, `ai_model`;
- никогда не публикуются автоматически (требует `PublishPostCommand` с user confirmation);
- всегда содержат хотя бы один source URL в `source_links` (иначе fallback на TemplateProvider);
- валидируются через zod-schema; на parse error — repair-attempt → TemplateProvider;
- если LLM refused — `risk_flags=['refused']`, score=null, `status='ai_refused'`;
- `risk_flags` всегда surface в UI badge'ом.

См. `11-AI-PROVIDER.md` для полного contract.

Cost guard:
- перед каждым generative-вызовом — check `ai_budget_state(workspace_id, today_utc).spent_rub + estimated_cost > AI_DAILY_CAP_RUB_PER_WORKSPACE`;
- если да — task `deferred`, surface UI;
- embeddings НЕ в cap (дёшевы).

## Phase-based development

Implement one phase at a time from `08-IMPLEMENTATION-ROADMAP.md`.

After every phase:
- run tests/lint;
- update docs if needed;
- commit;
- stop and summarize what was done.

Do not jump ahead to future features.

## What not to build in MVP

Do not build:
- autoposting without approval;
- billing;
- VK/Discord;
- parsing Telegram channels;
- complex analytics;
- white-label bots;
- autonomous research agent.

Leave extension points, but do not overbuild.

## Expected output after each phase

For each phase, provide:
- files changed;
- database migrations added;
- endpoints added;
- commands added;
- UI screens added;
- tests added;
- known limitations;
- next phase instructions.
