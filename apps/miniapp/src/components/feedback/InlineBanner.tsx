/**
 * Inline banner — the §7 "Inline banner" tier of the error taxonomy.
 *
 * For sticky state issues that are not fatal: "Канал отключён", "AI лимит
 * исчерпан", "Бот без админ-прав", and the §6 "медленно, проверь сеть" slow-
 * network hint. Thin wrapper over telegram-ui <Banner> so screens import one
 * stable name and pass copy + an optional action.
 */

import { Banner, Button } from '@telegram-apps/telegram-ui';
import type { ReactNode } from 'react';

interface InlineBannerProps {
  /** Bold first line. */
  header: string;
  /** Supporting line. */
  description: string;
  /** Optional inline action button (label + handler). */
  action?: { label: string; onClick: () => void };
}

export function InlineBanner({ header, description, action }: InlineBannerProps): ReactNode {
  return (
    <Banner type="inline" header={header} subheader={description}>
      {action && (
        <Button size="s" mode="bezeled" onClick={action.onClick} aria-label={action.label}>
          {action.label}
        </Button>
      )}
    </Banner>
  );
}
