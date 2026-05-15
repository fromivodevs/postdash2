/**
 * telegram-ui <AppRoot> wired to the live Telegram theme (§3).
 *
 * <AppRoot> is the styling boundary for every telegram-ui component: it picks
 * the iOS vs base component set from `platform` and the light/dark palette from
 * `appearance`. We feed it from useTelegramTheme so it re-renders when the user
 * flips their system theme while the app is open.
 *
 * telegram-ui ships its own stylesheet — imported once here so no screen has to
 * remember to.
 */

import { AppRoot } from '@telegram-apps/telegram-ui';
import '@telegram-apps/telegram-ui/dist/styles.css';
import type { ReactNode } from 'react';
import { useTelegramTheme } from './useTelegramTheme.ts';

interface TelegramAppRootProps {
  children: ReactNode;
}

export function TelegramAppRoot({ children }: TelegramAppRootProps) {
  const { colorScheme, platform } = useTelegramTheme();

  // telegram-ui only distinguishes the iOS component set from the "base" one.
  const uiPlatform = platform === 'ios' ? 'ios' : 'base';

  return (
    <AppRoot appearance={colorScheme} platform={uiPlatform}>
      {children}
    </AppRoot>
  );
}
