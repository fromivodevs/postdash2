/**
 * Draft detail — Phase 1 placeholder for the `/drafts/:draftId` route (§10, §16).
 *
 * Exists so a `?startapp=draft_<id>` deep-link lands on a real route instead of
 * silently falling through to Radar. The actual editor is built in a later
 * phase; here we show a stable header and the id as a muted caption so a
 * UUID deep-link doesn't make the title look broken.
 *
 * Not a root tab — the native BackButton is shown so the user can return.
 */

import { Placeholder, Section } from '../components/index.ts';
import { useBackButton } from '../telegram/useBackButton.ts';
import { useLocation, useParams } from 'wouter';

export function DraftDetailScreen() {
  const [, navigate] = useLocation();
  // Detail screen (not a root tab) — native back returns to the Drafts list.
  useBackButton({ visible: true, onClick: () => navigate('/drafts') });

  // Route param from <Route path="/drafts/:draftId"> — present by construction.
  const draftId = useParams<{ draftId: string }>().draftId;

  return (
    <Section header="Черновик">
      <Placeholder
        header="Черновик"
        description="Экран редактора появится позже — пока это заглушка."
      >
        <code className="muted">{draftId}</code>
      </Placeholder>
    </Section>
  );
}
