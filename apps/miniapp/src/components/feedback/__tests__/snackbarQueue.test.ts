import { describe, expect, it } from 'vitest';
import {
  initialSnackbarState,
  snackbarReducer,
  snackbarToneClass,
  type SnackbarState,
} from '../snackbarQueue.ts';

describe('snackbarReducer', () => {
  it('shows a toast with defaults', () => {
    const state = snackbarReducer(initialSnackbarState, {
      type: 'show',
      input: { text: 'Скопировано' },
    });
    expect(state.current).toMatchObject({ text: 'Скопировано', tone: 'neutral', durationMs: 3000 });
    expect(state.nextId).toBe(2);
  });

  it('rate-limits to one toast: a new show replaces the current one', () => {
    let state: SnackbarState = snackbarReducer(initialSnackbarState, {
      type: 'show',
      input: { text: 'first' },
    });
    state = snackbarReducer(state, { type: 'show', input: { text: 'second' } });
    // Only the newest toast is visible — no stacking.
    expect(state.current?.text).toBe('second');
    expect(state.current?.id).toBe(2);
  });

  it('dismiss clears the current toast', () => {
    const shown = snackbarReducer(initialSnackbarState, {
      type: 'show',
      input: { text: 'bye' },
    });
    const dismissed = snackbarReducer(shown, { type: 'dismiss', id: shown.current!.id });
    expect(dismissed.current).toBe(null);
  });

  it('ignores a stale dismiss token (does not kill the successor toast)', () => {
    let state = snackbarReducer(initialSnackbarState, {
      type: 'show',
      input: { text: 'first' },
    });
    const staleId = state.current!.id;
    state = snackbarReducer(state, { type: 'show', input: { text: 'second' } });
    // The first toast's timer fires late — must not dismiss the second toast.
    state = snackbarReducer(state, { type: 'dismiss', id: staleId });
    expect(state.current?.text).toBe('second');
  });

  it('keeps ids monotonic across the session', () => {
    let state = initialSnackbarState;
    for (let i = 0; i < 5; i++) {
      state = snackbarReducer(state, { type: 'show', input: { text: `t${i}` } });
    }
    expect(state.current?.id).toBe(5);
    expect(state.nextId).toBe(6);
  });
});

describe('snackbarToneClass', () => {
  it('maps success and danger tones to distinct accent classes', () => {
    expect(snackbarToneClass('success')).toBe('snackbar--success');
    expect(snackbarToneClass('danger')).toBe('snackbar--danger');
  });

  it('gives the neutral tone no accent class', () => {
    expect(snackbarToneClass('neutral')).toBeUndefined();
  });

  it('never maps two tones to the same class (feedback stays distinguishable)', () => {
    const classes = (['neutral', 'success', 'danger'] as const).map(snackbarToneClass);
    const accents = classes.filter((c): c is string => c !== undefined);
    expect(new Set(accents).size).toBe(accents.length);
  });
});
