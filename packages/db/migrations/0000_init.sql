-- Phase 0: only pgvector extension.
-- Tables come in Phase 1+ (see tg_mvp_plan/03-DATABASE-SCHEMA.md).
-- Use IF NOT EXISTS so re-running is safe.
--
-- NO explicit BEGIN/COMMIT here: the migrate runner (packages/db/src/migrate.ts)
-- wraps this whole file AND its `_migrations` ledger INSERT in one
-- `client.begin(...)` transaction. Adding BEGIN/COMMIT here would nest
-- transactions and split the ledger insert out of the migration body.

CREATE EXTENSION IF NOT EXISTS vector;
