/**
 * DB-backed tests for `assertWorkspaceRole`. Gated by SKIP_DB_TESTS=1.
 *
 * Asserts:
 *   - viewer/editor cannot pass an 'admin' minimum.
 *   - admin/owner can.
 *   - removed membership counts as "not a member".
 *   - non-member user is rejected.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { CommandError } from '../errors.js';
import { assertWorkspaceRole, ROLE_RANK } from '../policies.js';
import { SKIP_DB, setupTestDb, seedUserAndWorkspace, type TestDbHandle } from './_db-helpers.js';

describe('ROLE_RANK', () => {
  it('orders viewer < editor < admin < owner', () => {
    expect(ROLE_RANK.viewer).toBeLessThan(ROLE_RANK.editor);
    expect(ROLE_RANK.editor).toBeLessThan(ROLE_RANK.admin);
    expect(ROLE_RANK.admin).toBeLessThan(ROLE_RANK.owner);
  });
});

describe.skipIf(SKIP_DB)('assertWorkspaceRole (DB)', () => {
  let handle: TestDbHandle;
  beforeAll(async () => {
    handle = await setupTestDb('policies');
  });
  afterAll(async () => {
    if (handle) await handle.cleanup();
  });

  it('rejects an editor when minRole is admin', async () => {
    const { userId, workspaceId } = await seedUserAndWorkspace(handle.db, { role: 'editor' });
    await expect(
      assertWorkspaceRole(handle.db, workspaceId, userId, 'admin'),
    ).rejects.toBeInstanceOf(CommandError);
    await expect(
      assertWorkspaceRole(handle.db, workspaceId, userId, 'admin'),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('accepts an admin when minRole is admin', async () => {
    const { userId, workspaceId } = await seedUserAndWorkspace(handle.db, { role: 'admin' });
    const result = await assertWorkspaceRole(handle.db, workspaceId, userId, 'admin');
    expect(result.role).toBe('admin');
  });

  it('accepts an owner when minRole is admin', async () => {
    const { userId, workspaceId } = await seedUserAndWorkspace(handle.db, { role: 'owner' });
    const result = await assertWorkspaceRole(handle.db, workspaceId, userId, 'admin');
    expect(result.role).toBe('owner');
  });

  it('treats a removed membership as not-a-member (forbidden)', async () => {
    const { userId, workspaceId } = await seedUserAndWorkspace(handle.db, { role: 'admin' });
    // Flip the membership to 'removed'. assertWorkspaceRole must reject.
    await handle.db.execute(
      sql`UPDATE workspace_members SET status = 'removed'
          WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`,
    );
    await expect(
      assertWorkspaceRole(handle.db, workspaceId, userId, 'admin'),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rejects a user with no membership row at all', async () => {
    const { workspaceId } = await seedUserAndWorkspace(handle.db, { role: 'owner' });
    // Manufacture a second user with no membership in the workspace above.
    const newUser = await handle.db.execute<{ id: string }>(
      sql`INSERT INTO users (status) VALUES ('active') RETURNING id`,
    );
    const otherUserId = newUser[0]?.id;
    if (!otherUserId) throw new Error('user insert returned no row');
    await expect(
      assertWorkspaceRole(handle.db, workspaceId, otherUserId, 'viewer'),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});
