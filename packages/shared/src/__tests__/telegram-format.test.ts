/**
 * Unit tests for the Telegram length-limit helpers in telegram-format.ts.
 *
 * Boundary coverage matters here because the cap (4096 chars) is used by
 * `TemplateProvider` to decide whether to truncate at all, and an off-by-one
 * here silently changes truncation behavior across the AI + Mini App preview.
 */

import { describe, expect, it } from 'vitest';
import { TELEGRAM_POST_MAX_LENGTH, fitsTelegramPostLimit } from '../telegram-format.js';

describe('fitsTelegramPostLimit', () => {
  it('returns true for empty string', () => {
    expect(fitsTelegramPostLimit('')).toBe(true);
  });

  it('returns true at exactly the boundary (length === TELEGRAM_POST_MAX_LENGTH)', () => {
    const atLimit = 'a'.repeat(TELEGRAM_POST_MAX_LENGTH);
    expect(atLimit).toHaveLength(TELEGRAM_POST_MAX_LENGTH);
    expect(fitsTelegramPostLimit(atLimit)).toBe(true);
  });

  it('returns false at one over the boundary (length === TELEGRAM_POST_MAX_LENGTH + 1)', () => {
    const overLimit = 'a'.repeat(TELEGRAM_POST_MAX_LENGTH + 1);
    expect(fitsTelegramPostLimit(overLimit)).toBe(false);
  });

  it('exposes 4096 as the documented cap', () => {
    // Pin the constant so a future "let's bump to 8192" change must update the
    // test deliberately, not silently.
    expect(TELEGRAM_POST_MAX_LENGTH).toBe(4096);
  });
});
