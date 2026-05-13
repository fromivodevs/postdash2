-- Phase 0: only pgvector extension.
-- Tables come in Phase 1+ (see tg_mvp_plan/03-DATABASE-SCHEMA.md).
-- Use IF NOT EXISTS so re-running is safe.

CREATE EXTENSION IF NOT EXISTS vector;
