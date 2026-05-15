/**
 * Applies the Telegram `start_param` deep-link BEFORE the router's first render
 * (§10 step 1-2).
 *
 * Telegram fills `WebApp.initDataUnsafe.start_param` from the `?startapp=...`
 * launch URL, but the browser URL itself is always `/` on launch — so wouter,
 * which reads `window.location`, would render Radar first and only then get
 * navigated by an effect, causing a visible root-flash.
 *
 * Fix: resolve the target path and `history.replaceState` it at boot time,
 * before `createRoot(...).render(...)` (see main.tsx). wouter then reads the
 * correct location on its very first render — no intermediate paint, no extra
 * history entry. This is a plain boot function, not a hook — the resolution
 * must happen before React renders, so there is no component to hang it on.
 *
 * Dependencies are injectable (same approach as telegram/webapp.ts and
 * session/initdata.ts) so the resolution is unit-testable without a DOM:
 * pass a fake WebApp + a fake history.
 */

import { getWebApp, type TelegramWebApp } from '../telegram/webapp.ts';
import { startParamToPath } from './routes.ts';

/** The slice of the History API this module touches. */
export interface HistoryLike {
  replaceState: (data: unknown, unused: string, url: string) => void;
}

/**
 * Reads the launch `start_param`, maps it to an in-app path, and rewrites the
 * browser location so the first render is already at the target route.
 *
 * @returns the applied target path, or null when there was no deep-link.
 */
export function applyDeepLinkToHistory(
  webApp: TelegramWebApp | null = getWebApp(),
  history: HistoryLike | undefined = typeof window === 'undefined' ? undefined : window.history,
): string | null {
  const target = startParamToPath(webApp?.initDataUnsafe?.start_param);
  if (!target || !history) return null;

  // replaceState (not pushState): the deep-link is the entry point, not a step
  // the user can navigate "back" out of into a bare root.
  history.replaceState(null, '', target);
  return target;
}
