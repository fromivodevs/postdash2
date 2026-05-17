/**
 * Pure view-model helpers for AddSourceScreen. Matches the
 * channelView / settingsView / sourcesView pattern: keep validation +
 * form-derived state in a unit-testable module separate from React.
 */

export type SourceTypeOption = 'rss' | 'website' | 'api' | 'manual';

export interface AddSourceFormState {
  url: string;
  type: SourceTypeOption;
  name: string;
}

export const EMPTY_ADD_SOURCE_FORM: AddSourceFormState = {
  url: '',
  type: 'rss',
  name: '',
};

export interface AddSourceValidationResult {
  ok: boolean;
  urlError: string | null;
}

export function validateAddSourceForm(state: AddSourceFormState): AddSourceValidationResult {
  if (!state.url.trim()) {
    return { ok: false, urlError: 'Укажи URL.' };
  }
  return { ok: true, urlError: null };
}

/**
 * Narrow a raw `<select>` value back into the typed union. Defaults to
 * 'rss' on any unknown input — matches the schema's preferred type.
 */
export function narrowSourceType(s: string): SourceTypeOption {
  if (s === 'website') return 'website';
  if (s === 'api') return 'api';
  if (s === 'manual') return 'manual';
  return 'rss';
}

/**
 * Build the POST /sources payload from form state. Drops empty optional
 * fields (server schema rejects empty strings on optional fields).
 */
export function buildPostSourceInput(state: AddSourceFormState): {
  url: string;
  type: SourceTypeOption;
  name?: string;
} {
  const trimmedName = state.name.trim();
  return {
    url: state.url.trim(),
    type: state.type,
    ...(trimmedName ? { name: trimmedName } : {}),
  };
}
