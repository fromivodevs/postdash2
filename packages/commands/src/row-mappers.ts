/**
 * Shared DB-row -> domain-type mappers.
 *
 * `authenticateTelegram` (write path) and `readCurrentUser` (read path) both
 * need to turn raw `users` / `telegram_identities` / `workspaces` rows into the
 * pure domain types. These mappers were byte-duplicated between the two
 * modules; extracting them here keeps one definition so a status-narrowing
 * tweak or a new field can't drift between the read and write paths.
 *
 * Each mapper takes a structural row shape (not the Drizzle `$inferSelect`
 * type) so callers can pass a spread-patched row — e.g. authenticateTelegram
 * overrides `lastActiveWorkspaceId` before mapping.
 */

import type { TelegramIdentity, User, Workspace, WorkspaceRole } from '@postdash/domain';

export function rowToUser(row: {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  status: string;
  primaryTelegramIdentityId: string | null;
  lastActiveWorkspaceId: string | null;
}): User {
  return {
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.status === 'disabled' ? 'disabled' : 'active',
    primaryTelegramIdentityId: row.primaryTelegramIdentityId,
    lastActiveWorkspaceId: row.lastActiveWorkspaceId,
  };
}

export function rowToIdentity(row: {
  id: string;
  userId: string;
  telegramUserId: bigint;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
  linkedAt: Date;
  status: string;
  lastSeenAt: Date | null;
}): TelegramIdentity {
  return {
    id: row.id,
    userId: row.userId,
    telegramUserId: row.telegramUserId,
    username: row.username,
    firstName: row.firstName,
    lastName: row.lastName,
    photoUrl: row.photoUrl,
    linkedAt: row.linkedAt,
    status:
      row.status === 'blocked_bot'
        ? 'blocked_bot'
        : row.status === 'revoked'
          ? 'revoked'
          : 'active',
    lastSeenAt: row.lastSeenAt,
  };
}

export function rowToWorkspace(row: {
  id: string;
  name: string;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  status: string;
}): Workspace {
  return {
    id: row.id,
    name: row.name,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.status === 'disabled' ? 'disabled' : 'active',
  };
}

/**
 * Single assembler for the `AuthenticateTelegram` result shape, shared by BOTH
 * the execute path (`doAuthenticate`, new + existing user) and the replay path
 * (`loadByUserId`). Keeping one definition means a future field added to the
 * result cannot diverge between the two paths — a divergence there is an
 * idempotency-contract break (a replay disagreeing with the original call).
 *
 * Takes raw DB rows (the same structural shapes the mappers accept) so callers
 * can pass spread-patched rows — e.g. the execute path overrides
 * `lastActiveWorkspaceId` / `primaryTelegramIdentityId` before assembly.
 */
export function assembleAuthResult(args: {
  userRow: Parameters<typeof rowToUser>[0];
  identityRow: Parameters<typeof rowToIdentity>[0];
  workspaceRow: Parameters<typeof rowToWorkspace>[0];
  role: WorkspaceRole;
  isNew: boolean;
}): {
  user: User;
  identity: TelegramIdentity;
  defaultWorkspace: Workspace;
  role: WorkspaceRole;
  isNew: boolean;
} {
  return {
    user: rowToUser(args.userRow),
    identity: rowToIdentity(args.identityRow),
    defaultWorkspace: rowToWorkspace(args.workspaceRow),
    role: args.role,
    isNew: args.isNew,
  };
}
