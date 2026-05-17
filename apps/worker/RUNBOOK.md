# PostDash Worker — Operations Runbook

> Quick triage guide for 3am situations. Full architecture: `architecture/global-ingestion.md`.

## What this process does

Single Node process (`apps/worker/`). Polls the `tasks` table from Postgres, dispatches by `tasks.type` to one of 6 handlers (fetch_source / extract_news_item / embed_news_item / cluster_news / janitor_release_stuck_tasks / refresh_iam_token). Also runs an in-process scheduler (fastTick 1/min for fetch enqueue, slowTick 5/min for janitor + IAM refresh).

## Quick health check (no /health endpoint yet — see Known follow-ups)

```sql
-- Is the scheduler ticking?
SELECT type, status, count(*), max(scheduled_at) AS latest
FROM tasks
GROUP BY type, status
ORDER BY type, status;
-- 'pending' fetch_source rows should refresh every ~1 min;
-- if `latest` is hours old → scheduler.fastTick is not running.

-- Oldest pending task age (queue depth proxy)
SELECT type, now() - min(scheduled_at) AS oldest_pending_age
FROM tasks
WHERE status = 'pending'
GROUP BY type;

-- IAM token expiry
SELECT key, expires_at, expires_at - now() AS time_left
FROM system_state
WHERE key = 'ya_iam_token';
```

## Common scenarios

### Symptom: news stops appearing in Radar

1. Check sources health:
   ```sql
   SELECT status, count(*) FROM sources WHERE type = 'rss' GROUP BY status;
   -- 'error' sources are retried every 60 min via scheduler.fastTick.
   -- A spike in 'error' typically means: external feeds 5xx, network issue,
   -- or YA_SA_KEY_JSON expired (look at recent ai_usage_events).
   ```
2. Check task pipeline depth:
   ```sql
   SELECT type, status, count(*)
   FROM tasks
   WHERE status IN ('pending', 'running', 'failed_permanent')
   GROUP BY type, status;
   ```
3. Check embedding backlog:
   ```sql
   SELECT embedding_status, count(*)
   FROM global_news_items
   GROUP BY embedding_status;
   -- 'failed' rows accumulate after Yandex outages; no automatic backfill
   -- in Phase 4 (see Known follow-ups). To re-enqueue:
   --   UPDATE global_news_items SET embedding_status = 'pending'
   --   WHERE embedding_status = 'failed' AND updated_at < now() - interval '1 hour'
   --   LIMIT 100;
   -- Then INSERT INTO tasks (type, payload) VALUES ('embed_news_item',
   --   jsonb_build_object('news_item_id', id)) for each.
   ```

### Symptom: tasks stuck in 'running' status

Janitor (`janitor_release_stuck_tasks`) resets stuck tasks every 5 min (lease = 5 min default). If running tasks pile up:
- Check `select count(*) from tasks where status='running' AND locked_until < now();` — janitor should reset these
- If janitor itself is stuck, manually:
  ```sql
  UPDATE tasks
  SET status = CASE WHEN attempts >= max_attempts THEN 'failed_permanent' ELSE 'pending' END,
      locked_by = NULL, locked_until = NULL, last_error = 'manual_janitor_release'
  WHERE status = 'running' AND locked_until < now() - interval '10 minutes';
  ```

### Symptom: Yandex IAM token expired or revoked

- Worker logs `IAM exchange failed: HTTP 401` → SA key invalid.
- Force-refresh: `DELETE FROM system_state WHERE key = 'ya_iam_token';` — next worker poll re-mints.
- If new tokens also fail: SA key revoked → regenerate `YA_SA_KEY_JSON` in env, redeploy worker.

### Symptom: deploy stranded leased tasks

Worker SIGTERM doesn't await in-flight handlers (Phase 8 follow-up — graceful drain). Behaviour: leased tasks remain `status='running'` until janitor reset 5 min later. Acceptable for low-frequency deploys; visible as 5-min throughput dip per deploy.

### Symptom: tasks_polling_idx lock contention

Verify migration 0007 applied (`SELECT * FROM _migrations WHERE name LIKE '%phase4_perf%';`). The polling index column order was fixed in 0007 from `(status, scheduled_at, priority DESC)` to `(priority DESC, scheduled_at ASC) WHERE status='pending'`. Without 0007, Postgres heap-sorts every poll → all worker slots serialize at sort step under load.

## Manual operations

### Re-enqueue a fetch for a specific source

```sql
INSERT INTO tasks (type, priority, source_id, payload)
VALUES ('fetch_source', 80, '<source-uuid>', '{}'::jsonb)
ON CONFLICT (source_id) WHERE type='fetch_source' AND status IN ('pending','running')
DO NOTHING;
```
Priority 80 = user-requested (vs scheduler's 40 = background).

### Reset a source from 'error' to 'active' manually

(Normally automatic via scheduler.fastTick 60-min retry, but if you want to retry now):
```sql
UPDATE sources SET status = 'active', updated_at = now()
WHERE id = '<source-uuid>' AND status = 'error';
```
Next fastTick will pick it up.

### Wipe failed_permanent tasks older than a week

```sql
DELETE FROM tasks
WHERE status = 'failed_permanent' AND completed_at < now() - interval '7 days';
```
(task_runs retention is Phase 8 work — until then, manual cleanup.)

## Known follow-ups (Phase 8)

Not implemented in Phase 4 — see `architecture/global-ingestion.md` "Known follow-ups (Phase 4+ ops)" section:

- Worker `/health` HTTP endpoint
- SIGTERM graceful drain
- Stranded `global_news_items` reaper
- `embedding_status='failed'` backfill task
- `task_runs` retention cron
- `ivfflat` REINDEX policy after corpus growth
- `system_state` IAM token encryption-at-rest
- Connect-time IP pinning in rss-parser (TOCTOU DNS)
- Integration test harness for 5 plan-promised DB-backed scenarios

These are addressed in Phase 8 — MVP hardening, notifications, source health (`tg_mvp_plan/08-IMPLEMENTATION-ROADMAP.md`).
