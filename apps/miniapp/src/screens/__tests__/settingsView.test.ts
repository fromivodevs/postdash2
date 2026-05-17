import { describe, expect, it } from 'vitest';
import {
  EMPTY_SETTINGS_FORM,
  isFormDirty,
  projectionToFormState,
  validateSettingsForm,
} from '../settingsView.ts';
import type { TopicProfileProjection } from '@postdash/shared';

const PROFILE: TopicProfileProjection = {
  id: '11111111-1111-1111-1111-111111111111',
  workspace_id: '22222222-2222-2222-2222-222222222222',
  name: 'AI',
  language: 'ru',
  main_topics: ['llm', 'gpt'],
  keywords: ['anthropic'],
  negative_keywords: ['spam'],
  tone_profile: null,
  embedding_status: 'pending',
  status: 'active',
  created_at: '2026-05-17T00:00:00Z',
  updated_at: '2026-05-17T00:00:00Z',
};

describe('projectionToFormState', () => {
  it('returns empty form when no profile loaded', () => {
    expect(projectionToFormState(null)).toEqual(EMPTY_SETTINGS_FORM);
  });

  it('joins tag arrays with comma+space for single-input form', () => {
    const state = projectionToFormState(PROFILE);
    expect(state.name).toBe('AI');
    expect(state.mainTopics).toBe('llm, gpt');
    expect(state.keywords).toBe('anthropic');
    expect(state.negativeKeywords).toBe('spam');
  });
});

describe('isFormDirty', () => {
  it('blank form + no loaded profile = not dirty', () => {
    expect(isFormDirty(EMPTY_SETTINGS_FORM, null)).toBe(false);
  });

  it('any typed character + no loaded profile = dirty', () => {
    expect(isFormDirty({ ...EMPTY_SETTINGS_FORM, name: 'X' }, null)).toBe(true);
    expect(isFormDirty({ ...EMPTY_SETTINGS_FORM, mainTopics: 'ai' }, null)).toBe(true);
    expect(isFormDirty({ ...EMPTY_SETTINGS_FORM, keywords: 'gpt' }, null)).toBe(true);
    expect(isFormDirty({ ...EMPTY_SETTINGS_FORM, negativeKeywords: 'spam' }, null)).toBe(true);
  });

  it('form matching the loaded profile = not dirty', () => {
    expect(isFormDirty(projectionToFormState(PROFILE), PROFILE)).toBe(false);
  });

  it.each([
    ['name', { name: 'Edited' }],
    ['language', { language: 'en' as const }],
    ['mainTopics', { mainTopics: 'llm, gpt, transformer' }],
    ['keywords', { keywords: 'opus' }],
    ['negativeKeywords', { negativeKeywords: 'spam, ad' }],
  ])('change to %s flips dirty true', (_, override) => {
    const base = projectionToFormState(PROFILE);
    expect(isFormDirty({ ...base, ...override }, PROFILE)).toBe(true);
  });

  it('whitespace-only name with no loaded profile = not dirty (trim semantics)', () => {
    expect(isFormDirty({ ...EMPTY_SETTINGS_FORM, name: '   ' }, null)).toBe(false);
  });
});

describe('validateSettingsForm', () => {
  it('rejects empty name with field error', () => {
    const r = validateSettingsForm(EMPTY_SETTINGS_FORM);
    expect(r.ok).toBe(false);
    expect(r.nameError).toBe('Укажи название.');
  });

  it('rejects whitespace-only name', () => {
    const r = validateSettingsForm({ ...EMPTY_SETTINGS_FORM, name: '   ' });
    expect(r.ok).toBe(false);
    expect(r.nameError).not.toBeNull();
  });

  it('accepts any non-empty name', () => {
    const r = validateSettingsForm({ ...EMPTY_SETTINGS_FORM, name: 'AI' });
    expect(r.ok).toBe(true);
    expect(r.nameError).toBeNull();
  });
});
