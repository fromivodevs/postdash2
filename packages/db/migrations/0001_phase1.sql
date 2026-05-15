-- Phase 1 schema: identity, workspace, idempotency, audit.
-- Mirrors packages/db/src/schema.ts. See tg_mvp_plan/03-DATABASE-SCHEMA.md.
--
-- NO explicit BEGIN/COMMIT here on purpose: the migrate runner
-- (packages/db/src/migrate.ts) wraps this whole file AND its `_migrations`
-- ledger INSERT in one `client.begin(...)` transaction, so a mid-run failure
-- (process killed between two CREATE TABLEs) rolls back both the schema and the
-- ledger row — the file is never left applied-but-unrecorded. Adding BEGIN/COMMIT
-- here would nest transactions and split the ledger insert back out of the body.
-- Rollback artifact: 0001_phase1.down.sql.

-- CHECK-edit caveat: every table below uses CREATE TABLE IF NOT EXISTS, so on a
-- DB that has already run this migration, editing a CHECK constraint *in this
-- file* is a no-op -- the table is skipped entirely. A future constraint change
-- (e.g. adding an allowed status value) needs its own new ALTER TABLE migration
-- file, not an in-place edit here.

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'active',
  primary_telegram_identity_id uuid,
  last_active_workspace_id uuid,
  CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  -- ON DELETE RESTRICT: account removal is a soft-delete (users.status =
  -- 'disabled'), never a row DELETE. This FK enforces that — a creator row
  -- cannot be hard-deleted while a workspace still references it.
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'active',
  CONSTRAINT workspaces_status_check CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE IF NOT EXISTS telegram_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  telegram_user_id bigint NOT NULL,
  username text,
  first_name text,
  last_name text,
  photo_url text,
  linked_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'active',
  last_seen_at timestamptz,
  CONSTRAINT telegram_identities_telegram_user_id_unique UNIQUE (telegram_user_id),
  CONSTRAINT telegram_identities_status_check
    CHECK (status IN ('active', 'blocked_bot', 'revoked'))
);
CREATE INDEX IF NOT EXISTS telegram_identities_user_id_idx ON telegram_identities (user_id);

CREATE TABLE IF NOT EXISTS workspace_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'active',
  CONSTRAINT workspace_members_workspace_user_unique UNIQUE (workspace_id, user_id),
  CONSTRAINT workspace_members_role_check
    CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  CONSTRAINT workspace_members_status_check CHECK (status IN ('active', 'removed'))
);
CREATE INDEX IF NOT EXISTS workspace_members_user_id_idx ON workspace_members (user_id);

CREATE TABLE IF NOT EXISTS command_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  command_type text NOT NULL,
  idempotency_key text NOT NULL,
  result_object_type text,
  result_object_id uuid,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT command_idempotency_unique UNIQUE (command_type, idempotency_key),
  -- Only 'pending' and 'success' are ever persisted: a failed work() DELETEs
  -- its slot rather than marking it 'failed' (see runIdempotent in
  -- packages/commands/src/idempotency.ts).
  CONSTRAINT command_idempotency_status_check
    CHECK (status IN ('pending', 'success'))
);
CREATE INDEX IF NOT EXISTS command_idempotency_expires_at_idx ON command_idempotency (expires_at);

CREATE TABLE IF NOT EXISTS operation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid,
  user_id uuid,
  telegram_user_id bigint,
  command_type text NOT NULL,
  object_type text,
  object_id uuid,
  payload_summary jsonb,
  result text NOT NULL,
  error_message text,
  -- correlation_id / idempotency_key are forward-provisions: Phase 1 commands
  -- write neither (see authenticate-telegram.ts / mark-bot-blocked.ts).
  --
  -- =========================================================================
  -- SECURITY -- idempotency_key MUST NEVER store the raw `tma:<hash>` auth key.
  -- =========================================================================
  -- That hash is a session-bound credential (HMAC over the whole initData), so
  -- persisting it here would turn operation_log into a credential store. The
  -- FIRST writer of this column (a later-phase operation_log insert) MUST
  -- hash/truncate the value to a non-reversible digest before it reaches this
  -- row -- treat that as a hard review gate. Mirrored in schema.ts.
  -- =========================================================================
  correlation_id text,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The command layer only ever writes 'success' today (see
  -- authenticate-telegram.ts / mark-bot-blocked.ts). 'failure' is an
  -- intentional forward-provision for later phases so a failing command can be
  -- logged without a migration -- not an oversight.
  CONSTRAINT operation_log_result_check CHECK (result IN ('success', 'failure'))
);
CREATE INDEX IF NOT EXISTS operation_log_workspace_created_at_idx ON operation_log (workspace_id, created_at);
CREATE INDEX IF NOT EXISTS operation_log_command_created_at_idx ON operation_log (command_type, created_at);
CREATE INDEX IF NOT EXISTS operation_log_user_created_at_idx ON operation_log (user_id, created_at);

-- Note: deferred FK from users.last_active_workspace_id -> workspaces.id is
-- intentionally NOT added (creates chicken-and-egg with workspaces.created_by).
-- Application layer enforces consistency via transactions.
