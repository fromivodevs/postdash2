/**
 * Display-name fallback for the signed-in Telegram user (§4, goal-keeper).
 *
 * Telegram identities may carry any subset of first_name / last_name /
 * username — only `telegram_user_id` is guaranteed. We prefer the human name
 * (first + optional last), fall back to @username, and finally to a neutral
 * label so a screen never renders an empty string. Mirrors the workspace-name
 * fallback style: pure string -> string, no React, trivially testable.
 */

import type { AuthProjection } from '../api/types.ts';

export function pickUserDisplayName(identity: AuthProjection['identity']): string {
  const first = identity.first_name?.trim();
  const last = identity.last_name?.trim();
  if (first) return last ? `${first} ${last}` : first;

  const username = identity.username?.trim();
  if (username) return `@${username}`;

  return 'Пользователь Telegram';
}
