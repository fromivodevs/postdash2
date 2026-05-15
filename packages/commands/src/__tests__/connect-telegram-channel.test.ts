/**
 * DB-backed tests for `connectTelegramChannel`. Gated by SKIP_DB_TESTS=1.
 *
 * Covers tests #4-10 from architecture/channel-connection.md test plan:
 *   #4: expired code -> not_found (expired_code).
 *   #5: reused (consumed) code -> conflict (reused_code).
 *   #6: adapter bot_not_admin -> validation_failed (bot_not_admin), code stays active.
 *   #7: adapter missing_post_permission -> validation_failed (missing_post_permission).
 *   #8: channel taken by another workspace -> conflict (channel_taken), code stays active.
 *   #9: private channel (no @username) succeeds.
 *   #10: successful connect consumes code idempotently; replay returns same connection.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  connectTelegramChannel,
  type TelegramChannelAdapter,
  type VerifyConnectionResult,
} from '../connect-telegram-channel.js';
import { generateConnectCode, hashConnectCode } from '../connect-code-helpers.js';
import { CommandError } from '../errors.js';
import { SKIP_DB, setupTestDb, seedUserAndWorkspace, type TestDbHandle } from './_db-helpers.js';

function makeAdapter(result: VerifyConnectionResult): TelegramChannelAdapter & {
  verifyMock: ReturnType<typeof vi.fn>;
} {
  const verifyMock = vi.fn(async () => result);
  return { verifyConnection: verifyMock, verifyMock };
}

async function seedCode(
  db: TestDbHandle['db'],
  args: {
    workspaceId: string;
    userId: string;
    code: string;
    status?: 'active' | 'consumed' | 'expired';
    expiresAtOffsetMs?: number;
  },
): Promise<{ codeId: string; codeHash: string }> {
  const codeHash = hashConnectCode(args.code);
  const status = args.status ?? 'active';
  const offset = args.expiresAtOffsetMs ?? 30 * 60 * 1000;
  const expiresAt = new Date(Date.now() + offset);
  const rows = await db.execute<{ id: string }>(
    sql`INSERT INTO channel_connect_codes
          (workspace_id, created_by_user_id, code_hash, status, expires_at)
        VALUES (${args.workspaceId}, ${args.userId}, ${codeHash}, ${status}, ${expiresAt})
        RETURNING id`,
  );
  const row = rows[0];
  if (!row) throw new Error('seed code insert returned no row');
  return { codeId: row.id, codeHash };
}

const OK_VERIFICATION = (overrides: Partial<Extract<VerifyConnectionResult, { ok: true }>> = {}): VerifyConnectionResult => ({
  ok: true,
  externalId: '-1001234567890',
  title: 'Test Channel',
  username: 'testchan',
  photoUrl: null,
  chatType: 'channel',
  canPostMessages: true,
  ...overrides,
});

describe.skipIf(SKIP_DB)('connectTelegramChannel (DB)', () => {
  let handle: TestDbHandle;
  beforeAll(async () => {
    handle = await setupTestDb('connect_tg_channel');
  });
  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('#4: expired code -> CommandError(not_found, code=expired_code)', async () => {
    const { userId, workspaceId } = await seedUserAndWorkspace(handle.db, { role: 'admin' });
    const code = generateConnectCode();
    // expires_at 1 minute in the past.
    await seedCode(handle.db, {
      workspaceId,
      userId,
      code,
      expiresAtOffsetMs: -60_000,
    });

    const adapter = makeAdapter(OK_VERIFICATION());
    let caught: unknown;
    try {
      await connectTelegramChannel(handle.db, adapter, {
        idempotencyKey: 'k-expired',
        code,
        externalChatId: '@testchan',
        invokedBy: { source: 'miniapp', userId },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CommandError);
    expect((caught as CommandError).code).toBe('not_found');
    expect((caught as CommandError).details?.code).toBe('expired_code');
    // Adapter should not have been called (we throw before verify).
    expect(adapter.verifyMock).not.toHaveBeenCalled();
  });

  it('#5: reused (consumed) code -> CommandError(conflict, code=reused_code)', async () => {
    const { userId, workspaceId } = await seedUserAndWorkspace(handle.db, { role: 'admin' });
    const code = generateConnectCode();
    await seedCode(handle.db, { workspaceId, userId, code, status: 'consumed' });

    const adapter = makeAdapter(OK_VERIFICATION());
    let caught: unknown;
    try {
      await connectTelegramChannel(handle.db, adapter, {
        idempotencyKey: 'k-reused',
        code,
        externalChatId: '@testchan',
        invokedBy: { source: 'miniapp', userId },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CommandError);
    expect((caught as CommandError).code).toBe('conflict');
    expect((caught as CommandError).details?.code).toBe('reused_code');
    expect(adapter.verifyMock).not.toHaveBeenCalled();
  });

  it('#6: adapter bot_not_admin -> validation_failed; code stays active', async () => {
    const { userId, workspaceId } = await seedUserAndWorkspace(handle.db, { role: 'admin' });
    const code = generateConnectCode();
    const { codeId } = await seedCode(handle.db, { workspaceId, userId, code });

    const adapter = makeAdapter({
      ok: false,
      errorCode: 'bot_not_admin',
      detail: 'bot is not an administrator',
    });
    let caught: unknown;
    try {
      await connectTelegramChannel(handle.db, adapter, {
        idempotencyKey: 'k-notadmin',
        code,
        externalChatId: '@testchan',
        invokedBy: { source: 'miniapp', userId },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CommandError);
    expect((caught as CommandError).code).toBe('validation_failed');
    expect((caught as CommandError).details?.code).toBe('bot_not_admin');

    // Code must still be active so the user can retry after fixing perms.
    const rows = await handle.db.execute<{ status: string }>(
      sql`SELECT status FROM channel_connect_codes WHERE id = ${codeId}`,
    );
    expect(rows[0]?.status).toBe('active');
  });

  it('#7: adapter missing_post_permission -> validation_failed; code stays active', async () => {
    const { userId, workspaceId } = await seedUserAndWorkspace(handle.db, { role: 'admin' });
    const code = generateConnectCode();
    const { codeId } = await seedCode(handle.db, { workspaceId, userId, code });

    const adapter = makeAdapter({
      ok: false,
      errorCode: 'missing_post_permission',
      detail: 'bot lacks can_post_messages',
    });
    let caught: unknown;
    try {
      await connectTelegramChannel(handle.db, adapter, {
        idempotencyKey: 'k-nopost',
        code,
        externalChatId: '@testchan',
        invokedBy: { source: 'miniapp', userId },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CommandError);
    expect((caught as CommandError).code).toBe('validation_failed');
    expect((caught as CommandError).details?.code).toBe('missing_post_permission');

    const rows = await handle.db.execute<{ status: string }>(
      sql`SELECT status FROM channel_connect_codes WHERE id = ${codeId}`,
    );
    expect(rows[0]?.status).toBe('active');
  });

  it('#8: channel taken by another workspace -> conflict (channel_taken); code stays active', async () => {
    // Workspace A connects the channel first.
    const a = await seedUserAndWorkspace(handle.db, { role: 'admin' });
    const codeA = generateConnectCode();
    await seedCode(handle.db, { workspaceId: a.workspaceId, userId: a.userId, code: codeA });
    const adapterA = makeAdapter(OK_VERIFICATION({ externalId: '-100999' }));
    const firstResult = await connectTelegramChannel(handle.db, adapterA, {
      idempotencyKey: 'k-a',
      code: codeA,
      externalChatId: '@somechan',
      invokedBy: { source: 'miniapp', userId: a.userId },
    });
    expect(firstResult.replayed).toBe(false);
    expect(firstResult.result.channelConnection.status).toBe('connected');

    // Workspace B tries to connect the SAME channel (same externalId).
    const b = await seedUserAndWorkspace(handle.db, { role: 'admin' });
    const codeB = generateConnectCode();
    const { codeId: codeBId } = await seedCode(handle.db, {
      workspaceId: b.workspaceId,
      userId: b.userId,
      code: codeB,
    });
    const adapterB = makeAdapter(OK_VERIFICATION({ externalId: '-100999' }));
    let caught: unknown;
    try {
      await connectTelegramChannel(handle.db, adapterB, {
        idempotencyKey: 'k-b',
        code: codeB,
        externalChatId: '@somechan',
        invokedBy: { source: 'miniapp', userId: b.userId },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CommandError);
    expect((caught as CommandError).code).toBe('conflict');
    expect((caught as CommandError).details?.code).toBe('channel_taken');

    // Code B must still be active (user can't fix this on their own).
    const rows = await handle.db.execute<{ status: string }>(
      sql`SELECT status FROM channel_connect_codes WHERE id = ${codeBId}`,
    );
    expect(rows[0]?.status).toBe('active');
  });

  it('#9: private (no-username) channel with bot admin succeeds', async () => {
    const { userId, workspaceId } = await seedUserAndWorkspace(handle.db, { role: 'admin' });
    const code = generateConnectCode();
    await seedCode(handle.db, { workspaceId, userId, code });

    // chatType='channel' (not 'private_chat'), username=null = "private channel".
    const adapter = makeAdapter(
      OK_VERIFICATION({ externalId: '-100888', username: null, title: 'Secret Channel' }),
    );
    const result = await connectTelegramChannel(handle.db, adapter, {
      idempotencyKey: 'k-priv',
      code,
      externalChatId: '-100888',
      invokedBy: { source: 'miniapp', userId },
    });
    expect(result.replayed).toBe(false);
    expect(result.result.contentChannel.username).toBeNull();
    expect(result.result.contentChannel.title).toBe('Secret Channel');
    expect(result.result.channelConnection.status).toBe('connected');
    expect(result.result.channelConnection.canPostMessages).toBe(true);
    expect(result.result.channelConnection.lastVerifyStatus).toBe('ok');
  });

  it('#10: successful connect consumes code; replay returns same connection', async () => {
    const { userId, workspaceId } = await seedUserAndWorkspace(handle.db, { role: 'admin' });
    const code = generateConnectCode();
    const { codeId } = await seedCode(handle.db, { workspaceId, userId, code });

    const adapter = makeAdapter(OK_VERIFICATION({ externalId: '-100777' }));
    const first = await connectTelegramChannel(handle.db, adapter, {
      idempotencyKey: 'k-success',
      code,
      externalChatId: '@chan777',
      invokedBy: { source: 'miniapp', userId },
    });
    expect(first.replayed).toBe(false);

    // Code must be consumed now.
    const codeRows = await handle.db.execute<{ status: string; consumed_by_external_chat_id: string | null }>(
      sql`SELECT status, consumed_by_external_chat_id FROM channel_connect_codes WHERE id = ${codeId}`,
    );
    expect(codeRows[0]?.status).toBe('consumed');
    expect(codeRows[0]?.consumed_by_external_chat_id).toBe('-100777');

    // Replay with the same idempotency key returns the same connection
    // (via loadFromPointer). Adapter must NOT be called again.
    adapter.verifyMock.mockClear();
    const second = await connectTelegramChannel(handle.db, adapter, {
      idempotencyKey: 'k-success',
      code,
      externalChatId: '@chan777',
      invokedBy: { source: 'miniapp', userId },
    });
    expect(second.replayed).toBe(true);
    expect(second.result.channelConnection.id).toBe(first.result.channelConnection.id);
    expect(second.result.contentChannel.id).toBe(first.result.contentChannel.id);
    expect(adapter.verifyMock).not.toHaveBeenCalled();
  });
});
