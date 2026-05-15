/**
 * CopyButton — wraps `navigator.clipboard.writeText` with a Telegram-WebApp
 * fallback for environments that don't expose the async Clipboard API
 * (older Telegram desktop, in-app browsers, mobile webview restrictions).
 *
 * On success a neutral Snackbar "Скопировано" is fired through the existing
 * `useSnackbar()` provider (§7) so feedback is consistent with the rest of
 * the screens. On failure (no clipboard + no WebApp.showAlert) we surface a
 * danger Snackbar — never a thrown error — because the screen still works
 * without the copy (the user can read the code visually).
 *
 * The component owns NO copy state of its own; everything it shows comes from
 * props. That keeps it composable: PendingView passes the deep-link, a future
 * draft-share view can pass a draft URL, and the visual stays identical.
 */

import { Button } from '@telegram-apps/telegram-ui';
import type { ReactNode } from 'react';
import { useSnackbar } from './index.ts';
import { getWebApp } from '../telegram/webapp.ts';

interface CopyButtonProps {
  /** The text to write to the clipboard. */
  value: string;
  /** Visible button label (e.g. "Скопировать ссылку"). */
  label: string;
  /**
   * Optional override of the success toast text. Defaults to "Скопировано"
   * which matches the conventional confirmation copy used elsewhere in §7.
   */
  successText?: string;
  /** Disable the button when there's nothing to copy. */
  disabled?: boolean;
}

/**
 * Attempts `navigator.clipboard.writeText`, falling back to `WebApp.showAlert`
 * (which on Telegram surfaces the value to the user so they can long-press +
 * copy manually). Returns `true` when the clipboard write succeeded, `false`
 * otherwise — caller decides which Snackbar tone to fire.
 *
 * Exported separately so unit tests can drive the fallback path without
 * rendering the component (and so the screen can reuse the same logic if it
 * ever needs to trigger a copy outside the button surface).
 */
export async function copyToClipboard(value: string): Promise<boolean> {
  const clipboard: Clipboard | undefined =
    typeof navigator !== 'undefined' && 'clipboard' in navigator
      ? navigator.clipboard
      : undefined;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(value);
      return true;
    } catch {
      // Fall through to the WebApp fallback below.
    }
  }
  const webApp = getWebApp();
  if (webApp && 'showAlert' in webApp) {
    try {
      (webApp as unknown as { showAlert: (text: string) => void }).showAlert(value);
      // The alert path is NOT a real clipboard write — return false so the
      // caller fires a neutral "look here" toast rather than a "Скопировано"
      // confirmation that would lie about what happened.
      return false;
    } catch {
      return false;
    }
  }
  return false;
}

export function CopyButton({
  value,
  label,
  successText = 'Скопировано',
  disabled = false,
}: CopyButtonProps): ReactNode {
  const { showSnackbar } = useSnackbar();

  const handleClick = (): void => {
    void copyToClipboard(value).then((ok) => {
      if (ok) {
        showSnackbar({ text: successText, tone: 'success' });
      } else {
        showSnackbar({
          text: 'Не удалось скопировать — выдели текст вручную',
          tone: 'danger',
        });
      }
    });
  };

  return (
    <Button
      size="m"
      mode="bezeled"
      onClick={handleClick}
      disabled={disabled}
      aria-label={label}
    >
      {label}
    </Button>
  );
}
