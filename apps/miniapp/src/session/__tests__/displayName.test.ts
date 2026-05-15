import { describe, expect, it } from 'vitest';
import { pickUserDisplayName } from '../displayName.ts';
import type { AuthProjection } from '../../api/types.ts';

function identity(overrides: Partial<AuthProjection['identity']>): AuthProjection['identity'] {
  return {
    id: 'id-1',
    telegram_user_id: '1',
    username: null,
    first_name: null,
    last_name: null,
    status: 'active',
    ...overrides,
  };
}

describe('pickUserDisplayName', () => {
  it('prefers first_name + last_name when both are present', () => {
    expect(pickUserDisplayName(identity({ first_name: 'Ада', last_name: 'Лавлейс' }))).toBe(
      'Ада Лавлейс',
    );
  });

  it('uses first_name alone when last_name is missing', () => {
    expect(pickUserDisplayName(identity({ first_name: 'Ада' }))).toBe('Ада');
  });

  it('falls back to @username when no first_name', () => {
    expect(pickUserDisplayName(identity({ username: 'ada' }))).toBe('@ada');
  });

  it('falls back to a neutral label when nothing is set', () => {
    expect(pickUserDisplayName(identity({}))).toBe('Пользователь Telegram');
  });

  it('ignores whitespace-only fields', () => {
    expect(pickUserDisplayName(identity({ first_name: '   ', username: 'ada' }))).toBe('@ada');
  });
});
