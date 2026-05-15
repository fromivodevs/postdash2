/**
 * Sources screen — Phase 1 placeholder (§16). Empty-state copy from §12.
 */

import { Button, Placeholder, Section, useSnackbar } from '../components/index.ts';
import { useBackButton } from '../telegram/useBackButton.ts';

export function SourcesScreen() {
  useBackButton({ visible: false, onClick: () => {} });
  const { showSnackbar } = useSnackbar();

  // §12: every empty state must be actionable. The add-source flow lands in a
  // later phase — for now the action acknowledges the tap; real wiring (a
  // /sources/new route) comes with the Sources management phase.
  const handleAddSource = (): void => {
    showSnackbar({ text: 'Добавление источников появится в следующей фазе.' });
  };

  return (
    <Section header="Источники">
      <Placeholder
        header="Пока нет источников"
        description="Добавь источники, чтобы радар начал работу."
      >
        <Button size="l" stretched onClick={handleAddSource} aria-label="Добавить источник">
          + Добавить источник
        </Button>
      </Placeholder>
    </Section>
  );
}
