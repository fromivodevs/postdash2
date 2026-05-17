import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { AIProviderError, type AIProvider, type AIProviderErrorCode } from '@postdash/ai';
import type { TelegramChannelAdapter } from '@postdash/commands';
import type { Pool } from '@postdash/db';
import type { Bot } from 'grammy';
import { authTelegramRoute } from './routes/auth-telegram.js';
import { channelsRoute } from './routes/channels.js';
import { healthRoutes } from './routes/health.js';
import { meRoute } from './routes/me.js';
import { readyRoutes } from './routes/ready.js';
import { radarRoute } from './routes/radar.js';
import { sourcesRoute } from './routes/sources.js';
import { telegramWebhookRoute } from './routes/telegram-webhook.js';
import { topicsRoute } from './routes/topics.js';
import type { ApiEnv } from './env.js';

declare module 'fastify' {
  interface FastifyInstance {
    pool: Pool;
    ai: AIProvider;
  }
}

// AIProviderError.message can embed provider-side detail (raw upstream error
// text, prompt fragments). The `code` is the stable client contract; the
// `message` gets replaced with a static, code-keyed string. The raw error is
// logged server-side. `unknown` is the catch-all for any future code.
const AI_PROVIDER_MESSAGE_TABLE: Record<AIProviderErrorCode, string> = {
  budget_exceeded: 'AI budget exceeded',
  refused: 'AI provider refused the request',
  rate_limit: 'AI provider is rate limited; retry later',
  server_error: 'AI provider is temporarily unavailable',
  auth_error: 'AI provider is temporarily unavailable',
  parse_error: 'AI provider is temporarily unavailable',
  not_implemented: 'AI provider is temporarily unavailable',
  unknown: 'AI provider is temporarily unavailable',
};

export interface AppDeps {
  pool?: Pool;
  ai?: AIProvider;
  bot?: Bot;
  /**
   * Phase 2: Telegram channel adapter, used by `POST /channels/connect`.
   * Resolved at startup via `bot.api.getMe()` (see `index.ts`); on getMe
   * failure the field is left `undefined` and the channels mutation routes
   * 503 cleanly. Read paths (`GET /channels`) do not require it.
   */
  channelAdapter?: TelegramChannelAdapter;
}

export async function buildApp(
  env: ApiEnv,
  deps: AppDeps = {},
  opts: FastifyServerOptions = {},
): Promise<FastifyInstance> {
  const isProd = env.NODE_ENV === 'production';
  const app = Fastify({
    logger: isProd
      ? { level: env.LOG_LEVEL }
      : {
          level: env.LOG_LEVEL,
          transport: { target: 'pino-pretty', options: { colorize: true } },
        },
    disableRequestLogging: env.NODE_ENV === 'test',
    // Under a reverse proxy (Cloud Run, Render, fly.io, nginx), req.ip would
    // otherwise resolve to the proxy address and @fastify/rate-limit's per-IP
    // buckets would collapse to a single bucket shared by all clients.
    // The hop-count is deploy-topology-specific (1 = single LB, 2 = CDN + LB),
    // so it's env-configurable; blanket `true` is spoofable if the origin is
    // ever directly reachable. Dev runs with no proxy.
    trustProxy: isProd ? env.API_TRUST_PROXY_HOPS : false,
    ...opts,
  });

  await app.register(sensible);

  // CORS for the Mini App. The Mini App is served from a different origin
  // (MINIAPP_URL) and runs inside Telegram Desktop / Telegram Web — both real
  // browsers that enforce CORS — so the API must answer preflight and echo
  // Access-Control-* headers or the cross-origin fetch is blocked.
  //   - production: lock the allowed origin to MINIAPP_URL exactly.
  //   - dev/test: be permissive (reflect any origin) so a Vite dev server on
  //     any localhost port works without per-port config churn.
  // Methods are limited to what the API actually exposes (GET + POST). The
  // Authorization header must be allowed — the Mini App sends `Authorization:
  // tma <initData>`. credentials stays false: the client uses
  // `credentials: 'omit'`, so no cookies cross the boundary.
  await app.register(cors, {
    origin: isProd ? env.MINIAPP_URL : true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: false,
  });

  // Baseline security headers on every response. This API only ever serves
  // JSON — it renders no HTML and embeds no resources — so the policy is
  // maximally locked down rather than tuned per-route:
  //   - Content-Security-Policy: default-src 'none' — nothing should ever be
  //     loaded as a result of a response from this origin.
  //   - X-Frame-Options: DENY — the API origin must never be framed
  //     (clickjacking surface defence; the Mini App is a separate origin).
  //   - X-Content-Type-Options: nosniff — no MIME sniffing of JSON bodies.
  //   - Strict-Transport-Security: production only — pinning HSTS on a
  //     http://localhost dev box would poison the browser for that host.
  // A tiny manual onSend hook is preferred over adding @fastify/helmet: helmet
  // is not a dependency, and a JSON-only API needs only this fixed handful.
  app.addHook('onSend', async (_req, reply) => {
    void reply.header('Content-Security-Policy', "default-src 'none'");
    void reply.header('X-Frame-Options', 'DENY');
    void reply.header('X-Content-Type-Options', 'nosniff');
    if (isProd) {
      void reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    }
  });

  // Per-route rate limit for the public HTTP surface. The auth routes verify
  // HMAC on every call (cheap-ish, but pollutable); without an HTTP gate an
  // attacker can hammer /auth/telegram with random initData blobs and
  // saturate DB idempotency inserts. /ready also carries a limit — it pings
  // the DB on every call, so a flood could saturate the pool. /health (no DB)
  // and /telegram/webhook stay unlimited — uptime probers hit health hard and
  // Telegram's own retry semantics + secret-token check guard the webhook.
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof AIProviderError) {
      const status = error.code === 'budget_exceeded' ? 402 : error.code === 'refused' ? 422 : 503;
      // Log the raw error (provider detail) server-side; send only the static,
      // code-keyed message to the client.
      req.log.warn({ err: error, code: error.code }, 'AI provider error');
      void reply.status(status).send({
        statusCode: status,
        error: 'AIProviderError',
        code: error.code,
        message: AI_PROVIDER_MESSAGE_TABLE[error.code] ?? AI_PROVIDER_MESSAGE_TABLE.unknown,
      });
      return;
    }
    // 4xx errors (Fastify validation, not-found, etc.) carry safe, useful
    // messages — let Fastify serialize them. Anything 5xx is masked behind a
    // generic body so driver internals / stack traces never reach the client;
    // the real error is logged server-side.
    const status =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 500;
    if (status >= 500) {
      req.log.error({ err: error }, 'unhandled server error');
      void reply.status(status).send({
        statusCode: status,
        error: 'InternalServerError',
        message: 'internal error',
      });
      return;
    }
    void reply.send(error);
  });

  if (deps.pool) {
    const pool = deps.pool;
    app.decorate('pool', pool);
    app.addHook('onClose', async () => {
      await pool.close();
    });
    await app.register(readyRoutes);
  }
  if (deps.ai) {
    app.decorate('ai', deps.ai);
  }

  await app.register(healthRoutes);

  // Auth + identity routes always register; they 503 cleanly if pool/token missing.
  await app.register(authTelegramRoute, {
    botToken: env.TELEGRAM_BOT_TOKEN,
    initDataMaxAgeSec: env.TELEGRAM_INITDATA_MAX_AGE_SEC,
  });
  await app.register(meRoute, {
    botToken: env.TELEGRAM_BOT_TOKEN,
    initDataMaxAgeSec: env.TELEGRAM_INITDATA_MAX_AGE_SEC,
  });
  // Channel-connection routes (Phase 2). Same self-503 contract as auth/me:
  // pool / bot token / bot username / adapter absences trigger 503 inside the
  // route preflight rather than blowing up plugin registration. This keeps
  // the API serving auth/identity even if a Phase 2 dep is misconfigured.
  await app.register(channelsRoute, {
    botToken: env.TELEGRAM_BOT_TOKEN,
    initDataMaxAgeSec: env.TELEGRAM_INITDATA_MAX_AGE_SEC,
    botUsername: env.TELEGRAM_BOT_USERNAME,
    channelAdapter: deps.channelAdapter,
  });
  // Topics + sources routes (Phase 3). Same self-503 contract: bot token /
  // pool absence triggers 503 inside preflight rather than blowing up plugin
  // registration.
  await app.register(topicsRoute, {
    botToken: env.TELEGRAM_BOT_TOKEN,
    initDataMaxAgeSec: env.TELEGRAM_INITDATA_MAX_AGE_SEC,
  });
  await app.register(sourcesRoute, {
    botToken: env.TELEGRAM_BOT_TOKEN,
    initDataMaxAgeSec: env.TELEGRAM_INITDATA_MAX_AGE_SEC,
  });
  // Phase 5: GET /radar (read-only). Same self-503 contract as topics/sources.
  await app.register(radarRoute, {
    botToken: env.TELEGRAM_BOT_TOKEN,
    initDataMaxAgeSec: env.TELEGRAM_INITDATA_MAX_AGE_SEC,
  });

  if (deps.bot) {
    // Webhook auth depends on the secret-token header; refuse to expose the
    // endpoint at all when the secret is empty rather than silently fail-open.
    // env.ts already enforces this in production; this guard covers dev/test.
    if (!env.TELEGRAM_WEBHOOK_SECRET.trim()) {
      app.log.warn('TELEGRAM_WEBHOOK_SECRET is empty; /telegram/webhook route is NOT registered');
    } else {
      await app.register(telegramWebhookRoute, {
        bot: deps.bot,
        webhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
      });
    }
  }

  return app;
}
