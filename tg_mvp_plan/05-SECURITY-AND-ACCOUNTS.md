# Security and Accounts Plan

## 1. Security principle

Telegram is not trusted by itself.

Any action from Bot or Mini App must be checked by backend:
- who is the user;
- what workspace they belong to;
- what role they have;
- whether the object belongs to this workspace;
- whether the channel belongs to this workspace;
- whether the action is allowed.

## 2. Identity model

Telegram identity is linked to internal user.

```text
telegram_user_id -> telegram_identity -> user -> workspace_member -> workspace
```

Mini App must send Telegram WebApp initData to backend. Backend verifies signature using bot token.

Never trust only data from frontend.

### 2.1 initData verification rules

- HMAC-signature от bot token — обязательная проверка.
- `auth_date` должен быть `< 24h` от текущего времени; иначе 401 + UX "переоткрой бота".
- Telegram username/first_name/last_name обновляются на каждом auth-вызове.
- Если bot был заблокирован user'ом — `telegram_identities.status='blocked_bot'`, notification path отключается, Mini App доступ остаётся (initData приходит из WebApp, не зависит от send-permission бота).
- Backend session token (если выдаётся) — короткоживущий, привязан к `user_id + telegram_user_id`, проверяется на каждом запросе.

## 3. Workspace model

Workspace is the security boundary.

All important objects must have `workspace_id` or be connected to workspace through a clear relation:
- content_channel;
- topic_profile;
- workspace_source_subscription;
- workspace_news_match;
- post_draft;
- publish_event.

Global sources and global news are shared, but workspace matches/drafts are private.

## 4. Roles

MVP can implement owner-only, but schema should support:

```text
owner
admin
editor
viewer
```

Suggested permissions:

### owner
- manage workspace;
- connect/disconnect channels;
- manage sources;
- publish;
- invite members later.

### admin
- manage sources;
- publish;
- manage settings.

### editor
- edit drafts;
- create drafts;
- maybe publish if enabled.

### viewer
- read only.

## 5. Channel connection security

Do not auto-connect a channel just because bot was added.

Safe flow:

1. User opens Mini App.
2. User clicks “Create connect code”.
3. Backend creates short-lived connect code for workspace.
4. User adds bot as admin to Telegram channel.
5. User sends code to bot or enters code in Mini App.
6. Backend verifies:
   - code exists;
   - code not expired;
   - code belongs to user workspace;
   - user has owner/admin permission;
   - bot can access channel;
   - bot has publish permission.
7. Backend creates `content_channel` + `channel_connection`.

Connect code should expire quickly, e.g. 10–30 minutes.

## 6. Publish security

Publishing must happen only through backend command:

```text
PublishPostCommand
```

Checks:
- user exists;
- user is member of workspace;
- role allows publish;
- draft belongs to workspace;
- channel belongs to workspace;
- draft is not already published;
- selected version belongs to draft;
- bot has admin rights;
- workspace is within limits;
- content passes basic safety checks.

Only then call Telegram adapter.

## 7. Callback security

If using bot inline buttons, never rely only on callback data like:

```text
approve_post_123
```

Every callback must be resolved through backend:
- callback user identity;
- workspace;
- object ownership;
- role;
- status.

Signed callback tokens can be used, but DB checks are still required.

## 8. Mini App API security

All Mini App API requests must include Telegram initData or an issued session token.

Backend should:
- verify initData on session creation;
- issue short-lived backend session token if desired;
- bind session to user_id and telegram_user_id;
- check workspace on every request.

## 9. OperationLog

Every important action writes to operation_log:
- CreateWorkspace;
- LinkTelegramIdentity;
- CreateConnectCode;
- ConnectChannel;
- AddSource;
- UpdateTopics;
- GenerateDraft;
- RewriteDraft;
- PublishPost;
- RejectDraft.

This helps:
- debugging;
- security investigation;
- future audit UI;
- agent reasoning later.

## 10. Rate limits and abuse prevention

MVP should have basic limits:
- max sources per workspace;
- max manual fetches per hour;
- max AI drafts per day (через cost guard в `11-AI-PROVIDER.md`);
- max rewrites per draft;
- max publish attempts per minute;
- bot message rate-limit per telegram_user_id: 10 msg/min (защита от `/start` flood).

Even if billing is not implemented, limits protect costs.

### 10.1 Bot rate-limit implementation

Middleware в bot-handler, до любой обработки:
- хранение в Postgres (`bot_rate_limit_state(telegram_user_id, window_start, count)`) либо in-memory с TTL;
- при превышении — silently drop (не отвечать, не логировать спам).

### 10.2 Idempotency для критичных commands

Команды, которые мутируют внешний мир или критически дороги, принимают `idempotency_key: uuid` от клиента:
- `PublishPostCommand`;
- `GenerateDraftCommand`;
- `RewriteDraftCommand`;
- `CreateConnectCodeCommand`.

Backend хранит результат в `command_idempotency`. Повторный вызов с тем же ключом возвращает кешированный результат (TTL 24h).

Защищает от:
- double-click пользователя;
- worker retry после network-hiccup;
- mobile flaky-сети, повторяющей запрос.

## 11. Data isolation tests

Required tests:
- user cannot read another workspace drafts;
- user cannot publish another workspace draft;
- user cannot connect channel to another workspace;
- user cannot use expired connect code;
- editor cannot change settings if not allowed;
- rejected/published draft cannot be published twice unless specifically allowed;
- `PublishPostCommand` фейлится, если `draft.workspace_id != channel.workspace_id` (cross-workspace integrity invariant);
- `PublishPostCommand` с тем же `idempotency_key` второй раз возвращает кешированный результат, не публикует повторно;
- expired initData отвергается с 401;
- replay initData со старым `auth_date` отвергается;
- bot заблокирован user'ом — notification path помечает `blocked`, не пытается retry.

### 11.1 Re-checks при publish

Publish — самая критичная операция. На момент execute (а не только на момент schedule) проверяется:

- user всё ещё member workspace;
- role позволяет publish;
- draft.workspace_id == channel.workspace_id (compound invariant);
- channel.status == 'active';
- bot всё ещё admin в канале и имеет `can_post_messages=true`;
- draft.status in ('ready', 'draft') (не 'published', не 'rejected');
- selected version belongs to draft;
- AI cost guard не блокирует (если publish зависит от rewrite-вызова);
- idempotency_key не использовался для других каналов.

## 12. AI safety rules MVP

- Always keep source URL.
- Avoid unsupported claims.
- Do not fabricate facts.
- Do not copy long source text verbatim.
- No auto-publish in MVP.
- For high-risk topics, show warning or block by default later.

## 13. Secrets

Store secrets only in environment variables or secure secret storage:
- Telegram bot token;
- AI API keys;
- DB connection;
- payment keys later.

Never expose bot token to Mini App.
