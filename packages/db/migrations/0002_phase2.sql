-- Phase 2 schema: channel connection (content_channels, channel_connections,
-- channel_connect_codes). See architecture/channel-connection.md.
--
-- Mirrors packages/db/src/schema.ts. See tg_mvp_plan/03-DATABASE-SCHEMA.md.
--
-- NO explicit BEGIN/COMMIT here on purpose: the migrate runner
-- (packages/db/src/migrate.ts) wraps this whole file AND its `_migrations`
-- ledger INSERT in one `client.begin(...)` transaction, so a mid-run failure
-- (process killed between two CREATE TABLEs) rolls back both the schema and the
-- ledger row — the file is never left applied-but-unrecorded. Adding BEGIN/COMMIT
-- here would nest transactions and split the ledger insert back out of the body.
-- Rollback artifact: 0002_phase2.down.sql.

-- CHECK-edit caveat: every table below uses CREATE TABLE IF NOT EXISTS, so on a
-- DB that has already run this migration, editing a CHECK constraint *in this
-- file* is a no-op -- the table is skipped entirely. A future constraint change
-- (e.g. adding 'vk' to platform allowed values) needs its own new ALTER TABLE
-- migration file, not an in-place edit here.

-- content_channels: platform-global identity for a publish target. Workspace
-- binding lives one level up in channel_connections (architecture Rule 1:
-- Telegram is an adapter, not the core).
CREATE TABLE IF NOT EXISTS content_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL,
  -- external_id stored as text (not bigint): Telegram chat_ids fit in int64
  -- but choosing text keeps the column shape uniform across future platforms
  -- whose IDs are alphanumeric (Discord snowflakes, etc.). One ALTER avoided
  -- per new platform.
  external_id text NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  username text,
  photo_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_channels_platform_check CHECK (platform IN ('telegram')),
  CONSTRAINT content_channels_type_check
    CHECK (type IN ('channel', 'supergroup', 'group', 'private_chat')),
  CONSTRAINT content_channels_platform_external_unique UNIQUE (platform, external_id)
);
CREATE INDEX IF NOT EXISTS content_channels_platform_idx ON content_channels (platform);

-- channel_connections: workspace -> content_channel binding. UNIQUE on
-- content_channel_id enforces single-workspace ownership in Phase 2 (relaxed in
-- Phase 9 for agency mode).
CREATE TABLE IF NOT EXISTS channel_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- ON DELETE RESTRICT: a content_channels row should never be hard-deleted
  -- while a binding exists. The channel identity survives workspace churn.
  content_channel_id uuid NOT NULL REFERENCES content_channels(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending',
  -- can_post_messages NULL = "never verified" (pending); true/false after first
  -- verifyConnection. Lets UI distinguish pending vs broken.
  can_post_messages boolean,
  last_verify_status text,
  -- last_verify_error: SHORT human label (<=200 chars). Stack traces go to
  -- logs only, never to this column.
  last_verify_error text,
  last_verified_at timestamptz,
  connected_at timestamptz,
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
  -- a partial-unique excluding 'revoked', but for MVP this enforces edge-case
  -- 3.3 ("channel taken by another workspace").
  CONSTRAINT channel_connections_content_channel_unique UNIQUE (content_channel_id)
);
CREATE INDEX IF NOT EXISTS channel_connections_workspace_idx
  ON channel_connections (workspace_id, status);

-- channel_connect_codes: one-time, TTL-bound (30 min) handshake tokens.
-- Plaintext code is shown to the user once (API response + deep-link); DB
-- stores code_hash only. Treat as a session-bearer token at rest.
CREATE TABLE IF NOT EXISTS channel_connect_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- ON DELETE RESTRICT: same soft-delete policy as workspaces.created_by_user_id.
  -- An account is disabled via users.status='disabled', never row-deleted, so
  -- this FK is the enforcer of that policy.
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  -- =========================================================================
  -- SECURITY -- code_hash is sha256(plaintext_code) hex.
  -- =========================================================================
  -- The plaintext code is a short-lived bearer token shared in the deep-link
  -- URL. Storing plaintext here would turn at-rest leakage (backups, replicas,
  -- log spillover) into "any active code is redeemable by the leaker". sha256
  -- + 40-bit code + TTL + single-use + rate limit on POST /channels/connect
  -- makes brute force infeasible. NEVER persist plaintext in this column or
  -- in operation_log.payload_summary or command_idempotency.idempotency_key.
  -- Mirrored in schema.ts and architecture doc Invariant 1.
  -- =========================================================================
  code_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by_telegram_user_id bigint,
  -- consumed_by_external_chat_id: which chat the code was actually bound to.
  -- Defence against a bot-side race where the wrong chat_id reaches redeem.
  consumed_by_external_chat_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_connect_codes_status_check
    CHECK (status IN ('active', 'consumed', 'expired')),
  CONSTRAINT channel_connect_codes_code_hash_unique UNIQUE (code_hash)
);
-- Two narrow indexes for distinct access patterns:
--   (status, expires_at) -- janitor sweeps expired-but-active codes.
--   (workspace_id, status) -- UI list "my workspace's active codes".
-- Lookup by code_hash is already covered by the UNIQUE constraint.
CREATE INDEX IF NOT EXISTS channel_connect_codes_status_expires_at_idx
  ON channel_connect_codes (status, expires_at);
CREATE INDEX IF NOT EXISTS channel_connect_codes_workspace_idx
  ON channel_connect_codes (workspace_id, status);
