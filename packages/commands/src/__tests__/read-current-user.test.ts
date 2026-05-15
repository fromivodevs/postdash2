/**
 * Unit tests for readCurrentUser. Uses the shared scripted mock DB — the three
 * SELECTs now run inside a read-only `db.transaction`, so the mock's
 * `transaction()` passthrough is exercised here too.
 */

import { describe, expect, it } from 'vitest';
import { CommandError } from '../errors.js';
import { readCurrentUser } from '../read-current-user.js';
import { makeMockDb } from './_mock-db.js';

const baseIdentity = {
  id: 'idn-1',
  userId: 'usr-1',
  telegramUserId: 100n,
  username: 'adrian',
  firstName: 'Adrian',
  lastName: null,
  photoUrl: null,
  linkedAt: new Date('2026-05-01T00:00:00Z'),
  status: 'active' as const,
  lastSeenAt: new Date('2026-05-13T00:00:00Z'),
};
const baseUser = {
  id: 'usr-1',
  createdAt: new Date('2026-05-01T00:00:00Z'),
  updatedAt: new Date('2026-05-01T00:00:00Z'),
  status: 'active' as const,
  primaryTelegramIdentityId: 'idn-1',
  lastActiveWorkspaceId: 'ws-1',
};
const baseWorkspaceJoin = {
  workspaces: {
    id: 'ws-1',
    name: "Adrian's workspace",
    createdByUserId: 'usr-1',
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: new Date('2026-05-01T00:00:00Z'),
    status: 'active' as const,
  },
  workspace_members: { role: 'owner' as const },
};

describe('readCurrentUser', () => {
  it('returns user/identity/workspace for an active identity (inside a transaction)', async () => {
    const mock = makeMockDb({
      selectResults: [[baseIdentity], [baseUser], [baseWorkspaceJoin]],
    });
    const result = await readCurrentUser(mock.db, { telegramUserId: 100 });
    expect(result.user.id).toBe('usr-1');
    expect(result.identity.id).toBe('idn-1');
    expect(result.defaultWorkspace.id).toBe('ws-1');
    expect(result.role).toBe('owner');
    // All three reads happened inside the read-only transaction.
    expect(mock.calls[0]).toBe('transaction');
    expect(mock.selectCount).toBe(3);
  });

  it('throws not_found when no identity row exists', async () => {
    const mock = makeMockDb({ selectResults: [[]] });
    await expect(readCurrentUser(mock.db, { telegramUserId: 999 })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('throws forbidden when identity status is revoked (admin kill-switch)', async () => {
    const revoked = { ...baseIdentity, status: 'revoked' as const };
    const mock = makeMockDb({ selectResults: [[revoked]] });
    await expect(readCurrentUser(mock.db, { telegramUserId: 100 })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('throws internal when the identity points to a missing user', async () => {
    const mock = makeMockDb({ selectResults: [[baseIdentity], []] });
    await expect(readCurrentUser(mock.db, { telegramUserId: 100 })).rejects.toMatchObject({
      code: 'internal',
    });
  });

  it('throws internal when the user has no active workspace', async () => {
    const mock = makeMockDb({ selectResults: [[baseIdentity], [baseUser], []] });
    await expect(readCurrentUser(mock.db, { telegramUserId: 100 })).rejects.toMatchObject({
      code: 'internal',
    });
  });

  it('throws validation_failed when telegramUserId is not finite', async () => {
    const mock = makeMockDb();
    await expect(readCurrentUser(mock.db, { telegramUserId: Number.NaN })).rejects.toBeInstanceOf(
      CommandError,
    );
  });
});
