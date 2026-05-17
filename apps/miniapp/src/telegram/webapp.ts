/**
 * Typed access to the global Telegram WebApp object.
 *
 * index.html loads telegram-web-app.js synchronously, so `window.Telegram.WebApp`
 * exists before our bundle runs. We deliberately talk to that global instead of
 * the async `@telegram-apps/sdk-react` init flow: boot stays synchronous, every
 * helper here is a pure function of a host object, and tests can pass a fake
 * host with zero mocking ceremony (same approach as session/initdata.ts).
 *
 * `@telegram-apps/telegram-ui`'s <AppRoot> is still used for the component layer
 * (see telegram/AppRoot.tsx) — it only needs platform + appearance, both of
 * which we derive from this global.
 */

export type TelegramColorScheme = 'light' | 'dark';
export type TelegramPlatform = 'ios' | 'android' | 'tdesktop' | 'web' | 'unknown';

/** Subset of WebApp we actually touch in Phase 1. Extend as screens need more. */
export interface TelegramWebApp {
  initData?: string;
  colorScheme?: TelegramColorScheme;
  platform?: string;
  themeParams?: Record<string, string>;
  initDataUnsafe?: { start_param?: string };
  ready?: () => void;
  expand?: () => void;
  onEvent?: (event: string, handler: () => void) => void;
  offEvent?: (event: string, handler: () => void) => void;
  BackButton?: TelegramBackButton;
  MainButton?: TelegramMainButton;
  SettingsButton?: TelegramSettingsButton;
  /** Tells Telegram to show the "Close without saving?" prompt on dismiss. */
  enableClosingConfirmation?: () => void;
  disableClosingConfirmation?: () => void;
}

export interface TelegramBackButton {
  show: () => void;
  hide: () => void;
  onClick: (handler: () => void) => void;
  offClick: (handler: () => void) => void;
}

export interface TelegramMainButton {
  setText: (text: string) => void;
  show: () => void;
  hide: () => void;
  enable: () => void;
  disable: () => void;
  showProgress: (leaveActive?: boolean) => void;
  hideProgress: () => void;
  onClick: (handler: () => void) => void;
  offClick: (handler: () => void) => void;
}

export interface TelegramSettingsButton {
  show: () => void;
  hide: () => void;
  onClick: (handler: () => void) => void;
  offClick: (handler: () => void) => void;
}

interface TelegramHost {
  Telegram?: { WebApp?: TelegramWebApp };
}

/** Reads the WebApp global, or null outside Telegram (desktop browser dev). */
export function getWebApp(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  const host = window as unknown as TelegramHost;
  return host.Telegram?.WebApp ?? null;
}

/**
 * One-time boot calls: ready() unhides the app, expand() takes the full
 * viewport (§13). Safe to call when WebApp is absent — it just no-ops.
 */
export function bootWebApp(webApp: TelegramWebApp | null = getWebApp()): void {
  if (!webApp) return;
  webApp.ready?.();
  webApp.expand?.();
}

/** Normalises WebApp.platform into the small set telegram-ui understands. */
export function normalizePlatform(raw: string | undefined): TelegramPlatform {
  switch (raw) {
    case 'ios':
      return 'ios';
    case 'android':
    case 'android_x':
      return 'android';
    case 'tdesktop':
    case 'macos':
    case 'unigram':
      return 'tdesktop';
    case 'web':
    case 'weba':
    case 'webk':
      return 'web';
    default:
      return 'unknown';
  }
}

/** Current color scheme, defaulting to light when WebApp is unavailable. */
export function readColorScheme(webApp: TelegramWebApp | null): TelegramColorScheme {
  return webApp?.colorScheme === 'dark' ? 'dark' : 'light';
}
