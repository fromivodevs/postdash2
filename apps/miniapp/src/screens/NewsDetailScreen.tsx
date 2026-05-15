/**
 * News detail — Phase 1 placeholder for the `/radar/:matchId` route (§10, §16).
 *
 * Exists so a deep-link / Radar-list tap lands on a real route instead of
 * silently falling through to Radar. The actual news+draft view is built in a
 * later phase; here we show a stable header and the id as a muted caption.
 *
 * Not a root tab — the native BackButton is shown so the user can return.
 */

import { Placeholder, Section } from '../components/index.ts';
import { useBackButton } from '../telegram/useBackButton.ts';
import { useLocation, useParams } from 'wouter';
import { ROUTES } from '../routing/routes.ts';

export function NewsDetailScreen() {
  const [, navigate] = useLocation();
  // Detail screen (not a root tab) — native back returns to the Radar list.
  useBackButton({ visible: true, onClick: () => navigate(ROUTES.radar) });

  // Route param from <Route path="/radar/:matchId"> — present by construction.
  const matchId = useParams<{ matchId: string }>().matchId;

  return (
    <Section header="Новость">
      <Placeholder
        header="Новость"
        description="Экран новости и черновика появится позже — пока это заглушка."
      >
        <code className="muted">{matchId}</code>
      </Placeholder>
    </Section>
  );
}
