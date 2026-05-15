/**
 * Channel screen — Phase 1 placeholder (§16).
 *
 * The detailed "not connected" empty state lives in
 * 04-TELEGRAM-BOT-AND-MINIAPP-UX.md and is built in a later phase.
 */

import { Button, Placeholder, Section, useSnackbar } from '../components/index.ts';
import { useBackButton } from '../telegram/useBackButton.ts';

export function ChannelScreen() {
  useBackButton({ visible: false, onClick: () => {} });
  const { showSnackbar } = useSnackbar();

  // §12: every empty state must be actionable. Channel connection needs the
  // bot-side flow — not in Phase 1 scope — so the action acknowledges the tap;
  // real wiring lands in Phase 2.
  const handleConnect = (): void => {
    showSnackbar({ text: 'Подключение канала появится в Phase 2.' });
  };

  return (
    <Section header="Канал">
      <Placeholder
        header="Канал не подключён"
        description="Подключи Telegram-канал, чтобы публиковать посты."
      >
        <Button size="l" stretched onClick={handleConnect} aria-label="Подключить канал">
          Подключить канал
        </Button>
      </Placeholder>
    </Section>
  );
}
