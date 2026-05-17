import { describe, expect, it } from 'vitest';
import type { RadarMatchProjection } from '../../api/types.ts';
import {
  formatPublishedAt,
  formatScore,
  selectRadarView,
  statusLabel,
  statusTone,
} from '../radarView.ts';

function mkItem(overrides: Partial<RadarMatchProjection> = {}): RadarMatchProjection {
  return {
    match_id: 'm1',
    workspace_id: 'w1',
    news_item_id: 'n1',
    cluster_id: null,
    score: 7.5,
    relevance_reason: 'ok',
    should_create_draft: false,
    risk_flags: [],
    score_components: {},
    ai_provider: null,
    used_model: null,
    prompt_version: null,
    status: 'candidate',
    scored_at: null,
    created_at: '2026-05-17T00:00:00Z',
    updated_at: '2026-05-17T00:00:00Z',
    news: {
      title: 'Title',
      url: 'https://example.com',
      canonical_url: 'https://example.com',
      summary: null,
      published_at: null,
      language: 'ru',
    },
    source: { id: 's1', name: 'Source', canonical_url: 'https://example.com/feed' },
    cluster: null,
    ...overrides,
  };
}

describe('selectRadarView', () => {
  it('returns loading state', () => {
    expect(selectRadarView({ loading: true, errored: false, items: undefined })).toEqual({
      kind: 'loading',
    });
  });
  it('returns error state', () => {
    expect(selectRadarView({ loading: false, errored: true, items: undefined })).toEqual({
      kind: 'error',
    });
  });
  it('returns empty state when items array is empty', () => {
    expect(selectRadarView({ loading: false, errored: false, items: [] })).toEqual({
      kind: 'empty',
    });
  });
  it('returns empty state when items is undefined', () => {
    expect(selectRadarView({ loading: false, errored: false, items: undefined })).toEqual({
      kind: 'empty',
    });
  });
  it('returns list state with items', () => {
    const items = [mkItem()];
    expect(selectRadarView({ loading: false, errored: false, items })).toEqual({
      kind: 'list',
      items,
    });
  });
});

describe('formatScore', () => {
  it('null → em-dash', () => {
    expect(formatScore(null)).toBe('—');
  });
  it('integer keeps .0 suffix', () => {
    expect(formatScore(8)).toBe('8.0');
  });
  it('decimal rounds to one place', () => {
    expect(formatScore(8.44)).toBe('8.4');
  });
  it('non-finite → em-dash', () => {
    expect(formatScore(NaN)).toBe('—');
    expect(formatScore(Infinity)).toBe('—');
  });
});

describe('statusLabel / statusTone', () => {
  it('covers every status', () => {
    const statuses: RadarMatchProjection['status'][] = [
      'candidate',
      'low_score',
      'filtered_negative',
      'hidden',
      'ai_refused',
      'suppressed',
    ];
    for (const s of statuses) {
      expect(statusLabel(s).length).toBeGreaterThan(0);
      expect(statusTone(s)).toMatch(/^(neutral|positive|warning|danger)$/);
    }
  });
  it('candidate is positive, ai_refused is warning', () => {
    expect(statusTone('candidate')).toBe('positive');
    expect(statusTone('ai_refused')).toBe('warning');
  });
});

describe('formatPublishedAt', () => {
  const now = Date.parse('2026-05-17T12:00:00Z');
  it('returns empty for null/invalid', () => {
    expect(formatPublishedAt(null, now)).toBe('');
    expect(formatPublishedAt('not a date', now)).toBe('');
  });
  it('< 1 min → "только что"', () => {
    expect(formatPublishedAt('2026-05-17T11:59:50Z', now)).toBe('только что');
  });
  it('< 60 min → "X мин назад"', () => {
    expect(formatPublishedAt('2026-05-17T11:30:00Z', now)).toBe('30 мин назад');
  });
  it('< 24 h → "X ч назад"', () => {
    expect(formatPublishedAt('2026-05-17T07:00:00Z', now)).toBe('5 ч назад');
  });
  it('< 7 d → "X д назад"', () => {
    expect(formatPublishedAt('2026-05-14T12:00:00Z', now)).toBe('3 д назад');
  });
  it('older → absolute date', () => {
    const out = formatPublishedAt('2026-04-01T12:00:00Z', now);
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toMatch(/назад/);
  });
});
