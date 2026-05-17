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
export {
  createConnectCode,
  CreateConnectCodeInputSchema,
  type CreateConnectCodeInput,
  type CreateConnectCodeResult,
} from './create-connect-code.js';
export {
  connectTelegramChannel,
  ConnectTelegramChannelInputSchema,
  type ConnectTelegramChannelInput,
  type ConnectTelegramChannelResult,
  type TelegramChannelAdapter,
  type VerifyConnectionInput,
  type VerifyConnectionResult,
} from './connect-telegram-channel.js';
export {
  generateConnectCode,
  hashConnectCode,
  lookupActiveCode,
  validateConnectCode,
  type ValidateConnectCodeResult,
  type ValidateConnectCodeStatus,
} from './connect-code-helpers.js';
export { assertWorkspaceRole, ROLE_RANK, type WorkspaceMinRole } from './policies.js';

// Phase 3: topics + sources.
export {
  createTopicProfile,
  updateTopicProfile,
  deleteTopicProfile,
  listTopicProfiles,
  CreateTopicProfileInputSchema,
  UpdateTopicProfileInputSchema,
  DeleteTopicProfileInputSchema,
  ListTopicProfilesInputSchema,
  type CreateTopicProfileInput,
  type UpdateTopicProfileInput,
  type DeleteTopicProfileInput,
  type ListTopicProfilesInput,
} from './topic-profiles.js';
export {
  createSource,
  updateSourceSubscription,
  deleteSourceSubscription,
  listSources,
  CreateSourceInputSchema,
  UpdateSourceSubscriptionInputSchema,
  DeleteSourceSubscriptionInputSchema,
  ListSourcesInputSchema,
  type CreateSourceInput,
  type UpdateSourceSubscriptionInput,
  type DeleteSourceSubscriptionInput,
  type ListSourcesInput,
  type CreateSourceResult,
  type ListSourcesResultItem,
  type ResolveRedirectFn,
} from './sources.js';
export { rowToTopicProfile, rowToSource, rowToSubscription } from './topic-row-mappers.js';

// Phase 5: workspace_news_matches.
export {
  upsertWorkspaceNewsMatch,
  suppressWorkspaceNewsMatch,
  listRadarMatches,
  UpsertWorkspaceNewsMatchInputSchema,
  SuppressWorkspaceNewsMatchInputSchema,
  ListRadarMatchesInputSchema,
  WORKSPACE_NEWS_MATCH_STATUSES,
  type UpsertWorkspaceNewsMatchInput,
  type UpsertResult as UpsertWorkspaceNewsMatchResult,
  type SuppressWorkspaceNewsMatchInput,
  type ListRadarMatchesInput,
  type RadarMatchRow,
  type RadarListResult,
  type WorkspaceNewsMatchStatus,
  type ScoreComponents,
} from './workspace-news-matches.js';
