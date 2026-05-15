import { describe, expect, it } from 'vitest';
import { errorToCopy } from '../errorCopy.ts';
import { ApiError } from '../../../api/client.ts';

describe('errorToCopy', () => {
  it('maps an initData-integrity code to the "reopen" copy, non-retryable', () => {
    const err = new ApiError(401, 'bad hash', {
      error: 'TelegramInitDataError',
      code: 'invalid_hash',
    });
    const copy = errorToCopy(err);
    expect(copy.title).toBe('Сессия Telegram недействительна');
    expect(copy.retryable).toBe(false);
  });

  it('groups all initData-integrity codes onto the same "session invalid" copy', () => {
    const codes = ['missing_hash', 'missing_user', 'missing_auth_date', 'invalid_hash', 'parse_error'];
    for (const code of codes) {
      const copy = errorToCopy(new ApiError(401, 'x', { error: 'TelegramInitDataError', code }));
      expect(copy.title).toBe('Сессия Telegram недействительна');
      expect(copy.retryable).toBe(false);
    }
  });

  it('maps expired / future_auth_date to the "session stale" copy', () => {
    for (const code of ['expired', 'future_auth_date']) {
      const copy = errorToCopy(new ApiError(401, 'x', { error: 'TelegramInitDataError', code }));
      expect(copy.title).toBe('Сессия устарела');
      expect(copy.retryable).toBe(false);
    }
  });

  it('maps infrastructure faults (db_unavailable, internal, bot_token_missing) to retryable tech-failure copy', () => {
    for (const code of ['db_unavailable', 'internal', 'bot_token_missing']) {
      const copy = errorToCopy(new ApiError(503, 'x', { error: 'ServiceError', code }));
      expect(copy.title).toBe('Технический сбой');
      expect(copy.retryable).toBe(true);
    }
  });

  it('maps missing_authorization to the open-in-Telegram copy', () => {
    const copy = errorToCopy(new ApiError(401, 'x', { error: 'Unauthorized', code: 'missing_authorization' }));
    expect(copy.title).toBe('Открой через Telegram');
    expect(copy.retryable).toBe(false);
  });

  it('maps CommandError codes (forbidden, conflict, validation_failed) to tailored copy', () => {
    expect(errorToCopy(new ApiError(403, 'x', { error: 'CommandError', code: 'forbidden' })).title).toBe(
      'Доступ ограничен',
    );
    expect(errorToCopy(new ApiError(409, 'x', { error: 'CommandError', code: 'conflict' })).retryable).toBe(
      true,
    );
    expect(
      errorToCopy(new ApiError(400, 'x', { error: 'CommandError', code: 'validation_failed' })).retryable,
    ).toBe(false);
  });

  it('falls back to a generic 5xx message for server errors', () => {
    const err = new ApiError(503, 'unavailable', undefined);
    const copy = errorToCopy(err);
    expect(copy.title).toBe('Сервис временно недоступен');
    expect(copy.retryable).toBe(true);
  });

  it('falls back to a generic 4xx message for unknown client errors', () => {
    const err = new ApiError(400, 'bad request', { error: 'BadRequest' });
    const copy = errorToCopy(err);
    expect(copy.title).toBe('Что-то пошло не так');
    expect(copy.retryable).toBe(true);
  });

  it('maps the "initData is missing" error to the open-in-Telegram message', () => {
    const copy = errorToCopy(new Error('initData is missing'));
    expect(copy.title).toBe('Открой через Telegram');
    expect(copy.retryable).toBe(false);
  });

  it('treats any other thrown value as a network failure', () => {
    expect(errorToCopy(new TypeError('Failed to fetch')).title).toBe('Нет связи');
    expect(errorToCopy('weird').title).toBe('Нет связи');
  });

  it('never surfaces the raw error message', () => {
    const err = new ApiError(500, 'stack trace leaked here', undefined);
    const copy = errorToCopy(err);
    expect(copy.title).not.toContain('stack trace');
    expect(copy.description).not.toContain('stack trace');
  });
});
