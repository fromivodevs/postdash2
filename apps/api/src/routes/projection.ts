import type { AuthenticateTelegramResult, ReadCurrentUserResult } from '@postdash/commands';
import type { AuthProjection } from '@postdash/shared';

/**
 * Stable HTTP-shaped projection of auth/identity reads.
 *
 * The wire shape itself (`AuthProjection`) lives in `@postdash/shared` so the
 * API and the Mini App share a single typed source of truth — this module only
 * owns the command-result -> wire mapping. See auth-projection.ts in
 * packages/shared for the photoUrl / `replayed`-flag omission rationale.
 */
export type { AuthProjection };

export type ProjectionMaker = (result: AuthenticateTelegramResult) => AuthProjection;

export function projectAuthResult(result: AuthenticateTelegramResult): AuthProjection {
  return {
    user: {
      id: result.user.id,
      status: result.user.status,
      last_active_workspace_id: result.user.lastActiveWorkspaceId,
    },
    identity: {
      id: result.identity.id,
      telegram_user_id: result.identity.telegramUserId.toString(),
      username: result.identity.username,
      first_name: result.identity.firstName,
      last_name: result.identity.lastName,
      status: result.identity.status,
    },
    workspace: {
      id: result.defaultWorkspace.id,
      name: result.defaultWorkspace.name,
      status: result.defaultWorkspace.status,
    },
    role: result.role,
    is_new: result.isNew,
  };
}

/**
 * Projection for the read-only GET /me path. `is_new` is false: this is a read,
 * not the execution of an authenticate command. Sharing the wire shape with
 * `projectAuthResult` lets the Mini App keep one type.
 */
export function projectReadCurrentUser(result: ReadCurrentUserResult): AuthProjection {
  return {
    user: {
      id: result.user.id,
      status: result.user.status,
      last_active_workspace_id: result.user.lastActiveWorkspaceId,
    },
    identity: {
      id: result.identity.id,
      telegram_user_id: result.identity.telegramUserId.toString(),
      username: result.identity.username,
      first_name: result.identity.firstName,
      last_name: result.identity.lastName,
      status: result.identity.status,
    },
    workspace: {
      id: result.defaultWorkspace.id,
      name: result.defaultWorkspace.name,
      status: result.defaultWorkspace.status,
    },
    role: result.role,
    is_new: false,
  };
}
