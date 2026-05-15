import { describe, expect, it } from 'vitest';
import { readInitDataFrom } from '../initdata.ts';

describe('readInitDataFrom', () => {
  it('returns null when host is null/undefined', () => {
    expect(readInitDataFrom(null)).toBe(null);
    expect(readInitDataFrom(undefined)).toBe(null);
  });

  it('returns null when Telegram.WebApp is missing', () => {
    expect(readInitDataFrom({})).toBe(null);
    expect(readInitDataFrom({ Telegram: {} })).toBe(null);
  });

  it('returns null when initData is empty string', () => {
    expect(readInitDataFrom({ Telegram: { WebApp: { initData: '' } } })).toBe(null);
  });

  it('returns null when initData is not a string', () => {
    expect(readInitDataFrom({ Telegram: { WebApp: { initData: 42 } } })).toBe(null);
  });

  it('returns the raw initData when present', () => {
    const raw = 'user=%7B%22id%22%3A1%7D&hash=abc';
    expect(readInitDataFrom({ Telegram: { WebApp: { initData: raw } } })).toBe(raw);
  });
});
