/**
 * Mini App entry point.
 *
 * Provider order (outer -> inner):
 *   QueryClientProvider  — server state (session, future screens)
 *   TelegramAppRoot      — telegram-ui styling boundary, theme-synced (§3)
 *   Router               — wouter client-side routing (§10)
 *   SnackbarProvider     — §7 toast tier, available app-wide
 *   SessionProvider      — auth/session gate
 *
 * WebApp.ready()/expand() are fired before render so Telegram unhides the app
 * and gives us the full viewport (§13).
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Router } from 'wouter';
import { App } from './App.tsx';
import { SnackbarProvider } from './components/index.ts';
import { SessionProvider } from './session/SessionProvider.tsx';
import { TelegramAppRoot } from './telegram/AppRoot.tsx';
import { bootWebApp } from './telegram/webapp.ts';
import { applyDeepLinkToHistory } from './routing/applyDeepLink.ts';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found in index.html');

// Native chrome boot (§13): unhide + full viewport. No-op outside Telegram.
bootWebApp();

// Deep-link (§10): rewrite the location from ?startapp=... BEFORE React renders
// so wouter's first paint is already at the target route — no root flash.
applyDeepLinkToHistory();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false },
  },
});

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TelegramAppRoot>
        <Router>
          <SnackbarProvider>
            <SessionProvider>
              <App />
            </SessionProvider>
          </SnackbarProvider>
        </Router>
      </TelegramAppRoot>
    </QueryClientProvider>
  </StrictMode>,
);
