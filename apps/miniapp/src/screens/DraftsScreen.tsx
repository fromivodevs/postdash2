/**
 * Drafts screen — Phase 1 placeholder (§16). Empty-state copy from §12.
 */

import { useLocation } from 'wouter';
import { Button, Placeholder, Section } from '../components/index.ts';
import { useBackButton } from '../telegram/useBackButton.ts';
import { ROUTES } from '../routing/routes.ts';

export function DraftsScreen() {
  useBackButton({ visible: false, onClick: () => {} });
  const [, navigate] = useLocation();

  // §12: every empty state must be actionable. Drafts are created from a Radar
  // news item, so the action sends the user to the Radar tab.
  const handleGoToRadar = (): void => {
    navigate(ROUTES.radar);
  };

  return (
    <Section header="Черновики">
      <Placeholder
        header="Здесь будут готовые посты"
        description="Открой Радар, выбери новость, создай черновик."
      >
        <Button size="l" stretched onClick={handleGoToRadar} aria-label="В Радар">
          В Радар
        </Button>
      </Placeholder>
    </Section>
  );
}
