/**
 * Full-screen error state — the §7 "Full-screen empty/error state" tier.
 *
 * Used for fatal load errors (e.g., the session query failed). Shows the
 * user-friendly copy from errorToCopy() — never a raw error.message — and,
 * when the failure is retryable, a button wired by the caller to
 * `query.refetch()`.
 *
 * Built on telegram-ui <Placeholder> + <Button> so it matches native chrome.
 */

import { Button, Placeholder } from '@telegram-apps/telegram-ui';
import { errorToCopy } from './errorCopy.ts';

interface ErrorStateProps {
  /** The thrown value — mapped to friendly copy internally. */
  error: unknown;
  /** Retry handler — typically `() => query.refetch()`. */
  onRetry?: () => void;
}

export function ErrorState({ error, onRetry }: ErrorStateProps) {
  const copy = errorToCopy(error);
  const showRetry = copy.retryable && Boolean(onRetry);

  return (
    <div className="screen-center">
      <Placeholder header={copy.title} description={copy.description}>
        {showRetry && (
          <Button size="m" onClick={onRetry} aria-label="Повторить попытку">
            Повторить
          </Button>
        )}
      </Placeholder>
    </div>
  );
}
