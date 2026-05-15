import { Bot, type Context } from 'grammy';
import type { Database } from '@postdash/db';
import { RateLimiter } from './rate-limit.js';
import { handleStartConnect } from './handlers/start-connect.js';

/**
 * Minimal structural logger contract. Pino's Logger and Fastify's
 * FastifyBaseLogger both satisfy this without us importing either type
 * directly — keeps `apps/api/src/bot` independent of the host framework.
 */
export interface BotLogger {
  warn: (obj: object, msg?: string) => void;
  info: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

export interface BotDeps {
  token: string;
  miniAppUrl: string;
  buildVersion: string;
  rateLimiter: RateLimiter;
  /**
   * Returns the active logger. A function (not a logger) so the bot can be
   * constructed before Fastify exists; resolve to `app.log` after `buildApp`.
   */
  getLogger: () => BotLogger;
  /**
   * Called when Telegram reports the user blocked/kicked the bot (my_chat_member
   * status = 'kicked'). Implementations should mark the identity as blocked_bot
   * so the Mini App can surface a reconnect hint. Optional — wiring without a
   * DB-aware caller is allowed (the bot still functions for /start etc.).
   */
  onBotBlocked?: (telegramUserId: number) => Promise<void>;
  /**
   * DB handle for read-only side-paths the bot owns (Phase 2: validating
   * `/start connect_<code>` payloads via `validateConnectCode`). Optional:
   * when missing, the `kind:'connect'` deep-link still opens the Mini App
   * via the inline button — we just skip the bot-side code validation reply.
   * This mirrors the `onBotBlocked` optional-DB pattern so a bot without a
   * pool still functions for /start, /help, and block detection.
   */
  db?: Database;
}

/** Parsed `/start` deep-link payload (e.g., `/start connect_abc123`). */
export interface StartPayload {
  raw: string;
  kind: 'connect' | 'draft' | 'unknown';
  id: string | null;
}

export function parseStartPayload(payload: string): StartPayload | null {
  if (!payload) return null;
  const trimmed = payload.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('connect_')) {
    return { raw: trimmed, kind: 'connect', id: trimmed.slice('connect_'.length) || null };
  }
  if (trimmed.startsWith('draft_')) {
    return { raw: trimmed, kind: 'draft', id: trimmed.slice('draft_'.length) || null };
  }
  return { raw: trimmed, kind: 'unknown', id: null };
}

/**
 * grammy middleware enforcing the per-user bot rate limit. Extracted from
 * `buildBot` so it can be unit-tested with a fake Context + counting `next`
 * without standing up a whole Bot. Updates without a from-user (channel
 * posts, etc.) pass through untouched; over-limit updates are silently
 * dropped (per 12-EDGE-CASES.md §13.10) — `next()` is simply not called.
 */
export function createRateLimitMiddleware(
  rateLimiter: RateLimiter,
  getLogger: () => BotLogger,
): (ctx: Context, next: () => Promise<void>) => Promise<void> {
  return async (ctx, next) => {
    const tgUserId = ctx.from?.id;
    if (tgUserId === undefined) {
      // System message without from-user (channel post, etc.). Let through.
      await next();
      return;
    }
    const allowed = rateLimiter.consume(BigInt(tgUserId));
    if (!allowed) {
      getLogger().warn({ telegramUserId: tgUserId }, 'bot message dropped by rate limit');
      return;
    }
    await next();
  };
}

const START_MESSAGE = `Привет! Я AI-радар инфоповодов для Telegram-каналов.

Я нахожу новости по твоим темам, оцениваю важность и готовлю посты на публикацию.

Нажми кнопку ниже, чтобы открыть панель.`;

export function buildBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.token);

  // Rate-limit middleware: silently drop above 10/min per user (default).
  bot.use(createRateLimitMiddleware(deps.rateLimiter, deps.getLogger));

  bot.command('start', async (ctx) => {
    const payloadStr = ctx.match;
    const parsed = parseStartPayload(payloadStr ?? '');
    deps.getLogger().info(
      {
        telegramUserId: ctx.from?.id,
        payload: parsed?.raw ?? null,
        kind: parsed?.kind ?? null,
      },
      '/start command received',
    );

    // Phase 2 routing: `/start connect_<code>` validates the code (does NOT
    // consume it — the actual binding happens in the Mini App via POST
    // /channels/connect, per architecture doc Decision "bot acts as validator
    // only"). The validation reply is in addition to — not instead of — the
    // standard `START_MESSAGE` + inline button, so the user always gets a
    // path forward into the Mini App.
    if (parsed?.kind === 'connect' && parsed.id && deps.db) {
      const tgUserId = ctx.from?.id;
      if (tgUserId !== undefined) {
        try {
          await handleStartConnect(
            {
              db: deps.db,
              reply: (text) => ctx.reply(text).then(() => undefined),
              log: deps.getLogger(),
            },
            { code: parsed.id, telegramUserId: tgUserId },
          );
        } catch (err) {
          // Validation is best-effort: a DB hiccup should NOT prevent the user
          // from seeing the inline button to the Mini App. Log and continue.
          deps.getLogger().error(
            { err, telegramUserId: tgUserId },
            'start-connect handler failed; continuing with default reply',
          );
        }
      }
    }

    const url = buildMiniAppUrl(deps.miniAppUrl, deps.buildVersion, parsed);
    await ctx.reply(START_MESSAGE, {
      reply_markup: {
        inline_keyboard: [[{ text: 'Открыть панель', web_app: { url } }]],
      },
    });
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(
      `Как это работает:\n1. Открой панель\n2. Задай темы\n3. Подключи источники\n4. Добавь бота админом в канал\n5. Получай черновики постов\n6. Публикуй после проверки`,
    );
  });

  // Telegram delivers my_chat_member when the user blocks/unblocks the bot
  // (private chat). new_chat_member.status='kicked' means blocked. We surface
  // it as blocked_bot so the Mini App can prompt a reconnect.
  bot.on('my_chat_member', async (ctx) => {
    const update = ctx.myChatMember;
    if (update.chat.type !== 'private') return;
    const newStatus = update.new_chat_member.status;
    if (newStatus !== 'kicked') return;
    const tgUserId = update.from.id;
    if (!deps.onBotBlocked) {
      deps.getLogger().warn({ telegramUserId: tgUserId }, 'bot blocked but no handler wired');
      return;
    }
    try {
      await deps.onBotBlocked(tgUserId);
      deps.getLogger().info({ telegramUserId: tgUserId }, 'telegram_identity marked blocked_bot');
    } catch (err) {
      deps.getLogger().error({ err, telegramUserId: tgUserId }, 'failed to mark blocked_bot');
    }
  });

  bot.catch((err) => {
    deps.getLogger().error({ err }, 'unhandled grammy error');
  });

  return bot;
}

function buildMiniAppUrl(base: string, buildVersion: string, payload: StartPayload | null): string {
  const url = new URL(base);
  url.searchParams.set('v', buildVersion);
  if (payload?.kind === 'connect' && payload.id) {
    url.searchParams.set('startapp', `connect_${payload.id}`);
  } else if (payload?.kind === 'draft' && payload.id) {
    url.searchParams.set('startapp', `draft_${payload.id}`);
  }
  return url.toString();
}

export type { Context };
