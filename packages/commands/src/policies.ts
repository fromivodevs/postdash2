/**
 * Workspace-role policies shared across commands.
 *
 * Phase 2 first need: gate `CreateConnectCodeCommand` and
 * `ConnectTelegramChannelCommand` on `role >= 'admin'`. Future phases will
 * reuse `assertWorkspaceRole` for source subscriptions, post drafts, publish,
 * etc. (`packages/policies/` is a Phase 0 stub that may absorb this in
 * Phase 3+ when more policies land — see architecture doc "Risks §7").
 *
 * Single source of truth for rank ordering — a future reorganisation that
 * adds e.g. `'analyst'` between `'viewer'` and `'editor'` only needs to edit
 * ROLE_RANK here, NOT every caller.
 */

import { and, eq } from 'drizzle-orm';
import type { WorkspaceRole } from '@postdash/domain';
import type { DbOrTx } from '@postdash/db';
import { workspaceMembers } from '@postdash/db';
import { CommandError } from './errors.js';

/**
 * Numeric rank for `WorkspaceRole`. Higher = more privileged. Comparisons
 * use `>=`: `assertWorkspaceRole(..., 'admin')` accepts `'admin'` and
 * `'owner'`, rejects `'editor'` and `'viewer'`.
 *
 * The ordering is intentionally `owner > admin > editor > viewer` — `'owner'`
 * has every permission `'admin'` does plus workspace-lifecycle privileges
 * (deferred to Phase 9: rename, delete, transfer).
 */
export const ROLE_RANK: Readonly<Record<WorkspaceRole, number>> = Object.freeze({
  viewer: 1,
  editor: 2,
  admin: 3,
  owner: 4,
});

export type WorkspaceMinRole = WorkspaceRole;

/**
 * Asserts that `userId` is an active member of `workspaceId` AND that their
 * role rank is at least `minRole`. Throws `CommandError('forbidden', ...)`
 * otherwise.
 *
 * Reads `workspace_members WHERE workspace_id=$1 AND user_id=$2 AND
 * status='active'`. A row in status='removed' counts as "not a member"
 * (the soft-delete pattern; see workspace_members status check).
 *
 * Pass the transaction handle from the surrounding command so the role check
 * and the subsequent writes see one consistent snapshot (a concurrent
 * remove-member is observed atomically against the work).
 *
 * Returns the actual role so callers can record it in audit logs without a
 * second SELECT.
 */
export async function assertWorkspaceRole(
  tx: DbOrTx,
  workspaceId: string,
  userId: string,
  minRole: WorkspaceMinRole,
): Promise<{ role: WorkspaceRole }> {
  const rows = await tx
    .select({ role: workspaceMembers.role, status: workspaceMembers.status })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new CommandError(
      'forbidden',
      `user ${userId} is not a member of workspace ${workspaceId}`,
    );
  }
  if (row.status !== 'active') {
    throw new CommandError(
      'forbidden',
      `user ${userId} membership in workspace ${workspaceId} is ${row.status}`,
    );
  }
  const role = narrowRole(row.role);
  if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
    throw new CommandError(
      'forbidden',
      `role '${role}' is below required minimum '${minRole}'`,
    );
  }
  return { role };
}

/**
 * Narrow the raw `text` column from the DB into the `WorkspaceRole` union.
 * The CHECK constraint guarantees one of four values, but TS doesn't see
 * CHECK constraints — if the DB ever returns something else, that's an
 * integrity bug; we fall back to the most-restrictive role `'viewer'` so a
 * corrupt row can't accidentally grant elevated access.
 */
function narrowRole(s: string): WorkspaceRole {
  if (s === 'owner') return 'owner';
  if (s === 'admin') return 'admin';
  if (s === 'editor') return 'editor';
  return 'viewer';
}
