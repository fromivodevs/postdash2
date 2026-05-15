import { describe, expect, it } from 'vitest';
import { authenticateTelegram } from '../authenticate-telegram.js';
import { makeMockDb } from './_mock-db.js';

const VALID_USER = {
  telegramUserId: 12345,
  username: 'adrian',
  firstName: 'Adrian',
  lastName: null,
  photoUrl: null,
};

describe('authenticateTelegram — input validation', () => {
  it('rejects an empty idempotencyKey', async () => {
    const mock = makeMockDb();
    await expect(
      authenticateTelegram(mock.db, { idempotencyKey: '  ', telegramUser: VALID_USER }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    // Threw before touching the DB.
    expect(mock.calls).toEqual([]);
  });

  it('rejects a non-finite telegramUserId', async () => {
    const mock = makeMockDb();
    await expect(
      authenticateTelegram(mock.db, {
        idempotencyKey: 'k1',
        telegramUser: { ...VALID_USER, telegramUserId: Number.NaN },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(mock.calls).toEqual([]);
  });

  it('rejects an empty firstName', async () => {
    const mock = makeMockDb();
    await expect(
      authenticateTelegram(mock.db, {
        idempotencyKey: 'k1',
        telegramUser: { ...VALID_USER, firstName: '   ' },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(mock.calls).toEqual([]);
  });
});

describe('authenticateTelegram — idempotent double-call', () => {
  it('a 2nd call with the same idempotencyKey replays the cached result — same workspace, no second creation', async () => {
    const now = new Date();
    const newUser = {
      id: 'user-1',
      createdAt: now,
      updatedAt: now,
      status: 'active',
      primaryTelegramIdentityId: null as string | null,
      lastActiveWorkspaceId: null as string | null,
    };
    const newIdentity = {
      id: 'identity-1',
      userId: 'user-1',
      telegramUserId: 12345n,
      username: 'adrian',
      firstName: 'Adrian',
      lastName: null,
      photoUrl: null,
      linkedAt: now,
      status: 'active' as const,
      lastSeenAt: now,
    };
    const newWorkspace = {
      id: 'workspace-1',
      name: '@adrian',
      createdByUserId: 'user-1',
      createdAt: now,
      updatedAt: now,
      status: 'active',
    };
    // The user row as it looks AFTER the 1st call committed: primary identity
    // and last_active_workspace are now set, so the replay's loadByUserId +
    // findDefaultWorkspace resolve to the SAME workspace.
    const userAfterAuth = {
      ...newUser,
      primaryTelegramIdentityId: 'identity-1',
      lastActiveWorkspaceId: 'workspace-1',
    };

    // One shared scripted queue spanning BOTH calls (the mock's counters are
    // cumulative). Call 1: new-user happy path. Call 2: slot-conflict ->
    // cached-success replay.
    const mock = makeMockDb({
      insertResults: [
        [{ id: 'slot-1' }], // call 1 — runIdempotent: acquire slot
        [newUser], // call 1 — insert users
        [newIdentity], // call 1 — insert telegram_identities
        [newWorkspace], // call 1 — insert workspaces
        [], // call 1 — insert workspace_members
        [], // call 1 — insert operation_log
        [], // call 2 — runIdempotent: slot INSERT conflicts (ON CONFLICT DO NOTHING)
      ],
      selectResults: [
        [], // call 1 — doAuthenticate: existing identity lookup -> none
        // call 2 — runIdempotent: existing row is already 'success'
        [{ status: 'success', resultObjectType: 'user', resultObjectId: 'user-1' }],
        [userAfterAuth], // call 2 — loadByUserId: select users
        [newIdentity], // call 2 — loadByUserId: select telegram_identities
        // call 2 — findDefaultWorkspace: last_active_workspace join hit
        [{ workspaces: newWorkspace, workspace_members: { role: 'owner' } }],
      ],
      updateResults: [
        [], // call 1 — doAuthenticate: update users (primary id + last active)
        [{ id: 'slot-1' }], // call 1 — runIdempotent: mark slot success
      ],
    });

    const first = await authenticateTelegram(mock.db, {
      idempotencyKey: 'dup-key',
      telegramUser: VALID_USER,
    });
    expect(first.replayed).toBe(false);
    expect(first.result.isNew).toBe(true);
    expect(first.result.defaultWorkspace.id).toBe('workspace-1');

    const second = await authenticateTelegram(mock.db, {
      idempotencyKey: 'dup-key',
      telegramUser: VALID_USER,
    });
    // Double-click -> one workspace: the 2nd call is a replay of the cached
    // pointer, never a second create.
    expect(second.replayed).toBe(true);
    expect(second.result.defaultWorkspace.id).toBe(first.result.defaultWorkspace.id);
    expect(second.result.user.id).toBe(first.result.user.id);
    // `isNew` is execute-only and explicitly outside the idempotent-replay
    // contract: the fresh execute reported `true`, but the replay reports
    // `false` by design — by replay time the user already exists, so the
    // replay is not a new-user creation. See AuthenticateTelegramResult.isNew.
    expect(first.result.isNew).toBe(true);
    expect(second.result.isNew).toBe(false);
  });
});

describe('authenticateTelegram — revoked kill-switch', () => {
  it('throws forbidden when the existing identity is revoked, and releases the idempotency slot', async () => {
    const revokedIdentity = {
      id: 'idn-1',
      userId: 'usr-1',
      telegramUserId: 12345n,
      username: 'adrian',
      firstName: 'Adrian',
      lastName: null,
      photoUrl: null,
      linkedAt: new Date(),
      status: 'revoked' as const,
      lastSeenAt: null,
    };
    const mock = makeMockDb({
      // runIdempotent acquires the slot...
      insertResults: [[{ id: 'slot-1' }]],
      // ...then doAuthenticate's first SELECT finds a revoked identity.
      selectResults: [[revokedIdentity]],
    });

    await expect(
      authenticateTelegram(mock.db, { idempotencyKey: 'k1', telegramUser: VALID_USER }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // runIdempotent must release the slot it acquired on the failure path.
    expect(mock.deleteCount).toBe(1);
    // The transaction was entered (work.execute ran inside db.transaction).
    expect(mock.calls).toContain('transaction');
  });
});

describe('authenticateTelegram — concurrent first-auth race', () => {
  it('surfaces a 23505 on the new-user identity INSERT as conflict and releases the slot', async () => {
    const now = new Date();
    const newUser = {
      id: 'user-1',
      createdAt: now,
      updatedAt: now,
      status: 'active',
      primaryTelegramIdentityId: null as string | null,
      lastActiveWorkspaceId: null as string | null,
    };
    // Postgres unique-violation: a concurrent first-auth for the same
    // telegram_user_id won the unique constraint a beat earlier.
    const uniqueViolation = Object.assign(new Error('duplicate key value'), {
      code: '23505',
    });

    const mock = makeMockDb({
      insertResults: [
        [{ id: 'slot-1' }], // runIdempotent: acquire slot
        [newUser], // doAuthenticate: insert users
        uniqueViolation, // doAuthenticate: insert telegram_identities -> 23505
      ],
      selectResults: [
        [], // doAuthenticate: existing identity lookup -> none (so we take the new-user path)
      ],
    });

    await expect(
      authenticateTelegram(mock.db, { idempotencyKey: 'race-key', telegramUser: VALID_USER }),
    ).rejects.toMatchObject({ code: 'conflict' });

    // The slot runIdempotent acquired must be released so the client's retry
    // can re-acquire it and hit the "existing identity" branch.
    expect(mock.deleteCount).toBe(1);
    // The unique-violation surfaced from inside the work transaction.
    expect(mock.calls).toContain('transaction');
  });
});
