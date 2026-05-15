/**
 * Command handlers.
 *
 * Phase 1+: AuthenticateTelegram, idempotency wrapper.
 * Phase 2+: CreateConnectCode, ConnectTelegramChannel.
 *
 * Критичные команды идемпотентны через `command_idempotency` таблицу
 * (см. tg_mvp_plan/02-ARCHITECTURE.md Rule 10).
 */

export { CommandError, type CommandErrorCode } from './errors.js';
export {
  runIdempotent,
  type IdempotencyContext,
  type IdempotentResult,
  type IdempotentWork,
} from './idempotency.js';
export {
  authenticateTelegram,
  findDefaultWorkspace,
  type AuthenticateTelegramInput,
  type AuthenticateTelegramResult,
  type ResolvedWorkspace,
  type TelegramUserInput,
} from './authenticate-telegram.js';
export {
  readCurrentUser,
  type ReadCurrentUserInput,
  type ReadCurrentUserResult,
} from './read-current-user.js';
export { markBotBlocked, type MarkBotBlockedInput } from './mark-bot-blocked.js';
