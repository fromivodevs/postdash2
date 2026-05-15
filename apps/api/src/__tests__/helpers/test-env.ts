import type { ApiEnv } from '../../env.js';

/** Reusable test env with all fields populated for type-safety. */
export const testEnv: ApiEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  API_HOST: '0.0.0.0',
  API_PORT: 0,
  TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_WEBHOOK_SECRET: '',
  TELEGRAM_INITDATA_MAX_AGE_SEC: 86_400,
  TELEGRAM_BOT_USERNAME: '',
  MINIAPP_URL: 'http://localhost:5173',
  MINIAPP_BUILD_VERSION: 'dev',
  BOT_RATE_LIMIT_MAX_PER_MINUTE: 10,
  API_TRUST_PROXY_HOPS: 1,
};

export function withTestEnv(overrides: Partial<ApiEnv> = {}): ApiEnv {
  return { ...testEnv, ...overrides };
}
