/**
 * Confirm modal — the §7 "Modal" tier of the error taxonomy.
 *
 * For destructive confirmations: "Отклонить черновик?", "Опубликовать в канал?".
 * No Phase 1 screen triggers one yet, but the taxonomy requires the wrapper to
 * exist and be usable, so later phases have a single consistent confirm path.
 *
 * Built on the native <dialog> element rather than telegram-ui's <Modal>: it
 * gives us correct focus-trapping and Esc handling for free, semantic HTML
 * (§8), and zero dependency on telegram-ui's drawer internals. Styling stays on
 * design tokens — no hardcoded colors.
 */

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Button } from '../layout.ts';

interface ConfirmModalProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** When true, the confirm action is styled as destructive (--color-danger). */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional extra content rendered between description and actions. */
  children?: ReactNode;
}

export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Отмена',
  destructive = false,
  onConfirm,
  onCancel,
  children,
}: ConfirmModalProps): ReactNode {
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Keep the native <dialog> open-state in sync with the `open` prop. The
  // <dialog> element is ALWAYS rendered (never `return null` before this
  // effect) so the ref is reliably attached on the very first `open`
  // transition — otherwise showModal() could be missed. useLayoutEffect runs
  // synchronously before paint, so the modal/backdrop never flicker.
  // showModal()/close() (not the `open` attribute) gives us the backdrop,
  // focus trap, and Esc-to-close behaviour.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // The `!dialog.open` / `dialog.open` guards are not redundant with the
    // `[open]` dependency. Under rapid open/close churn the effect can re-run
    // while the <dialog> is already in the target state (e.g. an unrelated
    // re-render, or React batching two state flips). Calling showModal() on an
    // already-open <dialog> throws InvalidStateError; calling close() on an
    // already-closed one fires a spurious `cancel`/`close` event. The guards
    // make both transitions idempotent.
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="confirm-modal"
      aria-labelledby="confirm-modal-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="confirm-modal__body">
        <h2 id="confirm-modal-title" className="confirm-modal__title">
          {title}
        </h2>
        {description && <p className="confirm-modal__description">{description}</p>}
        {children}
        <div className="confirm-modal__actions">
          <Button
            size="m"
            mode="gray"
            stretched
            className="confirm-modal__btn"
            onClick={onCancel}
          >
            {cancelLabel}
          </Button>
          <Button
            size="m"
            mode="filled"
            stretched
            className={
              destructive ? 'confirm-modal__btn confirm-modal__btn--danger' : 'confirm-modal__btn'
            }
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
