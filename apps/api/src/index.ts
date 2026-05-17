import { createAIProvider, parseAIEnv } from '@postdash/ai';
import {
  createTelegramChannelAdapter,
  type TelegramChannelAdapter,
} from '@postdash/channel-adapters';
import { markBotBlocked } from '@postdash/commands';
import { createPool, parseDbEnv } from '@postdash/db';
import type { Bot } from 'grammy';
import { pino } from 'pino';
import { buildApp } from './app.js';
import { buildBot, type BotLogger } from './bot/bot.js';
import { RateLimiter } from './bot/rate-limit.js';
import { parseApiEnv } from './env.js';

const env = parseApiEnv();
const dbEnv = parseDbEnv();
const aiEnv = parseAIEnv();

const pool = createPool(dbEnv.DATABASE_URL);
const ai = createAIProvider(aiEnv);

let bot: Bot | undefined;
let rateLimiter: RateLimiter | undefined;

// The bot is constructed before Fastify (so buildApp can register its webhook
// route), but its middleware needs the Fastify logger for rate-limit-drop and
// /start observability. Hold a mutable ref that buildBot resolves at call time
// via getLogger(); we swap in app.log right after buildApp returns.
let activeLogger: BotLogger = pino({ level: env.LOG_LEVEL });

if (env.TELEGRAM_BOT_TOKEN.trim()) {
  // 5-minute sweep keeps stale per-user buckets from leaking for the process
  // lifetime. The interval is .unref()ed so it never holds the event loop open.
  rateLimiter = new RateLimiter({
    maxPerWindow: env.BOT_RATE_LIMIT_MAX_PER_MINUTE,
    sweepIntervalMs: 5 * 60_000,
    // The last-resort eviction branch only fires under a genuine distinct-id
    // flood with every tracked bucket still active — a metric-style warn so
    // operators can see the bot's bucket map is under capacity pressure.
    onLastResortEviction: () => {
      activeLogger.warn(
        { metric: 'bot.rate_limiter.last_resort_eviction', maxBuckets: 50_000 },
        'RateLimiter evicted an in-window bucket — distinct-id flood pressure',
      );
    },
  });
  bot = buildBot({
    token: env.TELEGRAM_BOT_TOKEN,
    miniAppUrl: env.MINIAPP_URL,
    buildVersion: env.MINIAPP_BUILD_VERSION,
    rateLimiter,
    getLogger: () => activeLogger,
    onBotBlocked: async (telegramUserId) => {
      await markBotBlocked(pool.db, { telegramUserId });
    },
    // Phase 2: bot uses `validateConnectCode` on `/start connect_<code>` to
    // give the user a tailored reply (active / expired / consumed / unknown)
    // before nudging them into the Mini App.
    db: pool.db,
  });
}

// Resolve the bot's own user_id via `getMe()` — needed by the channel adapter
// to call `getChatMember(chat_id, user_id=bot)` when verifying post permission.
// This is a STARTUP, BOOTSTRAP call (architecture doc Invariant 3 carves out
// the only Bot API call permitted outside `packages/channel-adapters`).
//
// Failure-mode policy (architecture doc Risks §1): if getMe fails we keep the
// API running. The channels mutation routes 503 cleanly via the
// `requireAdapter:true` preflight guard — the rest of the API (auth, /me,
// webhook) is unaffected. Eager-fail would gate ALL endpoints on a Telegram
// reachability check, which is over-coupling for an MVP.
let channelAdapter: TelegramChannelAdapter | undefined;
if (bot) {
  try {
    const me = await bot.api.getMe();
    // getMe.id is a positive int64-fitting-in-Number for any real bot —
    // Telegram bot ids are well below 2^53. The adapter factory re-validates.
    channelAdapter = createTelegramChannelAdapter({
      botToken: env.TELEGRAM_BOT_TOKEN,
      botUserId: me.id,
    });
    activeLogger.info(
      { botUserId: me.id, botUsername: me.username },
      'telegram channel adapter wired',
    );
  } catch (err) {
    activeLogger.warn(
      { err },
      'bot.api.getMe() failed; channel adapter NOT wired — POST /channels/connect will 503',
    );
  }
}

const app = await buildApp(
  env,
  bot ? { pool, ai, bot, ...(channelAdapter ? { channelAdapter } : {}) } : { pool, ai },
);

// Re-point the bot's logger ref to the Fastify app logger so /start logs and
// rate-limit warnings land in the unified pino pipeline.
activeLogger = app.log;

if (rateLimiter) {
  // Make the in-memory bot rate-limiter's single-process assumption visible at
  // runtime, not just in rate-limit.ts comments: the counters live in THIS
  // process's heap, so running more than one bot process behind the same token
  // multiplies the effective limit. See the SINGLE-PROCESS ASSUMPTION caveat in
  // bot/rate-limit.ts.
  app.log.warn(
    { component: 'bot.rate_limiter', maxPerMinute: env.BOT_RATE_LIMIT_MAX_PER_MINUTE },
    'bot rate limiter is in-memory and single-process — do not scale the bot process out',
  );
  app.addHook('onClose', async () => {
    rateLimiter?.stop();
  });
}

// The bot only reaches Telegram once it is either subscribed via setWebhook or
// actively long-polling — constructing it is not enough. We pick EXACTLY ONE
// transport from config: a TELEGRAM_WEBHOOK_URL means "production-style,
// Telegram POSTs to us"; its absence means "dev, poll for updates". The two are
// mutually exclusive — running both would double-deliver every update — so the
// fork below is a hard XOR: the `transport` variable is assigned in exactly one
// branch and logged once, and the polling branch is unreachable whenever a
// webhook URL is set. Either way the bot is stopped cleanly on app onClose so a
// redeploy does not leave a dangling long-poll connection or an orphaned
// webhook subscription mid-restart.
//
// Updates we actually handle: message (/start, /help) and my_chat_member
// (block/unblock detection). Narrowing allowed_updates keeps Telegram from
// queueing update types the bot would just drop.
const ALLOWED_UPDATES = ['message', 'my_chat_member'] as const;

if (bot) {
  const activeBot = bot;
  let transport: 'webhook' | 'long-polling';
  if (env.TELEGRAM_WEBHOOK_URL) {
    transport = 'webhook';
    // setWebhook is best-effort: a transient Telegram API failure here must NOT
    // take down the HTTP API — /auth/telegram, /me, /health etc. can still
    // serve, and an operator can re-run setWebhook out of band. Log loudly so
    // the failure is visible, but keep the process up.
    const webhookEndpoint = new URL('/telegram/webhook', env.TELEGRAM_WEBHOOK_URL).toString();
    try {
      await activeBot.api.setWebhook(webhookEndpoint, {
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: [...ALLOWED_UPDATES],
      });
      app.log.info({ webhookEndpoint }, 'telegram webhook registered');
    } catch (err) {
      app.log.error({ err, webhookEndpoint }, 'telegram setWebhook failed; webhook NOT registered');
    }
    app.addHook('onClose', async () => {
      // Drop the webhook subscription on shutdown so Telegram stops POSTing to
      // an instance that is going away. Best-effort — never block shutdown.
      try {
        await activeBot.api.deleteWebhook();
      } catch (err) {
        app.log.warn({ err }, 'telegram deleteWebhook failed during shutdown');
      }
    });
  } else {
    transport = 'long-polling';
    // Dev fallback: no public URL, so long-poll instead. bot.start() resolves
    // only when the bot stops, so it is intentionally not awaited. This branch
    // is unreachable when TELEGRAM_WEBHOOK_URL is set — the `if` above owns
    // that case — so polling can never run alongside a webhook subscription.
    void activeBot.start({ allowed_updates: [...ALLOWED_UPDATES] });
    app.addHook('onClose', async () => {
      await activeBot.stop();
    });
  }
  // Single log line naming the one active transport — makes "exactly one
  // transport is live" observable at boot.
  app.log.info({ transport }, 'telegram bot transport active');
}

const onSignal = async (signal: string): Promise<void> => {
  app.log.warn({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};

process.once('SIGINT', () => void onSignal('SIGINT'));
process.once('SIGTERM', () => void onSignal('SIGTERM'));

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
