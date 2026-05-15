/**
 * Native Telegram BackButton integration (§4).
 *
 * Telegram renders its own back chevron in the header — we must use it instead
 * of a custom button. Convention: show it on every non-root screen, hide it on
 * unmount. Pass `visible: false` for root tabs.
 *
 * The hook is a no-op outside Telegram, so screens can call it unconditionally.
 */

import { useEffect } from 'react';
import { getWebApp } from './webapp.ts';

export interface UseBackButtonOptions {
  /** Whether the back button should be shown for the current screen. */
  visible: boolean;
  /** Invoked when the user taps the native back button. */
  onClick: () => void;
}

export function useBackButton({ visible, onClick }: UseBackButtonOptions): void {
  useEffect(() => {
    const backButton = getWebApp()?.BackButton;
    if (!backButton) return;

    if (!visible) {
      backButton.hide();
      return;
    }

    backButton.onClick(onClick);
    backButton.show();
    return () => {
      backButton.offClick(onClick);
      backButton.hide();
    };
  }, [visible, onClick]);
}
