import { describe, expect, it } from 'vitest';
import {
  ListRadarMatchesInputSchema,
  SuppressWorkspaceNewsMatchInputSchema,
  UpsertWorkspaceNewsMatchInputSchema,
  WORKSPACE_NEWS_MATCH_STATUSES,
} from '../workspace-news-matches.js';

const UUID = '00000000-0000-0000-0000-000000000001';

describe('WORKSPACE_NEWS_MATCH_STATUSES', () => {
  it('mirrors the migration CHECK constraint exactly', () => {
    expect(WORKSPACE_NEWS_MATCH_STATUSES).toStrictEqual([
      'candidate',
      'filtered_negative',
      'hidden',
      'ai_refused',
      'low_score',
      'suppressed',
    ]);
  });
});

describe('UpsertWorkspaceNewsMatchInputSchema', () => {
  const base = {
    workspaceId: UUID,
    newsItemId: UUID,
    clusterId: null,
    score: 7.5,
    relevanceReason: 'good match',
    shouldCreateDraft: true,
    riskFlags: [],
    scoreComponents: { llm: 8, cosine: 0.9, freshness: 0.7, reliability: 0.6, weighted: 7.5 },
    aiProvider: 'yandex-deepseek',
    usedModel: 'yandex-deepseek-v3.2',
    promptVersion: 'yandex-deepseek-score@v1.0',
    status: 'candidate' as const,
    scoredAt: new Date(),
  };

  it('accepts a valid scored row', () => {
    const r = UpsertWorkspaceNewsMatchInputSchema.safeParse(base);
    expect(r.success).toBe(true);
  });

  it('accepts null score for filtered rows', () => {
    const r = UpsertWorkspaceNewsMatchInputSchema.safeParse({
      ...base,
      score: null,
      relevanceReason: null,
      status: 'filtered_negative',
      aiProvider: null,
      usedModel: null,
      promptVersion: null,
      scoredAt: null,
    });
    expect(r.success).toBe(true);
  });

  it('rejects out-of-range score', () => {
    const r = UpsertWorkspaceNewsMatchInputSchema.safeParse({ ...base, score: 11 });
    expect(r.success).toBe(false);
  });

  it('rejects relevance_reason > 280 chars', () => {
    const r = UpsertWorkspaceNewsMatchInputSchema.safeParse({
      ...base,
      relevanceReason: 'a'.repeat(281),
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown status', () => {
    const r = UpsertWorkspaceNewsMatchInputSchema.safeParse({
      ...base,
      status: 'mystery',
    });
    expect(r.success).toBe(false);
  });
});

describe('SuppressWorkspaceNewsMatchInputSchema', () => {
  it('accepts well-formed input', () => {
    const r = SuppressWorkspaceNewsMatchInputSchema.safeParse({
      matchId: UUID,
      workspaceId: UUID,
      userId: UUID,
    });
    expect(r.success).toBe(true);
  });
  it('rejects non-uuid', () => {
    const r = SuppressWorkspaceNewsMatchInputSchema.safeParse({
      matchId: 'not-uuid',
      workspaceId: UUID,
      userId: UUID,
    });
    expect(r.success).toBe(false);
  });
});

describe('ListRadarMatchesInputSchema', () => {
  it('defaults to status=candidate, page=1, pageSize=20', () => {
    const r = ListRadarMatchesInputSchema.parse({ workspaceId: UUID, userId: UUID });
    expect(r.status).toBe('candidate');
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(20);
  });
  it('accepts "all" sentinel for status', () => {
    const r = ListRadarMatchesInputSchema.safeParse({
      workspaceId: UUID,
      userId: UUID,
      status: 'all',
    });
    expect(r.success).toBe(true);
  });
  it('caps pageSize at 50', () => {
    const r = ListRadarMatchesInputSchema.safeParse({
      workspaceId: UUID,
      userId: UUID,
      pageSize: 51,
    });
    expect(r.success).toBe(false);
  });
  it('accepts minScore + maxScore filters', () => {
    const r = ListRadarMatchesInputSchema.parse({
      workspaceId: UUID,
      userId: UUID,
      minScore: 5,
      maxScore: 9.5,
    });
    expect(r.minScore).toBe(5);
    expect(r.maxScore).toBe(9.5);
  });
});
