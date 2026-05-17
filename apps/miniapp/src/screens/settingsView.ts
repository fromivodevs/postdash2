/**
 * Pure view-model helpers for SettingsScreen.
 *
 * Extracted so the form-validation + dirty-detection logic is testable
 * without mounting React. Mirrors the channelView.ts / channelScreen split
 * pattern from Phase 2.
 */

import type { TopicProfileProjection } from '@postdash/shared';

export interface SettingsFormState {
  name: string;
  language: 'ru' | 'en';
  mainTopics: string;
  keywords: string;
  negativeKeywords: string;
}

export const EMPTY_SETTINGS_FORM: SettingsFormState = {
  name: '',
  language: 'ru',
  mainTopics: '',
  keywords: '',
  negativeKeywords: '',
};

/**
 * Build initial form values from a loaded topic profile, or the empty form
 * shape when no profile exists yet. Tag arrays are joined with `, ` because
 * the form uses a single text input per field (MVP UX choice).
 */
export function projectionToFormState(profile: TopicProfileProjection | null): SettingsFormState {
  if (!profile) return EMPTY_SETTINGS_FORM;
  return {
    name: profile.name,
    language: profile.language,
    mainTopics: profile.main_topics.join(', '),
    keywords: profile.keywords.join(', '),
    negativeKeywords: profile.negative_keywords.join(', '),
  };
}

/**
 * Returns true when the current form state differs from what was loaded
 * (or, if nothing was loaded, when ANY field has content). Drives the
 * §13 "unsaved changes" close-confirmation prompt.
 */
export function isFormDirty(
  state: SettingsFormState,
  loaded: TopicProfileProjection | null,
): boolean {
  if (!loaded) {
    return (
      state.name.trim().length > 0 ||
      state.language !== EMPTY_SETTINGS_FORM.language ||
      state.mainTopics.trim().length > 0 ||
      state.keywords.trim().length > 0 ||
      state.negativeKeywords.trim().length > 0
    );
  }
  return (
    state.name !== loaded.name ||
    state.language !== loaded.language ||
    state.mainTopics !== loaded.main_topics.join(', ') ||
    state.keywords !== loaded.keywords.join(', ') ||
    state.negativeKeywords !== loaded.negative_keywords.join(', ')
  );
}

/**
 * Validation result. `nameError` is the only field-level error today;
 * the shape is an object so a future field gains a slot without changing
 * the call sites.
 */
export interface SettingsValidationResult {
  ok: boolean;
  nameError: string | null;
}

export function validateSettingsForm(state: SettingsFormState): SettingsValidationResult {
  if (!state.name.trim()) {
    return { ok: false, nameError: 'Укажи название.' };
  }
  return { ok: true, nameError: null };
}
