/**
 * Read-only query that backs GET /me. Resolves the current user from a
 * verified Telegram identity without writing anything.
 *
 * Returns CommandError('not_found') if the Telegram user hasn't authenticated
 * yet — the client should call POST /auth/telegram first.
 *
 * Splitting this from authenticateTelegram fixes the read/write conflation
 * flagged in the Phase 1 step-perfect-loop: /me must not UPDATE profile
 * fields, INSERT operation_log rows, or hold an idempotency slot.
 */

import { eq } from 'drizzle-orm';
import type { TelegramIdentity, User, Workspace, WorkspaceRole } from '@postdash/domain';
import type { Database, DbOrTx } from '@postdash/db';
import { telegramIdentities, users } from '@postdash/db';
import { findDefaultWorkspace } from './authenticate-telegram.js';
import { CommandError } from './errors.js';
import { rowToIdentity, rowToUser, rowToWorkspace } from './row-mappers.js';

export interface ReadCurrentUserInput {
  telegramUserId: number;
}

export interface ReadCurrentUserResult {
  user: User;
  identity: TelegramIdentity;
  defaultWorkspace: Workspace;
  role: WorkspaceRole;
}

export async function readCurrentUser(
  db: Database,
  input: ReadCurrentUserInput,
): Promise<ReadCurrentUserResult> {
  // isSafeInteger guards against a telegramUserId past 2^53 colliding two
  // users on one identity row once BigInt-cast (see authenticate-telegram.ts).
  if (!Number.isSafeInteger(input.telegramUserId)) {
    throw new CommandError('validation_failed', 'telegramUserId is not a safe integer');
  }
  const telegramUserId = BigInt(input.telegramUserId);

  // The three reads run inside one read-only transaction so an admin
  // revocation (or workspace delete) cannot interleave between them and
  // produce a half-consistent view.
  return db.transaction((tx) => readWithin(tx, telegramUserId), {
    accessMode: 'read only',
    isolationLevel: 'repeatable read',
  });
}

async function readWithin(tx: DbOrTx, telegramUserId: bigint): Promise<ReadCurrentUserResult> {
  const identityRows = await tx
    .select()
    .from(telegramIdentities)
    .where(eq(telegramIdentities.telegramUserId, telegramUserId))
    .limit(1);
  const identity = identityRows[0];
  if (!identity) {
    throw new CommandError('not_found', 'telegram identity not found; call /auth/telegram first');
  }
  // Honour the admin kill-switch on the read path too. authenticateTelegram
  // throws 'forbidden' on revoked re-auth; without this check, /me would
  // happily return a full session for a revoked identity.
  if (identity.status === 'revoked') {
    throw new CommandError('forbidden', 'telegram identity is revoked');
  }

  const userRows = await tx.select().from(users).where(eq(users.id, identity.userId)).limit(1);
  const user = userRows[0];
  if (!user) {
    throw new CommandError('internal', 'orphaned telegram_identity points to missing user');
  }

  // Resolve the default workspace via the shared helper so GET /me picks the
  // SAME workspace as POST /auth/telegram (last_active preference, else oldest).
  const resolved = await findDefaultWorkspace(tx, user.id, user.lastActiveWorkspaceId);
  if (!resolved) {
    throw new CommandError('internal', 'user has no active workspace');
  }

  return {
    user: rowToUser(user),
    identity: rowToIdentity(identity),
    defaultWorkspace: rowToWorkspace(resolved.workspace),
    role: resolved.role,
  };
}
