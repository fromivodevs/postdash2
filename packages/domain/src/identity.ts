/**
 * Pure domain types for identity / workspace.
 *
 * No I/O, no SDK imports. db row types live in @postdash/db; these are the
 * shapes domain logic + API projections work with.
 */

export type UserStatus = 'active' | 'disabled';

export interface User {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  status: UserStatus;
  primaryTelegramIdentityId: string | null;
  lastActiveWorkspaceId: string | null;
}

export type TelegramIdentityStatus = 'active' | 'blocked_bot' | 'revoked';

export interface TelegramIdentity {
  id: string;
  userId: string;
  telegramUserId: bigint;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  photoUrl: string | null;
  linkedAt: Date;
  status: TelegramIdentityStatus;
  lastSeenAt: Date | null;
}

export type WorkspaceStatus = 'active' | 'disabled';

export interface Workspace {
  id: string;
  name: string;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  status: WorkspaceStatus;
}

export type WorkspaceRole = 'owner' | 'admin' | 'editor' | 'viewer';
export type WorkspaceMemberStatus = 'active' | 'removed';

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: Date;
  status: WorkspaceMemberStatus;
}
