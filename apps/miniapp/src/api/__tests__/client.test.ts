import { describe, expect, it } from 'vitest';
import { ApiError } from '../client.ts';

describe('ApiError', () => {
  it('captures status, code, message, and body', () => {
    const body = { error: 'TelegramInitDataError', code: 'invalid_hash', message: 'bad hash' };
    const err = new ApiError(401, 'bad hash', body);
    expect(err.status).toBe(401);
    expect(err.code).toBe('invalid_hash');
    expect(err.message).toBe('bad hash');
    expect(err.body).toEqual(body);
    expect(err.name).toBe('ApiError');
    expect(err).toBeInstanceOf(Error);
  });

  it('handles missing body', () => {
    const err = new ApiError(500, 'Server Error', undefined);
    expect(err.status).toBe(500);
    expect(err.code).toBeUndefined();
    expect(err.body).toBeUndefined();
  });
});
