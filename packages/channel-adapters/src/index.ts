/**
 * Channel adapters: единая точка интеграции с платформами публикации.
 *
 * Phase 0: placeholder.
 * Phase 2: TelegramChannelAdapter (verifyConnection).
 * Phase 7+: publishPost.
 * Phase MVP+1+: VK, Discord, Slack, etc.
 *
 * Интерфейс: см. tg_mvp_plan/02-ARCHITECTURE.md §3.7
 * и architecture/channel-connection.md.
 */

export {
  createTelegramChannelAdapter,
  TelegramAdapterError,
} from './telegram/index.js';
export type {
  TelegramChannelAdapter,
  CreateTelegramChannelAdapterDeps,
} from './telegram/index.js';
export type {
  VerifyConnectionInput,
  VerifyConnectionResult,
  VerifyConnectionErrorCode,
  ChannelType,
} from './telegram/types.js';
