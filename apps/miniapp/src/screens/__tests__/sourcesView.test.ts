import { describe, expect, it } from 'vitest';
import {
  formatLastFetched,
  isRowDeleting,
  isRowToggling,
  selectSourcesView,
} from '../sourcesView.ts';
import type { SourceSubscriptionProjection } from '@postdash/shared';

const SUB: SourceSubscriptionProjection = {
  subscription_id: 'sub-1',
  source: {
    id: 'src-1',
    type: 'rss',
    url: 'https://example.com/feed.xml',
    canonical_url: 'https://example.com/feed.xml',
    name: 'Example',
    fetch_interval_minutes: 60,
    last_fetched_at: null,
    last_fetch_status: null,
    last_fetch_error: null,
    status: 'active',
  },
  enabled: true,
  priority: 50,
  topic_profile_id: null,
  created_at: '2026-05-17T00:00:00Z',
};

describe('selectSourcesView', () => {
  it('loading short-circuits', () => {
    const v = selectSourcesView({ loading: true, errored: false, items: [SUB] });
    expect(v.kind).toBe('loading');
    expect(v.items).toEqual([]);
  });

  it('error short-circuits', () => {
    const v = selectSourcesView({ loading: false, errored: true, items: [SUB] });
    expect(v.kind).toBe('error');
    expect(v.items).toEqual([]);
  });

  it('null/undefined items → empty', () => {
    expect(selectSourcesView({ loading: false, errored: false, items: null }).kind).toBe('empty');
    expect(selectSourcesView({ loading: false, errored: false, items: undefined }).kind).toBe('empty');
  });

  it('zero items → empty', () => {
    expect(selectSourcesView({ loading: false, errored: false, items: [] }).kind).toBe('empty');
  });

  it('items present → list', () => {
    const v = selectSourcesView({ loading: false, errored: false, items: [SUB] });
    expect(v.kind).toBe('list');
    expect(v.items).toHaveLength(1);
  });
});

describe('formatLastFetched', () => {
  it('null → "пока не проверялся"', () => {
    expect(formatLastFetched(null)).toBe('пока не проверялся');
  });

  it('undefined → "пока не проверялся"', () => {
    expect(formatLastFetched(undefined)).toBe('пока не проверялся');
  });

  it('invalid ISO → "пока не проверялся"', () => {
    expect(formatLastFetched('not a date')).toBe('пока не проверялся');
  });

  it('valid ISO → localised string', () => {
    const out = formatLastFetched('2026-05-17T12:34:56Z');
    // Don't assert the exact string (locale data varies between Node versions)
    // — just that it's no longer the placeholder copy.
    expect(out).not.toBe('пока не проверялся');
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('isRowToggling / isRowDeleting', () => {
  it('false when no pending id', () => {
    expect(isRowToggling('src-1', null)).toBe(false);
    expect(isRowDeleting('src-1', null)).toBe(false);
  });

  it('true when pending id matches', () => {
    expect(isRowToggling('src-1', 'src-1')).toBe(true);
    expect(isRowDeleting('src-2', 'src-2')).toBe(true);
  });

  it('false when pending id differs (sibling row unaffected)', () => {
    expect(isRowToggling('src-1', 'src-2')).toBe(false);
    expect(isRowDeleting('src-1', 'src-2')).toBe(false);
  });
});
