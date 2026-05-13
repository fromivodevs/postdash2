import { miniappEnv } from './env.ts';

export function App() {
  return (
    <div className="root">
      <h1>PostDash</h1>
      <p>AI-радар инфоповодов для Telegram-каналов.</p>
      <p className="muted">
        Phase 0 scaffold готов. Реальные экраны (Радар, Черновики, Источники, Канал, Настройки)
        появятся с Phase 1.
      </p>
      <p className="muted">
        API: <code>{miniappEnv.VITE_API_URL}</code> • Build:{' '}
        <code>{miniappEnv.VITE_BUILD_VERSION}</code>
      </p>
    </div>
  );
}
