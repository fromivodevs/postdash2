/**
 * Route-level integration tests for the Phase 5 radar route.
 *
 * Mirrors routes-topics.test.ts style: drives the real Fastify handler via
 * buildApp(...).inject(...) with a scripted fake pool. SKIP_DB_TESTS=1
 * friendly — no live Postgres.
 */

import { afterEach, describe, expect, it } from 'vitest';
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
const TG_USER_ID = 555;
const MATCH_ID = '44444444-4444-4444-4444-444444444444';
const NEWS_ID = '55555555-5555-5555-5555-555555555555';
const CLUSTER_ID = '66666666-6666-6666-6666-666666666666';
const SOURCE_ID = '77777777-7777-7777-7777-777777777777';

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
    role: 'viewer',
    createdAt: NOW,
    status: 'active',
  },
};
const VIEWER_MEMBERSHIP_ROW = { role: 'viewer', status: 'active' };

const MATCH_ROW = {
  matchId: MATCH_ID,
  workspaceId: WORKSPACE_ID,
  newsItemId: NEWS_ID,
  clusterId: CLUSTER_ID,
  score: '8.40',
  relevanceReason: 'Strong topical match',
  shouldCreateDraft: true,
  riskFlags: [],
  scoreComponents: { llm: 8, cosine: 8, freshness: 9, reliability: 7, weighted: 8.4 },
  aiProvider: 'yandex-deepseek',
  usedModel: 'yandex-deepseek-v3.2',
  promptVersion: 'yandex-deepseek-score@v1.0',
  status: 'candidate',
  scoredAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  newsTitle: 'Cursor releases AI feature',
  newsUrl: 'https://example.com/article',
  newsCanonicalUrl: 'https://example.com/article',
  newsSummary: 'Cursor adds AI helper.',
  newsPublishedAt: NOW,
  newsLanguage: 'ru',
  sourceId: SOURCE_ID,
  sourceName: 'Example',
  sourceCanonicalUrl: 'https://example.com/feed',
  clusterSourcesCount: 3,
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

describe('GET /radar', () => {
  it('200 with workspace matches list', async () => {
    const fake = makeFakePool({
      selectResults: [
        // readCurrentUser tx
        [IDENTITY_ROW],
        [USER_ROW],
        [MEMBER_JOIN_ROW],
        // listRadarMatches tx
        [VIEWER_MEMBERSHIP_ROW],
        [{ c: 1 }], // count
        [MATCH_ROW], // page rows
      ],
    });
    app = await buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), { pool: fake.pool });
    const res = await app.inject({
      method: 'GET',
      url: '/radar',
      headers: {
        authorization: signedHeader({
          user: JSON.stringify({ id: TG_USER_ID, first_name: 'Alice' }),
          auth_date: String(freshAuthDate()),
        }),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<Record<string, unknown>>;
      page: number;
      page_size: number;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(20);
    expect(body.items).toHaveLength(1);
    const item = body.items[0]!;
    expect(item['match_id']).toBe(MATCH_ID);
    expect(item['score']).toBe(8.4);
    expect(item['status']).toBe('candidate');
    expect((item['cluster'] as { sources_count: number }).sources_count).toBe(3);
    expect((item['news'] as { title: string }).title).toBe('Cursor releases AI feature');
    expect((item['source'] as { name: string }).name).toBe('Example');
  });

  it('400 on invalid query param', async () => {
    const fake = makeFakePool({
      selectResults: [[IDENTITY_ROW], [USER_ROW], [MEMBER_JOIN_ROW]],
    });
    app = await buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), { pool: fake.pool });
    const res = await app.inject({
      method: 'GET',
      url: '/radar?status=mystery',
      headers: {
        authorization: signedHeader({
          user: JSON.stringify({ id: TG_USER_ID, first_name: 'Alice' }),
          auth_date: String(freshAuthDate()),
        }),
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts status=all and min_score / max_score filters', async () => {
    const fake = makeFakePool({
      selectResults: [
        [IDENTITY_ROW],
        [USER_ROW],
        [MEMBER_JOIN_ROW],
        [VIEWER_MEMBERSHIP_ROW],
        [{ c: 0 }],
        [],
      ],
    });
    app = await buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), { pool: fake.pool });
    const res = await app.inject({
      method: 'GET',
      url: '/radar?status=all&min_score=5&max_score=9.5',
      headers: {
        authorization: signedHeader({
          user: JSON.stringify({ id: TG_USER_ID, first_name: 'Alice' }),
          auth_date: String(freshAuthDate()),
        }),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[]; total: number };
    expect(body.total).toBe(0);
    expect(body.items).toEqual([]);
  });

  it('401 when initData is missing', async () => {
    const fake = makeFakePool();
    app = await buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), { pool: fake.pool });
    const res = await app.inject({ method: 'GET', url: '/radar' });
    expect(res.statusCode).toBe(401);
  });

  it('503 when bot token is not configured', async () => {
    const fake = makeFakePool();
    app = await buildApp(withTestEnv({}), { pool: fake.pool });
    const res = await app.inject({ method: 'GET', url: '/radar' });
    expect(res.statusCode).toBe(503);
  });
});
