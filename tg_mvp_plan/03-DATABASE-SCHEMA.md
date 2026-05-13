# Database Schema Plan

This is a conceptual schema. Implementation can use Prisma/Drizzle migrations.

Notation: `pk` — primary key, `fk` — foreign key, `unique(...)` — unique constraint, `partial unique` — partial unique index, `nullable` отмечено явно.

Postgres extensions:
- `pgvector` для embedding-колонок (Phase 4);
- `uuid-ossp` (или `gen_random_uuid()` в Postgres 13+).

## 1. Identity and workspace

### users

```text
id uuid pk
created_at timestamptz
updated_at timestamptz
status text -- active/disabled
primary_telegram_identity_id uuid nullable
last_active_workspace_id uuid nullable fk workspaces.id
```

### telegram_identities

```text
id uuid pk
user_id uuid fk users.id
telegram_user_id bigint unique
username text nullable
first_name text nullable
last_name text nullable
photo_url text nullable
linked_at timestamptz
status text -- active / blocked_bot / revoked
last_seen_at timestamptz nullable
```

### workspaces

```text
id uuid pk
name text
created_by_user_id uuid fk users.id
created_at timestamptz
updated_at timestamptz
status text -- active / disabled
```

### workspace_members

```text
id uuid pk
workspace_id uuid fk workspaces.id
user_id uuid fk users.id
role text -- owner / admin / editor / viewer
created_at timestamptz
status text -- active / removed
unique(workspace_id, user_id)
```

## 2. Channels and adapters

### content_channels

Core channel entity, not Telegram-specific.

```text
id uuid pk
workspace_id uuid fk workspaces.id
platform text -- telegram now, later vk/discord/etc
name text
status text -- pending / connected / disabled / error
created_at timestamptz
updated_at timestamptz
```

### channel_connections

Platform-specific connection data.

```text
id uuid pk
content_channel_id uuid fk content_channels.id
platform text
external_id text -- telegram chat_id as string
external_title text nullable
credentials_ref text nullable
platform_settings jsonb
verified_at timestamptz nullable
last_verify_status text nullable -- ok / no_post_permission / not_admin / not_found / etc.
status text -- pending / active / revoked / error / broken
unique(platform, external_id)
```

### channel_connect_codes

```text
id uuid pk
workspace_id uuid fk workspaces.id
created_by_user_id uuid fk users.id
code_hash text
expires_at timestamptz
used_at timestamptz nullable
used_by_telegram_user_id bigint nullable
status text -- active / used / expired
created_at timestamptz
```

Index: `(workspace_id, status, expires_at)`.

## 3. Topics and source subscriptions

### topic_profiles

```text
id uuid pk
workspace_id uuid fk workspaces.id
name text
language text -- ru / en
main_topics text[]
keywords text[]
negative_keywords text[]
tone_profile jsonb
embedding vector(256) nullable
embedding_status text default 'pending' -- pending / ok / failed
embedding_updated_at timestamptz nullable
status text
created_at timestamptz
updated_at timestamptz
```

MVP: один default topic_profile per workspace (UI ограничение); schema допускает много.

### sources

Global source table.

```text
id uuid pk
type text -- rss / website / api / manual
url text
canonical_url text unique
name text nullable
fetch_interval_minutes int
max_items_per_fetch int default 50
reliability_score numeric nullable
last_fetched_at timestamptz nullable
last_fetch_status text nullable -- ok / 4xx / 5xx / parse_error / timeout
last_fetch_error text nullable
canonicalization_rule_version text -- bump при изменении правил
status text -- active / disabled / error
created_at timestamptz
updated_at timestamptz
```

### workspace_source_subscriptions

```text
id uuid pk
workspace_id uuid fk workspaces.id
source_id uuid fk sources.id
topic_profile_id uuid fk topic_profiles.id nullable
enabled boolean
priority int default 50
custom_rules jsonb
created_at timestamptz
updated_at timestamptz
unique(workspace_id, source_id, topic_profile_id)
```

## 4. Global news layer

### global_news_items

```text
id uuid pk
source_id uuid fk sources.id
title text
url text
canonical_url text
content_hash text
extracted_text text nullable
summary text nullable
published_at timestamptz nullable
fetched_at timestamptz
language text nullable -- ru / en / other
global_quality_score numeric nullable
embedding vector(256) nullable
embedding_status text default 'pending' -- pending / ok / failed
embedding_updated_at timestamptz nullable
last_updated_in_source_at timestamptz nullable
was_updated boolean default false
status text -- new / extracted / clustered / ignored / ai_refused / error
unique(source_id, canonical_url)
```

Indexes:
- `(status, fetched_at desc)`;
- `(language, published_at desc)`;
- ivfflat / hnsw на `embedding` (Phase 4).

### news_clusters

```text
id uuid pk
canonical_title text
main_url text nullable
first_seen_at timestamptz
last_seen_at timestamptz
sources_count int default 1
cluster_hash text unique
centroid_embedding vector(256) nullable
status text
```

### news_cluster_items

```text
id uuid pk
cluster_id uuid fk news_clusters.id
news_item_id uuid fk global_news_items.id
created_at timestamptz
unique(cluster_id, news_item_id)
```

## 5. Workspace matching

### workspace_news_matches

```text
id uuid pk
workspace_id uuid fk workspaces.id
topic_profile_id uuid fk topic_profiles.id nullable
news_item_id uuid fk global_news_items.id nullable
cluster_id uuid fk news_clusters.id nullable
score numeric -- clamped 0..10
relevance_reason text
risk_flags text[]
status text -- candidate / hidden / filtered_negative / drafted / rejected / published / ai_refused
created_at timestamptz
updated_at timestamptz
```

Уникальность матча — на cluster-level если cluster есть, иначе item-level. Это защищает от дублей в Radar когда одна новость пришла из нескольких источников.

```sql
CREATE UNIQUE INDEX workspace_news_matches_unique_by_cluster
  ON workspace_news_matches (workspace_id, cluster_id)
  WHERE cluster_id IS NOT NULL;

CREATE UNIQUE INDEX workspace_news_matches_unique_by_item
  ON workspace_news_matches (workspace_id, news_item_id)
  WHERE cluster_id IS NULL;
```

Index: `(workspace_id, status, score desc, created_at desc)`.

## 6. Drafts and publishing

### post_drafts

```text
id uuid pk
workspace_id uuid fk workspaces.id
content_channel_id uuid fk content_channels.id nullable
match_id uuid fk workspace_news_matches.id nullable
news_item_id uuid fk global_news_items.id nullable
parent_draft_id uuid nullable fk post_drafts.id -- если редактируем уже published
status text -- draft / editing / rewriting / ready / published / rejected / failed
current_version_id uuid nullable
created_by text -- ai / user / system
created_at timestamptz
updated_at timestamptz
```

### post_draft_versions

```text
id uuid pk
post_draft_id uuid fk post_drafts.id
version_number int
text text
title text nullable
source_links jsonb
created_by_user_id uuid nullable
created_by_task_id uuid nullable
rewrite_instruction text nullable
ai_provider text nullable
ai_model text nullable
prompt_version text nullable
risk_flags text[]
created_at timestamptz
unique(post_draft_id, version_number)
```

### publish_events

```text
id uuid pk
workspace_id uuid fk workspaces.id
content_channel_id uuid fk content_channels.id
post_draft_id uuid fk post_drafts.id
post_draft_version_id uuid fk post_draft_versions.id
platform text
external_message_id text nullable
published_by_user_id uuid fk users.id
idempotency_key text nullable
command_idempotency_id uuid nullable fk command_idempotency.id
status text -- pending / success / failed / unknown
error_message text nullable
created_at timestamptz
finalized_at timestamptz nullable
```

Constraints:
- partial unique: `(post_draft_id) WHERE status='success'` — один draft публикуется один раз;
- index: `(status, created_at)` для janitor'а pending-events.

### command_idempotency

```text
id uuid pk
workspace_id uuid fk workspaces.id
user_id uuid fk users.id nullable
command_type text -- PublishPost / GenerateDraft / RewriteDraft / CreateConnectCode / ...
idempotency_key text
result_object_type text nullable -- e.g., 'publish_event', 'post_draft_version'
result_object_id uuid nullable
status text -- pending / success / failed
error_message text nullable
created_at timestamptz
expires_at timestamptz -- TTL e.g., 24h
unique(workspace_id, command_type, idempotency_key)
```

## 7. Task system

### tasks

```text
id uuid pk
type text
priority int
status text -- pending / running / completed / failed / failed_permanent / cancelled / deferred / skipped_volume_cap
payload jsonb
workspace_id uuid nullable
source_id uuid nullable
locked_by text nullable
locked_until timestamptz nullable
attempts int default 0
max_attempts int default 3
scheduled_at timestamptz
started_at timestamptz nullable
completed_at timestamptz nullable
last_error text nullable
created_at timestamptz
updated_at timestamptz
```

Indexes:
- `(status, scheduled_at, priority desc)`;
- `(source_id, status)`;
- `(workspace_id, status)`;
- partial unique `(source_id) WHERE type='fetch_source' AND status IN ('pending','running')` — защита от duplicate fetch tasks.

### task_runs

```text
id uuid pk
task_id uuid fk tasks.id
worker_id text
started_at timestamptz
finished_at timestamptz nullable
status text
error_message text nullable
```

### source_fetch_locks

Optional если не использовать `tasks` lock для source. Можно реализовать через tasks-table only.

```text
source_id uuid pk
locked_by text
locked_until timestamptz
updated_at timestamptz
```

## 8. Operation log and events

### operation_log

```text
id uuid pk
workspace_id uuid nullable
user_id uuid nullable
telegram_user_id bigint nullable
command_type text
object_type text nullable
object_id uuid nullable
payload_summary jsonb -- без PII, без секретов, без полного output AI
result text -- success / failure
error_message text nullable
correlation_id text nullable
idempotency_key text nullable
created_at timestamptz
```

Index: `(workspace_id, created_at desc)`, `(correlation_id)`, `(command_type, created_at desc)`.

### domain_events

```text
id uuid pk
workspace_id uuid nullable
event_type text
aggregate_type text
aggregate_id uuid nullable
payload jsonb
created_at timestamptz
processed_at timestamptz nullable
```

## 9. AI usage and budgets

### ai_usage_events

```text
id uuid pk
workspace_id uuid
user_id uuid nullable
task_id uuid nullable
action_type text -- score / generate / rewrite / embed
model text nullable
prompt_version text nullable
input_tokens int nullable
output_tokens int nullable
cost_rub numeric nullable
duration_ms int nullable
status text -- success / failed / refused / parse_error / fallback
error_message text nullable
payload_summary jsonb -- без полного контента; счётчики, флаги, длина
created_at timestamptz
```

Index: `(workspace_id, created_at desc)`, `(action_type, created_at desc)`.

### ai_budget_state

Per-day rollup для cost guard.

```text
id uuid pk
workspace_id uuid fk workspaces.id
day date -- UTC day
spent_rub numeric default 0
calls_count int default 0
last_updated_at timestamptz
unique(workspace_id, day)
```

Атомарное обновление:
```sql
UPDATE ai_budget_state
SET spent_rub = spent_rub + $1,
    calls_count = calls_count + 1,
    last_updated_at = now()
WHERE workspace_id = $2 AND day = $3;
```

## 10. Notifications

### notification_events

```text
id uuid pk
workspace_id uuid fk workspaces.id
user_id uuid fk users.id
telegram_user_id bigint
kind text -- new_high_score / drafts_ready / channel_disconnected / cost_cap_reached
related_object_type text nullable
related_object_id uuid nullable
payload_summary jsonb
status text -- pending / delivered / blocked / failed
delivered_at timestamptz nullable
error_message text nullable
created_at timestamptz
unique(workspace_id, user_id, kind, related_object_id)
```

Защищает от двойной отправки + tracking блокировок.

## 11. System state

### system_state

Key-value для cross-worker shared state (e.g., IAM token).

```text
key text pk
value jsonb
expires_at timestamptz nullable
updated_at timestamptz
```

Не для критичных данных. Для cache'а IAM-токена, последнего scheduler-tick'а и т.п.

## 12. Future billing tables

Не требуется в MVP, но зарезервированы имена:

```text
plans
subscriptions
usage_limits
invoices
payment_events
```

## 13. Critical constraints summary

- `workspace_news_matches` всегда принадлежит одному workspace.
- `post_drafts` всегда принадлежит одному workspace.
- Publishing проверяет `draft.workspace_id == channel.workspace_id` (integration test обязателен).
- Source — global; source subscription — workspace-specific.
- Никогда не хранить Telegram bot token per workspace в MVP.
- Если в будущем добавятся white-label bots — хранить через `channel_connections.credentials_ref` в secret-store.
- `publish_events` имеет partial unique на `(post_draft_id) WHERE status='success'`.
- `tasks` имеет partial unique `(source_id) WHERE type='fetch_source' AND status IN ('pending','running')`.
- `channel_connections` имеет unique `(platform, external_id)`.
- `command_idempotency` имеет unique `(workspace_id, command_type, idempotency_key)`.
- `notification_events` имеет unique `(workspace_id, user_id, kind, related_object_id)`.

## 14. Indexes summary (MVP critical)

- `tasks (status, scheduled_at, priority desc)` — worker polling.
- `tasks (locked_until) WHERE status='running'` — janitor.
- `global_news_items` ivfflat / hnsw на `embedding` — semantic dedup и matching.
- `workspace_news_matches (workspace_id, status, score desc, created_at desc)` — Radar query.
- `operation_log (workspace_id, created_at desc)` — audit query.
- `ai_usage_events (workspace_id, created_at desc)` — cost dashboard.
