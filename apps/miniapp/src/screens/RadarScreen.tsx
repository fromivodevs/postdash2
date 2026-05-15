/**
 * Radar screen — Phase 1 placeholder (real list lands in a later phase, §16).
 *
 * Shows the §12 empty-state copy plus the signed-in workspace/user context so
 * the boot path is verifiable end-to-end. The native BackButton stays hidden
 * here because Radar is a root tab (§4).
 */

import { Button, Placeholder, Section, Cell, useSnackbar } from '../components/index.ts';
import { useBackButton } from '../telegram/useBackButton.ts';
import { useSession } from '../session/SessionProvider.tsx';
import { pickUserDisplayName } from '../session/displayName.ts';

export function RadarScreen() {
  // Root tab — never show the native back button.
  useBackButton({ visible: false, onClick: () => {} });

  const { session } = useSession();
  const { showSnackbar } = useSnackbar();

  // §12: the Radar empty state must be actionable. In Phase 1 the manual
  // refetch isn't wired yet (no radar query), so "Проверить сейчас" just
  // acknowledges the tap; the real trigger lands with the Radar list phase.
  const handleCheckNow = (): void => {
    showSnackbar({ text: 'Уже проверяем источники — новости появятся скоро.' });
  };

  return (
    <Section header="Радар">
      {session && (
        <Cell subtitle={`${pickUserDisplayName(session.auth.identity)} · Роль: ${session.auth.role}`}>
          {session.auth.workspace.name}
        </Cell>
      )}
      <Placeholder
        header="Радар пока пуст"
        description="Подожди 5-10 мин, мы проверяем источники."
      >
        <Button size="l" stretched onClick={handleCheckNow} aria-label="Проверить сейчас">
          Проверить сейчас
        </Button>
      </Placeholder>
    </Section>
  );
}
