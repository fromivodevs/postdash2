/**
 * Reads raw Telegram initData from the current runtime.
 *
 * In Telegram clients, `window.Telegram.WebApp.initData` is set before our bundle
 * runs. Outside Telegram (e.g., desktop browser dev), it is missing — callers
 * surface that as a SessionError so the user sees an explicit "open in Telegram"
 * message instead of a confusing 401.
 *
 * We deliberately avoid @telegram-apps/sdk-react retrieval here so the session
 * boot stays synchronous and easy to test. The full SDK is still useful for
 * theme/viewport hooks in screens that come later.
 */

interface TelegramHost {
  Telegram?: {
    WebApp?: {
      initData?: unknown;
    };
  };
}

export function readInitDataFrom(host: TelegramHost | undefined | null): string | null {
  if (!host) return null;
  const raw = host.Telegram?.WebApp?.initData;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return raw;
}

export function readInitDataRaw(): string | null {
  if (typeof window === 'undefined') return null;
  return readInitDataFrom(window as unknown as TelegramHost);
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData?: string;
        ready?: () => void;
        expand?: () => void;
      };
    };
  }
}
