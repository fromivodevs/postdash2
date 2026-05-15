/**
 * Route-level integration test for POST /telegram/webhook.
 *
 * Drives the real Fastify handler. The secret-token check is the security
 * boundary: only Telegram (which echoes the `setWebhook` secret_token back in
 * the `X-Telegram-Bot-Api-Secret-Token` header) may reach grammy. We assert:
 *   - correct secret           -> forwarded (200)
 *   - wrong / missing secret   -> 401
 *   - duplicate secret header  -> 400
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Bot } from 'grammy';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { withTestEnv } from './helpers/test-env.js';

const BOT_TOKEN = '123456:test-bot-token';
const WEBHOOK_SECRET = 'webhook-secret-sixteen-plus';
const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/**
 * A structurally-valid Telegram update with no actionable content. grammy's
 * webhookCallback runs it through middleware (rate-limit lets it through —
 * `ctx.from` is set but well under the limit) and replies 200 without ever
 * touching the network.
 */
const MINIMAL_UPDATE = {
  update_id: 1,
  message: {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 1, type: 'private', first_name: 'Tester' },
    from: { id: 1, is_bot: false, first_name: 'Tester' },
    text: 'noop',
  },
};

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

async function buildWithBot(): Promise<FastifyInstance> {
  const bot = new Bot(BOT_TOKEN);
  // init() would normally call getMe over the network; supply botInfo so
  // grammy treats the bot as initialized offline.
  bot.botInfo = {
    id: 123456,
    is_bot: true,
    first_name: 'TestBot',
    username: 'test_bot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    can_manage_bots: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
  };
  return buildApp(withTestEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET }), {
    bot,
  });
}

describe('POST /telegram/webhook', () => {
  it('forwards the update when the secret-token header matches', async () => {
    app = await buildWithBot();
    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { [SECRET_HEADER]: WEBHOOK_SECRET },
      payload: MINIMAL_UPDATE,
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a wrong secret-token with 401', async () => {
    app = await buildWithBot();
    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { [SECRET_HEADER]: 'wrong-secret' },
      payload: MINIMAL_UPDATE,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a missing secret-token with 401', async () => {
    app = await buildWithBot();
    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      payload: MINIMAL_UPDATE,
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a duplicate secret-token header with 400', async () => {
    app = await buildWithBot();
    // Passing an array value to inject() sends the header twice. Node does not
    // special-case `x-telegram-bot-api-secret-token`, so — exactly as in a real
    // Fastify deployment behind a proxy — it collapses the two header lines into
    // one comma-joined string (`"<secret>, <secret>"`) before the route ever
    // sees it. The route detects that comma (the secret-token charset never
    // contains one) and refuses with 400.
    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: { [SECRET_HEADER]: [WEBHOOK_SECRET, WEBHOOK_SECRET] },
      payload: MINIMAL_UPDATE,
    });
    expect(res.statusCode).toBe(400);
  });
});
