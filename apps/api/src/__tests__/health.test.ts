import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { sanitizeVersion } from '../routes/health.js';
import { testEnv } from './helpers/test-env.js';

const app = await buildApp(testEnv);

afterAll(async () => {
  await app.close();
});

describe('GET /health', () => {
  it('returns ok status with service identifier', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['status']).toBe('ok');
    expect(body['service']).toBe('postdash-api');
    expect(typeof body['version']).toBe('string');
    expect(typeof body['uptime_sec']).toBe('number');
  });

  it('returns ISO time string', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json() as { time: string };
    expect(() => new Date(body.time).toISOString()).not.toThrow();
  });

  it('reflects CORS headers for a cross-origin request', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(res.statusCode).toBe(200);
    // dev/test env reflects the request origin (origin: true).
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});

describe('sanitizeVersion', () => {
  it('returns undefined for undefined input', () => {
    expect(sanitizeVersion(undefined)).toBeUndefined();
  });

  it('returns undefined for whitespace-only input (caller falls through to next candidate)', () => {
    expect(sanitizeVersion('   ')).toBeUndefined();
    expect(sanitizeVersion('\t\n  ')).toBeUndefined();
  });

  it('strips real control characters but keeps the rest intact', () => {
    // \x07 BEL, \x1B ESC, \x7F DEL — all C0/DEL control bytes.
    expect(sanitizeVersion('v1.\x072.\x1B3\x7F')).toBe('v1.2.3');
    // Newline / CR / tab smuggled in via shell heredoc.
    expect(sanitizeVersion('v1.2.3\n')).toBe('v1.2.3');
    expect(sanitizeVersion('hello\r\nworld')).toBe('helloworld');
  });

  it('keeps printable Unicode (Greek, Cyrillic, emoji)', () => {
    // Earlier ASCII-only filter wiped these to 'v1.0.0-' — now they survive.
    expect(sanitizeVersion('v1.0.0-α')).toBe('v1.0.0-α');
    expect(sanitizeVersion('релиз-2026')).toBe('релиз-2026');
  });

  it('caps the output at 64 code points (not UTF-16 code units)', () => {
    // 70 ASCII chars → trimmed to 64.
    expect(sanitizeVersion('a'.repeat(70))).toHaveLength(64);
    // 70 emoji code points (each 2 UTF-16 units): result is 64 code points,
    // i.e. 128 UTF-16 code units. Spread-based length check confirms the cap.
    const emojiResult = sanitizeVersion('😀'.repeat(70));
    expect(emojiResult).toBeDefined();
    expect([...(emojiResult as string)]).toHaveLength(64);
  });
});
