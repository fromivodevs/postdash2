import { miniappEnv } from '../env.ts';
import type { ApiErrorBody } from './types.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: ApiErrorBody | undefined;

  constructor(status: number, message: string, body: ApiErrorBody | undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.code;
    this.body = body;
  }
}

export interface ApiRequestInit extends Omit<RequestInit, 'headers' | 'body'> {
  initData: string;
  json?: unknown;
  headers?: Record<string, string>;
}

/**
 * Calls the PostDash API with Telegram initData attached via Authorization: tma.
 *
 * The Mini App is the only client today, so we keep this minimal: JSON in, JSON out.
 * Network failures surface as fetch errors; HTTP non-2xx becomes ApiError.
 */
export async function apiFetch<T>(path: string, init: ApiRequestInit): Promise<T> {
  const url = `${miniappEnv.VITE_API_URL.replace(/\/$/, '')}${path}`;
  const headers: Record<string, string> = {
    Authorization: `tma ${init.initData}`,
    Accept: 'application/json',
    ...init.headers,
  };
  const reqInit: RequestInit = {
    method: init.method ?? 'GET',
    headers,
    credentials: 'omit',
  };
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    reqInit.body = JSON.stringify(init.json);
  }
  if (init.signal) reqInit.signal = init.signal;

  const res = await fetch(url, reqInit);

  if (!res.ok) {
    const errBody = await safeJson<ApiErrorBody>(res);
    throw new ApiError(res.status, errBody?.message ?? res.statusText, errBody);
  }
  return (await res.json()) as T;
}

async function safeJson<T>(res: Response): Promise<T | undefined> {
  try {
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}
