/**
 * Route-level integration tests for the Phase 3 topic routes.
 *
 * Mirrors routes-channels.test.ts style: drives the real Fastify handler via
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
const TOPIC_ID = '44444444-4444-4444-4444-444444444444';
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

const TOPIC_ROW = {
  id: TOPIC_ID,
  workspaceId: WORKSPACE_ID,
  name: 'AI',
  language: 'ru',
  mainTopics: ['llm'],
  keywords: ['ai'],
  negativeKeywords: ['spam'],
  toneProfile: null,
  embeddingStatus: 'pending',
  embeddingUpdatedAt: null,
  status: 'active',
  createdAt: NOW,
  updatedAt: NOW,
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

describe('POST /topics', () => {
  it('200 on first create (insert path)', async () => {
    const fake = makeFakePool({
      selectResults: [
        [IDENTITY_ROW],
        [USER_ROW],
        [MEMBER_JOIN_ROW],
        [EDITOR_MEMBERSHIP_ROW],
        [], // no existing active profile
      ],
      insertResults: [[TOPIC_ROW]],
    });
    app = await buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), { pool: fake.pool });
    const res = await app.inject({
      method: 'POST',
      url: '/topics',
      headers: {
        authorization: signedHeader({
          user: JSON.stringify({ id: TG_USER_ID, first_name: 'Alice' }),
          auth_date: String(freshAuthDate()),
        }),
      },
      payload: { name: 'AI', language: 'ru', main_topics: ['llm'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['id']).toBe(TOPIC_ID);
    expect(body['language']).toBe('ru');
    expect(body['main_topics']).toEqual(['llm']);
  });

  it('400 on invalid body', async () => {
    const fake = makeFakePool({
      selectResults: [[IDENTITY_ROW], [USER_ROW], [MEMBER_JOIN_ROW]],
    });
    app = await buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), { pool: fake.pool });
    const res = await app.inject({
      method: 'POST',
      url: '/topics',
      headers: {
        authorization: signedHeader({
          user: JSON.stringify({ id: TG_USER_ID, first_name: 'Alice' }),
          auth_date: String(freshAuthDate()),
        }),
      },
      payload: { language: 'fr' }, // unsupported lang + missing name
    });
    expect(res.statusCode).toBe(400);
  });

  it('401 when initData is missing', async () => {
    const fake = makeFakePool();
    app = await buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), { pool: fake.pool });
    const res = await app.inject({
      method: 'POST',
      url: '/topics',
      payload: { name: 'X', language: 'ru' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('503 when bot token is not configured', async () => {
    const fake = makeFakePool();
    app = await buildApp(withTestEnv({}), { pool: fake.pool });
    const res = await app.inject({
      method: 'POST',
      url: '/topics',
      payload: { name: 'X', language: 'ru' },
    });
    expect(res.statusCode).toBe(503);
  });
});

describe('GET /topics', () => {
  it('200 with workspace topics list', async () => {
    const fake = makeFakePool({
      selectResults: [
        [IDENTITY_ROW],
        [USER_ROW],
        [MEMBER_JOIN_ROW],
        [{ role: 'viewer', status: 'active' }],
        [TOPIC_ROW],
      ],
    });
    app = await buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), { pool: fake.pool });
    const res = await app.inject({
      method: 'GET',
      url: '/topics',
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

describe('PATCH /topics/:id', () => {
  it('400 on invalid uuid in URL', async () => {
    const fake = makeFakePool({
      selectResults: [[IDENTITY_ROW], [USER_ROW], [MEMBER_JOIN_ROW]],
    });
    app = await buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), { pool: fake.pool });
    const res = await app.inject({
      method: 'PATCH',
      url: '/topics/not-a-uuid',
      headers: {
        authorization: signedHeader({
          user: JSON.stringify({ id: TG_USER_ID, first_name: 'Alice' }),
          auth_date: String(freshAuthDate()),
        }),
      },
      payload: { name: 'Renamed' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('DELETE /topics/:id', () => {
  it('204 on successful soft-delete', async () => {
    const fake = makeFakePool({
      selectResults: [
        [IDENTITY_ROW],
        [USER_ROW],
        [MEMBER_JOIN_ROW],
        [EDITOR_MEMBERSHIP_ROW],
        [{ id: TOPIC_ID, workspaceId: WORKSPACE_ID }],
      ],
      updateResults: [[{ id: TOPIC_ID, status: 'disabled' }]],
    });
    app = await buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), { pool: fake.pool });
    const res = await app.inject({
      method: 'DELETE',
      url: `/topics/${TOPIC_ID}`,
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
