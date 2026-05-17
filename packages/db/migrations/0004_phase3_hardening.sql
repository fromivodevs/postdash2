-- Phase 3 hardening (added in perfect-loop): two partial UNIQUE indices to
-- close race windows that the application-layer upsert logic left open.
--
-- Why these can't be edited into 0003: the CHECK-edit caveat at the top of
-- 0003_phase3.sql applies — CREATE TABLE IF NOT EXISTS skips on a DB that
-- already ran 0003. New constraints land via a fresh migration file.
--
-- Rollback artifact: 0004_phase3_hardening.down.sql.

-- =============================================================================
-- topic_profiles: one active profile per workspace (MVP UX invariant)
-- =============================================================================
--
-- The architecture doc + createTopicProfile command both claim "one active
-- profile per workspace". The application layer enforced this via a
-- transaction-scoped SELECT-then-INSERT. Under READ COMMITTED two concurrent
-- requests from the same workspace can both see "no existing profile" and
-- both INSERT, producing two active profiles. A subsequent createTopicProfile
-- only updates one of them (the .limit(1) winner), silently leaking state.
--
-- Partial UNIQUE index closes this at the DB layer. The trade-off: a direct
-- INSERT (raw SQL, future migration) for a SECOND active profile fails with
-- 23505 — the command layer catches that, treats it as "concurrent winner
-- created it; re-run upsert" and converges.
CREATE UNIQUE INDEX IF NOT EXISTS topic_profiles_one_active_per_workspace_uniq
  ON topic_profiles (workspace_id)
  WHERE status = 'active';

-- =============================================================================
-- workspace_source_subscriptions: one default-profile subscription per (workspace, source)
-- =============================================================================
--
-- The 3-column UNIQUE (workspace_id, source_id, topic_profile_id) in 0003
-- treats two NULLs as distinct per vanilla Postgres semantics — the 0003
-- migration comment even documented this. createSource's NULL-profile branch
-- did SELECT-then-INSERT-or-UPDATE which races the same way as topic_profiles.
--
-- Partial UNIQUE index on (workspace_id, source_id) WHERE topic_profile_id IS
-- NULL gives us the missing slot, enabling a single-statement
-- ON CONFLICT DO UPDATE in the command layer (collapsed from 2 round-trips to
-- 1, and now race-safe).
CREATE UNIQUE INDEX IF NOT EXISTS workspace_source_subscriptions_default_per_source_uniq
  ON workspace_source_subscriptions (workspace_id, source_id)
  WHERE topic_profile_id IS NULL;
