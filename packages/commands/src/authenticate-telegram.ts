/**
 * AuthenticateTelegram command.
 *
 * Input: verified Telegram user (from initData) + idempotency key.
 * Output: { user, identity, defaultWorkspace, isNew }.
 *
 * Behaviour:
 * - If telegram_user_id exists → update profile fields, return existing user
 *   + their last_active_workspace (or first owned workspace) as defaultWorkspace.
 * - If telegram_user_id is new → create user + identity + default workspace
 *   + owner membership atomically inside a transaction.
 * - Wrapped in `runIdempotent` keyed by `AuthenticateTelegram:<idempotencyKey>`
 *   so double POSTs converge to the same user/workspace.
 * - OperationLog gets one entry per non-replayed call.
 *
 * См. tg_mvp_plan/05-SECURITY-AND-ACCOUNTS.md, 12-EDGE-CASES.md §1.
 */

import { and, eq, sql } from 'drizzle-orm';
import type { TelegramIdentity, User, Workspace, WorkspaceRole } from '@postdash/domain';
import type { Database, DbOrTx } from '@postdash/db';
import {
  operationLog,
  telegramIdentities,
  users,
  workspaceMembers,
  workspaces,
} from '@postdash/db';
import { CommandError } from './errors.js';
import { runIdempotent } from './idempotency.js';
import { assembleAuthResult, rowToIdentity, rowToUser, rowToWorkspace } from './row-mappers.js';

export interface TelegramUserInput {
  telegramUserId: number;
  username: string | null;
  firstName: string;
  lastName: string | null;
  photoUrl: string | null;
}

export interface AuthenticateTelegramInput {
  idempotencyKey: string;
  telegramUser: TelegramUserInput;
}

export interface AuthenticateTelegramResult {
  user: User;
  identity: TelegramIdentity;
  defaultWorkspace: Workspace;
  role: WorkspaceRole;
  /**
   * True only on the FRESH execution that created the user. This is an
   * explicitly execute-only field and is NOT part of the idempotent-replay
   * contract: a replay of the same idempotency key always reports
   * `isNew: false`, because by replay time the user already exists — the
   * replay is not a new-user creation. Same treatment the internal `replayed`
   * flag gets: callers must not assume `isNew` is stable across a retry.
   */
  isNew: boolean;
}

const COMMAND_TYPE = 'AuthenticateTelegram';

export async function authenticateTelegram(
  db: Database,
  input: AuthenticateTelegramInput,
): Promise<{ replayed: boolean; result: AuthenticateTelegramResult }> {
  if (!input.idempotencyKey.trim()) {
    throw new CommandError('validation_failed', 'idempotencyKey is required');
  }
  // isSafeInteger, not just isFinite: a telegramUserId past 2^53 cannot be
  // BigInt-cast without precision loss, which would collide two users on one
  // identity row. The HTTP path already guards this in parseInitData; this is
  // the defense for any non-route caller of the command.
  if (!Number.isSafeInteger(input.telegramUser.telegramUserId)) {
    throw new CommandError('validation_failed', 'telegramUserId is not a safe integer');
  }
  if (!input.telegramUser.firstName.trim()) {
    throw new CommandError('validation_failed', 'firstName is required');
  }

  return runIdempotent<AuthenticateTelegramResult>(
    db,
    {
      commandType: COMMAND_TYPE,
      idempotencyKey: input.idempotencyKey,
    },
    {
      // `runIdempotent` owns the transaction now: the work's writes and the
      // idempotency slot's success-UPDATE commit atomically inside the SAME
      // `tx`. A crash mid-transaction rolls back the operation_log insert too,
      // so a PENDING_TTL reclaim is a genuinely fresh run — no duplicate
      // operation_log row. See idempotency.ts crash-safety contract.
      execute: async (tx) => {
        const out = await doAuthenticate(tx, input);
        return {
          objectType: 'user',
          objectId: out.user.id,
          result: out,
        };
      },
      loadFromPointer: async ({ objectId }) => loadByUserId(db, objectId),
    },
  );
}

async function doAuthenticate(
  tx: DbOrTx,
  input: AuthenticateTelegramInput,
): Promise<AuthenticateTelegramResult> {
  const telegramUserId = BigInt(input.telegramUser.telegramUserId);

  const existingIdentityRows = await tx
    .select()
    .from(telegramIdentities)
    .where(eq(telegramIdentities.telegramUserId, telegramUserId))
    .limit(1);
  const existingIdentity = existingIdentityRows[0];

  if (existingIdentity) {
    // 'revoked' is an administrative kill-switch — we must not silently revive
    // such an identity on the next /auth/telegram. blocked_bot, by contrast,
    // is a soft state the user clears by un-blocking the bot and re-opening
    // the Mini App, so we DO clear it on re-auth.
    if (existingIdentity.status === 'revoked') {
      throw new CommandError('forbidden', 'telegram identity is revoked');
    }
    // Update profile fields (Telegram username/names can change) + clear blocked_bot flag.
    await tx
      .update(telegramIdentities)
      .set({
        username: input.telegramUser.username,
        firstName: input.telegramUser.firstName,
        lastName: input.telegramUser.lastName,
        photoUrl: input.telegramUser.photoUrl,
        status: 'active',
        lastSeenAt: sql`now()`,
      })
      .where(eq(telegramIdentities.id, existingIdentity.id));

    const refreshedRows = await tx
      .select()
      .from(telegramIdentities)
      .where(eq(telegramIdentities.id, existingIdentity.id))
      .limit(1);
    const refreshedIdentity = refreshedRows[0];
    if (!refreshedIdentity) {
      throw new CommandError('internal', 'telegram_identity disappeared after update');
    }

    const userRows = await tx
      .select()
      .from(users)
      .where(eq(users.id, existingIdentity.userId))
      .limit(1);
    const user = userRows[0];
    if (!user) {
      throw new CommandError('internal', 'orphaned telegram_identity points to missing user');
    }

    const { workspace, role, autocreated } = await ensureDefaultWorkspace(
      tx,
      user.id,
      input.telegramUser,
    );

    if (user.lastActiveWorkspaceId !== workspace.id) {
      await tx
        .update(users)
        .set({ lastActiveWorkspaceId: workspace.id })
        .where(eq(users.id, user.id));
    }

    // `workspace_autocreated` records the rare case where an existing user
    // had no active workspace and ensureDefaultWorkspace had to create one —
    // otherwise that workspace+membership creation would leave no audit
    // trail of its own. Omitted (rather than `false`) on the common path.
    await tx.insert(operationLog).values({
      workspaceId: workspace.id,
      userId: user.id,
      telegramUserId,
      commandType: COMMAND_TYPE,
      objectType: 'user',
      objectId: user.id,
      payloadSummary: {
        isNew: false,
        identity_status: refreshedIdentity.status,
        ...(autocreated ? { workspace_autocreated: true } : {}),
      },
      result: 'success',
    });

    return assembleAuthResult({
      userRow: { ...user, lastActiveWorkspaceId: workspace.id },
      identityRow: refreshedIdentity,
      workspaceRow: workspace,
      role,
      isNew: false,
    });
  }

  // New user path.
  const newUserRows = await tx.insert(users).values({ status: 'active' }).returning();
  const newUser = newUserRows[0];
  if (!newUser) throw new CommandError('internal', 'users insert returned no row');

  let newIdentity;
  try {
    const newIdentityRows = await tx
      .insert(telegramIdentities)
      .values({
        userId: newUser.id,
        telegramUserId,
        username: input.telegramUser.username,
        firstName: input.telegramUser.firstName,
        lastName: input.telegramUser.lastName,
        photoUrl: input.telegramUser.photoUrl,
        status: 'active',
        lastSeenAt: sql`now()`,
      })
      .returning();
    newIdentity = newIdentityRows[0];
  } catch (err) {
    // Race: a concurrent first-auth for the same telegram_user_id won the
    // unique constraint. Surface as a CommandError so runIdempotent releases
    // the slot — the client's retry will hit the "existing identity" branch.
    if (isUniqueViolation(err)) {
      throw new CommandError(
        'conflict',
        'telegram_user_id was claimed by a concurrent request; retry',
      );
    }
    throw err;
  }
  if (!newIdentity)
    throw new CommandError('internal', 'telegram_identities insert returned no row');

  const workspaceName = pickWorkspaceName(input.telegramUser);
  const newWorkspaceRows = await tx
    .insert(workspaces)
    .values({ name: workspaceName, createdByUserId: newUser.id, status: 'active' })
    .returning();
  const newWorkspace = newWorkspaceRows[0];
  if (!newWorkspace) throw new CommandError('internal', 'workspaces insert returned no row');

  await tx
    .insert(workspaceMembers)
    .values({ workspaceId: newWorkspace.id, userId: newUser.id, role: 'owner', status: 'active' });

  // Single UPDATE covers both deferred-FK fields (primary identity + last
  // active workspace) — both have a chicken-and-egg with the rows above.
  await tx
    .update(users)
    .set({ lastActiveWorkspaceId: newWorkspace.id, primaryTelegramIdentityId: newIdentity.id })
    .where(eq(users.id, newUser.id));

  // `workspace_name` is derived from the Telegram username / first_name, so it
  // is PII landing in the audit log. This is intentional: operation_log is the
  // forensic trail for account creation and the workspace name is part of what
  // was created — auditability wins over minimization for this one field.
  await tx.insert(operationLog).values({
    workspaceId: newWorkspace.id,
    userId: newUser.id,
    telegramUserId,
    commandType: COMMAND_TYPE,
    objectType: 'user',
    objectId: newUser.id,
    payloadSummary: { isNew: true, workspace_name: workspaceName },
    result: 'success',
  });

  return assembleAuthResult({
    userRow: {
      ...newUser,
      primaryTelegramIdentityId: newIdentity.id,
      lastActiveWorkspaceId: newWorkspace.id,
    },
    identityRow: newIdentity,
    workspaceRow: newWorkspace,
    role: 'owner',
    isNew: true,
  });
}

export interface ResolvedWorkspace {
  workspace: {
    id: string;
    name: string;
    createdByUserId: string;
    createdAt: Date;
    updatedAt: Date;
    status: string;
  };
  role: WorkspaceRole;
  /**
   * True only when `ensureDefaultWorkspace` had to CREATE the workspace for an
   * existing user who had none. `findDefaultWorkspace` (pure read) never sets
   * it. Used to flag the auto-creation in the operation_log payloadSummary.
   */
  autocreated?: boolean;
}

/**
 * Resolves a user's default workspace: prefer `last_active_workspace` if the
 * user is still an active member of it, else the oldest active membership.
 * Returns null if the user has no active workspace.
 *
 * Single source of truth for "which workspace is this user's default" — used
 * by the execute() path (`ensureDefaultWorkspace`), the replay path
 * (`loadByUserId`), and the read path (`readCurrentUser` / GET /me) so all
 * three pick the SAME workspace. Divergence here is an idempotency-contract
 * break (a replay or a /me read disagreeing with the original auth call).
 */
export async function findDefaultWorkspace(
  tx: DbOrTx,
  userId: string,
  lastActiveWorkspaceId: string | null,
): Promise<ResolvedWorkspace | null> {
  if (lastActiveWorkspaceId) {
    const wsRows = await tx
      .select()
      .from(workspaces)
      .innerJoin(workspaceMembers, eq(workspaceMembers.workspaceId, workspaces.id))
      .where(
        and(
          eq(workspaces.id, lastActiveWorkspaceId),
          eq(workspaceMembers.userId, userId),
          eq(workspaceMembers.status, 'active'),
          eq(workspaces.status, 'active'),
        ),
      )
      .limit(1);
    const found = wsRows[0];
    if (found) {
      return {
        workspace: found.workspaces,
        role: found.workspace_members.role as WorkspaceRole,
      };
    }
  }

  const memberRows = await tx
    .select()
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.userId, userId),
        eq(workspaceMembers.status, 'active'),
        eq(workspaces.status, 'active'),
      ),
    )
    .orderBy(workspaces.createdAt)
    .limit(1);
  const first = memberRows[0];
  if (first) {
    return {
      workspace: first.workspaces,
      role: first.workspace_members.role as WorkspaceRole,
    };
  }
  return null;
}

async function ensureDefaultWorkspace(
  tx: DbOrTx,
  userId: string,
  telegramUser: TelegramUserInput,
): Promise<ResolvedWorkspace> {
  const userRows = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = userRows[0];
  if (!user) throw new CommandError('internal', 'user disappeared mid-transaction');

  const existing = await findDefaultWorkspace(tx, userId, user.lastActiveWorkspaceId);
  if (existing) return existing;

  // User has no workspace yet (rare; e.g., previously deleted). Create one.
  // `autocreated: true` flags this for the operation_log audit trail.
  const wsName = pickWorkspaceName(telegramUser);
  const createdRows = await tx
    .insert(workspaces)
    .values({ name: wsName, createdByUserId: userId, status: 'active' })
    .returning();
  const created = createdRows[0];
  if (!created) throw new CommandError('internal', 'workspaces insert returned no row');
  await tx
    .insert(workspaceMembers)
    .values({ workspaceId: created.id, userId, role: 'owner', status: 'active' });
  return { workspace: created, role: 'owner', autocreated: true };
}

async function loadByUserId(db: Database, userId: string): Promise<AuthenticateTelegramResult> {
  const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = userRows[0];
  if (!user) throw new CommandError('not_found', `user ${userId} not found on replay`);

  const identityId = user.primaryTelegramIdentityId;
  if (!identityId) throw new CommandError('internal', 'user has no primary telegram identity');
  const identityRows = await db
    .select()
    .from(telegramIdentities)
    .where(eq(telegramIdentities.id, identityId))
    .limit(1);
  const identity = identityRows[0];
  if (!identity) throw new CommandError('internal', 'primary identity not found');

  // Resolve the workspace via the SAME helper the execute() path uses, so a
  // replay of a multi-workspace user returns the same defaultWorkspace as the
  // original call (idempotency-contract invariant).
  const resolved = await findDefaultWorkspace(db, userId, user.lastActiveWorkspaceId);
  if (!resolved) throw new CommandError('internal', 'replay found user but no workspace');

  // `isNew: false` on every replay — by design, not a divergence bug. The
  // execute() path may have returned `isNew: true` for this same idempotency
  // key, but a replay is not a new-user creation: the user demonstrably
  // already exists (we just loaded it). `isNew` is documented on
  // AuthenticateTelegramResult as an execute-only field outside the idempotent
  // contract, so this asymmetry is the contract, not a violation of it.
  return assembleAuthResult({
    userRow: user,
    identityRow: identity,
    workspaceRow: resolved.workspace,
    role: resolved.role,
    isNew: false,
  });
}

function pickWorkspaceName(user: TelegramUserInput): string {
  if (user.username && user.username.trim()) return `@${user.username}`;
  if (user.firstName.trim()) return `${user.firstName}'s workspace`;
  return 'My workspace';
}

/**
 * Postgres unique-violation guard: pg's error code 23505. Drivers wrap the
 * error differently (postgres-js exposes `.code`, pg uses `.code` on Error),
 * so we string-match both paths defensively.
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === '23505';
}

export const _internals = { pickWorkspaceName, rowToUser, rowToWorkspace, rowToIdentity };
