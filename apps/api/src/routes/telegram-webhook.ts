import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { webhookCallback } from 'grammy';
import type { Bot } from 'grammy';

export interface TelegramWebhookDeps {
  bot: Bot;
  webhookSecret: string;
}

const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

export async function telegramWebhookRoute(
  app: FastifyInstance,
  deps: TelegramWebhookDeps,
): Promise<void> {
  // Telegram sends the secret as `X-Telegram-Bot-Api-Secret-Token` header.
  // We bind the bot to setWebhook(secret_token=...) at startup; only requests
  // matching the secret are forwarded to grammy. Without this, anyone who knows
  // the public webhook URL could spam fake updates.
  const handler = webhookCallback(deps.bot, 'fastify');
  const expectedBuf = deps.webhookSecret ? Buffer.from(deps.webhookSecret, 'utf8') : null;

  app.post(
    '/telegram/webhook',
    {
      // Telegram updates are small (a message + metadata); 1 MB is already very
      // generous. The cap stops a wrong-secret flood from forcing large Buffer
      // allocations before the secret-token check (below) can reject the request.
      bodyLimit: 1024 * 1024,
      // A modest rate limit on the public webhook URL: legitimate traffic is
      // bounded by Telegram's own delivery rate, so anything above this is a
      // flood of forged/wrong-secret requests still costing us a request cycle.
      config: {
        rateLimit: { max: 120, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      if (expectedBuf) {
        const raw = req.headers[SECRET_HEADER];
        // Telegram never sends duplicate secret-token headers; multiple values
        // is either a misconfigured proxy or a smuggling attempt — refuse.
        //
        // Node lowercases incoming header names and, for headers it does not
        // special-case (this one is not in the discard/array list), joins
        // duplicates with ", " into a single string — so a real duplicate
        // arrives as a comma-joined string, not an array. The secret token's
        // charset (A-Za-z0-9_-, per Telegram's setWebhook docs) never contains
        // a comma, so a comma in the value unambiguously means >1 header. We
        // also keep the Array.isArray guard for any proxy/runtime that does
        // surface duplicates as an array.
        const isDuplicate =
          (Array.isArray(raw) && raw.length > 1) || (typeof raw === 'string' && raw.includes(','));
        if (isDuplicate) {
          void reply.status(400).send({ error: 'duplicate_secret_header' });
          return;
        }
        const provided = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
        const providedBuf = Buffer.from(String(provided), 'utf8');
        if (
          providedBuf.length !== expectedBuf.length ||
          !timingSafeEqual(providedBuf, expectedBuf)
        ) {
          void reply.status(401).send({ error: 'webhook_secret_mismatch' });
          return;
        }
      }
      return handler(req, reply);
    },
  );
}
