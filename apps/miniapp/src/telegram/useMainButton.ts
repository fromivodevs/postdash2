/**
 * Native Telegram MainButton integration (§4) — scaffold for Phase 1.
 *
 * Telegram's sticky-bottom MainButton is the per-screen primary CTA ("Создать
 * черновик", "Опубликовать"). No Phase 1 screen uses it yet (placeholders only),
 * but the hook exists so later phases wire CTAs through one consistent path
 * instead of poking WebApp.MainButton ad hoc.
 *
 * No-op outside Telegram. Pass `visible: false` (the default behaviour when a
 * screen simply does not call this hook) to keep the button hidden.
 */

import { useEffect } from 'react';
import { getWebApp } from './webapp.ts';

export interface UseMainButtonOptions {
  /** Whether the MainButton should be shown for the current screen. */
  visible: boolean;
  /** Button label. */
  text: string;
  /** Invoked when the user taps the MainButton. */
  onClick: () => void;
  /** When true, the button is disabled and shows a progress spinner. */
  loading?: boolean;
  /** When true (and not loading), the button is interactive. Defaults to true. */
  enabled?: boolean;
}

export function useMainButton({
  visible,
  text,
  onClick,
  loading = false,
  enabled = true,
}: UseMainButtonOptions): void {
  useEffect(() => {
    const mainButton = getWebApp()?.MainButton;
    if (!mainButton) return;

    if (!visible) {
      mainButton.hide();
      return;
    }

    mainButton.setText(text);
    mainButton.onClick(onClick);
    mainButton.show();

    if (loading) {
      mainButton.disable();
      mainButton.showProgress();
    } else {
      mainButton.hideProgress();
      if (enabled) mainButton.enable();
      else mainButton.disable();
    }

    return () => {
      mainButton.offClick(onClick);
      mainButton.hideProgress();
      mainButton.hide();
    };
  }, [visible, text, onClick, loading, enabled]);
}
