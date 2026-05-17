/**
 * Handler: refresh_iam_token.
 *
 * Proactive IAM-token refresh. Driven by the 5-minute janitor tick — the
 * scheduler enqueues this when system_state.expires_at is within
 * REFRESH_LEAD_TIME_MS of now() (default 1h). The handler itself just calls
 * `ai.embed()` worthless test call? — no, we don't want side-effect calls.
 * Instead we call `IAMTokenCache.forceRefresh()` directly through the
 * AIProvider's stored cache.
 *
 * Tricky bit: `AIProvider` interface doesn't expose the token cache. We
 * tag the active provider with a `_iamRefresh` method when it's the Yandex
 * provider — see apps/worker/src/loop.ts wiring. TemplateProvider gets a
 * no-op refresh so this handler is safe in any deployment.
 */

import type { TaskHandler } from '../dispatcher.js';

export interface AIProviderWithRefresh {
  _iamRefresh?: () => Promise<void>;
}

export const refreshIamTokenHandler: TaskHandler = async (_task, ctx) => {
  const ai = ctx.ai as unknown as AIProviderWithRefresh;
  if (typeof ai._iamRefresh !== 'function') {
    ctx.logger.debug('AI provider has no IAM refresh; treating as no-op');
    return;
  }
  await ai._iamRefresh();
  ctx.logger.info('IAM token refreshed');
};
