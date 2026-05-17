import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { generateConnectCode, hashConnectCode, _testInternals } from '../connect-code-helpers.js';

describe('generateConnectCode', () => {
  it('produces an 8-character string from the Crockford alphabet', () => {
    const code = generateConnectCode();
    // 8 chars, all from the 31-symbol Crockford set (no 0/O/1/I/L).
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    expect(code.length).toBe(8);
  });

  it('only emits characters from the documented alphabet', () => {
    // 1000 samples should cover >99% of the alphabet under uniform sampling.
    for (let i = 0; i < 1000; i++) {
      const code = generateConnectCode();
      for (const ch of code) {
        expect(_testInternals.CROCKFORD_ALPHABET).toContain(ch);
      }
    }
  });

  it('generates unique codes across many samples (smoke test for entropy)', () => {
    // ~40 bits of entropy (log2(31^8) ≈ 39.6); 1000 samples have a birthday-
    // collision probability of ~5e-7. We assert at least 999 distinct values.
    const samples = new Set<string>();
    for (let i = 0; i < 1000; i++) samples.add(generateConnectCode());
    expect(samples.size).toBeGreaterThanOrEqual(999);
  });

  it('distributes characters approximately uniformly across the 31-symbol alphabet', () => {
    // Rejection sampling against 248/256 of the byte space gives each symbol
    // an expected frequency of 1/31 ≈ 3.23%. With 1000 codes × 8 chars =
    // 8000 samples, the standard deviation per symbol is ≈ √(8000·1/31·30/31)
    // ≈ 15.95 — so a 4% (= 320) cap is comfortably above the 95% noise band
    // while still rejecting the old 'R'-padding skew (which doubled 'R'
    // frequency to ~6%). Also assert every symbol appears at least once
    // (P(any missing | uniform) ≈ 31 × (30/31)^8000 ≈ 0).
    const counts = new Map<string, number>();
    for (const ch of _testInternals.CROCKFORD_ALPHABET) counts.set(ch, 0);
    const N = 1000;
    let total = 0;
    for (let i = 0; i < N; i++) {
      const code = generateConnectCode();
      for (const ch of code) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
        total += 1;
      }
    }
    expect(total).toBe(N * 8);
    for (const ch of _testInternals.CROCKFORD_ALPHABET) {
      const c = counts.get(ch) ?? 0;
      expect(c).toBeGreaterThan(0); // every symbol seen
      // 4% cap — well below the old 'R'-doubling (~6.45%) and well above 1σ.
      expect(c / total).toBeLessThan(0.04);
    }
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
