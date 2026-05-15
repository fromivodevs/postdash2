/**
 * Route-level integration tests for the Phase 2 channel routes.
 *
 * Mirrors `routes-auth.test.ts` style: drives the real Fastify handler via
 * `buildApp(...).inject(...)`, with a scripted fake pool (`makeFakePool`)
 * and a stubbed `TelegramChannelAdapter`. SKIP_DB_TESTS=1 friendly because
 * this layer never opens a real Postgres connection.
 *
 * Test plan items (architecture/channel-connection.md):
 *   #16: POST /channels/connect-codes returns 200 with code+deep_link.
 *   #17: POST /channels/connect expired code -> 410 with code='expired_code'.
 *   #18: POST /channels/connect reused code -> 409 with code='reused_code'.
 *   #19: POST /channels/connect channel taken -> 409 with code='channel_taken'.
 *   #20: POST /channels/connect bot no post permission -> 400 with code='missing_post_permission'.
 *   #21: GET /channels returns workspace's channels with status.
 *
 * Adapter stubbing strategy: instead of injecting it through the route deps
 * directly, we plumb a custom `TelegramChannelAdapter` into `buildApp` via the
 * `channelAdapter` AppDeps field — exactly the seam `index.ts` uses in
 * production. This makes the test path match the production wiring.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { signInitDataForTest } from '@postdash/shared';
import type {
  TelegramChannelAdapter,
  VerifyConnectionResult,
} from '@postdash/commands';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { makeFakePool } from './helpers/fake-pool.js';
import { withTestEnv } from './helpers/test-env.js';

const BOT_TOKEN = '123456:test-bot-token';
const BOT_USERNAME = 'postdash_test_bot';

function freshAuthDate(): number {
  return Math.floor(Date.now() / 1000);
}

function signedHeader(fields: Record<string, string>): string {
  return `tma ${signInitDataForTest(fields, BOT_TOKEN)}`;
}

/**
 * A pre-existing user/identity/workspace baseline. `readCurrentUser` consumes
 * exactly three SELECTs in order:
 *   1. select telegram_identities by telegram_user_id
 *   2. select users by id
 *   3. select workspace+members JOIN (because user.lastActiveWorkspaceId=null,
 *      `findDefaultWorkspace` skips the first SELECT and falls to memberRows).
 */
const NOW = new Date();
const USER_ID = '11111111-1111-1111-1111-111111111111';
const IDENTITY_ID = '22222222-2222-2222-2222-222222222222';
const WORKSPACE_ID = '33333333-3333-3333-3333-333333333333';
const CONNECT_CODE_ID = '44444444-4444-4444-4444-444444444444';
const CONTENT_CHANNEL_ID = '55555555-5555-5555-5555-555555555555';
const CONNECTION_ID = '66666666-6666-6666-6666-666666666666';
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

// findDefaultWorkspace's memberRows JOIN returns `{workspaces, workspace_members}`.
const MEMBER_JOIN_ROW = {
  workspaces: WORKSPACE_ROW,
  workspace_members: {
    id: 'member-1',
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    role: 'admin',
    createdAt: NOW,
    status: 'active',
  },
};

/** assertWorkspaceRole's narrow SELECT shape. */
const ADMIN_MEMBERSHIP_ROW = { role: 'admin', status: 'active' };

/** Adapter stub helper. */
function makeAdapter(result: VerifyConnectionResult): TelegramChannelAdapter {
  return { verifyConnection: vi.fn(async () => result) };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

// ============================================================================
// POST /channels/connect-codes
// ============================================================================
describe('POST /channels/connect-codes', () => {
  it('200 with code + deep_link on the happy path', async () => {
    const fake = makeFakePool({
      // readCurrentUser: identity, user, workspace+member JOIN
      // assertWorkspaceRole: membership { role, status }
      selectResults: [
        [IDENTITY_ROW],
        [USER_ROW],
        [MEMBER_JOIN_ROW],
        [ADMIN_MEMBERSHIP_ROW],
      ],
      // runIdempotent INSERT slot (with returning id) +
      // INSERT channel_connect_codes RETURNING id +
      // INSERT operation_log (no returning)
      insertResults: [
        [{ id: 'idem-1' }],
        [{ id: CONNECT_CODE_ID }],
        [],
      ],
      // runIdempotent UPDATE slot -> success
      updateResults: [[{ id: 'idem-1' }]],
    });
    app = await buildApp(
      withTestEnv({
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_BOT_USERNAME: BOT_USERNAME,
      }),
      { pool: fake.pool },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/channels/connect-codes',
      headers: {
        authorization: signedHeader({
          user: JSON.stringify({ id: TG_USER_ID, first_name: 'Alice' }),
          auth_date: String(freshAuthDate()),
        }),
      },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['id']).toBe(CONNECT_CODE_ID);
    // 8 Crockford chars; the exact value is random per call.
    expect(String(body['code'])).toMatch(/^[A-Z0-9]{8}$/);
    expect(String(body['deep_link'])).toBe(
      `https://t.me/${BOT_USERNAME}?start=connect_${body['code']}`,
    );
    expect(typeof body['expires_at']).toBe('string');
  });

  it('503 when TELEGRAM_BOT_USERNAME is not configured', async () => {
    const fake = makeFakePool();
    app = await buildApp(
      withTestEnv({
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        // TELEGRAM_BOT_USERNAME deliberately empty
      }),
      { pool: fake.pool },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/channels/connect-codes',
      headers: {
        authorization: signedHeader({
          user: JSON.stringify({ id: TG_USER_ID, first_name: 'Alice' }),
          auth_date: String(freshAuthDate()),
        }),
      },
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe('bot_username_missing');
  });
});

// ============================================================================
// POST /channels/connect
// ============================================================================
describe('POST /channels/connect', () => {
  function buildHeaders(): Record<string, string> {
    return {
      authorization: signedHeader({
        user: JSON.stringify({ id: TG_USER_ID, first_name: 'Alice' }),
        auth_date: String(freshAuthDate()),
      }),
      'idempotency-key': 'test-idem-key-1',
      'content-type': 'application/json',
    };
  }

  /**
   * Connect-flow DB calls in order. `connectTelegramChannel` opens the
   * idempotency slot, then inside the tx calls `lookupActiveCode` (a SELECT
   * with FOR UPDATE), then optionally `assertWorkspaceRole`, then the adapter,
   * then UPSERT content_channels, INSERT channel_connections, UPDATE the code,
   * INSERT operation_log. The fake-pool doesn't differentiate `for('update')`;
   * it just consumes the next select result.
   */
  function baseSelectResultsForCode(codeRow: unknown): unknown[][] {
    return [
      [IDENTITY_ROW], // readCurrentUser: identity
      [USER_ROW], // readCurrentUser: user
      [MEMBER_JOIN_ROW], // readCurrentUser: workspace JOIN
      [codeRow], // lookupActiveCode FOR UPDATE
    ];
  }

  it('410 with code=expired_code when the connect code has expired', async () => {
    const expiredCodeRow = {
      id: CONNECT_CODE_ID,
      workspaceId: WORKSPACE_ID,
      createdByUserId: USER_ID,
      status: 'active',
      expiresAt: new Date(Date.now() - 60_000), // 1 minute ago
    };
    const fake = makeFakePool({
      selectResults: baseSelectResultsForCode(expiredCodeRow),
      // runIdempotent slot insert, then UPDATE channel_connect_codes -> expired.
      insertResults: [[{ id: 'idem-1' }]],
      updateResults: [[]],
    });
    const adapter = makeAdapter({
      ok: true,
      externalId: '-1001',
      title: 't',
      username: null,
      photoUrl: null,
      chatType: 'channel',
      canPostMessages: true,
    });
    app = await buildApp(
      withTestEnv({
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_BOT_USERNAME: BOT_USERNAME,
      }),
      { pool: fake.pool, channelAdapter: adapter },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/channels/connect',
      headers: buildHeaders(),
      payload: { code: 'EXPIRED12', external_chat_id: '@somechan' },
    });
    expect(res.statusCode).toBe(410);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe('expired_code');
    // Adapter must NOT have been called on the expired path.
    expect(adapter.verifyConnection).not.toHaveBeenCalled();
  });

  it('409 with code=reused_code when the connect code is already consumed', async () => {
    const consumedCodeRow = {
      id: CONNECT_CODE_ID,
      workspaceId: WORKSPACE_ID,
      createdByUserId: USER_ID,
      status: 'consumed',
      expiresAt: new Date(Date.now() + 60_000),
    };
    const fake = makeFakePool({
      selectResults: baseSelectResultsForCode(consumedCodeRow),
      insertResults: [[{ id: 'idem-1' }]],
      updateResults: [],
    });
    const adapter = makeAdapter({
      ok: true,
      externalId: '-1001',
      title: 't',
      username: null,
      photoUrl: null,
      chatType: 'channel',
      canPostMessages: true,
    });
    app = await buildApp(
      withTestEnv({
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_BOT_USERNAME: BOT_USERNAME,
      }),
      { pool: fake.pool, channelAdapter: adapter },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/channels/connect',
      headers: buildHeaders(),
      payload: { code: 'CONSUMED1', external_chat_id: '@somechan' },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe('reused_code');
    expect(adapter.verifyConnection).not.toHaveBeenCalled();
  });

  it('409 with code=channel_taken when another workspace already owns the channel', async () => {
    const activeCodeRow = {
      id: CONNECT_CODE_ID,
      workspaceId: WORKSPACE_ID,
      createdByUserId: USER_ID,
      status: 'active',
      expiresAt: new Date(Date.now() + 60_000),
    };
    const upsertedChannelRow = {
      id: CONTENT_CHANNEL_ID,
      platform: 'telegram',
      externalId: '-1001234567890',
      type: 'channel',
      title: 'Test',
      username: 'test',
      photoUrl: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    // Custom fake-pool: override insert to fail the 2nd business insert
    // (channel_connections) with a unique-violation. The fake-pool's makeChain
    // doesn't support throwing on a specific call directly, so we patch the
    // 3rd insert call (idem + content_channels + channel_connections) to throw.
    const fake = makeFakePool({
      selectResults: [
        [IDENTITY_ROW],
        [USER_ROW],
        [MEMBER_JOIN_ROW],
        [activeCodeRow], // lookupActiveCode
        [ADMIN_MEMBERSHIP_ROW], // assertWorkspaceRole
      ],
      insertResults: [
        [{ id: 'idem-1' }], // runIdempotent slot
        [upsertedChannelRow], // UPSERT content_channels
      ],
      updateResults: [],
    });
    const adapter = makeAdapter({
      ok: true,
      externalId: '-1001234567890',
      title: 'Test',
      username: 'test',
      photoUrl: null,
      chatType: 'channel',
      canPostMessages: true,
    });
    // Monkey-patch the next insert (channel_connections) to throw a
    // unique-violation. The connect command catches 23505 with constraint
    // name `channel_connections_content_channel_unique` and maps it.
    const originalInsert = (fake.pool.db as unknown as { insert: () => unknown })
      .insert;
    let insertCallCount = 0;
    (fake.pool.db as unknown as { insert: () => unknown }).insert = () => {
      insertCallCount += 1;
      if (insertCallCount === 3) {
        // Returns a proxy whose `.returning()` rejects with a unique-violation.
        const err = Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'channel_connections_content_channel_unique',
        });
        const proxy: Record<string, unknown> = {};
        const pass = ['from', 'where', 'set', 'values', 'onConflictDoUpdate', 'innerJoin', 'orderBy', 'limit'];
        for (const m of pass) proxy[m] = () => proxy;
        proxy['returning'] = async () => {
          throw err;
        };
        (proxy as { then: unknown }).then = (
          _: unknown,
          reject: (e: unknown) => unknown,
        ): unknown => reject(err);
        return proxy;
      }
      return originalInsert();
    };

    app = await buildApp(
      withTestEnv({
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_BOT_USERNAME: BOT_USERNAME,
      }),
      { pool: fake.pool, channelAdapter: adapter },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/channels/connect',
      headers: buildHeaders(),
      payload: { code: 'ACTIVE123', external_chat_id: '@somechan' },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe('channel_taken');
    expect(adapter.verifyConnection).toHaveBeenCalledTimes(1);
  });

  it('400 with code=missing_post_permission when the bot lacks post rights', async () => {
    const activeCodeRow = {
      id: CONNECT_CODE_ID,
      workspaceId: WORKSPACE_ID,
      createdByUserId: USER_ID,
      status: 'active',
      expiresAt: new Date(Date.now() + 60_000),
    };
    const fake = makeFakePool({
      selectResults: [
        [IDENTITY_ROW],
        [USER_ROW],
        [MEMBER_JOIN_ROW],
        [activeCodeRow],
        [ADMIN_MEMBERSHIP_ROW],
      ],
      insertResults: [[{ id: 'idem-1' }]],
      updateResults: [],
    });
    const adapter = makeAdapter({
      ok: false,
      errorCode: 'missing_post_permission',
      detail: 'bot has no posting right',
    });
    app = await buildApp(
      withTestEnv({
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_BOT_USERNAME: BOT_USERNAME,
      }),
      { pool: fake.pool, channelAdapter: adapter },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/channels/connect',
      headers: buildHeaders(),
      payload: { code: 'GOODCODE1', external_chat_id: '@somechan' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe('missing_post_permission');
    expect(adapter.verifyConnection).toHaveBeenCalledTimes(1);
  });

  it('400 when Idempotency-Key header is missing', async () => {
    const fake = makeFakePool({
      selectResults: [[IDENTITY_ROW], [USER_ROW], [MEMBER_JOIN_ROW]],
    });
    const adapter = makeAdapter({
      ok: true,
      externalId: '-1001',
      title: 't',
      username: null,
      photoUrl: null,
      chatType: 'channel',
      canPostMessages: true,
    });
    app = await buildApp(
      withTestEnv({
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_BOT_USERNAME: BOT_USERNAME,
      }),
      { pool: fake.pool, channelAdapter: adapter },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/channels/connect',
      headers: {
        authorization: signedHeader({
          user: JSON.stringify({ id: TG_USER_ID, first_name: 'Alice' }),
          auth_date: String(freshAuthDate()),
        }),
        'content-type': 'application/json',
      },
      payload: { code: 'GOOD12345', external_chat_id: '@somechan' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe('missing_idempotency_key');
  });

  it('503 when channel adapter is not wired', async () => {
    const fake = makeFakePool({
      selectResults: [[IDENTITY_ROW], [USER_ROW], [MEMBER_JOIN_ROW]],
    });
    app = await buildApp(
      withTestEnv({
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_BOT_USERNAME: BOT_USERNAME,
      }),
      { pool: fake.pool },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/channels/connect',
      headers: buildHeaders(),
      payload: { code: 'GOOD12345', external_chat_id: '@somechan' },
    });
    expect(res.statusCode).toBe(503);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe('channel_adapter_unavailable');
  });
});

// ============================================================================
// GET /channels
// ============================================================================
describe('GET /channels', () => {
  it("200 returns the workspace's channels as ChannelProjection list", async () => {
    // List query returns one connected row.
    const connectionRow = {
      id: CONNECTION_ID,
      workspaceId: WORKSPACE_ID,
      contentChannelId: CONTENT_CHANNEL_ID,
      status: 'connected',
      canPostMessages: true,
      lastVerifyStatus: 'ok',
      lastVerifyError: null,
      lastVerifiedAt: NOW,
      connectedAt: NOW,
      connectedByUserId: USER_ID,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const contentChannelRow = {
      id: CONTENT_CHANNEL_ID,
      platform: 'telegram',
      externalId: '-1001234567890',
      type: 'channel',
      title: 'Channel',
      username: 'chan',
      photoUrl: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const fake = makeFakePool({
      selectResults: [
        [IDENTITY_ROW],
        [USER_ROW],
        [MEMBER_JOIN_ROW],
        // The list query's JOIN row shape uses the aliases declared in
        // channels.ts: `{ connection, content_channel }`.
        [{ connection: connectionRow, content_channel: contentChannelRow }],
      ],
    });
    app = await buildApp(
      withTestEnv({
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_BOT_USERNAME: BOT_USERNAME,
      }),
      { pool: fake.pool },
    );
    const res = await app.inject({
      method: 'GET',
      url: '/channels',
      headers: {
        authorization: signedHeader({
          user: JSON.stringify({ id: TG_USER_ID, first_name: 'Alice' }),
          auth_date: String(freshAuthDate()),
        }),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<Record<string, unknown>> };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(1);
    const first = body.items[0]!;
    expect(first['id']).toBe(CONNECTION_ID);
    expect(first['workspace_id']).toBe(WORKSPACE_ID);
    expect(first['content_channel_id']).toBe(CONTENT_CHANNEL_ID);
    expect(first['platform']).toBe('telegram');
    expect(first['status']).toBe('connected');
    expect(first['external_id']).toBe('-1001234567890');
  });

  it('200 returns empty list when the workspace has no channels', async () => {
    const fake = makeFakePool({
      selectResults: [[IDENTITY_ROW], [USER_ROW], [MEMBER_JOIN_ROW], []],
    });
    app = await buildApp(
      withTestEnv({
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_BOT_USERNAME: BOT_USERNAME,
      }),
      { pool: fake.pool },
    );
    const res = await app.inject({
      method: 'GET',
      url: '/channels',
      headers: {
        authorization: signedHeader({
          user: JSON.stringify({ id: TG_USER_ID, first_name: 'Alice' }),
          auth_date: String(freshAuthDate()),
        }),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: unknown[] };
    expect(body.items).toEqual([]);
  });
});
