import { describe, expect, it, vi } from 'vitest';
import {
  createSource,
  deleteSourceSubscription,
  listSources,
  updateSourceSubscription,
} from '../sources.js';
import { makeMockDb } from './_mock-db.js';

const WORKSPACE = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const SOURCE = '44444444-4444-4444-4444-444444444444';
const SUBSCRIPTION = '55555555-5555-5555-5555-555555555555';
const TOPIC = '33333333-3333-3333-3333-333333333333';

function policyOk(role: 'editor' | 'viewer' = 'editor') {
  return [{ role, status: 'active' }];
}

function sourceRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SOURCE,
    type: 'rss',
    url: 'https://example.com/feed.xml',
    canonicalUrl: 'https://example.com/feed.xml',
    name: null,
    fetchIntervalMinutes: 60,
    maxItemsPerFetch: 50,
    reliabilityScore: null,
    lastFetchedAt: null,
    lastFetchStatus: null,
    lastFetchError: null,
    canonicalizationRuleVersion: 'v1',
    status: 'active',
    createdAt: new Date('2026-05-17T00:00:00Z'),
    updatedAt: new Date('2026-05-17T00:00:00Z'),
    ...overrides,
  };
}

function subscriptionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SUBSCRIPTION,
    workspaceId: WORKSPACE,
    sourceId: SOURCE,
    topicProfileId: null,
    enabled: true,
    priority: 50,
    customRules: {},
    createdAt: new Date('2026-05-17T00:00:00Z'),
    updatedAt: new Date('2026-05-17T00:00:00Z'),
    ...overrides,
  };
}

describe('createSource', () => {
  it('rejects unparseable URL with validation_failed', async () => {
    const resolve = vi.fn().mockResolvedValue({ finalUrl: 'ftp://invalid' });
    const mock = makeMockDb({});
    await expect(
      createSource(
        mock.db,
        {
          workspaceId: WORKSPACE,
          userId: USER,
          url: 'ftp://invalid',
          type: 'rss',
        },
        { resolveRedirect: resolve },
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('inserts a fresh source + subscription on first add', async () => {
    const resolve = vi.fn().mockResolvedValue({ finalUrl: 'https://example.com/feed.xml' });
    const fresh = sourceRow();
    const mock = makeMockDb({
      selectResults: [policyOk('editor'), []],
      insertResults: [[fresh], [subscriptionRow()]],
    });
    const r = await createSource(
      mock.db,
      {
        workspaceId: WORKSPACE,
        userId: USER,
        url: 'https://example.com/feed.xml?utm_source=x',
        type: 'rss',
      },
      { resolveRedirect: resolve },
    );
    expect(resolve).toHaveBeenCalledWith('https://example.com/feed.xml?utm_source=x');
    expect(r.sourceCreated).toBe(true);
    expect(r.subscriptionCreated).toBe(true);
    expect(r.source.canonicalUrl).toBe('https://example.com/feed.xml');
  });

  it('reuses the existing global source when canonical_url collides (cross-workspace dedup)', async () => {
    const resolve = vi.fn().mockResolvedValue({ finalUrl: 'https://example.com/feed.xml' });
    // sourceCreated = false when createdAt < updatedAt (existing row was UPDATEd, not INSERTed).
    const existing = sourceRow({
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-05-17T00:00:00Z'),
    });
    const mock = makeMockDb({
      selectResults: [policyOk('editor'), []],
      insertResults: [[existing], [subscriptionRow()]],
    });
    const r = await createSource(
      mock.db,
      {
        workspaceId: WORKSPACE,
        userId: USER,
        url: 'https://example.com/feed.xml',
        type: 'rss',
      },
      { resolveRedirect: resolve },
    );
    expect(r.sourceCreated).toBe(false);
    // Subscription is fresh — the OTHER workspace had this source, ours
    // didn't.
    expect(r.subscriptionCreated).toBe(true);
  });

  it('re-enables an existing disabled subscription on re-add', async () => {
    const resolve = vi.fn().mockResolvedValue({ finalUrl: 'https://example.com/feed.xml' });
    const mock = makeMockDb({
      selectResults: [policyOk('editor'), [subscriptionRow({ enabled: false })]],
      insertResults: [[sourceRow()]],
      updateResults: [[subscriptionRow({ enabled: true })]],
    });
    const r = await createSource(
      mock.db,
      {
        workspaceId: WORKSPACE,
        userId: USER,
        url: 'https://example.com/feed.xml',
        type: 'rss',
      },
      { resolveRedirect: resolve },
    );
    expect(r.subscriptionCreated).toBe(false);
    expect(r.subscription.enabled).toBe(true);
    expect(mock.calls).toContain('update');
  });

  it('rejects topic_profile_id from a different workspace with forbidden', async () => {
    const resolve = vi.fn().mockResolvedValue({ finalUrl: 'https://example.com/feed.xml' });
    const mock = makeMockDb({
      selectResults: [
        policyOk('editor'),
        [{ workspaceId: '99999999-9999-9999-9999-999999999999' }],
      ],
    });
    await expect(
      createSource(
        mock.db,
        {
          workspaceId: WORKSPACE,
          userId: USER,
          url: 'https://example.com/feed.xml',
          type: 'rss',
          topicProfileId: TOPIC,
        },
        { resolveRedirect: resolve },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('does not block source creation when redirect resolution fails (fallback to input URL)', async () => {
    // The resolver returns the input URL on network error per its contract;
    // createSource simply canonicalizes whatever the resolver returned.
    const resolve = vi.fn().mockResolvedValue({ finalUrl: 'https://offline.example/' });
    const mock = makeMockDb({
      selectResults: [policyOk('editor'), []],
      insertResults: [[sourceRow({ url: 'https://offline.example/', canonicalUrl: 'https://offline.example/' })], [subscriptionRow()]],
    });
    const r = await createSource(
      mock.db,
      {
        workspaceId: WORKSPACE,
        userId: USER,
        url: 'https://offline.example/',
        type: 'rss',
      },
      { resolveRedirect: resolve },
    );
    expect(r.source.url).toBe('https://offline.example/');
  });
});

describe('updateSourceSubscription', () => {
  it('returns 404 when no subscription exists for (workspace, source)', async () => {
    const mock = makeMockDb({ selectResults: [policyOk('editor'), []] });
    await expect(
      updateSourceSubscription(mock.db, {
        workspaceId: WORKSPACE,
        userId: USER,
        sourceId: SOURCE,
        enabled: false,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('updates enabled and priority on the subscription', async () => {
    const mock = makeMockDb({
      selectResults: [policyOk('editor'), [{ id: SUBSCRIPTION }]],
      updateResults: [[subscriptionRow({ enabled: false, priority: 30 })]],
    });
    const r = await updateSourceSubscription(mock.db, {
      workspaceId: WORKSPACE,
      userId: USER,
      sourceId: SOURCE,
      enabled: false,
      priority: 30,
    });
    expect(r.enabled).toBe(false);
    expect(r.priority).toBe(30);
  });
});

describe('deleteSourceSubscription', () => {
  it('hard-deletes the subscription row (global source stays)', async () => {
    const mock = makeMockDb({
      selectResults: [policyOk('editor'), [{ id: SUBSCRIPTION }]],
    });
    await deleteSourceSubscription(mock.db, {
      workspaceId: WORKSPACE,
      userId: USER,
      sourceId: SOURCE,
    });
    expect(mock.deleteCount).toBe(1);
  });
});

describe('listSources', () => {
  it('returns subscriptions joined with their global sources', async () => {
    const mock = makeMockDb({
      selectResults: [
        policyOk('viewer'),
        [{ subscription: subscriptionRow(), source: sourceRow() }],
      ],
    });
    const r = await listSources(mock.db, { workspaceId: WORKSPACE, userId: USER });
    expect(r).toHaveLength(1);
    expect(r[0]?.subscription.id).toBe(SUBSCRIPTION);
    expect(r[0]?.source.id).toBe(SOURCE);
  });
});
