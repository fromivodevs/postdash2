/**
 * Settings screen — Phase 1 placeholder (§16). Empty-state copy from §12.
 */

import { Button, Placeholder, Section, useSnackbar } from '../components/index.ts';
import { useBackButton } from '../telegram/useBackButton.ts';

export function SettingsScreen() {
  useBackButton({ visible: false, onClick: () => {} });
  const { showSnackbar } = useSnackbar();

  // §12: every empty state must be actionable. The topics editor lands in a
  // later phase — for now the action acknowledges the tap; real wiring comes
  // with the Settings phase.
  const handleAddTopics = (): void => {
    showSnackbar({ text: 'Редактор тем появится в следующей фазе.' });
  };

  return (
    <Section header="Настройки">
      <Placeholder
        header="Темы не заданы"
        description="Задай темы — без них радар не знает, что искать."
      >
        <Button size="l" stretched onClick={handleAddTopics} aria-label="Добавить темы">
          Добавить темы
        </Button>
      </Placeholder>
    </Section>
  );
}
