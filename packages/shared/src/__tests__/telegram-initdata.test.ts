import { describe, expect, it } from 'vitest';
import {
  parseInitData,
  signInitDataForTest,
  TelegramInitDataError,
  verifyInitData,
} from '../telegram-initdata.js';

const TOKEN = '123456:fake-bot-token-for-tests';
const NOW = 1_715_000_000; // fixed reference second
const USER_JSON = JSON.stringify({ id: 12345, first_name: 'Adrian', username: 'adrian' });

function freshInitData(extras: Record<string, string> = {}): string {
  return signInitDataForTest(
    {
      user: USER_JSON,
      auth_date: String(NOW),
      query_id: 'q-test',
      ...extras,
    },
    TOKEN,
  );
}

describe('parseInitData', () => {
  it('parses well-formed initData', () => {
    const initData = freshInitData();
    const parsed = parseInitData(initData);
    expect(parsed.user.id).toBe(12345);
    expect(parsed.user.first_name).toBe('Adrian');
    expect(parsed.auth_date).toBe(NOW);
    expect(parsed.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.query_id).toBe('q-test');
  });

  it('throws missing_hash if hash absent', () => {
    const initData = new URLSearchParams({ user: USER_JSON, auth_date: String(NOW) }).toString();
    expect(() => parseInitData(initData)).toThrowError(TelegramInitDataError);
    try {
      parseInitData(initData);
    } catch (err) {
      expect((err as TelegramInitDataError).code).toBe('missing_hash');
    }
  });

  it('throws missing_user when user param absent', () => {
    const initData = new URLSearchParams({ auth_date: String(NOW), hash: 'x' }).toString();
    try {
      parseInitData(initData);
    } catch (err) {
      expect((err as TelegramInitDataError).code).toBe('missing_user');
    }
  });

  it('throws parse_error on invalid user JSON', () => {
    const initData = new URLSearchParams({
      user: 'not-json',
      auth_date: String(NOW),
      hash: 'x',
    }).toString();
    try {
      parseInitData(initData);
    } catch (err) {
      expect((err as TelegramInitDataError).code).toBe('parse_error');
    }
  });

  it('keeps an https photo_url', () => {
    const userJson = JSON.stringify({
      id: 12345,
      first_name: 'Adrian',
      photo_url: 'https://t.me/i/userpic/320/abc.jpg',
    });
    const initData = freshInitData({ user: userJson });
    const parsed = parseInitData(initData);
    expect(parsed.user.photo_url).toBe('https://t.me/i/userpic/320/abc.jpg');
  });

  it('drops a non-https photo_url instead of failing auth', () => {
    // A bad photo_url is cosmetic — it must be dropped, not throw, so an
    // otherwise valid login still succeeds.
    for (const bad of [
      'http://t.me/i/userpic/320/abc.jpg',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'not-a-url',
    ]) {
      const userJson = JSON.stringify({ id: 12345, first_name: 'Adrian', photo_url: bad });
      const initData = freshInitData({ user: userJson });
      const parsed = parseInitData(initData);
      expect(parsed.user.photo_url).toBeUndefined();
    }
  });

  it('throws parse_error when user.id exceeds the safe integer range', () => {
    // 2^53 + 1 — not representable as a distinct JS number.
    const unsafeUser = '{"id":9007199254740993,"first_name":"Adrian"}';
    const initData = new URLSearchParams({
      user: unsafeUser,
      auth_date: String(NOW),
      hash: 'x',
    }).toString();
    try {
      parseInitData(initData);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TelegramInitDataError).code).toBe('parse_error');
    }
  });
});

describe('verifyInitData', () => {
  it('verifies a freshly signed initData', () => {
    const initData = freshInitData();
    const parsed = verifyInitData(initData, TOKEN, { nowSec: NOW + 60 });
    expect(parsed.user.id).toBe(12345);
  });

  it('throws invalid_hash if bot token is wrong', () => {
    const initData = freshInitData();
    try {
      verifyInitData(initData, 'wrong-token', { nowSec: NOW });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramInitDataError);
      expect((err as TelegramInitDataError).code).toBe('invalid_hash');
    }
  });

  it('throws invalid_hash if any non-hash field is tampered', () => {
    const initData = freshInitData();
    const params = new URLSearchParams(initData);
    params.set('user', JSON.stringify({ id: 99999, first_name: 'Hacker' }));
    try {
      verifyInitData(params.toString(), TOKEN, { nowSec: NOW });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TelegramInitDataError).code).toBe('invalid_hash');
    }
  });

  it('throws expired if auth_date older than maxAgeSec (24h default)', () => {
    const initData = freshInitData();
    try {
      verifyInitData(initData, TOKEN, { nowSec: NOW + 86_401 });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TelegramInitDataError).code).toBe('expired');
    }
  });

  it('accepts initData exactly at the edge (24h)', () => {
    const initData = freshInitData();
    const parsed = verifyInitData(initData, TOKEN, { nowSec: NOW + 86_400 });
    expect(parsed.auth_date).toBe(NOW);
  });

  it('respects custom maxAgeSec', () => {
    const initData = freshInitData();
    try {
      verifyInitData(initData, TOKEN, { nowSec: NOW + 60, maxAgeSec: 30 });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TelegramInitDataError).code).toBe('expired');
    }
  });

  it('throws missing_hash if hash absent', () => {
    const initData = new URLSearchParams({
      user: USER_JSON,
      auth_date: String(NOW),
    }).toString();
    try {
      verifyInitData(initData, TOKEN);
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TelegramInitDataError).code).toBe('missing_hash');
    }
  });

  it('throws invalid_hash on empty bot token', () => {
    const initData = freshInitData();
    try {
      verifyInitData(initData, '');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TelegramInitDataError).code).toBe('invalid_hash');
    }
  });

  it('extracts start_param when present (deep-link support)', () => {
    const initData = freshInitData({ start_param: 'connect_abc' });
    const parsed = verifyInitData(initData, TOKEN, { nowSec: NOW });
    expect(parsed.start_param).toBe('connect_abc');
  });

  it('rejects auth_date far in the future (clock-skew bound)', () => {
    // Sign initData stamped 10 minutes ahead of the verifier's clock.
    const future = String(NOW + 600);
    const initData = signInitDataForTest(
      { user: USER_JSON, auth_date: future, query_id: 'q-test' },
      TOKEN,
    );
    try {
      verifyInitData(initData, TOKEN, { nowSec: NOW });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TelegramInitDataError).code).toBe('future_auth_date');
    }
  });

  it('accepts auth_date within the default 60s skew window', () => {
    const skew = String(NOW + 30);
    const initData = signInitDataForTest(
      { user: USER_JSON, auth_date: skew, query_id: 'q-test' },
      TOKEN,
    );
    const parsed = verifyInitData(initData, TOKEN, { nowSec: NOW });
    expect(parsed.auth_date).toBe(NOW + 30);
  });
});
