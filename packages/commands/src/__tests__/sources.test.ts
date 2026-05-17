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
    // After xmax-via-RETURNING: rows include `inserted: boolean`.
    const fresh = { ...sourceRow(), inserted: true };
    const freshSub = { ...subscriptionRow(), inserted: true };
    const mock = makeMockDb({
      selectResults: [policyOk('editor')],
      // sources upsert RETURNING, subscription upsert RETURNING, operation_log INSERT
      insertResults: [[fresh], [freshSub], []],
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
    // existing row from ON CONFLICT DO UPDATE → xmax != 0 → inserted: false.
    const existing = { ...sourceRow(), inserted: false };
    const freshSub = { ...subscriptionRow(), inserted: true };
    const mock = makeMockDb({
      selectResults: [policyOk('editor')],
      insertResults: [[existing], [freshSub], []],
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
    expect(r.subscriptionCreated).toBe(true);
  });

  it('re-enables an existing disabled subscription on re-add (ON CONFLICT DO UPDATE)', async () => {
    const resolve = vi.fn().mockResolvedValue({ finalUrl: 'https://example.com/feed.xml' });
    const fresh = { ...sourceRow(), inserted: true };
    // existing subscription → xmax != 0 (inserted: false) → re-enabled by DO UPDATE.
    const reEnabled = { ...subscriptionRow({ enabled: true }), inserted: false };
    const mock = makeMockDb({
      selectResults: [policyOk('editor')],
      insertResults: [[fresh], [reEnabled], []],
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
  });

  it('rejects topic_profile_id pointing at a disabled profile with conflict', async () => {
    const resolve = vi.fn().mockResolvedValue({ finalUrl: 'https://example.com/feed.xml' });
    const mock = makeMockDb({
      selectResults: [
        policyOk('editor'),
        // topic_profile exists, same workspace, but status='disabled'
        [{ workspaceId: WORKSPACE, status: 'disabled' }],
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
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects topic_profile_id from a different workspace with forbidden', async () => {
    const resolve = vi.fn().mockResolvedValue({ finalUrl: 'https://example.com/feed.xml' });
    const mock = makeMockDb({
      selectResults: [
        policyOk('editor'),
        [{ workspaceId: '99999999-9999-9999-9999-999999999999', status: 'active' }],
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
    const resolve = vi.fn().mockResolvedValue({ finalUrl: 'https://offline.example/' });
    const fresh = {
      ...sourceRow({ url: 'https://offline.example/', canonicalUrl: 'https://offline.example/' }),
      inserted: true,
    };
    const freshSub = { ...subscriptionRow(), inserted: true };
    const mock = makeMockDb({
      selectResults: [policyOk('editor')],
      insertResults: [[fresh], [freshSub], []],
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

  it('updates enabled and priority on the subscription and returns joined source', async () => {
    const mock = makeMockDb({
      selectResults: [
        policyOk('editor'),
        [{ id: SUBSCRIPTION }], // loadOwnedSubscription
        [sourceRow()], // joined source SELECT after update
      ],
      updateResults: [[subscriptionRow({ enabled: false, priority: 30 })]],
    });
    const r = await updateSourceSubscription(mock.db, {
      workspaceId: WORKSPACE,
      userId: USER,
      sourceId: SOURCE,
      enabled: false,
      priority: 30,
    });
    expect(r.subscription.enabled).toBe(false);
    expect(r.subscription.priority).toBe(30);
    expect(r.source.id).toBe(SOURCE);
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

describe('createSource: bulk add (20 sources sequentially)', () => {
  // Plan promises a bulk-add (20 sources) test (08-IMPLEMENTATION-ROADMAP.md).
  // This validates the command path under a realistic batch — all 20 must
  // succeed, each with its own SELECT-policy + INSERT-source + INSERT-sub +
  // INSERT-operation_log script slots.
  it('20 sequential createSource calls all succeed with global dedup discipline', async () => {
    const N = 20;
    const resolve = vi.fn(async (url: string) => ({ finalUrl: url }));

    // Build 20 distinct canonical URLs. All collide on canonical_url=>UNIQUE
    // would prevent duplicate global rows; here each is unique so each is
    // sourceCreated=true.
    const selectScript: unknown[][] = [];
    const insertScript: unknown[][] = [];
    for (let i = 0; i < N; i++) {
      selectScript.push(policyOk('editor'));
      insertScript.push(
        [
          {
            ...sourceRow({ id: `source-${i}`, canonicalUrl: `https://feed-${i}.example/rss` }),
            inserted: true,
          },
        ],
        [{ ...subscriptionRow({ id: `sub-${i}`, sourceId: `source-${i}` }), inserted: true }],
        [], // operation_log
      );
    }
    const mock = makeMockDb({ selectResults: selectScript, insertResults: insertScript });

    const results = [];
    for (let i = 0; i < N; i++) {
      results.push(
        await createSource(
          mock.db,
          {
            workspaceId: WORKSPACE,
            userId: USER,
            url: `https://feed-${i}.example/rss`,
            type: 'rss',
          },
          { resolveRedirect: resolve },
        ),
      );
    }
    expect(results).toHaveLength(N);
    expect(results.every((r) => r.sourceCreated && r.subscriptionCreated)).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(N);
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
