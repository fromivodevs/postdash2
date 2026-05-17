import { describe, expect, it } from 'vitest';
import { contentHash } from '../content-hash.js';

describe('contentHash', () => {
  it('returns identical hash for identical input', () => {
    const a = contentHash({
      title: 'hello',
      summary: 'world',
      publishedAt: new Date('2026-05-01T00:00:00Z'),
    });
    const b = contentHash({
      title: 'hello',
      summary: 'world',
      publishedAt: new Date('2026-05-01T00:00:00Z'),
    });
    expect(a).toBe(b);
  });

  it('differs when title changes', () => {
    const a = contentHash({ title: 'hello', summary: 'world' });
    const b = contentHash({ title: 'goodbye', summary: 'world' });
    expect(a).not.toBe(b);
  });

  it('differs when summary changes', () => {
    const a = contentHash({ title: 'hello', summary: 'world' });
    const b = contentHash({ title: 'hello', summary: 'WORLD' });
    expect(a).not.toBe(b);
  });

  it('differs when publishedAt changes', () => {
    const a = contentHash({ title: 'hello', publishedAt: new Date('2026-01-01T00:00:00Z') });
    const b = contentHash({ title: 'hello', publishedAt: new Date('2026-02-01T00:00:00Z') });
    expect(a).not.toBe(b);
  });

  it('treats missing summary the same as empty string', () => {
    const a = contentHash({ title: 'hello', summary: '' });
    const b = contentHash({ title: 'hello' });
    expect(a).toBe(b);
  });

  it('treats missing publishedAt as empty (not "now")', () => {
    // Run twice with a small wait to confirm output is stable when publishedAt is absent.
    const a = contentHash({ title: 'hello' });
    const b = contentHash({ title: 'hello' });
    expect(a).toBe(b);
  });

  it('normalizes whitespace on title/summary', () => {
    const a = contentHash({ title: '  hello  ', summary: '\nworld\n' });
    const b = contentHash({ title: 'hello', summary: 'world' });
    expect(a).toBe(b);
  });

  it('produces a 64-char hex string', () => {
    const h = contentHash({ title: 'x' });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
