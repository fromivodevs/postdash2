import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  generateConnectCode,
  hashConnectCode,
  _testInternals,
} from '../connect-code-helpers.js';

describe('generateConnectCode', () => {
  it('produces an 8-character string from the Crockford alphabet', () => {
    const code = generateConnectCode();
    // 8 chars, all from the 32-symbol Crockford set (no 0/O/1/I/L).
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    expect(code.length).toBe(8);
  });

  it('only emits characters from the documented alphabet', () => {
    // 1000 samples should cover >99% of the alphabet under uniform sampling.
    for (let i = 0; i < 1000; i++) {
      const code = generateConnectCode();
      for (const ch of code) {
        expect(_testInternals.CROCKFORD_TABLE).toContain(ch);
      }
    }
  });

  it('generates unique codes across many samples (smoke test for entropy)', () => {
    // 40 bits of entropy; 1000 samples have a birthday-collision probability
    // of ~5e-7. We assert at least 999 distinct values out of 1000.
    const samples = new Set<string>();
    for (let i = 0; i < 1000; i++) samples.add(generateConnectCode());
    expect(samples.size).toBeGreaterThanOrEqual(999);
  });
});

describe('hashConnectCode', () => {
  it('returns the same hash for the same plaintext (deterministic)', () => {
    expect(hashConnectCode('K7XQAR9F')).toBe(hashConnectCode('K7XQAR9F'));
  });

  it('returns DIFFERENT hashes for different plaintexts', () => {
    expect(hashConnectCode('K7XQAR9F')).not.toBe(hashConnectCode('K7XQAR9G'));
  });

  it('matches a manually-computed sha256 hex digest', () => {
    const expected = createHash('sha256').update('K7XQAR9F', 'utf8').digest('hex');
    expect(hashConnectCode('K7XQAR9F')).toBe(expected);
  });

  it('returns lowercase hex (64 chars)', () => {
    const h = hashConnectCode('abc');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
