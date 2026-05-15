/**
 * Snackbar (toast) provider — the §7 "Toast" tier of the error taxonomy.
 *
 * Wraps the pure snackbarReducer (snackbarQueue.ts) with React state + an
 * auto-dismiss timer, and exposes `useSnackbar()` so any screen can fire a
 * transient confirmation ("Скопировано", "Помечено прочитанным") without
 * importing UI plumbing.
 *
 * Rate-limit (§7): only one toast renders at a time; a newer one replaces the
 * current. Rendered through telegram-ui's <Snackbar> for native look.
 */

import { Snackbar } from '@telegram-apps/telegram-ui';
import { createContext, useCallback, useContext, useEffect, useReducer, type ReactNode } from 'react';
import {
  initialSnackbarState,
  snackbarReducer,
  snackbarToneClass,
  type SnackbarShowInput,
} from './snackbarQueue.ts';

interface SnackbarContextValue {
  /** Show a transient toast. Replaces any toast currently on screen. */
  showSnackbar: (input: SnackbarShowInput) => void;
}

const SnackbarContext = createContext<SnackbarContextValue | null>(null);

interface SnackbarProviderProps {
  children: ReactNode;
}

export function SnackbarProvider({ children }: SnackbarProviderProps) {
  const [state, dispatch] = useReducer(snackbarReducer, initialSnackbarState);

  const showSnackbar = useCallback((input: SnackbarShowInput) => {
    dispatch({ type: 'show', input });
  }, []);

  const current = state.current;

  // Auto-dismiss: one timer keyed to the current toast id. Replacing the toast
  // tears this effect down and starts a fresh timer for the successor.
  useEffect(() => {
    if (!current) return;
    const token = current.id;
    const timer = setTimeout(() => dispatch({ type: 'dismiss', id: token }), current.durationMs);
    return () => clearTimeout(timer);
  }, [current]);

  return (
    <SnackbarContext.Provider value={{ showSnackbar }}>
      {children}
      {current && (
        <div className="snackbar-host">
          <Snackbar
            // Tone -> accent class so error feedback is visually distinct from
            // a neutral confirmation (§7). Neutral renders with no accent.
            className={snackbarToneClass(current.tone)}
            onClose={() => dispatch({ type: 'dismiss', id: current.id })}
            duration={current.durationMs}
          >
            {current.text}
          </Snackbar>
        </div>
      )}
    </SnackbarContext.Provider>
  );
}

export function useSnackbar(): SnackbarContextValue {
  const ctx = useContext(SnackbarContext);
  if (!ctx) throw new Error('useSnackbar must be used within a SnackbarProvider');
  return ctx;
}
