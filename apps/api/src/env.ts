import { z, ZodError } from 'zod';

export const apiEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    API_HOST: z.string().default('0.0.0.0'),
    API_PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    TELEGRAM_BOT_TOKEN: z.string().default(''),
    // Telegram's setWebhook secret_token charset is A-Za-z0-9_- only. An
    // operator typo that slips a comma (or any other char) in here would not
    // just be rejected by Telegram — it would also trip the comma-based
    // duplicate-header heuristic in /telegram/webhook and silently brick the
    // route. Reject malformed secrets at boot instead. Empty string stays
    // allowed (dev / no-bot deploys); the prod ≥16-char refine below still applies.
    TELEGRAM_WEBHOOK_SECRET: z
      .string()
      .regex(
        /^[A-Za-z0-9_-]*$/,
        'TELEGRAM_WEBHOOK_SECRET may only contain A-Za-z0-9_- (Telegram secret_token charset)',
      )
      .default(''),
    // Public base URL the API is reachable at (e.g. https://api.example.com).
    // When set, index.ts registers the Telegram webhook at <url>/telegram/webhook
    // on startup; when unset, the bot falls back to long-polling (dev default).
    TELEGRAM_WEBHOOK_URL: z.string().url().optional(),
    TELEGRAM_INITDATA_MAX_AGE_SEC: z.coerce.number().int().positive().default(86_400),
    // Canonical bot @username WITHOUT the leading `@` (e.g. `postdash_bot`).
    // Used by `buildConnectDeepLink` to construct
    // `https://t.me/<username>?start=connect_<code>` for the channel-connect
    // deep-link surfaced by `POST /channels/connect-codes`. A leading `@` is
    // rejected at boot rather than silently normalized — see channel-projection
    // helper rationale. Default empty: the channels route returns 503 if the
    // operator forgot to set it.
    TELEGRAM_BOT_USERNAME: z
      .string()
      .regex(
        /^[A-Za-z0-9_]*$/,
        'TELEGRAM_BOT_USERNAME may only contain A-Za-z0-9_ (Telegram username charset; no leading @)',
      )
      .default(''),
    MINIAPP_URL: z.string().url().default('http://localhost:5173'),
    MINIAPP_BUILD_VERSION: z.string().default('dev'),
    BOT_RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().int().positive().default(10),
    // Number of reverse-proxy hops to trust for client IP resolution
    // (@fastify/rate-limit per-IP buckets). 1 = single LB (Cloud Run, Render);
    // 2 = CDN + LB (Cloudflare → Cloud Run). Only applied in production.
    API_TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),
  })
  // Fail-closed: an empty webhook secret disables the secret-token header check
  // in /telegram/webhook, so anyone could POST fake Telegram updates. Two
  // independent triggers require a ≥16-char secret:
  //   1. TELEGRAM_WEBHOOK_URL is set (any NODE_ENV) — index.ts will call
  //      setWebhook, and a webhook URL with no secret is fail-open.
  //   2. NODE_ENV=production with a bot token — even before a webhook URL is
  //      wired, a prod bot must not boot with an unguarded webhook route.
  .refine(
    (env) => {
      const needsSecret =
        Boolean(env.TELEGRAM_WEBHOOK_URL) ||
        (env.NODE_ENV === 'production' && Boolean(env.TELEGRAM_BOT_TOKEN.trim()));
      return !needsSecret || env.TELEGRAM_WEBHOOK_SECRET.trim().length >= 16;
    },
    {
      message:
        'TELEGRAM_WEBHOOK_SECRET must be set (≥16 chars) whenever TELEGRAM_WEBHOOK_URL is set, ' +
        'or when NODE_ENV=production and TELEGRAM_BOT_TOKEN is set',
      path: ['TELEGRAM_WEBHOOK_SECRET'],
    },
  )
  // Length + charset are necessary but not sufficient: a 16-char secret of one
  // repeated character ("aaaaaaaaaaaaaaaa") passes both yet has near-zero
  // entropy. Reject an all-identical-character secret as an obvious
  // operator-placeholder footgun. This is intentionally a minimal guard, not a
  // real entropy estimator — a genuinely random secret never trips it.
  .refine((env) => new Set(env.TELEGRAM_WEBHOOK_SECRET).size !== 1, {
    message:
      'TELEGRAM_WEBHOOK_SECRET must not be a single repeated character (looks like a placeholder)',
    path: ['TELEGRAM_WEBHOOK_SECRET'],
  })
  // Telegram refuses non-HTTPS web_app button URLs; in production an http://
  // MINIAPP_URL would silently produce a link Telegram rejects. Fail fast.
  .refine((env) => env.NODE_ENV !== 'production' || env.MINIAPP_URL.startsWith('https://'), {
    message: 'MINIAPP_URL must be https:// when NODE_ENV=production',
    path: ['MINIAPP_URL'],
  })
  // Telegram's setWebhook only accepts HTTPS URLs; an http:// TELEGRAM_WEBHOOK_URL
  // in production would make setWebhook fail at startup. Fail fast at boot instead.
  .refine(
    (env) =>
      env.NODE_ENV !== 'production' ||
      !env.TELEGRAM_WEBHOOK_URL ||
      env.TELEGRAM_WEBHOOK_URL.startsWith('https://'),
    {
      message: 'TELEGRAM_WEBHOOK_URL must be https:// when NODE_ENV=production',
      path: ['TELEGRAM_WEBHOOK_URL'],
    },
  );

export type ApiEnv = z.infer<typeof apiEnvSchema>;

/**
 * Parse env with friendly fatal-on-error reporting.
 *
 * Raw zod stack dumps (`ZodError: ... at parseAsync (/.../node_modules/...)`)
 * scare operators and bury the actual misconfiguration. On parse failure we
 * print a one-line-per-issue summary and exit(1). Set DEBUG_ENV=1 to also
 * dump the underlying ZodError for hard cases.
 */
export function parseApiEnv(env: NodeJS.ProcessEnv = process.env): ApiEnv {
  try {
    return apiEnvSchema.parse(env);
  } catch (err) {
    if (err instanceof ZodError) {
      const lines = err.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `  - ${path}: ${issue.message}`;
      });
      // Under vitest, callers use `expect(() => parseApiEnv(...)).toThrow(...)`
      // to assert schema rejections — exit(1) would kill the test runner. Outside
      // tests we want a clean operator-friendly fatal at boot, so format the
      // issues and exit instead of dumping the raw zod stack.
      if (process.env['VITEST']) {
        throw err;
      }
      console.error(`Configuration error in apps/api:\n${lines.join('\n')}`);
      if (process.env['DEBUG_ENV'] === '1') {
        console.error(err);
      }
      process.exit(1);
    }
    throw err;
  }
}
