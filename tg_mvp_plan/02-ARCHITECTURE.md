# Architecture: Telegram-first MVP with Expansion-safe Core

## 1. High-level architecture

```text
Telegram Bot
    ↓
Telegram Mini App
    ↓
Backend API
    ↓
Command Layer
    ↓
Policy Layer
    ↓
Domain Core
    ↓
Postgres + Storage

Scheduler
    ↓
Task Table / Workflow-lite Layer
    ↓
Worker Pool
    ↓
Source Ingestion / Matching / AI Draft / Publish
```

## 2. Non-negotiable architecture rules

### Rule 1. Telegram is an adapter, not the core

Core domain must not contain Telegram-specific assumptions.

Use neutral concepts:
- `content_channel`, not `telegram_channel` as core concept;
- `channel_connection`, not direct bot token logic everywhere;
- `publish_target`, not only Telegram chat;
- `channel_adapter`, not hardcoded Telegram publishing.

### Rule 2. Source fetching is global

Sources are global. Workspaces subscribe to sources.

```text
source -> fetched once -> global_news_item -> matched to many workspaces
```

Do not fetch the same source separately for every user.

### Rule 3. Matching and draft generation are workspace-specific

One news item can be relevant differently to different workspaces.

```text
global_quality_score != workspace_relevance_score
```

### Rule 4. All mutations go through commands

Do not let Mini App or Bot directly update important domain state.

Examples:
- `ConnectTelegramIdentity`
- `CreateWorkspace`
- `ConnectChannel`
- `AddSourceSubscription`
- `CreatePostDraft`
- `RewritePostDraft`
- `PublishPost`

### Rule 5. Policy checks before handlers

Every command must pass policy checks:
- identity;
- workspace membership;
- role;
- object ownership;
- rate limit;
- capability flags.

### Rule 6. OperationLog from MVP

Every command writes operation log entry:
- who;
- workspace;
- command;
- payload summary;
- result;
- error;
- timestamp.

### Rule 7. Draft versioning

Every AI rewrite creates new `post_draft_version`.

Never destructively overwrite draft text without history.

### Rule 8. UI reads projections, not internal chaos

Mini App should read API responses shaped for UI, not raw database internals.

Later this evolves into formal projections:
- RadarProjection;
- DraftEditorProjection;
- ChannelSettingsProjection.

### Rule 9. AI is an adapter

Domain core must not import LLM SDK directly.

All AI work goes through `AIProvider` interface (см. `11-AI-PROVIDER.md`):
- score;
- generateDraft;
- rewriteDraft;
- embed.

MVP-провайдер — `YandexAIStudioDeepSeekProvider` + `TemplateProvider` fallback. Замена/добавление провайдеров не меняет call-site.

AI-вызовы происходят только из worker-tasks, не из HTTP-handlers. Все AI-вызовы пишут `ai_usage_events` (model, prompt_version, tokens, cost_rub, status).

### Rule 10. Commands are idempotent where it matters

Commands, которые мутируют внешний мир или критически дороги, должны принимать `idempotency_key`:
- `PublishPostCommand`;
- `GenerateDraftCommand`;
- `RewriteDraftCommand`;
- `CreateConnectCodeCommand`.

Backend хранит результат в `command_idempotency` таблице. Повторный вызов с тем же ключом возвращает кешированный результат, не выполняет команду повторно.

## 3. Main layers

## 3.1 Telegram Bot Layer

Responsibilities:
- `/start`;
- open Mini App;
- receive Telegram updates;
- send notifications;
- handle basic callback buttons;
- route commands to backend.

Must not:
- decide permissions by itself;
- store business state;
- publish without backend command.

## 3.2 Telegram Mini App Layer

Responsibilities:
- user interface;
- read dashboard data;
- edit drafts;
- show sources/topics;
- trigger commands through backend API.

Must:
- validate Telegram initData with backend;
- never trust client-only user identity.

## 3.3 Backend API Layer

Responsibilities:
- authentication of Telegram WebApp initData;
- command endpoints;
- query endpoints;
- API responses for Mini App;
- adapter orchestration.

## 3.4 Command Layer

Commands represent meaningful user/system actions.

Examples:
- CreateWorkspace
- LinkTelegramIdentity
- ConnectContentChannel
- AddTopicProfile
- AddSource
- SubscribeWorkspaceToSource
- GenerateDraft
- RewriteDraft
- PublishPost

## 3.5 Policy Layer

Centralized checks:
- auth;
- workspace access;
- role permissions;
- channel ownership;
- rate limits;
- usage limits;
- feature/capability checks.

## 3.6 Domain Core

Pure business concepts:
- workspace;
- source;
- global_news_item;
- workspace_news_match;
- content_channel;
- post_draft;
- publish_event.

No Telegram API calls here.

## 3.7 Channel Adapter Layer

Adapter interface:

```text
ChannelAdapter:
- verifyConnection()
- getChannelInfo()
- publishPost()
- editPost() optional
- deletePost() optional
- handleIncomingEvent()
```

MVP implements:
- TelegramChannelAdapter.

Future:
- VKAdapter;
- DiscordAdapter;
- SlackAdapter;
- WebDashboardAdapter.

## 3.8 Scheduler + Worker Layer

Responsibilities:
- schedule source fetch tasks;
- run global ingestion;
- dedupe (URL canonicalization + embedding cosine);
- match to workspaces;
- score;
- generate drafts;
- process rewrites;
- publish tasks if needed;
- task janitor (reset stale `running` tasks, release expired locks);
- IAM-token refresh для AI provider.

## 3.9 AI Provider Layer

Единая точка интеграции с LLM и embeddings.

Имплементирует `AIProvider` (см. `11-AI-PROVIDER.md`):
- `YandexAIStudioDeepSeekProvider` — LLM (DeepSeek 3.2) + embeddings (YandexGPT Embeddings, dim=256);
- `TemplateProvider` — no-AI fallback (Format A draft, score=5).

Обязанности:
- никогда не вызываться из API handlers — только из worker-tasks;
- логировать каждый вызов в `ai_usage_events` (model, prompt_version, tokens, cost_rub, status, duration);
- уважать cost guard (`ai_budget_state` per workspace per day) перед каждым generative-вызовом;
- валидировать output через zod-схему; на parse error — repair-attempt → fallback;
- маршрутизировать ru/en промпты в зависимости от `topic_profile.language` и `global_news_items.language`.

## 4. Recommended tech stack

MVP practical stack:

- Frontend Mini App: React + TypeScript + Vite or Next.js
- Bot/backend: Node.js + TypeScript
- Backend framework: Fastify / NestJS / Hono / Express; choose one and keep boundaries clean
- DB: Postgres
- ORM/query: Prisma or Drizzle
- Worker: Node.js worker process using Postgres-backed tasks
- Hosting: Render/Fly.io/Railway/VPS/Cloudflare/Vercel depending on preference

Important: stack is less important than boundaries.

## 5. Deployment shape MVP

```text
app-service:
- backend API
- Telegram webhook endpoint
- Mini App static build or served separately

worker-service:
- same codebase
- runs task polling
- N worker concurrency

postgres:
- main data store
```

## 6. Repository structure suggestion

```text
/apps
  /api
  /miniapp
  /worker

/packages
  /domain
  /commands
  /policies
  /db
  /channel-adapters
  /ai
  /sources
  /shared

/docs
  MAIN-PLAN.md
  MVP-SPEC.md
```

## 7. Scaling path

### MVP
- Postgres-backed task table;
- 5–10 workers;
- Telegram adapter only.

### After traction
- split workers by task type;
- add real queue if needed;
- add metrics and dashboards;
- add billing and quotas.

### Later
- add other channel adapters;
- web dashboard;
- research agent;
- paid workspace capabilities.
