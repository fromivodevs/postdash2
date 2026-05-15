/**
 * App root — session-state gate (§8).
 *
 * Branches on the four session statuses with telegram-ui components:
 *   no-telegram -> Placeholder ("open in Telegram")
 *   pending     -> full-screen Spinner + 5s slow-network banner (BootPending, §6)
 *   error       -> ErrorState with friendly copy + retry wired to query.refetch (§7)
 *   ready       -> the routed AppShell (Tabbar + current route)
 *
 * Never renders raw error.message — all error copy goes through errorToCopy.
 */

import { ErrorState, Placeholder } from './components/index.ts';
import { AppShell } from './AppShell.tsx';
import { BootPending } from './session/BootPending.tsx';
import { useSession } from './session/SessionProvider.tsx';

export function App() {
  const { status, error, query } = useSession();

  if (status === 'no-telegram') {
    return (
      <div className="screen-center">
        <Placeholder
          header="Открой через Telegram"
          description="Это приложение работает только внутри Telegram-бота — данные входа недоступны."
        />
      </div>
    );
  }

  if (status === 'pending') {
    return <BootPending />;
  }

  if (status === 'error') {
    return <ErrorState error={error} onRetry={() => void query.refetch()} />;
  }

  // status === 'ready'
  return <AppShell />;
}
