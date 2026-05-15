# Channel Connection (Phase 2)

## Purpose
Lets a workspace owner/admin bind a Telegram channel (or group) to a workspace so that subsequent phases can publish to it. Implements the connect-code handshake (Mini App generates code; user adds bot to channel; bot or Mini App activates the code) plus bot post-permission verification.

## Boundaries

**In scope:**
- DB schema for `content_channels` (platform-agnostic core entity), `channel_connections` (workspace-binding), `channel_connect_codes` (one-time, TTL-bound codes).
- `CreateConnectCodeCommand` and `ConnectTelegramChannelCommand` (idempotent through `command_idempotency`).
- `TelegramChannelAdapter.verifyConnection` — the ONLY place that calls Telegram Bot API (`getChat` + `getChatMember`).
- Bot `/start connect_<code>` payload handler that activates a code from the bot side.
- HTTP routes: `POST /channels/connect-codes`, `POST /channels/connect`, `GET /channels`.
- Mini App "Канал" screen with 4 states (not_connected / pending / connected / broken).
- Error UX mapping: expired → 410, reused → 409, taken → 409, no-post → 400.
- `operation_log` rows for every mutation.

**Out of scope (deferred):**
- Phase 7: `PublishPostCommand`, `verifyConnection` re-check before publish, `channel_connections.status='broken'` from publish failures, `TelegramChannelAdapter.publishPost`.
- Phase 7+: handling channel deletion / bot demoted after connection (edge cases 3.2, 3.7).
- Phase 8+: `migrate_from_chat_id` (edge case 3.6) — manual reconnect documented as the Phase 2 workaround.
- Phase 9+: multi-channel per workspace UX (schema supports it; UI shows one).
- VK / Discord / other adapters (schema is platform-keyed; only `platform='telegram'` accepted in Phase 2).
- Periodic background re-verification (Phase 8 health).

## Main state

Three new Postgres tables (see Schema design below):
- `content_channels` — global, platform-keyed `(platform, external_id)`. One row per real Telegram chat.
- `channel_connections` — workspace-binding. One row per `(workspace_id, content_channel_id)`. UNIQUE `(content_channel_id)` enforces single-workspace ownership (Phase 9 will relax to per-platform).
- `channel_connect_codes` — short-lived (30 min) one-time tokens. Plaintext code is shown to the user in deep-link form; DB stores `code_hash` only.

Plus:
- New idempotency `command_type` values: `'CreateConnectCode'`, `'ConnectTelegramChannel'`.
- New `operation_log.command_type` values matching the above.

## Module decomposition

Decomposed by business responsibility (not technical layer):

- `packages/db/migrations/0002_phase2.sql` — forward DDL: 3 tables + indexes + checks.
- `packages/db/migrations/0002_phase2.down.sql` — rollback.
- `packages/db/src/schema.ts` — Drizzle table definitions + `$inferSelect/Insert` row types (additions, no rewrites).
- `packages/domain/src/channel.ts` — pure types: `ContentChannel`, `ChannelConnection`, `ChannelConnectCode`, status unions, platform union.
- `packages/domain/src/index.ts` — re-export.
- `packages/commands/src/create-connect-code.ts` — `createConnectCode(db, input)` command.
- `packages/commands/src/connect-telegram-channel.ts` — `connectTelegramChannel(db, adapter, input)` command.
- `packages/commands/src/connect-code-helpers.ts` — code generation + sha256 hashing + redemption SQL.
- `packages/commands/src/policies.ts` — `assertWorkspaceRole(tx, workspaceId, userId, minRole)`; reused later phases.
- `packages/commands/src/index.ts` — re-exports.
- `packages/channel-adapters/src/telegram/types.ts` — `VerifyConnectionInput`, `VerifyConnectionOk`, `VerifyConnectionFail`, discriminated by `ok: true/false`.
- `packages/channel-adapters/src/telegram/errors.ts` — `TelegramAdapterError` (taxonomy: `bot_not_admin`, `missing_post_permission`, `chat_not_found`, `bot_blocked`, `bot_kicked`, `network`, `unauthorized`, `unknown`).
- `packages/channel-adapters/src/telegram/verify-connection.ts` — pure function that calls `getChat` + `getChatMember` (via injected `fetch`-like client) and maps responses.
- `packages/channel-adapters/src/telegram/api-client.ts` — minimal HTTP client (`callBotApi(token, method, params)`); single `fetch` boundary so tests stub one thing.
- `packages/channel-adapters/src/telegram/index.ts` — `createTelegramChannelAdapter({ botToken, botUserId, fetch? })`.
- `packages/channel-adapters/src/index.ts` — barrel; exports adapter factory + types.
- `apps/api/src/routes/channels.ts` — Fastify plugin: 3 routes with policy guard + projections.
- `apps/api/src/routes/channels-projection.ts` — `projectChannel(...)` and `projectConnectCode(...)` wire shapes.
- `apps/api/src/bot/handlers/start-connect.ts` — extracted handler invoked from `bot.ts` when `parseStartPayload()` returns `kind: 'connect'`.
- `apps/api/src/bot/bot.ts` — modified: route `connect` start payloads to `handleStartConnect(...)` instead of just opening Mini App.
- `apps/api/src/app.ts` — register `channelsRoute` and inject `TelegramChannelAdapter`.
- `apps/api/src/app.ts` (deps) — `AppDeps.channelAdapter?: TelegramChannelAdapter`.
- `apps/miniapp/src/screens/ChannelScreen.tsx` — replace Phase 1 placeholder with full state machine.
- `apps/miniapp/src/api/channels.ts` — `postConnectCode`, `postConnect`, `getChannels` client helpers.
- `apps/miniapp/src/api/types.ts` — `ChannelProjection`, `ConnectCodeProjection` additions.
- `apps/miniapp/src/components/CopyButton.tsx` — small utility for "Скопировать deep-link" (uses `navigator.clipboard` with `WebApp.showAlert` fallback).
- `packages/shared/src/channel-projection.ts` — shared wire types (`ChannelProjection`, `ConnectCodeProjection`).
- `packages/shared/src/index.ts` — re-export.

Test files (mirror unit boundaries):
- `packages/commands/src/__tests__/create-connect-code.test.ts`
- `packages/commands/src/__tests__/connect-telegram-channel.test.ts`
- `packages/commands/src/__tests__/connect-code-helpers.test.ts`
- `packages/commands/src/__tests__/policies.test.ts`
- `packages/channel-adapters/src/telegram/__tests__/verify-connection.test.ts`
- `packages/channel-adapters/src/telegram/__tests__/api-client.test.ts`
- `apps/api/src/__tests__/routes-channels.test.ts`
- `apps/api/src/bot/__tests__/start-connect.test.ts`
- `apps/miniapp/src/api/__tests__/channels.test.ts`
- `apps/miniapp/src/screens/__tests__/ChannelScreen.test.tsx`

## Schema design

### `content_channels` (global, platform-keyed)

```sql
CREATE TABLE IF NOT EXISTS content_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL,                 -- 'telegram' in Phase 2; future: 'vk', 'discord', ...
  external_id text NOT NULL,              -- Telegram chat_id as STRING (chat_id is int64; we store text for
                                          -- platform-uniform key + future external IDs that are non-numeric)
  type text NOT NULL,                     -- 'channel' / 'supergroup' / 'group' / 'private_chat' (mirrors Telegram's chat.type)
  title text NOT NULL,                    -- last-seen title; refreshed on verifyConnection
  username text,                          -- @public_username, nullable for private channels
  photo_url text,                         -- Telegram chat photo (small), best-effort
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_channels_platform_check CHECK (platform IN ('telegram')),
  CONSTRAINT content_channels_type_check
    CHECK (type IN ('channel', 'supergroup', 'group', 'private_chat')),
  CONSTRAINT content_channels_platform_external_unique UNIQUE (platform, external_id)
);
CREATE INDEX IF NOT EXISTS content_channels_platform_idx ON content_channels (platform);
```

**Justifications:**
- `external_id text` (not bigint): Telegram chat IDs are int64 (negative for channels) — Postgres `bigint` would fit, but choosing `text` keeps the column shape uniform across future platforms whose IDs are alphanumeric (Discord snowflakes are int64 strings; VK is int but historically string-shaped in URLs). One ALTER avoided per new platform.
- UNIQUE `(platform, external_id)`: same Telegram chat seen from two flows (bot deep-link + Mini App manual) resolves to one row via `INSERT … ON CONFLICT (platform, external_id) DO UPDATE SET title = …`.
- No `workspace_id` on `content_channels`: a channel is platform-global. Workspace binding lives on `channel_connections` (Rule 1 in 02-ARCHITECTURE.md).
- `type` allows future per-type policy (e.g., disallow `private_chat` connection in UI).

### `channel_connections` (workspace-binding)

```sql
CREATE TABLE IF NOT EXISTS channel_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content_channel_id uuid NOT NULL REFERENCES content_channels(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending',          -- pending / connected / broken / revoked
  can_post_messages boolean,                       -- last-known: NULL until first verify
  last_verify_status text,                         -- 'ok' / 'bot_not_admin' / 'missing_post_permission' /
                                                   -- 'chat_not_found' / 'bot_blocked' / 'network' / 'unknown'
  last_verify_error text,                          -- short human label, NOT a stack trace
  last_verified_at timestamptz,
  connected_at timestamptz,                        -- set once when first transitions to 'connected'
  connected_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_connections_status_check
    CHECK (status IN ('pending', 'connected', 'broken', 'revoked')),
  CONSTRAINT channel_connections_last_verify_status_check
    CHECK (last_verify_status IS NULL OR last_verify_status IN (
      'ok', 'bot_not_admin', 'missing_post_permission',
      'chat_not_found', 'bot_blocked', 'network', 'unauthorized', 'unknown'
    )),
  -- Phase 2: one workspace can own a content_channel. Phase 9 may relax to
  -- (workspace_id, content_channel_id) partial-unique excluding 'revoked',
  -- but for MVP this enforces edge-case 3.3 ("channel taken by another workspace").
  CONSTRAINT channel_connections_content_channel_unique UNIQUE (content_channel_id)
);
CREATE INDEX IF NOT EXISTS channel_connections_workspace_idx
  ON channel_connections (workspace_id, status);
```

**Justifications:**
- FK `workspaces ON DELETE CASCADE`: dropping a workspace removes its bindings; the underlying `content_channels` row survives (it represents a real chat that other workspaces could connect to later, after Phase 9).
- FK `content_channels ON DELETE RESTRICT`: a `content_channels` row should never be hard-deleted while a binding exists — we want a stable identity that survives workspace churn.
- FK `connected_by_user_id ON DELETE SET NULL`: same soft-delete policy as `command_idempotency.user_id`. Audit is in `operation_log`; this is denormalisation for UI.
- UNIQUE `(content_channel_id)` (NOT `(platform, external_id)` like 03-DATABASE-SCHEMA.md draft): we enforce single-workspace ownership at the connection-FK level so we don't duplicate the platform key. Same edge case (3.3) is satisfied because `content_channels.(platform, external_id)` is unique, so a second workspace trying to connect the same chat will first INSERT-OR-FIND the same `content_channel_id` and then hit this UNIQUE.
- `can_post_messages` nullable: NULL = "never verified" (the `pending` state); `true`/`false` after first `verifyConnection`. This lets the UI badge a pending vs broken state correctly.
- `last_verify_error` is a SHORT label (≤200 chars) — never a stack trace. Stack traces go to logs only.
- `status='revoked'` reserved for Phase 9+ (user explicit disconnect); Phase 2 commands never set it.

### `channel_connect_codes` (one-time, TTL-bound)

```sql
CREATE TABLE IF NOT EXISTS channel_connect_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  code_hash text NOT NULL,                         -- sha256(code) hex; code itself never persisted
  status text NOT NULL DEFAULT 'active',           -- active / consumed / expired
  expires_at timestamptz NOT NULL,                 -- created_at + 30 min
  consumed_at timestamptz,
  consumed_by_telegram_user_id bigint,             -- which Telegram user redeemed; for audit
  consumed_by_external_chat_id text,               -- which chat the bot/MA bound it to
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_connect_codes_status_check
    CHECK (status IN ('active', 'consumed', 'expired')),
  CONSTRAINT channel_connect_codes_code_hash_unique UNIQUE (code_hash)
);
-- Janitor: find expired-but-still-active codes to mark; also serves replay-lookup
-- on bot side (`WHERE code_hash=$1 AND status='active' AND expires_at > now()`).
CREATE INDEX IF NOT EXISTS channel_connect_codes_status_expires_at_idx
  ON channel_connect_codes (status, expires_at);
CREATE INDEX IF NOT EXISTS channel_connect_codes_workspace_idx
  ON channel_connect_codes (workspace_id, status);
```

**Justifications:**
- `code_hash` (sha256 hex, not plaintext): the deep-link is shared in chat; the code is shown to the user. Treat it as a session-bearer-token shape — hash at rest, identity-via-equality. (Same reasoning as `command_idempotency` SECURITY comment in schema.ts.)
- `status` enum + `expires_at`: enum lets us flip to `consumed`/`expired` for analytics and for the `409 reused_code` check. Expiry is enforced both via `expires_at > now()` clause AND via janitor (Phase 8) flipping to `'expired'`.
- Per `tg_mvp_plan/03-DATABASE-SCHEMA.md` indexes section the originally proposed index is `(workspace_id, status, expires_at)`; we split into two narrower indexes because the two access patterns are distinct (bot-side: `(code_hash)` already covered by UNIQUE; janitor: `(status, expires_at)`; UI list: `(workspace_id, status)`).
- `consumed_by_telegram_user_id bigint`: same shape as `telegram_identities.telegram_user_id` to allow JOIN for audit.
- `consumed_by_external_chat_id text`: stored so we can verify "this code redeemed THIS chat", not a different one — defence against bot-side race.

### Drizzle types (`packages/db/src/schema.ts`, additions only)

```typescript
export const contentChannels = pgTable('content_channels', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  platform: text('platform').notNull(),
  externalId: text('external_id').notNull(),
  type: text('type').notNull(),
  title: text('title').notNull(),
  username: text('username'),
  photoUrl: text('photo_url'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [
  check('content_channels_platform_check', sql`${t.platform} IN ('telegram')`),
  check('content_channels_type_check',
    sql`${t.type} IN ('channel', 'supergroup', 'group', 'private_chat')`),
  unique('content_channels_platform_external_unique').on(t.platform, t.externalId),
  index('content_channels_platform_idx').on(t.platform),
]);

export const channelConnections = pgTable('channel_connections', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  workspaceId: uuid('workspace_id').notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  contentChannelId: uuid('content_channel_id').notNull()
    .references(() => contentChannels.id, { onDelete: 'restrict' }),
  status: text('status').notNull().default('pending'),
  canPostMessages: boolean('can_post_messages'),
  lastVerifyStatus: text('last_verify_status'),
  lastVerifyError: text('last_verify_error'),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true, mode: 'date' }),
  connectedAt: timestamp('connected_at', { withTimezone: true, mode: 'date' }),
  connectedByUserId: uuid('connected_by_user_id')
    .references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [ /* mirrored CHECKs + unique + indexes */ ]);

export const channelConnectCodes = pgTable('channel_connect_codes', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  workspaceId: uuid('workspace_id').notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  createdByUserId: uuid('created_by_user_id').notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  codeHash: text('code_hash').notNull(),
  status: text('status').notNull().default('active'),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
  consumedByTelegramUserId: bigint('consumed_by_telegram_user_id', { mode: 'bigint' }),
  consumedByExternalChatId: text('consumed_by_external_chat_id'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
}, (t) => [ /* mirrored CHECKs + unique + indexes */ ]);
```

Plus `$inferSelect` / `$inferInsert` row type exports.

## Interface contracts

### `packages/domain/src/channel.ts` (pure types)

```typescript
export type ChannelPlatform = 'telegram';
export type ChannelType = 'channel' | 'supergroup' | 'group' | 'private_chat';

export interface ContentChannel {
  id: string;
  platform: ChannelPlatform;
  externalId: string;
  type: ChannelType;
  title: string;
  username: string | null;
  photoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ChannelConnectionStatus = 'pending' | 'connected' | 'broken' | 'revoked';
export type ChannelVerifyStatus =
  | 'ok'
  | 'bot_not_admin'
  | 'missing_post_permission'
  | 'chat_not_found'
  | 'bot_blocked'
  | 'network'
  | 'unauthorized'
  | 'unknown';

export interface ChannelConnection {
  id: string;
  workspaceId: string;
  contentChannelId: string;
  status: ChannelConnectionStatus;
  canPostMessages: boolean | null;
  lastVerifyStatus: ChannelVerifyStatus | null;
  lastVerifyError: string | null;
  lastVerifiedAt: Date | null;
  connectedAt: Date | null;
  connectedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ChannelConnectCodeStatus = 'active' | 'consumed' | 'expired';

export interface ChannelConnectCode {
  id: string;
  workspaceId: string;
  createdByUserId: string;
  expiresAt: Date;
  status: ChannelConnectCodeStatus;
  consumedAt: Date | null;
  consumedByTelegramUserId: bigint | null;
  consumedByExternalChatId: string | null;
  createdAt: Date;
}
```

### `packages/commands/src/create-connect-code.ts`

```typescript
import { z } from 'zod';

export const CreateConnectCodeInputSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
});
export type CreateConnectCodeInput = z.infer<typeof CreateConnectCodeInputSchema>;

export interface CreateConnectCodeResult {
  /** Plaintext code (NOT stored). Caller MUST surface it to the user once and never log it. */
  code: string;
  /** DB row id; used by tests + idempotent replay. */
  connectCodeId: string;
  workspaceId: string;
  expiresAt: Date;
}

export async function createConnectCode(
  db: Database,
  input: CreateConnectCodeInput,
): Promise<{ replayed: boolean; result: CreateConnectCodeResult }>;
```

**Behaviour:**
- Zod-validate input.
- Policy: `assertWorkspaceRole(tx, workspaceId, userId, 'admin')` — owners + admins may create codes; editors/viewers get `CommandError('forbidden')`.
- Wrap in `runIdempotent({ commandType: 'CreateConnectCode', idempotencyKey, workspaceId, userId, ttlHours: 1 })`. TTL is 1h: shorter than the default 24h because the replay-payload (`code`) is sensitive and we'd rather force a new code than serve a stale-but-cached one.
- Idempotency key shape (proposed for client): `cc:<workspace_id>:<user_id>:<unix_minute>` — same minute = same code (covers double-click).
- Inside `runIdempotent.execute(tx)`:
  - Generate random plaintext code: 8 base32-Crockford chars (~40 bits entropy, link-safe, low-confusion: no `0/O/1/l/I`). E.g. `K7XQAR9F`.
  - `codeHash = sha256_hex(code)`.
  - INSERT `channel_connect_codes` with `status='active'`, `expires_at = now() + interval '30 minutes'`.
  - INSERT `operation_log` (commandType, workspaceId, userId, objectType=`'channel_connect_code'`, objectId=<row id>, payloadSummary `{ expires_in_seconds: 1800 }`, result=`'success'`). Note: do NOT log plaintext `code` or `code_hash`.
  - Return `{ objectType: 'channel_connect_code', objectId: connectCodeId, result: { code, connectCodeId, workspaceId, expiresAt } }`.
- `loadFromPointer({ objectId })`: load row by id. **Replay caveat:** plaintext code cannot be reconstructed (we only stored hash). Two options considered:
  - **(a) FAIL on replay** with `CommandError('conflict', 'idempotency replay impossible: code not retained')`. Client must change idempotency key.
  - **(b) Return `code: null` in replay and let route map to 200 with `{ code: null, replayed: true }`.**

  **Chosen:** **(a)** — the client never has a legitimate reason to replay this command (one user click = one code). Replaying means the prior call succeeded; the client already got the code in that response. A genuine retry of the FAILED first call uses the auto-DELETE path from `runIdempotent` and re-generates fresh. This keeps the no-plaintext-at-rest invariant.

**Error path mapping:**
- `validation_failed` → 400.
- `forbidden` (policy) → 403.
- `not_found` (workspace doesn't exist) → 404.
- `conflict` (replay of success) → 409 with `code: 'idempotency_replay_impossible'`.

### `packages/commands/src/connect-telegram-channel.ts`

```typescript
import { z } from 'zod';

// Discriminated union: bot-side activation carries an external chat_id;
// Mini App manual entry has the user paste a chat_id directly. Both paths
// resolve to the same connect logic — only the source of `externalChatId` differs.
export const ConnectTelegramChannelInputSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  code: z.string().min(6).max(20),               // plaintext code (user-typed or from deep-link)
  externalChatId: z.string().min(1).max(64),     // Telegram chat_id as string; negative for channels
  invokedBy: z.union([
    z.object({ source: z.literal('bot'),     telegramUserId: z.number().int() }),
    z.object({ source: z.literal('miniapp'), userId: z.string().uuid() }),
  ]),
});
export type ConnectTelegramChannelInput = z.infer<typeof ConnectTelegramChannelInputSchema>;

export interface ConnectTelegramChannelResult {
  contentChannel: ContentChannel;
  channelConnection: ChannelConnection;
  workspaceId: string;
}

export async function connectTelegramChannel(
  db: Database,
  adapter: TelegramChannelAdapter,
  input: ConnectTelegramChannelInput,
): Promise<{ replayed: boolean; result: ConnectTelegramChannelResult }>;
```

**Behaviour:**
1. Zod-validate input.
2. Compute `codeHash = sha256_hex(code)`.
3. Wrap in `runIdempotent({ commandType: 'ConnectTelegramChannel', idempotencyKey, ttlHours: 24 })`.
4. Inside `execute(tx)`:
   - SELECT `channel_connect_codes` WHERE `code_hash = $1 FOR UPDATE` (lock the row to prevent two concurrent redemptions).
   - If row missing → `CommandError('not_found', 'unknown code')` → `code: 'invalid_code'` at the wire (404).
   - If `now() > expires_at` → mark `status='expired'` (best-effort, separate query if needed) and throw `CommandError('not_found', 'code expired')` → `code: 'expired_code'` mapped to 410.
   - If `status='consumed'` → `CommandError('conflict', 'code already used')` → `code: 'reused_code'` → 409.
   - Resolve `connecting_user_id`:
     - `source='miniapp'`: directly from input.
     - `source='bot'`: lookup `telegram_identities WHERE telegram_user_id = $1` → user_id. If not found → `'forbidden'` (the bot user is not a known user yet).
   - Policy: `assertWorkspaceRole(tx, code.workspaceId, connecting_user_id, 'admin')`. If the bot user is not an admin/owner of the code's workspace → `'forbidden'`.
   - **Call adapter (OUTSIDE the lock-scope ideally, but acceptable to call within tx; adapter is HTTP-bound so keep tx short — see Decision log "Adapter call inside tx").** `result = await adapter.verifyConnection({ externalChatId })`.
   - If `result.ok === false`: map `result.errorCode` to `CommandError`:
     - `'bot_not_admin'` → `CommandError('validation_failed', 'bot not admin')` with route mapping to 400 + `code: 'bot_not_admin'`.
     - `'missing_post_permission'` → 400 + `code: 'missing_post_permission'`.
     - `'chat_not_found'` → 400 + `code: 'chat_not_found'`.
     - `'bot_blocked' | 'unauthorized'` → 400 + same-name code.
     - On these errors **still** persist a `channel_connections` row with `status='broken'` IF a row already existed for this workspace? **No** — Phase 2 keeps the failure path clean: on adapter failure we DO NOT consume the code (so the user can retry after fixing permissions). Code stays `active` until TTL.
   - If `result.ok === true`:
     - UPSERT `content_channels` ON CONFLICT `(platform, external_id)` DO UPDATE SET `title, username, photo_url, type, updated_at = now()` RETURNING `id` (and the rest of the row). `platform='telegram'`, `external_id = input.externalChatId`.
     - INSERT `channel_connections` `(workspace_id = code.workspace_id, content_channel_id = above, status='connected', can_post_messages=true, last_verify_status='ok', last_verified_at=now(), connected_at=now(), connected_by_user_id = connecting_user_id)`.
       - On unique-violation `channel_connections_content_channel_unique`: the channel is taken by another workspace → `CommandError('conflict', 'channel taken')` → 409 + `code: 'channel_taken'`. **Code is NOT consumed** (taken channels are rare and we don't want to burn a code on an unfixable error from the user's perspective).
     - UPDATE `channel_connect_codes SET status='consumed', consumed_at=now(), consumed_by_telegram_user_id=$1, consumed_by_external_chat_id=$2 WHERE id=$code_id AND status='active'` — filter on `status='active'` so a concurrent successor doesn't double-consume.
     - INSERT `operation_log` (`commandType='ConnectTelegramChannel'`, `workspaceId`, `userId=connecting_user_id`, `objectType='channel_connection'`, `objectId=<connection id>`, `payloadSummary` `{ external_id, platform: 'telegram', source: 'bot'|'miniapp', chat_type }`, `result='success'`).
   - Return `{ objectType: 'channel_connection', objectId: connectionId, result }`.
5. `loadFromPointer({ objectId })`: re-load `channel_connection` + linked `content_channel`. Safe to replay because no plaintext is involved.

**Error path mapping:**
- `validation_failed` (zod) → 400.
- `not_found` (unknown code OR `code: 'expired_code'`) — route distinguishes via `err.message`/extra context: prefer attaching `code` to a richer error type or check `err.message` content; cleaner is to introduce an optional `details: { code: string }` on `CommandError`. **Decision below.**
- `conflict` → 409 (with `code` either `reused_code` or `channel_taken`).
- `forbidden` → 403.
- `internal` → 500.

### `packages/commands/src/policies.ts`

```typescript
export type WorkspaceMinRole = 'viewer' | 'editor' | 'admin' | 'owner';

export async function assertWorkspaceRole(
  tx: DbOrTx,
  workspaceId: string,
  userId: string,
  minRole: WorkspaceMinRole,
): Promise<{ role: WorkspaceRole }>;
```

Throws `CommandError('forbidden', ...)` if user is not an active member, or member role rank < minRole.

### `packages/channel-adapters/src/telegram/`

```typescript
// types.ts
export interface VerifyConnectionInput {
  externalChatId: string;            // negative int as string for channels, e.g. '-1001234567890'
}

export type VerifyConnectionResult =
  | {
      ok: true;
      title: string;
      username: string | null;
      photoUrl: string | null;
      chatType: 'channel' | 'supergroup' | 'group' | 'private_chat';
      canPostMessages: true;          // by construction; ok implies post permission
    }
  | {
      ok: false;
      errorCode:
        | 'bot_not_admin'
        | 'missing_post_permission'
        | 'chat_not_found'
        | 'bot_blocked'
        | 'unauthorized'
        | 'network'
        | 'unknown';
      detail: string;                 // safe-to-log; no secrets
    };

// index.ts
export interface TelegramChannelAdapter {
  verifyConnection(input: VerifyConnectionInput): Promise<VerifyConnectionResult>;
}

export interface CreateTelegramChannelAdapterDeps {
  botToken: string;
  botUserId: number;                  // resolved at startup via getMe (cached)
  fetch?: typeof globalThis.fetch;    // injectable for tests
  timeoutMs?: number;                 // default 5000
}

export function createTelegramChannelAdapter(
  deps: CreateTelegramChannelAdapterDeps,
): TelegramChannelAdapter;
```

**`verifyConnection` algorithm:**
1. `getChat(chat_id)` → if 400 `chat not found` → `{ ok: false, errorCode: 'chat_not_found' }`. If 401 → `'unauthorized'` (bot token bad). If network/timeout → `'network'`.
2. Read `result.type` → map to `chatType`. Read `title`, `username`, photo file_id (Phase 2: skip fetch; expose just from `chat.photo.small_file_id` resolved best-effort or pass null).
3. `getChatMember(chat_id, user_id = botUserId)`:
   - `status !== 'administrator'` (and not `'creator'`) → `{ ok: false, errorCode: 'bot_not_admin' }`.
   - For `type='channel'`: check `can_post_messages === true`. Else → `'missing_post_permission'`.
   - For `type='supergroup'/'group'`: bot can send by default if admin; check `can_post_messages !== false` (Telegram returns true/undefined when allowed).
   - For `type='private_chat'`: not a publishable target; → `'missing_post_permission'`. (Phase 2 documents this as "private chats are not supported").
4. If 403 `bot was blocked by the user` (rare for channels but possible for private_chat) → `'bot_blocked'`.
5. All-good → `{ ok: true, title, username, photoUrl, chatType, canPostMessages: true }`.

**Invariants:**
- NEVER throws on Telegram-side errors — always returns `{ ok: false, errorCode }`. Throwing is reserved for programmer errors (e.g., missing botToken) and surfaced as `TelegramAdapterError`.
- NEVER reads `command_idempotency`, `workspaces`, or any DB table — pure HTTP function.
- NEVER imports from `@postdash/db`, `@postdash/commands`, `@postdash/domain`. Strict layer boundary.
- All fetches use AbortController with `timeoutMs`.

### `apps/api/src/routes/channels.ts`

Three routes registered under no common prefix (matches existing `/auth/telegram`, `/me` style):

```typescript
// POST /channels/connect-codes
// Body: { } (empty; workspace inferred from auth)
// Idempotency: client may send `Idempotency-Key` header; default to `cc:<wsId>:<userId>:<unix_minute>`.
// Returns: ConnectCodeProjection { id, code, deep_link, expires_at }
// Rate limit: 5/min per user.

// POST /channels/connect
// Body: { code: string, external_chat_id: string }
// Header: `Idempotency-Key` (required).
// Returns: ChannelProjection
// Rate limit: 10/min per user.

// GET /channels
// Returns: { items: ChannelProjection[] }
// Rate limit: 60/min per user.
```

All three:
1. Extract & verify initData (reuses `extractInitData` from `apps/api/src/auth`).
2. Resolve user via `readCurrentUser` to get `userId` and `defaultWorkspaceId`.
3. Apply route-specific zod body schema.
4. Call command / read.
5. Map `CommandError` via `sanitizeCommandError` AND a Phase 2 extension table for the new domain codes (see Decision log).

### `apps/api/src/bot/handlers/start-connect.ts`

```typescript
export interface StartConnectDeps {
  db: Database;
  adapter: TelegramChannelAdapter;
  // For tests; bot.ts wires the real Context-based reply.
  reply: (text: string) => Promise<void>;
}

export interface StartConnectInput {
  code: string;
  telegramUserId: number;
  externalChatId: string;
  idempotencyKey: string;   // derived as `bot-start:<telegram_user_id>:<code_hash>`
}

export async function handleStartConnect(
  deps: StartConnectDeps,
  input: StartConnectInput,
): Promise<void>;
```

**Behaviour:**
- Calls `connectTelegramChannel(deps.db, deps.adapter, { ...input, invokedBy: { source: 'bot', telegramUserId }})`.
- Maps result:
  - success → `'Канал «<title>» подключён. Возвращайся в Mini App.'`.
  - `'bot_not_admin'` → `'Я не админ в этом канале. Добавь меня админом и нажми /start снова.'`.
  - `'missing_post_permission'` → `'У меня нет права постить в этот канал. Дай право и нажми /start снова.'`.
  - `'expired_code'` → `'Код истёк. Создай новый в Mini App.'`.
  - `'reused_code'` → `'Этот код уже использован. Создай новый.'`.
  - `'channel_taken'` → `'Этот канал уже подключён к другому workspace.'`.
  - generic error → `'Что-то пошло не так. Попробуй позже.'` + log.
- **Critical edge:** `/start connect_<code>` arrives in a PRIVATE chat with the bot. We don't have a channel `chat_id` there. **Resolution:** the Phase 2 bot flow expects the user to:
  1. Add the bot as admin in their channel.
  2. Forward any message from that channel TO the bot, OR — simpler MVP — paste the channel @username or chat_id into the Mini App after creating the code.
- **Actual Phase 2 wire-up:** the bot `/start connect_<code>` payload alone does NOT carry channel chat_id (Telegram doesn't provide it). So the bot handler will reply with: `'Готов подключить канал. Введи @username канала или chat_id в Mini App'` and the Mini App handles the rest (calls `POST /channels/connect`). **The "bot path" therefore acts as a code-validation + UX nudge, NOT a one-shot connect.** Manual entry in Mini App is the only flow that actually completes connection.
- **Alternative considered:** require the user to add bot to channel, then bot detects `my_chat_member` update with `new_chat_member.status='administrator'` and uses the most recent active code from that user's workspaces. **Rejected for Phase 2** because it's harder to correlate (which workspace? which code?) — postponed to Phase 9 polish.

So the Phase 2 deep-link `/start connect_<code>` flow validates the code's existence and prompts the user to finish in Mini App. Real channel binding happens via `POST /channels/connect`. The roadmap acceptance test `deep-link /start connect_<code> корректно вызывает connect flow` is satisfied by: bot handler calls `validateConnectCode(db, code)` (a helper that re-uses code-lookup logic from the command but stops before adapter call), records that the code is still valid, and replies with next-step instructions. We document this clearly in tests.

### Mini App: `apps/miniapp/src/screens/ChannelScreen.tsx`

State machine (driven by `getChannels` response + local UI state):

```
[Initial GET /channels]
  -> data.items.length === 0
       -> render NotConnectedView
  -> data.items[0].status === 'pending'
       -> render PendingView(channel, code?, deep_link?)
  -> data.items[0].status === 'connected'
       -> render ConnectedView(channel)
  -> data.items[0].status === 'broken' | 'revoked'
       -> render BrokenView(channel, last_verify_status)
```

`NotConnectedView`:
- `<Placeholder header="Канал не подключён" />`.
- Button "Создать код подключения" → POST `/channels/connect-codes` → on success transition to `PendingView` with the returned `{code, deep_link, expires_at}`.

`PendingView` (also shown right after code creation; locally cached because GET won't include it):
- Show `code` (large, monospace) + countdown to `expires_at`.
- Show deep-link `https://t.me/<bot_username>?start=connect_<code>`.
- Button "Скопировать deep-link" → clipboard write + Snackbar "Скопировано".
- Input field "Или введи @username / chat_id канала" + button "Подключить" → POST `/channels/connect` with `{ code, external_chat_id }`. On success → refresh `getChannels` → `ConnectedView`.
- Mapped errors per code (Banner inline):
  - `bot_not_admin` → "Сделай бота администратором канала".
  - `missing_post_permission` → "Включи «Posting» в правах бота".
  - `chat_not_found` → "Канал не найден; проверь @username".
  - `channel_taken` → "Канал уже подключён к другому workspace".
  - `expired_code` → button "Создать новый код".
  - `reused_code` → button "Создать новый код".

`ConnectedView`:
- Show channel title + photo (if any) + status badge "Подключён".
- Button "Проверить сейчас" (Phase 8 stub today: just re-fetches `GET /channels`; explicit re-verify endpoint in Phase 8).
- Button "Отключить канал" disabled in Phase 2 (Phase 9).

`BrokenView`:
- Banner with `last_verify_error` translated.
- Button "Создать новый код подключения" → goes through NotConnectedView flow.

**Deep-link handling:** when Mini App opens with `?startapp=connect_<code>`, the existing `apps/miniapp/src/routing/` deep-link mapper (Phase 1) lands us on `/channel`. ChannelScreen reads the start_param and, if present, pre-fills the code in PendingView's chat_id input. The code itself is decorative (the user already has it via the deep-link), but having it visible reassures them.

## Data flow

### Path A: Mini App initiates code, Mini App finishes connect

```
User taps "Создать код"
  → MA: POST /channels/connect-codes
    → api.channels.createCodeRoute(req)
      → policy: extractInitData → readCurrentUser → userId, workspaceId
      → CreateConnectCodeCommand.createConnectCode(db, { workspaceId, userId, idempotencyKey })
        → runIdempotent.execute(tx):
          → assertWorkspaceRole(tx, ws, user, 'admin')
          → generate code (8 chars), hash sha256
          → INSERT channel_connect_codes (status='active', expires=now+30m)
          → INSERT operation_log
          → return { code, connectCodeId, expiresAt }
      → projectConnectCode(result) -> ConnectCodeProjection { id, code, deep_link, expires_at }
  ← 200 { id, code, deep_link, expires_at }

User adds bot to channel as admin, then enters @username:
  → MA: POST /channels/connect { code, external_chat_id: '@mychan' }
    → api.channels.connectRoute(req)
      → policy: extractInitData → readCurrentUser
      → ConnectTelegramChannelCommand.connectTelegramChannel(db, adapter, {
            code, externalChatId: '@mychan',
            invokedBy: { source: 'miniapp', userId },
            idempotencyKey: header || derived })
        → runIdempotent.execute(tx):
          → SELECT channel_connect_codes WHERE code_hash=$ FOR UPDATE
          → guard expired / consumed
          → assertWorkspaceRole(tx, code.workspaceId, userId, 'admin')
          → adapter.verifyConnection({ externalChatId }) ───── HTTP ────► Telegram getChat + getChatMember
            ← { ok: true, title, username, chatType, canPostMessages: true }
          → UPSERT content_channels ON CONFLICT (platform, external_id)
              RETURNING content_channel_id
          → INSERT channel_connections (workspaceId, contentChannelId, status='connected', ...)
              ON unique violation → CommandError('conflict') 'channel_taken'
          → UPDATE channel_connect_codes SET status='consumed' WHERE id=$ AND status='active'
          → INSERT operation_log
          → return { contentChannel, channelConnection, workspaceId }
      → projectChannel(result) -> ChannelProjection
  ← 200 ChannelProjection
```

### Path B: Bot-side `/start connect_<code>` (Phase 2 acts as validator only)

```
User taps deep-link https://t.me/postdash_bot?start=connect_K7XQAR9F
  → Telegram → bot.command('start') → parseStartPayload('connect_K7XQAR9F') → { kind:'connect', id:'K7XQAR9F' }
  → handleStartConnect(deps, { code, telegramUserId, idempotencyKey })
    → validateConnectCode(db, code):
      SELECT channel_connect_codes WHERE code_hash=$ AND status='active' AND expires_at>now()
      → if missing/expired/consumed → reply with appropriate error message
      → else: reply "Код принят. Открой Mini App и введи @username канала, чтобы завершить."
  → Mini App URL constructed with ?startapp=connect_<code>; user taps "Open dashboard" inline button (already in bot.ts logic)
  → Mini App PendingView shows code prefilled → user enters @username → Path A POST /channels/connect.
```

## Dependency graph

```
apps/api/routes/channels.ts
  → apps/api/auth/extract-initdata.ts
  → @postdash/commands (createConnectCode, connectTelegramChannel, readCurrentUser, CommandError)
  → @postdash/channel-adapters/telegram (TelegramChannelAdapter)
  → apps/api/routes/channels-projection.ts → @postdash/shared (ChannelProjection, ConnectCodeProjection)

apps/api/bot/handlers/start-connect.ts
  → @postdash/commands (validateConnectCode helper) — DOES NOT call connectTelegramChannel directly in Phase 2
  → @postdash/db

apps/api/bot/bot.ts
  → apps/api/bot/handlers/start-connect.ts  (only adds: route on kind==='connect')

@postdash/commands
  → @postdash/db (Drizzle tables, types)
  → @postdash/domain (pure types)
  → crypto (node:crypto for sha256, randomBytes)

@postdash/channel-adapters/telegram
  → globalThis.fetch only (no internal deps)
  — does NOT import @postdash/db, @postdash/commands, @postdash/domain

@postdash/domain
  → (none — pure)

apps/miniapp/screens/ChannelScreen.tsx
  → apps/miniapp/api/channels.ts → apps/miniapp/api/client.ts
  → apps/miniapp/components (Placeholder, Button, Section, Banner, Snackbar, CopyButton)
  → @postdash/shared (ChannelProjection types)
```

No cycles. Note that `commands` does not depend on `channel-adapters` directly — the `connectTelegramChannel` command accepts the adapter as a parameter (dependency injection, breaks the would-be cycle through HTTP layer wiring).

## Integration points

- Reads `workspace_members.role` (Phase 1) to gate code creation and channel connect.
- Reads `users` (Phase 1) for `connected_by_user_id` FK + `created_by_user_id` FK.
- Reads `telegram_identities` (Phase 1) to resolve `telegramUserId → userId` in bot-side handler.
- Writes `command_idempotency` (Phase 1) via `runIdempotent`.
- Writes `operation_log` (Phase 1) — must include `commandType ∈ {'CreateConnectCode', 'ConnectTelegramChannel'}`.
- Bot `apps/api/src/bot/bot.ts` is modified to route `parseStartPayload(...).kind === 'connect'` payloads to the new `handleStartConnect`. Existing `/start` with no payload OR with `kind:'draft'` behavior preserved.
- Mini App routing already maps `?startapp=connect_<code>` → `/channel` route (Phase 1 `apps/miniapp/src/routing/`); we just consume the start_param in `ChannelScreen.tsx`.
- API server (`apps/api/src/index.ts` + `app.ts`):
  - At startup, after building the `bot` (which carries `botToken`), call `bot.api.getMe()` to resolve `botUserId` and pass it into `createTelegramChannelAdapter`.
  - Register the adapter into `deps.channelAdapter`.
  - Pass `deps.channelAdapter` to `channelsRoute`.
- `packages/shared/src/index.ts` re-exports new wire types.

## Files

(Already listed in **Module decomposition**; this section restates with public API summary.)

- `packages/db/migrations/0002_phase2.sql` — DDL for 3 tables + indexes + checks. UTF-8 LF, no BEGIN/COMMIT (migrator wraps).
- `packages/db/migrations/0002_phase2.down.sql` — `DROP TABLE` in reverse-FK order; `DELETE FROM _migrations WHERE name='0002_phase2.sql'`.
- `packages/db/src/schema.ts` — append `contentChannels`, `channelConnections`, `channelConnectCodes` + inferred row types. **Mirror parity with SQL is non-negotiable** (per existing schema.ts header comment).
- `packages/domain/src/channel.ts` — pure types (no I/O).
- `packages/domain/src/index.ts` — `export * from './channel.js'`.
- `packages/commands/src/create-connect-code.ts` — `createConnectCode(db, input)`.
- `packages/commands/src/connect-telegram-channel.ts` — `connectTelegramChannel(db, adapter, input)`.
- `packages/commands/src/connect-code-helpers.ts` — `generateConnectCode()`, `hashConnectCode(code)`, `validateConnectCode(db, code)` (read-only helper used by bot handler), `lookupActiveCode(tx, codeHash)` (FOR UPDATE variant).
- `packages/commands/src/policies.ts` — `assertWorkspaceRole`, `ROLE_RANK` constant.
- `packages/commands/src/errors.ts` — extended (see Decision log: add `details?: Record<string,string>` to `CommandError` for `code:'channel_taken'` etc.).
- `packages/commands/src/index.ts` — re-exports.
- `packages/channel-adapters/src/telegram/types.ts` — input/output types.
- `packages/channel-adapters/src/telegram/errors.ts` — `TelegramAdapterError`.
- `packages/channel-adapters/src/telegram/api-client.ts` — `callBotApi(token, method, params, opts)` thin wrapper with timeout + error mapping.
- `packages/channel-adapters/src/telegram/verify-connection.ts` — pure `verifyConnection` (takes an injected `callBotApi`).
- `packages/channel-adapters/src/telegram/index.ts` — `createTelegramChannelAdapter` factory.
- `packages/channel-adapters/src/index.ts` — barrel.
- `packages/channel-adapters/package.json` — add `peerDependency` on nothing; `devDependencies`: vitest. Add `dependencies` if any (none needed; fetch is global).
- `apps/api/src/routes/channels.ts` — Fastify plugin.
- `apps/api/src/routes/channels-projection.ts` — wire-mapping.
- `apps/api/src/bot/handlers/start-connect.ts` — new.
- `apps/api/src/bot/bot.ts` — minor edit (route connect kind to handler).
- `apps/api/src/app.ts` — register adapter + route; extend `AppDeps`.
- `apps/api/src/index.ts` — resolve `botUserId` via `bot.api.getMe()` before app build.
- `apps/miniapp/src/screens/ChannelScreen.tsx` — full rewrite from Phase 1 placeholder.
- `apps/miniapp/src/api/channels.ts` — client.
- `apps/miniapp/src/api/types.ts` — `ChannelProjection`, `ConnectCodeProjection`.
- `apps/miniapp/src/components/CopyButton.tsx` — new tiny component.
- `packages/shared/src/channel-projection.ts` — wire types.
- `packages/shared/src/index.ts` — re-export.

## Invariants

1. **Plaintext code is NEVER persisted.** `channel_connect_codes` stores only `code_hash` (sha256 hex). The plaintext appears in: (a) the API response of `POST /channels/connect-codes` exactly once; (b) the deep-link URL the user shares; (c) the body of `POST /channels/connect`. It MUST NOT appear in `operation_log.payload_summary`, `command_idempotency.idempotency_key`, or any log statement. (Mirrors the `tma:<hash>` SECURITY note in Phase 1.)
2. **`(platform, external_id)` is globally unique** in `content_channels`. Two workspaces trying to connect the same Telegram chat resolve to the same `content_channel` row; the conflict is enforced one level up by `channel_connections.content_channel_id` UNIQUE.
3. **Bot API calls never originate outside `packages/channel-adapters/telegram`.** `packages/commands`, `packages/domain`, `apps/api/routes/*`, and `apps/api/bot/handlers/*` all reach Telegram only through the injected `TelegramChannelAdapter` interface. The one exception is `apps/api/src/index.ts` calling `bot.api.getMe()` at startup to resolve `botUserId` — this is bootstrap, not business logic.
4. **A connect code is consumed exactly once.** Enforced by: (a) `SELECT … FOR UPDATE` lock during redemption; (b) `UPDATE … WHERE status='active'` filter; (c) TTL gate. A successful `connectTelegramChannel` consumes the code; an adapter-failure path (e.g., `bot_not_admin`) leaves the code `active` so the user can retry.
5. **`channel_connections.workspace_id` and `connected_by_user_id.workspace` always match.** `assertWorkspaceRole` guards this. Cross-workspace integrity test asserts that a member of workspace A cannot create a connection for workspace B (the code's `workspace_id` is the only thing that matters; the connector must be admin of THAT workspace).
6. **`status='connected'` implies `can_post_messages=true` AND `last_verify_status='ok'`.** Otherwise the row is `pending` or `broken`. Future re-verification flips status; Phase 2 only writes once at connect-time.
7. **Adapter HTTP calls have a hard timeout** (default 5s) and never throw on Telegram-side 4xx — they return `{ ok:false, errorCode }`.
8. **No Telegram API call inside `apps/api/src/routes/*` body.** Routes call commands; commands call adapter. (Tested by lint rule grep.)

## Decision log

### Decision: `content_channels` is global, `channel_connections` is workspace-binding (vs single `channels` table with `workspace_id`)
**Considered:** (a) One table `channels(workspace_id, platform, external_id, …)` with composite UNIQUE; (b) two tables as proposed in `03-DATABASE-SCHEMA.md`.
**Chosen:** Two tables.
**Why:** Rule 1 in `02-ARCHITECTURE.md` ("Telegram is an adapter, not the core"). A Telegram channel is one thing in the world; multiple workspaces could plausibly share it later (Phase 9: agency mode). Single-table forces denormalisation when that happens. Two tables also let `content_channels.title/photo` be refreshed independently of workspace state.
**Tradeoff:** One extra JOIN in projections. Acceptable — same pattern as `users` ⟂ `telegram_identities`.

### Decision: store `code_hash` (sha256), not plaintext, in `channel_connect_codes`
**Considered:** (a) plaintext `code`; (b) HMAC with a server pepper; (c) sha256.
**Chosen:** sha256 hex.
**Why:** Code is a short-lived bearer token. At-rest leakage (logs, backups, replicas) of plaintext would allow an attacker to redeem any active code. sha256 + low-entropy code (~40 bits) is enough because the code is single-use AND TTL-bound; brute-forcing the hash within 30 min requires guessing the 40-bit space, indistinguishable from rate-limiting `POST /channels/connect`. HMAC with pepper considered overkill and adds key-management.
**Tradeoff:** Replay of `CreateConnectCodeCommand` cannot return the original plaintext code — we fail the replay. Documented behaviour.

### Decision: Adapter receives `botUserId` at construction, not per-call
**Considered:** (a) Pass `botUserId` per `verifyConnection` call; (b) cache it in the adapter at construction via `getMe()`.
**Chosen:** (b).
**Why:** `botUserId` is invariant for a given `botToken`. Resolving it once at app startup (single `bot.api.getMe()` call already wired in `apps/api/src/index.ts`) avoids a per-request lookup + makes the adapter contract simpler.
**Tradeoff:** Bot user identity rotation (changing `TELEGRAM_BOT_TOKEN`) requires a restart. Acceptable — token rotation is an admin operation, not runtime.

### Decision: Adapter is called INSIDE the runIdempotent transaction (not outside)
**Considered:** (a) Call adapter outside `tx`, then `tx` only does DB writes; (b) call inside `tx`.
**Chosen:** (b), accepting that `tx` is open ~500ms during HTTP.
**Why:** Outside-tx means we'd hold the `runIdempotent` pending slot but not the per-code `FOR UPDATE` lock, opening a race where two callers verify simultaneously and double-consume the code. Inside-tx is simpler and safer with the adapter's 5s hard timeout.
**Tradeoff:** A 5s HTTP call inside a tx is unusual. Mitigated by: tight timeout; the lock is held on one row (`channel_connect_codes`); idempotency slot's PENDING_TTL of 120s is still well clear. If this becomes a problem in load tests, we can split: verify outside, then re-acquire row in a short tx and commit. Phase 2 keeps single-tx.

### Decision: CommandError grows optional `details?: { code: string }` (vs new `DomainError` per family)
**Considered:** (a) Keep `CommandError` as-is and overload `message` parsing; (b) introduce `ChannelCommandError extends CommandError`; (c) add `details?: Record<string,string>` to `CommandError` so callers can surface `code: 'expired_code'`, `code: 'channel_taken'`, etc.
**Chosen:** (c).
**Why:** The route layer needs to map a single CommandError into one of several wire `code` values (`expired_code`, `reused_code`, `channel_taken`, `bot_not_admin`, etc.) and HTTP statuses (400/409/410). Subclasses balloon the error hierarchy. `message`-parsing is fragile. `details` is a typed escape valve consistent with how `AIProviderError` carries `code`. The `sanitizeCommandError` table grows a per-`details.code` override map for status/message.
**Tradeoff:** `CommandError` becomes slightly less narrow. Acceptable — Phase 6+ will use this for `cost_cap_reached`, `provider_refused`, etc.

### Decision: bot `/start connect_<code>` validates code, but channel binding still happens in Mini App (vs full bot-side binding)
**Considered:** (a) Bot's `/start connect_<code>` triggers `connectTelegramChannel` directly using the bot's private chat — but the bot doesn't have a channel chat_id from this update; (b) Bot waits for `my_chat_member` admin-grant event and correlates with most-recent active code; (c) Bot validates code and instructs user to finish in Mini App.
**Chosen:** (c).
**Why:** (a) is impossible: `/start` payload arrives in private chat with the user, NOT in the channel. (b) requires correlation heuristics (which workspace? which code?) and a stateful per-bot-instance map — complex and error-prone for Phase 2. (c) is simple, well-documented, satisfies the acceptance test ("deep-link корректly вызывает connect flow" — interpreted as "validates and routes to next UI step"), and channels the user to the Mini App that already has clean error UX.
**Tradeoff:** A pure "deep-link → done" experience is deferred to Phase 9. UX acceptable: the deep-link still confirms "I see your code, now finish in Mini App".

### Decision: external_id as text, not bigint (chat_id is int64 in Telegram)
**Considered:** (a) bigint; (b) text.
**Chosen:** text.
**Why:** Cross-platform uniformity for future adapters (Discord snowflakes typically expressed as strings; VK has numeric but URLs treat them stringly). Also: Telegram channel chat_ids are negative int64 (e.g., `-1001234567890`), and storing the sign explicitly in text avoids accidental client-side number coercion bugs (JS Number is float64, loses precision past 2^53; while -100...12345 fits, future Telegram IDs might not).
**Tradeoff:** Slightly more bytes per row. Negligible.

## How to extend

### Add a new platform adapter (e.g., VK in Phase 13)
1. Create `packages/channel-adapters/src/vk/{types,errors,api-client,verify-connection,index}.ts`.
2. Implement `VKChannelAdapter` with same `verifyConnection` shape (or, by then, a richer `ChannelAdapter` interface in `packages/channel-adapters/src/index.ts`).
3. Add `'vk'` to `content_channels.platform` CHECK via a new migration `000N_add_vk_platform.sql` (`ALTER TABLE … DROP CONSTRAINT … ADD CONSTRAINT … CHECK (platform IN ('telegram','vk'))`).
4. Extend `ConnectTelegramChannelCommand` (rename to `ConnectChannelCommand` at that point) to dispatch on platform — or introduce `ConnectVkChannelCommand` if the input shape diverges.
5. Wire adapter in `apps/api/src/app.ts` deps.
6. Mini App: add platform picker to `ChannelScreen`.

### Add a new connection error code (e.g., 'rate_limited' from Telegram)
1. Add to `ChannelVerifyStatus` union in `domain/channel.ts`.
2. Add to the SQL CHECK on `channel_connections.last_verify_status` (new migration).
3. Map it in `verifyConnection` switch.
4. Route layer: add to the per-`details.code` table in `channels.ts`.
5. Mini App: add Banner copy for it.

### Re-verify a connection (Phase 8)
1. Add `POST /channels/:id/reverify` route.
2. New command `ReverifyChannelConnectionCommand` (idempotent, ttl=1 min) that calls `adapter.verifyConnection` and updates `channel_connections.last_verify_*` fields. On `ok=false` flip `status='broken'`.
3. Schedule via tasks (Phase 4 system) every 24h per active channel.

## Test plan (≥10 tests)

Per unit boundary. Each test name is the file path + describe + it; what it asserts is one line.

1. **`packages/commands/__tests__/create-connect-code.test.ts › creates active code with 30min TTL`**
   - Asserts `channel_connect_codes` row has `status='active'`, `expires_at ≈ now() + 30min`, `code_hash` is sha256(plaintext) hex, `operation_log` entry written.
2. **`create-connect-code.test.ts › double-click returns CommandError('conflict','idempotency_replay_impossible')`**
   - Second call with same idempotency key: hits `loadFromPointer` which by design throws `conflict` since plaintext code wasn't retained.
3. **`create-connect-code.test.ts › editor role is forbidden`**
   - User with role=`editor` calling createConnectCode → `CommandError('forbidden')`.
4. **`packages/commands/__tests__/connect-telegram-channel.test.ts › expired code → not_found (expired_code)`**
   - Pre-seed a row with `expires_at` in the past; command throws `CommandError('not_found', details: { code: 'expired_code' })`.
5. **`connect-telegram-channel.test.ts › reused code → conflict (reused_code)`**
   - Pre-seed `status='consumed'`; command throws `CommandError('conflict', details: { code: 'reused_code' })`.
6. **`connect-telegram-channel.test.ts › adapter reports bot_not_admin → validation_failed (bot_not_admin), code remains active`**
   - Stub adapter to return `{ ok:false, errorCode:'bot_not_admin' }`; assert code's `status` is still `'active'` after the failed call.
7. **`connect-telegram-channel.test.ts › missing_post_permission → validation_failed (missing_post_permission)`**
   - Stub adapter; assert error code passthrough.
8. **`connect-telegram-channel.test.ts › channel taken by other workspace → conflict (channel_taken)`**
   - Pre-seed: `content_channels` row + `channel_connections` for workspace A. Call command for workspace B with same chat → unique violation maps to `CommandError('conflict', { code:'channel_taken' })`. Code stays active.
9. **`connect-telegram-channel.test.ts › private channel with bot admin succeeds`**
   - Edge case 3.8. Stub adapter returns `chatType='channel'`, `username=null`, `ok:true`. Assert `content_channels.username IS NULL`, `channel_connections.status='connected'`. (Note: private channel here means no `@username`; not Telegram's `private_chat` type — that one is rejected with `missing_post_permission`.)
10. **`connect-telegram-channel.test.ts › successful connect consumes code idempotently`**
    - Call once → success, code `consumed`. Call again with same idempotency key → `replayed:true`, returns same `channelConnection` via `loadFromPointer`.
11. **`packages/channel-adapters/src/telegram/__tests__/verify-connection.test.ts › getChat 400 → chat_not_found`**
    - Mock fetch to return Telegram's error shape; assert `{ ok:false, errorCode:'chat_not_found' }`.
12. **`verify-connection.test.ts › getChatMember status='member' → bot_not_admin`**
    - Mock getChat ok + getChatMember member; assert `bot_not_admin`.
13. **`verify-connection.test.ts › channel type + can_post_messages=false → missing_post_permission`**
14. **`verify-connection.test.ts › supergroup + administrator + can_post_messages undefined → ok`**
15. **`verify-connection.test.ts › fetch timeout → network errorCode (no throw)`**
16. **`apps/api/__tests__/routes-channels.test.ts › POST /channels/connect-codes returns 200 with code+deep_link`**
17. **`routes-channels.test.ts › POST /channels/connect expired code → 410 with code='expired_code'`**
18. **`routes-channels.test.ts › POST /channels/connect reused code → 409 with code='reused_code'`**
19. **`routes-channels.test.ts › POST /channels/connect channel taken → 409 with code='channel_taken'`**
20. **`routes-channels.test.ts › POST /channels/connect bot no post permission → 400 with code='missing_post_permission'`**
21. **`routes-channels.test.ts › GET /channels returns workspace's channels with status`**
22. **`apps/api/bot/__tests__/start-connect.test.ts › /start connect_<valid> replies with 'finish in Mini App' instruction`**
    - Assert command not called (Phase 2 just validates), reply text matches success-validation copy.
23. **`start-connect.test.ts › /start connect_<expired> replies 'code expired'`**
24. **`apps/miniapp/src/screens/__tests__/ChannelScreen.test.tsx › renders NotConnectedView when GET /channels empty`**
25. **`ChannelScreen.test.tsx › renders PendingView with copy-deep-link button after code creation`**

## Risks / open questions

1. **`bot.api.getMe()` at startup vs lazy:** if startup fails because the bot token can't reach Telegram, the whole API fails to start. Mitigation: defer adapter wiring; allow `channelAdapter` to be `undefined` and have routes 503 cleanly (mirror existing `app.pool` check pattern). Implementer should decide eager-fail vs graceful 503.
2. **Resolving `@username` → numeric `chat_id`:** Telegram's `getChat` accepts both. We pass `external_chat_id` through verbatim. After `verifyConnection`, the canonical numeric id is in `result.id` from `getChat`; **the adapter should return that numeric id alongside the response and the command stores THAT in `content_channels.external_id`**, not the user-typed `@username`. Document this in the adapter contract (currently `VerifyConnectionResult` doesn't carry the numeric id — implementer should add `externalId: string` to the result).
3. **Rate-limit values:** I picked 5/min for code creation, 10/min for connect, 60/min for list. These are guesses; production may want lower for code creation (creating codes is cheap server-side but wasteful for users). Implementer can tune.
4. **Code entropy vs UX:** 8 base32-Crockford chars = ~40 bits. With 1000 active codes worldwide, collision prob is ~1e-9 — safe. With brute force at 100 req/s for 30 min, attacker tries 1.8e5 codes against 1e12 space — also safe. But the deep-link is 60+ chars. If we wanted shorter, 6 chars = 30 bits would be borderline and forces stricter rate-limit. Stick with 8 unless UX feedback complains.
5. **`channel_connect_codes` cleanup:** active-but-expired codes accumulate until Phase 8 janitor lands. The bot/connect path correctly rejects them via `expires_at > now()` filter, so they're functionally inert. Table grows ~30 rows/workspace/day worst case; safe for Phase 2.
6. **Mini App start_param vs explicit code input:** if the user opens Mini App via deep-link, the `?startapp=connect_<code>` param carries the code, but they still need to type/paste the `@username`. UX nit: do we prefill anything in that case? Current spec says we prefill the code field. Implementer to confirm with design review (§15 in `13-MINIAPP-DESIGN-SYSTEM.md`).
7. **`assertWorkspaceRole`** lives in `packages/commands` because Phase 2 is the first need. If Phase 3+ also reads it from `packages/policies`, we should move it then (Phase 0 stubbed an empty `packages/policies/`).

## Status
In design (Phase 2 not yet implemented)

## Last touched
2026-05-15
