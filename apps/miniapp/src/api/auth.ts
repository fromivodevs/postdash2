import { apiFetch } from './client.ts';
import type { AuthProjection } from './types.ts';

export function postAuthTelegram(initData: string, signal?: AbortSignal): Promise<AuthProjection> {
  return apiFetch<AuthProjection>('/auth/telegram', {
    method: 'POST',
    initData,
    json: {},
    ...(signal ? { signal } : {}),
  });
}

export function getMe(initData: string, signal?: AbortSignal): Promise<AuthProjection> {
  return apiFetch<AuthProjection>('/me', {
    method: 'GET',
    initData,
    ...(signal ? { signal } : {}),
  });
}
