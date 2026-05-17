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
import type { TelegramChannelAdapter, VerifyConnectionResult } from '@postdash/commands';
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
      selectResults: [[IDENTITY_ROW], [USER_ROW], [MEMBER_JOIN_ROW], [ADMIN_MEMBERSHIP_ROW]],
      // runIdempotent INSERT slot (with returning id) +
      // INSERT channel_connect_codes RETURNING id +
      // INSERT operation_log (no returning)
      insertResults: [[{ id: 'idem-1' }], [{ id: CONNECT_CODE_ID }], []],
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
   * Connect-flow DB calls in order. The route now runs a PRE-command
   * `validateConnectCode` (Phase 2 sub_loop 4 Fix W1) that consumes up to two
   * SELECTs (active+not-expired short-circuit, then a fallback any-row probe)
   * BEFORE entering `connectTelegramChannel`. If the pre-check returns
   * 'expired'/'consumed'/'unknown'/cross-workspace, the route fails fast and
   * the command never runs. On the happy path the command opens the
   * idempotency slot, then inside the tx calls `lookupActiveCode` (a SELECT
   * with FOR UPDATE), then optionally `assertWorkspaceRole`, then the adapter,
   * then UPSERT content_channels, INSERT channel_connections, UPDATE the code,
   * INSERT operation_log. The fake-pool doesn't differentiate `for('update')`;
   * it just consumes the next select result.
   */

  it('410 with code=expired_code when the connect code has expired', async () => {
    const fake = makeFakePool({
      selectResults: [
        [IDENTITY_ROW], // readCurrentUser: identity
        [USER_ROW], // readCurrentUser: user
        [MEMBER_JOIN_ROW], // readCurrentUser: workspace JOIN
        // validateConnectCode SELECT1 (active AND expires_at>now): the row
        // is `status=active` but already past expiry, so this filter excludes
        // it and returns no rows.
        [],
        // validateConnectCode SELECT2 (any row by hash): returns the expired
        // row. The handler narrows status='active' + past-expiry -> 'expired'.
        [
          {
            status: 'active',
            expiresAt: new Date(Date.now() - 60_000),
            workspaceId: WORKSPACE_ID,
          },
        ],
      ],
      // Command path never runs on the pre-check 'expired' branch.
      insertResults: [],
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
      payload: { code: 'EXPIRED12', external_chat_id: '@somechan' },
    });
    expect(res.statusCode).toBe(410);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe('expired_code');
    // Adapter must NOT have been called on the expired path.
    expect(adapter.verifyConnection).not.toHaveBeenCalled();
  });

  it('409 with code=reused_code when the connect code is already consumed', async () => {
    const fake = makeFakePool({
      selectResults: [
        [IDENTITY_ROW],
        [USER_ROW],
        [MEMBER_JOIN_ROW],
        // validateConnectCode SELECT1: status='consumed' fails the active filter.
        [],
        // SELECT2 returns the consumed row.
        [
          {
            status: 'consumed',
            expiresAt: new Date(Date.now() + 60_000),
            workspaceId: WORKSPACE_ID,
          },
        ],
      ],
      // Command path never runs on the pre-check 'consumed' branch.
      insertResults: [],
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
        // validateConnectCode SELECT1 (active+not-expired): returns the row.
        // Pre-check status='ok'; workspaceId matches caller's default ->
        // route proceeds into the command. SELECT2 is NOT executed because
        // SELECT1 already short-circuited inside `validateConnectCode`.
        [{ id: CONNECT_CODE_ID, workspaceId: WORKSPACE_ID }],
        [activeCodeRow], // lookupActiveCode (inside command)
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
    const originalInsert = (fake.pool.db as unknown as { insert: () => unknown }).insert;
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
        const pass = [
          'from',
          'where',
          'set',
          'values',
          'onConflictDoUpdate',
          'innerJoin',
          'orderBy',
          'limit',
        ];
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
        // validateConnectCode SELECT1 (active+not-expired) returns the row
        // with workspaceId matching the caller -> pre-check 'ok'.
        [{ id: CONNECT_CODE_ID, workspaceId: WORKSPACE_ID }],
        [activeCodeRow], // lookupActiveCode (inside command)
        [ADMIN_MEMBERSHIP_ROW], // assertWorkspaceRole
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
        // assertWorkspaceRole role gate: returns the caller's membership.
        [ADMIN_MEMBERSHIP_ROW],
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
      selectResults: [
        [IDENTITY_ROW],
        [USER_ROW],
        [MEMBER_JOIN_ROW],
        // assertWorkspaceRole role gate.
        [ADMIN_MEMBERSHIP_ROW],
        [],
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
    const body = res.json() as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it('403 when caller is not a member of the default workspace (role gate)', async () => {
    // `readCurrentUser` succeeded (workspace+member JOIN found a row above),
    // but the `assertWorkspaceRole(... 'viewer')` re-check inside the GET
    // handler reads a fresh membership snapshot and finds no row (e.g. a
    // concurrent admin removed this user mid-session). The route must
    // surface 403 rather than leaking the channel list.
    const fake = makeFakePool({
      selectResults: [
        [IDENTITY_ROW],
        [USER_ROW],
        [MEMBER_JOIN_ROW],
        // assertWorkspaceRole role gate: no row -> 'forbidden'.
        [],
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
    expect(res.statusCode).toBe(403);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe('forbidden');
  });
});

// ============================================================================
// Cross-workspace PRE-command guard (Phase 2 sub_loop 4 Fix W1)
// ============================================================================
describe('POST /channels/connect — cross-workspace pre-check', () => {
  it('403 with code=cross_workspace_code when the code belongs to a different workspace (fails fast, command never runs)', async () => {
    // Setup: the connect code was issued in OTHER_WORKSPACE_ID, but the
    // verified caller's `defaultWorkspace.id` is WORKSPACE_ID. The route's
    // PRE-command `validateConnectCode` reads the code's workspace and
    // rejects BEFORE entering `connectTelegramChannel`. This avoids the old
    // failure mode where the command would commit a binding in the OTHER
    // workspace and only THEN have the route 403 the response (leaving a
    // ghost binding + a misleading 409 on retry). The in-command
    // `assertWorkspaceRole` remains the real policy gate; this code is the
    // UX-layer marker telling the Mini App "wrong workspace".
    const OTHER_WORKSPACE_ID = '99999999-9999-9999-9999-999999999999';
    const fake = makeFakePool({
      selectResults: [
        [IDENTITY_ROW],
        [USER_ROW],
        [MEMBER_JOIN_ROW], // caller defaultWorkspace = WORKSPACE_ID
        // validateConnectCode SELECT1: active code row returns with the
        // OTHER workspace id. Pre-check 'ok' status + mismatched workspaceId
        // -> route maps to cross_workspace_code.
        [{ id: CONNECT_CODE_ID, workspaceId: OTHER_WORKSPACE_ID }],
      ],
      // Adapter + command path are NEVER reached.
      insertResults: [],
      updateResults: [],
    });
    const adapter = makeAdapter({
      ok: true,
      externalId: '-1009999999999',
      title: 'Other',
      username: 'other',
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
        'idempotency-key': 'wrong-workspace-key',
        'content-type': 'application/json',
      },
      payload: { code: 'OTHERWS1', external_chat_id: '@otherchan' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe('cross_workspace_code');
    // Adapter must NEVER be invoked when the pre-check fails.
    expect(adapter.verifyConnection).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Idempotency-Key + body-mismatch guard (Phase 2 sub_loop 4 Fix W3)
// ============================================================================
describe('POST /channels/connect — Idempotency-Key + body-mismatch', () => {
  it('two POSTs with same Idempotency-Key but different code each execute independently (no cache hit)', async () => {
    // Without the body-hash composition in the effective idempotency key
    // (header + ":" + sha256(body)), a second POST that reused the header
    // with a DIFFERENT code/external_chat_id would short-circuit on the
    // command-layer cache and return the FIRST call's projection. The Mini
    // App would then display a confirmation for a binding the caller never
    // submitted. This test drives two full /channels/connect flows back to
    // back with the SAME header and DIFFERENT bodies, and asserts BOTH
    // adapters were called -- proving cache wasn't hit on the second call.
    const activeCodeRowA = {
      id: CONNECT_CODE_ID,
      workspaceId: WORKSPACE_ID,
      createdByUserId: USER_ID,
      status: 'active',
      expiresAt: new Date(Date.now() + 60_000),
    };
    const upsertedChannelA = {
      id: CONTENT_CHANNEL_ID,
      platform: 'telegram',
      externalId: '-1001111111111',
      type: 'channel',
      title: 'A',
      username: 'a',
      photoUrl: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const insertedConnectionA = {
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

    const SECOND_CODE_ID = '77777777-7777-7777-7777-777777777777';
    const SECOND_CHANNEL_ID = '88888888-8888-8888-8888-888888888888';
    const SECOND_CONNECTION_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const activeCodeRowB = {
      id: SECOND_CODE_ID,
      workspaceId: WORKSPACE_ID,
      createdByUserId: USER_ID,
      status: 'active',
      expiresAt: new Date(Date.now() + 60_000),
    };
    const upsertedChannelB = {
      id: SECOND_CHANNEL_ID,
      platform: 'telegram',
      externalId: '-1002222222222',
      type: 'channel',
      title: 'B',
      username: 'b',
      photoUrl: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const insertedConnectionB = {
      id: SECOND_CONNECTION_ID,
      workspaceId: WORKSPACE_ID,
      contentChannelId: SECOND_CHANNEL_ID,
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

    const fake = makeFakePool({
      selectResults: [
        // ---- Request A ----
        [IDENTITY_ROW],
        [USER_ROW],
        [MEMBER_JOIN_ROW],
        // validateConnectCode SELECT1 for code A
        [{ id: CONNECT_CODE_ID, workspaceId: WORKSPACE_ID }],
        [activeCodeRowA], // lookupActiveCode (inside command)
        [ADMIN_MEMBERSHIP_ROW], // assertWorkspaceRole
        // ---- Request B ----
        [IDENTITY_ROW],
        [USER_ROW],
        [MEMBER_JOIN_ROW],
        [{ id: SECOND_CODE_ID, workspaceId: WORKSPACE_ID }],
        [activeCodeRowB],
        [ADMIN_MEMBERSHIP_ROW],
      ],
      insertResults: [
        // ---- Request A inserts ----
        [{ id: 'idem-A' }], // runIdempotent slot
        [upsertedChannelA], // UPSERT content_channels
        [insertedConnectionA], // INSERT channel_connections
        [], // operation_log
        // ---- Request B inserts ----
        // Different effective idempotency key (header + sha256(body)) -> the
        // runIdempotent INSERT slot succeeds again rather than colliding.
        [{ id: 'idem-B' }],
        [upsertedChannelB],
        [insertedConnectionB],
        [],
      ],
      updateResults: [
        // ---- Request A updates ----
        [], // consume code
        [{ id: 'idem-A' }], // runIdempotent: mark success
        // ---- Request B updates ----
        [],
        [{ id: 'idem-B' }],
      ],
    });

    // Two adapter responses; each call returns the matching projection so we
    // can assert both calls happened.
    let adapterCalls = 0;
    const adapter: TelegramChannelAdapter = {
      verifyConnection: vi.fn(async (): Promise<VerifyConnectionResult> => {
        adapterCalls += 1;
        if (adapterCalls === 1) {
          return {
            ok: true,
            externalId: '-1001111111111',
            title: 'A',
            username: 'a',
            photoUrl: null,
            chatType: 'channel',
            canPostMessages: true,
          };
        }
        return {
          ok: true,
          externalId: '-1002222222222',
          title: 'B',
          username: 'b',
          photoUrl: null,
          chatType: 'channel',
          canPostMessages: true,
        };
      }),
    };

    app = await buildApp(
      withTestEnv({
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_BOT_USERNAME: BOT_USERNAME,
      }),
      { pool: fake.pool, channelAdapter: adapter },
    );

    const sharedHeaders = {
      authorization: signedHeader({
        user: JSON.stringify({ id: TG_USER_ID, first_name: 'Alice' }),
        auth_date: String(freshAuthDate()),
      }),
      'idempotency-key': 'shared-header-key',
      'content-type': 'application/json',
    };

    const resA = await app.inject({
      method: 'POST',
      url: '/channels/connect',
      headers: sharedHeaders,
      payload: { code: 'BODYHAS1', external_chat_id: '@chanA' },
    });
    expect(resA.statusCode).toBe(200);
    const bodyA = resA.json() as Record<string, unknown>;
    expect(bodyA['id']).toBe(CONNECTION_ID);

    const resB = await app.inject({
      method: 'POST',
      url: '/channels/connect',
      headers: sharedHeaders,
      payload: { code: 'BODYHAS2', external_chat_id: '@chanB' },
    });
    expect(resB.statusCode).toBe(200);
    const bodyB = resB.json() as Record<string, unknown>;
    // CRITICAL: if the cache had been hit (old behavior), resB would echo
    // CONNECTION_ID from request A. The body-hash composition forces a fresh
    // execute, so resB returns the second connection.
    expect(bodyB['id']).toBe(SECOND_CONNECTION_ID);
    expect(bodyB['id']).not.toBe(bodyA['id']);

    // Both adapter calls happened: the second was NOT served from the cache.
    expect(adapter.verifyConnection).toHaveBeenCalledTimes(2);
  });
});
