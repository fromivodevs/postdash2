/**
 * DB-backed tests for `createConnectCode`. Gated by SKIP_DB_TESTS=1.
 *
 * Covers tests #1-3 from architecture/channel-connection.md test plan:
 *   #1: creates active code with 30-min TTL + correct code_hash + audit row.
 *   #2: replay of a successful create fails with `idempotency_replay_impossible`.
 *   #3: editor role is forbidden.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createConnectCode } from '../create-connect-code.js';
import { hashConnectCode } from '../connect-code-helpers.js';
import { CommandError } from '../errors.js';
import { SKIP_DB, setupTestDb, seedUserAndWorkspace, type TestDbHandle } from './_db-helpers.js';

describe.skipIf(SKIP_DB)('createConnectCode (DB)', () => {
  let handle: TestDbHandle;
  beforeAll(async () => {
    handle = await setupTestDb('create_connect_code');
  });
  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it('creates an active code with 30-min TTL, correct code_hash, and audit row', async () => {
    const { userId, workspaceId } = await seedUserAndWorkspace(handle.db, { role: 'owner' });
    const tBefore = Date.now();
    const out = await createConnectCode(handle.db, {
      idempotencyKey: 'k-create-1',
      workspaceId,
      userId,
    });
    const tAfter = Date.now();
    expect(out.replayed).toBe(false);
    expect(out.result.code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    expect(out.result.workspaceId).toBe(workspaceId);

    // Verify the persisted row has the correct hash and a ~30-min expiry.
    const codeHash = hashConnectCode(out.result.code);
    const rows = await handle.db.execute<{
      id: string;
      status: string;
      code_hash: string;
      expires_at: Date;
      workspace_id: string;
      created_by_user_id: string;
    }>(
      sql`SELECT id, status, code_hash, expires_at, workspace_id, created_by_user_id
          FROM channel_connect_codes WHERE id = ${out.result.connectCodeId}`,
    );
    const row = rows[0];
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.status).toBe('active');
    expect(row.code_hash).toBe(codeHash);
    expect(row.workspace_id).toBe(workspaceId);
    expect(row.created_by_user_id).toBe(userId);

    const expiresMs = new Date(row.expires_at).getTime();
    // 30 minutes from "just before the call". Allow a generous 5s window for
    // clock drift between Node and Postgres.
    const expectedLow = tBefore + 30 * 60 * 1000 - 5_000;
    const expectedHigh = tAfter + 30 * 60 * 1000 + 5_000;
    expect(expiresMs).toBeGreaterThanOrEqual(expectedLow);
    expect(expiresMs).toBeLessThanOrEqual(expectedHigh);

    // operation_log: exactly one row, no plaintext code, no code_hash in summary.
    const audit = await handle.db.execute<{
      command_type: string;
      object_type: string;
      object_id: string;
      payload_summary: { expires_in_seconds?: number; code?: string; code_hash?: string };
    }>(
      sql`SELECT command_type, object_type, object_id, payload_summary
          FROM operation_log
          WHERE object_type = 'channel_connect_code' AND object_id = ${row.id}`,
    );
    expect(audit.length).toBe(1);
    const auditRow = audit[0];
    expect(auditRow).toBeDefined();
    if (!auditRow) return;
    expect(auditRow.command_type).toBe('CreateConnectCode');
    expect(auditRow.payload_summary?.expires_in_seconds).toBe(1800);
    expect(auditRow.payload_summary?.code).toBeUndefined();
    expect(auditRow.payload_summary?.code_hash).toBeUndefined();
  });

  it('double-call with the same idempotencyKey fails with idempotency_replay_impossible', async () => {
    const { userId, workspaceId } = await seedUserAndWorkspace(handle.db, { role: 'admin' });
    const first = await createConnectCode(handle.db, {
      idempotencyKey: 'k-dup-1',
      workspaceId,
      userId,
    });
    expect(first.replayed).toBe(false);
    expect(first.result.code).toBeDefined();

    // Replay attempt: must throw 'conflict' with details.code='idempotency_replay_impossible'.
    let caught: unknown;
    try {
      await createConnectCode(handle.db, {
        idempotencyKey: 'k-dup-1',
        workspaceId,
        userId,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CommandError);
    expect((caught as CommandError).code).toBe('conflict');
    expect((caught as CommandError).details?.code).toBe('idempotency_replay_impossible');
  });

  it('rejects an editor with CommandError(forbidden)', async () => {
    const { userId, workspaceId } = await seedUserAndWorkspace(handle.db, { role: 'editor' });
    let caught: unknown;
    try {
      await createConnectCode(handle.db, {
        idempotencyKey: 'k-editor',
        workspaceId,
        userId,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CommandError);
    expect((caught as CommandError).code).toBe('forbidden');

    // No code row should have been created.
    const rows = await handle.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM channel_connect_codes WHERE workspace_id = ${workspaceId}`,
    );
    expect(rows[0]?.count).toBe('0');
  });
});
