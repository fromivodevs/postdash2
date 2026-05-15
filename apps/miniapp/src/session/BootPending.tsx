/**
 * Full-screen boot spinner with the §6 slow-network fallback.
 *
 * §6 allows a centered spinner ONLY for the initial app boot. If the session
 * request is still pending after 5s, we additionally show the inline
 * "медленно, проверь сеть" banner so the user is never staring at a silent
 * spinner.
 *
 * The 5s timer is a real setTimeout — tests for this component would need fake
 * timers; the timer logic is trivial enough that the tested surface stays in
 * the pure modules (routing, wizard, errorCopy, snackbar).
 */

import { useEffect, useState } from 'react';
import { InlineBanner, Spinner } from '../components/index.ts';

/** Delay before the slow-network hint appears (§6: "Loading > 5s"). */
const SLOW_NETWORK_MS = 5000;

export function BootPending() {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_NETWORK_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="screen-center">
      <Spinner size="l" />
      <p className="muted">Подключаемся к Telegram…</p>
      {/* aria-live region is always mounted (before the banner appears) so a
          screen reader announces the slow-network hint when it shows up 5s in.
          `display: contents` keeps the empty wrapper out of the flex layout. */}
      <div className="boot-live-region" aria-live="polite">
        {slow && (
          <InlineBanner
            header="Кажется, медленно"
            description="Проверь сеть — мы всё ещё пытаемся подключиться."
          />
        )}
      </div>
    </div>
  );
}
