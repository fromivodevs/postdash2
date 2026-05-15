/**
 * Route-level integration tests for POST /auth/telegram and GET /me.
 *
 * These drive the actual Fastify handlers via `buildApp(...).inject(...)` with
 * a real bot token (so HMAC verification runs for real) and a scripted fake
 * pool (so the command layer executes without a database). This is the layer
 * the Phase 1 plan promised — "valid initData -> user + workspace created +
 * 200" — that the mock-DB unit tests alone did not cover.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { signInitDataForTest } from '@postdash/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { makeFakePool } from './helpers/fake-pool.js';
import { withTestEnv } from './helpers/test-env.js';

const BOT_TOKEN = '123456:test-bot-token';

/** auth_date now, in whole seconds — inside the freshness window. */
function freshAuthDate(): string {
  return String(Math.floor(Date.now() / 1000));
}

/** Builds a valid `Authorization: tma <initData>` header value. */
function signedHeader(fields: Record<string, string>): string {
  return `tma ${signInitDataForTest(fields, BOT_TOKEN)}`;
}

/**
 * Scripts a fake pool for the `authenticateTelegram` new-user happy path. The
 * rowset order mirrors the command's DB calls: idempotency-insert, then inside
 * the transaction select(identity)/insert(user)/insert(identity)/
 * insert(workspace)/insert(member)/update(user)/insert(operation_log), then
 * the idempotency-success update.
 */
function newUserPool(): ReturnType<typeof makeFakePool> {
  const now = new Date();
  const newUser = {
    id: 'user-1',
    createdAt: now,
    updatedAt: now,
    status: 'active',
    primaryTelegramIdentityId: null,
    lastActiveWorkspaceId: null,
  };
  const newIdentity = {
    id: 'identity-1',
    userId: 'user-1',
    telegramUserId: 555n,
    username: 'alice',
    firstName: 'Alice',
    lastName: null,
    photoUrl: null,
    linkedAt: now,
    status: 'active',
    lastSeenAt: now,
  };
  const newWorkspace = {
    id: 'workspace-1',
    name: '@alice',
    createdByUserId: 'user-1',
    createdAt: now,
    updatedAt: now,
    status: 'active',
  };
  return makeFakePool({
    insertResults: [
      [{ id: 'idem-1' }], // runIdempotent: acquire slot
      [newUser], // insert users
      [newIdentity], // insert telegram_identities
      [newWorkspace], // insert workspaces
      [], // insert workspace_members (no returning)
      [], // insert operation_log
    ],
    selectResults: [
      [], // select existing telegram_identities -> none
    ],
    updateResults: [
      [], // update users.lastActiveWorkspaceId / primaryTelegramIdentityId
      [{ id: 'idem-1' }], // runIdempotent: mark success
    ],
  });
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

describe('POST /auth/telegram', () => {
  it('valid signed initData -> 200 with AuthProjection (user + workspace)', async () => {
    const fake = newUserPool();
    app = await buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), {
      pool: fake.pool,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/telegram',
      headers: {
        authorization: signedHeader({
          user: JSON.stringify({ id: 555, first_name: 'Alice', username: 'alice' }),
          auth_date: freshAuthDate(),
        }),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect((body['user'] as Record<string, unknown>)['id']).toBe('user-1');
    expect((body['workspace'] as Record<string, unknown>)['name']).toBe('@alice');
    expect((body['identity'] as Record<string, unknown>)['telegram_user_id']).toBe('555');
    expect(body['is_new']).toBe(true);
    // `replayed` is internal idempotency state and is deliberately NOT in the
    // wire DTO — assert it never leaks into the public response body.
    expect(body['replayed']).toBeUndefined();
  });

  it('missing Authorization header -> 401', async () => {
    const fake = makeFakePool();
    app = await buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), {
      pool: fake.pool,
    });
    const res = await app.inject({ method: 'POST', url: '/auth/telegram' });
    expect(res.statusCode).toBe(401);
  });

  it('expired initData (auth_date > 24h old) -> 401', async () => {
    const fake = makeFakePool();
    app = await buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), {
      pool: fake.pool,
    });
    const oldAuthDate = String(Math.floor(Date.now() / 1000) - 25 * 3600);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/telegram',
      headers: {
        authorization: signedHeader({
          user: JSON.stringify({ id: 555, first_name: 'Alice' }),
          auth_date: oldAuthDate,
        }),
      },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe('expired');
  });

  it('tampered initData (bad hash) -> 401', async () => {
    const fake = makeFakePool();
    app = await buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), {
      pool: fake.pool,
    });
    const signed = signInitDataForTest(
      {
        user: JSON.stringify({ id: 555, first_name: 'Alice' }),
        auth_date: freshAuthDate(),
      },
      BOT_TOKEN,
    );
    // Flip the last hex char of the hash so the HMAC no longer matches.
    const params = new URLSearchParams(signed);
    const hash = params.get('hash') ?? '';
    const lastChar = hash.slice(-1);
    const flipped = lastChar === '0' ? '1' : '0';
    params.set('hash', hash.slice(0, -1) + flipped);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/telegram',
      headers: { authorization: `tma ${params.toString()}` },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe('invalid_hash');
  });
});

describe('GET /me', () => {
  it('valid initData but no existing user -> 404', async () => {
    // readCurrentUser opens a read-only transaction, then select(identity)
    // returns [] -> CommandError('not_found') -> route maps to 404.
    const fake = makeFakePool({ selectResults: [[]] });
    app = await buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), {
      pool: fake.pool,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: {
        authorization: signedHeader({
          user: JSON.stringify({ id: 777, first_name: 'Bob' }),
          auth_date: freshAuthDate(),
        }),
      },
    });
    expect(res.statusCode).toBe(404);
  });

  it('missing Authorization header -> 401', async () => {
    const fake = makeFakePool();
    app = await buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), {
      pool: fake.pool,
    });
    const res = await app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
  });
});

describe('error body sanitization (regression guard for CommandError leakage)', () => {
  it('GET /me 404 body carries no idempotency-key or internal field strings', async () => {
    const fake = makeFakePool({ selectResults: [[]] });
    app = await buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }), {
      pool: fake.pool,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: {
        authorization: signedHeader({
          user: JSON.stringify({ id: 777, first_name: 'Bob' }),
          auth_date: freshAuthDate(),
        }),
      },
    });
    expect(res.statusCode).toBe(404);
    const raw = res.body;
    // The raw CommandError message was
    // "telegram identity not found; call /auth/telegram first" — the sanitized
    // body must not leak that internal phrasing, idempotency-key prefixes, or
    // schema field names.
    expect(raw).not.toContain('telegram identity not found');
    expect(raw).not.toContain('tma:');
    expect(raw).not.toContain('idempotencyKey');
    expect(raw).not.toContain('AuthenticateTelegram:');
  });
});
