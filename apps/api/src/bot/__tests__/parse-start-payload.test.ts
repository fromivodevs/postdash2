/**
 * Tests for `parseStartPayload`. Focused on the length-cap defences added
 * during Phase 2 hardening — connect-code payloads must never grow past a
 * realistic upper bound (Crockford codes are 8 chars; we accept up to 16,
 * reject longer). Oversized payloads short-circuit to a sentinel raw so
 * downstream logging stays cheap.
 */

import { describe, expect, it } from 'vitest';
import { parseStartPayload } from '../bot.js';

describe('parseStartPayload', () => {
  it('returns null for empty/whitespace input', () => {
    expect(parseStartPayload('')).toBeNull();
    expect(parseStartPayload('   ')).toBeNull();
  });

  it('parses `connect_<code>` into kind:connect', () => {
    const parsed = parseStartPayload('connect_ABCD1234');
    expect(parsed?.kind).toBe('connect');
    expect(parsed?.id).toBe('ABCD1234');
    expect(parsed?.raw).toBe('connect_ABCD1234');
  });

  it('parses `draft_<id>` into kind:draft', () => {
    const parsed = parseStartPayload('draft_xyz');
    expect(parsed?.kind).toBe('draft');
    expect(parsed?.id).toBe('xyz');
  });

  it('falls back to kind:unknown for unrecognised prefixes', () => {
    const parsed = parseStartPayload('something_else');
    expect(parsed?.kind).toBe('unknown');
    expect(parsed?.id).toBeNull();
  });

  it('caps payloads longer than 64 chars and replaces raw with sentinel', () => {
    // 65 chars — one over the cap. Should not echo back into raw to keep logs cheap.
    const oversized = 'connect_' + 'A'.repeat(58); // length 66
    expect(oversized.length).toBeGreaterThan(64);
    const parsed = parseStartPayload(oversized);
    expect(parsed?.kind).toBe('unknown');
    expect(parsed?.raw).toBe('<truncated>');
    expect(parsed?.id).toBeNull();
  });

  it('rejects connect_<id> where id is longer than 20 chars', () => {
    // id length 21 — past the realistic ceiling. Should not propagate into
    // validateConnectCode (which would otherwise sha256-hash junk input).
    const tooLong = 'connect_' + 'A'.repeat(21);
    const parsed = parseStartPayload(tooLong);
    expect(parsed?.kind).toBe('unknown');
    expect(parsed?.id).toBeNull();
    // Raw is sentineled so the downstream log path (which echoes
    // payload_prefix for kind:'unknown') never sees the would-be code prefix.
    expect(parsed?.raw).toBe('<truncated>');
  });

  it('accepts connect_<id> at the 20-char id boundary', () => {
    const ok = 'connect_' + 'A'.repeat(20);
    const parsed = parseStartPayload(ok);
    expect(parsed?.kind).toBe('connect');
    expect(parsed?.id).toBe('A'.repeat(20));
  });
});
