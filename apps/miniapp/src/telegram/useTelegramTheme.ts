/**
 * Keeps the React tree in sync with the Telegram theme.
 *
 * Telegram injects --tg-theme-* CSS vars directly into <html>, so colors flip
 * for free. What does NOT flip for free is anything that needs the *value* in
 * JS — chiefly telegram-ui's <AppRoot appearance=...>. This hook subscribes to
 * the WebApp `themeChanged` event and re-renders with the new scheme.
 *
 * Returns both the scheme and platform so <AppRoot> can be configured in one
 * place (telegram/AppRoot.tsx).
 */

import { useEffect, useState } from 'react';
import {
  getWebApp,
  normalizePlatform,
  readColorScheme,
  type TelegramColorScheme,
  type TelegramPlatform,
} from './webapp.ts';

export interface TelegramTheme {
  colorScheme: TelegramColorScheme;
  platform: TelegramPlatform;
}

export function useTelegramTheme(): TelegramTheme {
  const [colorScheme, setColorScheme] = useState<TelegramColorScheme>(() =>
    readColorScheme(getWebApp()),
  );

  useEffect(() => {
    const webApp = getWebApp();
    if (!webApp?.onEvent || !webApp.offEvent) return;

    const handler = (): void => {
      setColorScheme(readColorScheme(getWebApp()));
    };
    webApp.onEvent('themeChanged', handler);
    return () => webApp.offEvent?.('themeChanged', handler);
  }, []);

  return {
    colorScheme,
    platform: normalizePlatform(getWebApp()?.platform),
  };
}
