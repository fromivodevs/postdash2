import { describe, expect, it } from 'vitest';
import {
  buildPostSourceInput,
  EMPTY_ADD_SOURCE_FORM,
  narrowSourceType,
  validateAddSourceForm,
} from '../addSourceView.ts';

describe('validateAddSourceForm', () => {
  it('rejects empty URL with field error', () => {
    const r = validateAddSourceForm(EMPTY_ADD_SOURCE_FORM);
    expect(r.ok).toBe(false);
    expect(r.urlError).toBe('Укажи URL.');
  });

  it('rejects whitespace-only URL', () => {
    const r = validateAddSourceForm({ ...EMPTY_ADD_SOURCE_FORM, url: '   ' });
    expect(r.ok).toBe(false);
  });

  it('accepts any non-empty URL', () => {
    const r = validateAddSourceForm({ ...EMPTY_ADD_SOURCE_FORM, url: 'https://x.example/' });
    expect(r.ok).toBe(true);
    expect(r.urlError).toBeNull();
  });
});

describe('narrowSourceType', () => {
  it('preserves known values', () => {
    expect(narrowSourceType('rss')).toBe('rss');
    expect(narrowSourceType('website')).toBe('website');
    expect(narrowSourceType('api')).toBe('api');
    expect(narrowSourceType('manual')).toBe('manual');
  });

  it('defaults to rss for unknown / empty input', () => {
    expect(narrowSourceType('')).toBe('rss');
    expect(narrowSourceType('unknown')).toBe('rss');
    expect(narrowSourceType('RSS')).toBe('rss'); // case-sensitive
  });
});

describe('buildPostSourceInput', () => {
  it('omits empty name field', () => {
    const out = buildPostSourceInput({ url: 'https://x.example/', type: 'rss', name: '' });
    expect(out).toEqual({ url: 'https://x.example/', type: 'rss' });
    expect('name' in out).toBe(false);
  });

  it('omits whitespace-only name', () => {
    const out = buildPostSourceInput({ url: 'https://x.example/', type: 'rss', name: '   ' });
    expect('name' in out).toBe(false);
  });

  it('includes trimmed name when present', () => {
    const out = buildPostSourceInput({
      url: 'https://x.example/',
      type: 'website',
      name: '  Example  ',
    });
    expect(out).toEqual({ url: 'https://x.example/', type: 'website', name: 'Example' });
  });

  it('trims URL', () => {
    const out = buildPostSourceInput({ url: '  https://x.example/  ', type: 'rss', name: '' });
    expect(out.url).toBe('https://x.example/');
  });
});
