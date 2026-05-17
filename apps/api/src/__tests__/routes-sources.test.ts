/**
 * Route-level integration tests for the Phase 3 sources routes.
 *
 * The createSource command makes a network call (redirect resolver) before
 * touching the DB. The route uses the package default; here we cannot inject
 * a custom resolver through the route deps, so we route through tests that
 * either (a) submit a URL that won't actually be resolved before the test
 * intercepts the DB call, OR (b) target endpoints that don't call the
 * resolver (GET / PATCH / DELETE).
 *
 * For POST /sources we rely on globalThis.fetch being polluted: vitest's
 * default `fetch` will throw network_error for non-existent hosts; the
 * resolver's contract guarantees that becomes a fallback to the input URL,
 * which is then canonicalized.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signInitDataForTest } from '@postdash/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { makeFakePool } from './helpers/fake-pool.js';
import { withTestEnv } from './helpers/test-env.js';

const BOT_TOKEN = '123456:test-bot-token';

function freshAuthDate(): number {
  return Math.floor(Date.now() / 1000);
}
function signedHeader(fields: Record<string, string>): string {
  return `tma ${signInitDataForTest(fields, BOT_TOKEN)}`;
}

const NOW = new Date();
const USER_ID = '11111111-1111-1111-1111-111111111111';
const IDENTITY_ID = '22222222-2222-2222-2222-222222222222';
const WORKSPACE_ID = '33333333-3333-3333-3333-333333333333';
const SOURCE_ID = '44444444-4444-4444-4444-444444444444';
const SUBSCRIPTION_ID = '55555555-5555-5555-5555-555555555555';
const TG_USER_ID = 555;

const IDENTITY_ROW = {
  id: IDENTITY_ID,
  userId: USER_ID,
  telegramUserId: BigInt(TG_USER_ID),
  username: 'alice',
  firstName: 'Alice',
  lastName: null,
  photoUrl: null,
  linkedAt: NOW,
  status: 'active',
  lastSeenAt: NOW,
};
const USER_ROW = {
  id: USER_ID,
  createdAt: NOW,
  updatedAt: NOW,
  status: 'active',
  primaryTelegramIdentityId: IDENTITY_ID,
  lastActiveWorkspaceId: null,
};
const WORKSPACE_ROW = {
  id: WORKSPACE_ID,
  name: '@alice',
  createdByUserId: USER_ID,
  createdAt: NOW,
  updatedAt: NOW,
  status: 'active',
};
const MEMBER_JOIN_ROW = {
  workspaces: WORKSPACE_ROW,
  workspace_members: {
    id: 'member-1',
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    role: 'editor',
    createdAt: NOW,
    status: 'active',
  },
};
const EDITOR_MEMBERSHIP_ROW = { role: 'editor', status: 'active' };

const SOURCE_ROW = {
  id: SOURCE_ID,
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
  createdAt: NOW,
  updatedAt: NOW,
};

const SUBSCRIPTION_ROW = {
  id: SUBSCRIPTION_ID,
  workspaceId: WORKSPACE_ID,
  sourceId: SOURCE_ID,
  topicProfileId: null,
  enabled: true,
  priority: 50,
  customRules: {},
  createdAt: NOW,
  updatedAt: NOW,
};

let app: FastifyInstance | undefined;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // Stub the resolver's network call so it returns "no redirect" quickly.
  globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 })) as never;
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (app) {
    await app.close();
    app = undefined;
  }
});

describe('POST /sources', () => {
  it('200 with subscription projection on fresh add', async () => {
    const fake = makeFakePool({
      selectResults: [
        [IDENTITY_ROW],
        [USER_ROW],
        [MEMBER_JOIN_ROW],
        [EDITOR_MEMBERSHIP_ROW],
        [], // no existing default subscription
      ],
      insertResults: [[SOURCE_ROW], [SUBSCRIPTION_ROW]],
    });
    app = await buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), { pool: fake.pool });
    const res = await app.inject({
      method: 'POST',
      url: '/sources',
      headers: {
        authorization: signedHeader({
          user: JSON.stringify({ id: TG_USER_ID, first_name: 'Alice' }),
          auth_date: String(freshAuthDate()),
        }),
      },
      payload: { url: 'https://example.com/feed.xml?utm_source=foo', type: 'rss' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['subscription_id']).toBe(SUBSCRIPTION_ID);
    const source = body['source'] as Record<string, unknown>;
    expect(source['canonical_url']).toBe('https://example.com/feed.xml');
  });

  it('400 on invalid URL type', async () => {
    const fake = makeFakePool({
      selectResults: [[IDENTITY_ROW], [USER_ROW], [MEMBER_JOIN_ROW]],
    });
    app = await buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), { pool: fake.pool });
    const res = await app.inject({
      method: 'POST',
      url: '/sources',
      headers: {
        authorization: signedHeader({
          user: JSON.stringify({ id: TG_USER_ID, first_name: 'Alice' }),
          auth_date: String(freshAuthDate()),
        }),
      },
      payload: { url: 'https://example.com', type: 'unknown' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('401 when initData missing', async () => {
    const fake = makeFakePool();
    app = await buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), { pool: fake.pool });
    const res = await app.inject({
      method: 'POST',
      url: '/sources',
      payload: { url: 'https://example.com', type: 'rss' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /sources', () => {
  it('200 with subscription list', async () => {
    const fake = makeFakePool({
      selectResults: [
        [IDENTITY_ROW],
        [USER_ROW],
        [MEMBER_JOIN_ROW],
        [{ role: 'viewer', status: 'active' }],
        [{ subscription: SUBSCRIPTION_ROW, source: SOURCE_ROW }],
      ],
    });
    app = await buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), { pool: fake.pool });
    const res = await app.inject({
      method: 'GET',
      url: '/sources',
      headers: {
        authorization: signedHeader({
          user: JSON.stringify({ id: TG_USER_ID, first_name: 'Alice' }),
          auth_date: String(freshAuthDate()),
        }),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[] };
    expect(body.items).toHaveLength(1);
  });
});

describe('DELETE /sources/:source_id', () => {
  it('204 on successful unsubscribe', async () => {
    const fake = makeFakePool({
      selectResults: [
        [IDENTITY_ROW],
        [USER_ROW],
        [MEMBER_JOIN_ROW],
        [EDITOR_MEMBERSHIP_ROW],
        [{ id: SUBSCRIPTION_ID }],
      ],
    });
    app = await buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), { pool: fake.pool });
    const res = await app.inject({
      method: 'DELETE',
      url: `/sources/${SOURCE_ID}`,
      headers: {
        authorization: signedHeader({
          user: JSON.stringify({ id: TG_USER_ID, first_name: 'Alice' }),
          auth_date: String(freshAuthDate()),
        }),
      },
    });
    expect(res.statusCode).toBe(204);
  });
});
