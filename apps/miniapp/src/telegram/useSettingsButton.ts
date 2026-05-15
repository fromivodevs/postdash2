/**
 * Native Telegram SettingsButton integration (§13) — scaffold for Phase 1.
 *
 * Telegram can render a "Settings" entry in the Mini App's header menu
 * (`WebApp.SettingsButton`); tapping it should open our Settings screen. No
 * Phase 1 screen consumes this yet (placeholders only) — the hook exists so a
 * later phase wires the header entry through one consistent path instead of
 * poking WebApp.SettingsButton ad hoc, mirroring useBackButton / useMainButton.
 *
 * No-op outside Telegram, so callers can invoke it unconditionally. Pass
 * `visible: false` (or simply don't call the hook) to keep the entry hidden.
 */

import { useEffect } from 'react';
import { getWebApp } from './webapp.ts';

export interface UseSettingsButtonOptions {
  /** Whether the header SettingsButton should be shown for the current screen. */
  visible: boolean;
  /** Invoked when the user taps the native SettingsButton. */
  onClick: () => void;
}

export function useSettingsButton({ visible, onClick }: UseSettingsButtonOptions): void {
  useEffect(() => {
    const settingsButton = getWebApp()?.SettingsButton;
    if (!settingsButton) return;

    if (!visible) {
      settingsButton.hide();
      return;
    }

    settingsButton.onClick(onClick);
    settingsButton.show();
    return () => {
      settingsButton.offClick(onClick);
      settingsButton.hide();
    };
  }, [visible, onClick]);
}
