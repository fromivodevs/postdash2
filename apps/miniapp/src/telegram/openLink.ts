/**
 * Telegram WebApp.openLink wrapper.
 *
 * Telegram's WebApp.openLink() routes external URLs through the Telegram in-
 * app browser (with optional Instant View) and emits the platform-correct
 * haptic / focus signals. A bare `<a target="_blank">` skips all of that and
 * either opens a system browser (mobile) or a noisy popup (desktop). Wrap so
 * the radar card and any future external link goes through the right path.
 *
 * Outside Telegram (desktop browser dev) we fall back to `window.open` with
 * the standard `noopener noreferrer` so this helper is safe to call
 * unconditionally.
 */

import { getWebApp, type TelegramWebApp } from './webapp.ts';

interface OpenLinkOptions {
  try_instant_view?: boolean;
}

interface TelegramWebAppWithOpenLink extends TelegramWebApp {
  openLink?: (url: string, options?: OpenLinkOptions) => void;
}

/**
 * Open an external URL via Telegram WebApp if available, else `window.open`.
 *
 * Returns `true` when the helper handled the click (the caller should
 * `preventDefault()` on the originating event), `false` when neither path is
 * available (extremely rare — server-side render, or sandboxed iframe).
 */
export function openExternal(url: string): boolean {
  const webApp = getWebApp() as TelegramWebAppWithOpenLink | null;
  if (webApp?.openLink) {
    webApp.openLink(url, { try_instant_view: true });
    return true;
  }
  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  }
  return false;
}
