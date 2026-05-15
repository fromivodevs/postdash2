/**
 * One-at-a-time snackbar reducer (§7: "нельзя 5 toast подряд").
 *
 * Pure state machine, no React — so the rate-limit rule is unit-testable
 * without rendering. The provider (SnackbarProvider.tsx) is a thin shell that
 * holds this state and runs a timer to emit `dismiss`.
 *
 * Rule: at most one toast is visible. A new toast requested while one is
 * showing REPLACES it (newest wins) rather than stacking — keeps the UI calm
 * and the user always sees the most recent feedback.
 */

export type SnackbarTone = 'neutral' | 'success' | 'danger';

export interface SnackbarMessage {
  /** Monotonic id — also used as the React key and the timer token. */
  readonly id: number;
  readonly text: string;
  readonly tone: SnackbarTone;
  /** Auto-dismiss delay in ms (§7: bottom-3s auto-dismiss). */
  readonly durationMs: number;
}

export interface SnackbarState {
  /** The single currently-visible toast, or null when idle. */
  readonly current: SnackbarMessage | null;
  /** Id counter; never reset so keys stay unique for the session. */
  readonly nextId: number;
}

export const initialSnackbarState: SnackbarState = { current: null, nextId: 1 };

export interface SnackbarShowInput {
  text: string;
  tone?: SnackbarTone;
  durationMs?: number;
}

export type SnackbarAction =
  | { type: 'show'; input: SnackbarShowInput }
  | { type: 'dismiss'; id: number };

const DEFAULT_DURATION_MS = 3000;

/**
 * Maps a tone to the CSS modifier class the provider puts on the rendered
 * <Snackbar>. Kept here (pure) so the tone->class wiring is unit-testable
 * without rendering. `neutral` has no accent class — a plain confirmation.
 */
export function snackbarToneClass(tone: SnackbarTone): string | undefined {
  switch (tone) {
    case 'success':
      return 'snackbar--success';
    case 'danger':
      return 'snackbar--danger';
    case 'neutral':
      return undefined;
  }
}

export function snackbarReducer(state: SnackbarState, action: SnackbarAction): SnackbarState {
  switch (action.type) {
    case 'show': {
      const message: SnackbarMessage = {
        id: state.nextId,
        text: action.input.text,
        tone: action.input.tone ?? 'neutral',
        durationMs: action.input.durationMs ?? DEFAULT_DURATION_MS,
      };
      // Newest wins — replace any in-flight toast instead of queueing.
      return { current: message, nextId: state.nextId + 1 };
    }
    case 'dismiss': {
      // Ignore stale dismiss tokens: a toast that was already replaced must not
      // dismiss its successor.
      if (state.current?.id !== action.id) return state;
      return { ...state, current: null };
    }
    default:
      return state;
  }
}
