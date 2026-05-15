/**
 * Baseline component layer — the stable palette every screen draws from (§3).
 *
 * Re-exports layout primitives plus the feedback infrastructure that
 * implements the §7 error UX taxonomy (toast / inline banner / modal /
 * field error / full-screen error state).
 */

export { Section, Cell, List, Spinner, Placeholder, Button, Banner } from './layout.ts';
export { Skeleton } from './Skeleton.tsx';

export { SnackbarProvider, useSnackbar } from './feedback/SnackbarProvider.tsx';
export { InlineBanner } from './feedback/InlineBanner.tsx';
export { ConfirmModal } from './feedback/ConfirmModal.tsx';
export { FieldError } from './feedback/FieldError.tsx';
export { ErrorState } from './feedback/ErrorState.tsx';
export { errorToCopy, type ErrorCopy } from './feedback/errorCopy.ts';
