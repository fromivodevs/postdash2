/**
 * Webhook-hardening tests (priority fix #7).
 *
 * The /telegram/webhook route carries an explicit bodyLimit so a wrong-secret
 * flood cannot force large Buffer allocations before the secret-token check.
 * Telegram updates are tiny; anything past the cap is rejected with 413 before
 * the handler — and before the secret check — even runs.
 */

import { Bot } from 'grammy';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { withTestEnv } from './helpers/test-env.js';

const WEBHOOK_SECRET = 'sixteen-chars-secret-token';

function makeBot(): Bot {
  // The Bot constructor performs no network I/O; it is safe to build offline.
  return new Bot('123456:fake-token-for-tests');
}

describe('POST /telegram/webhook — bodyLimit hardening', () => {
  let teardown: () => Promise<void> = async () => {};

  afterEach(async () => {
    await teardown();
    teardown = async () => {};
  });

  it('rejects an oversized request body with 413 before any handler work', async () => {
    const app = await buildApp(
      withTestEnv({ TELEGRAM_BOT_TOKEN: '123456:fake', TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET }),
      { bot: makeBot() },
    );
    teardown = () => app.close();

    // 2 MB payload — well past the 1 MB route bodyLimit.
    const oversized = JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) });
    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: {
        'content-type': 'application/json',
        // A valid secret so we prove the 413 is the bodyLimit, not the secret check.
        'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
      },
      payload: oversized,
    });

    expect(res.statusCode).toBe(413);
  });

  it('accepts a small body (bodyLimit does not reject normal updates)', async () => {
    const app = await buildApp(
      withTestEnv({ TELEGRAM_BOT_TOKEN: '123456:fake', TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET }),
      { bot: makeBot() },
    );
    teardown = () => app.close();

    // A minimal well-formed Telegram update; grammy's webhookCallback handles it.
    const res = await app.inject({
      method: 'POST',
      url: '/telegram/webhook',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': WEBHOOK_SECRET,
      },
      payload: { update_id: 1 },
    });

    // Not 413 (bodyLimit) and not 401 (secret matched) — the request reached
    // the grammy handler.
    expect(res.statusCode).not.toBe(413);
    expect(res.statusCode).not.toBe(401);
  });
});
