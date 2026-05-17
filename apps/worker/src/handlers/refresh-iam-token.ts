/**
 * Handler: refresh_iam_token.
 *
 * Proactive IAM-token refresh. Driven by the 5-minute janitor tick — the
 * scheduler enqueues this when system_state.expires_at is within
 * REFRESH_LEAD_TIME_MS of now() (default 1h).
 *
 * The refresh seam lives on `ctx.iamRefresh` (set by `loop.ts` when the active
 * provider exposes a forceRefresh path — Yandex does, Template doesn't). This
 * keeps the AIProvider interface free of cache-specific methods and ensures we
 * force-refresh THE single IAMTokenCache instance the provider itself reads
 * from, not a sibling cache that would double the IAM-exchange budget.
 */

import type { TaskHandler } from '../dispatcher.js';

export const refreshIamTokenHandler: TaskHandler = async (_task, ctx) => {
  if (typeof ctx.iamRefresh !== 'function') {
    ctx.logger.debug('AI provider has no IAM refresh; treating as no-op');
    return;
  }
  await ctx.iamRefresh();
  ctx.logger.info('IAM token refreshed');
};
