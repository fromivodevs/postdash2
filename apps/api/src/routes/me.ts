import type { FastifyInstance } from 'fastify';
import { TelegramInitDataError } from '@postdash/shared';
import { CommandError, readCurrentUser } from '@postdash/commands';
import { extractInitData } from '../auth/extract-initdata.js';
import { sanitizeCommandError, sanitizeInitDataError } from './error-mapping.js';
import { projectReadCurrentUser, type AuthProjection } from './projection.js';

export interface MeRouteDeps {
  botToken: string;
  initDataMaxAgeSec: number;
}

export async function meRoute(app: FastifyInstance, deps: MeRouteDeps): Promise<void> {
  /**
   * GET /me — read-only path. Verifies initData, then loads the user/identity/
   * workspace via `readCurrentUser`. Does NOT call authenticateTelegram, so it
   * cannot UPDATE profile fields, insert operation_log rows, or hold an
   * idempotency slot. If the user has never authenticated, returns 404 so the
   * client knows to POST /auth/telegram first.
   */
  app.get(
    '/me',
    {
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (req, reply): Promise<AuthProjection> => {
      if (!deps.botToken) {
        void reply.status(503).send({
          error: 'ConfigError',
          code: 'bot_token_missing',
          message: 'TELEGRAM_BOT_TOKEN is not configured',
        });
        return undefined as never;
      }
      if (!app.pool) {
        void reply.status(503).send({
          error: 'ConfigError',
          code: 'db_unavailable',
          message: 'database pool is not wired',
        });
        return undefined as never;
      }

      let parsed;
      try {
        parsed = extractInitData(req, deps.botToken, deps.initDataMaxAgeSec);
      } catch (err) {
        if (err instanceof TelegramInitDataError) {
          // `code` is the stable client contract; the raw `message` can leak
          // field-name detail. Genericize the message, log the original.
          req.log.warn({ err, code: err.code }, 'telegram initData verification failed');
          void reply.status(401).send({
            error: 'TelegramInitDataError',
            code: err.code,
            message: sanitizeInitDataError(err),
          });
          return undefined as never;
        }
        throw err;
      }
      if (!parsed) {
        void reply.status(401).send({
          error: 'MissingAuthorization',
          code: 'missing_authorization',
          message: 'Authorization header is required',
        });
        return undefined as never;
      }

      try {
        const result = await readCurrentUser(app.pool.db, {
          telegramUserId: parsed.user.id,
        });
        return projectReadCurrentUser(result);
      } catch (err) {
        if (err instanceof CommandError) {
          // Sanitize at the boundary: the raw message leaks internal field
          // names and state. Log the original, send a generic message.
          const { status, message } = sanitizeCommandError(err);
          if (err.code === 'internal') {
            req.log.error({ err }, 'readCurrentUser internal error');
          } else {
            req.log.warn({ err, code: err.code }, 'readCurrentUser command error');
          }
          void reply.status(status).send({
            error: 'CommandError',
            code: err.code,
            message,
          });
          return undefined as never;
        }
        throw err;
      }
    },
  );
}
