import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_POLICY,
  EnqueueTaskInputSchema,
  TASK_TYPES,
  TASK_STATUSES,
} from '../types.js';

/**
 * Pure type/schema tests — no DB. Queue-level integration is covered by the
 * worker handler tests where the queue is exercised end-to-end through
 * dispatcher + mock SQL.
 */

describe('TASK_TYPES', () => {
  it('mirrors the migration CHECK constraint exactly', () => {
    expect(TASK_TYPES).toStrictEqual([
      'fetch_source',
      'extract_news_item',
      'embed_news_item',
      'cluster_news',
      'janitor_release_stuck_tasks',
      'refresh_iam_token',
    ]);
  });
});

describe('TASK_STATUSES', () => {
  it('mirrors the migration CHECK constraint', () => {
    expect(TASK_STATUSES).toStrictEqual([
      'pending',
      'running',
      'completed',
      'failed',
      'failed_permanent',
      'deferred',
      'skipped_volume_cap',
      'cancelled',
    ]);
  });
});

describe('EnqueueTaskInputSchema', () => {
  it('accepts a minimal task', () => {
    const r = EnqueueTaskInputSchema.safeParse({ type: 'fetch_source' });
    expect(r.success).toBe(true);
  });
  it('rejects unknown type', () => {
    const r = EnqueueTaskInputSchema.safeParse({ type: 'unknown_task' });
    expect(r.success).toBe(false);
  });
  it('rejects priority out of range', () => {
    const r = EnqueueTaskInputSchema.safeParse({ type: 'fetch_source', priority: 101 });
    expect(r.success).toBe(false);
  });
  it('rejects non-uuid sourceId', () => {
    const r = EnqueueTaskInputSchema.safeParse({ type: 'fetch_source', sourceId: 'not-uuid' });
    expect(r.success).toBe(false);
  });
});

describe('DEFAULT_RETRY_POLICY', () => {
  it('uses 10s → 30s → 90s backoff (matches §15 of WORKERS-AND-INGESTION)', () => {
    expect(DEFAULT_RETRY_POLICY.backoffSeconds).toStrictEqual([10, 30, 90]);
  });
});
