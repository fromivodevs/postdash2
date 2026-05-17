import type { FastifyInstance } from 'fastify';
import { TelegramInitDataError } from '@postdash/shared';
import { CommandError, authenticateTelegram } from '@postdash/commands';
import { extractInitData, idempotencyKeyFromInitData } from '../auth/extract-initdata.js';
import { sanitizeCommandError, sanitizeInitDataError } from './error-mapping.js';
import type { AuthProjection, ProjectionMaker } from './projection.js';
import { projectAuthResult } from './projection.js';

export interface AuthTelegramRouteDeps {
  botToken: string;
  initDataMaxAgeSec: number;
  /**
   * Projection maker, injectable for tests. Kept inside `deps` rather than as a
   * third plugin parameter: Fastify/avvio always invokes a plugin as
   * `plugin(instance, opts, done)`, so a third positional parameter — even one
   * with a default — is bound to avvio's `done` callback, not the default.
   * That made the handler's `return project(...)` call `done(...)` and resolve
   * with `undefined`, sending an empty 200 body.
   */
  project?: ProjectionMaker;
}

export async function authTelegramRoute(
  app: FastifyInstance,
  deps: AuthTelegramRouteDeps,
): Promise<void> {
  const project: ProjectionMaker = deps.project ?? projectAuthResult;
  app.post(
    '/auth/telegram',
    {
      // The request body is always `{}` — all auth input rides in the
      // Authorization header. A tight bodyLimit rejects an attacker streaming a
      // large body to burn parse/alloc work before the handler even runs.
      bodyLimit: 4096,
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (req, reply): Promise<AuthProjection> => {
      // Config preconditions first (same order as GET /me): a 503 from a
      // missing token or unwired pool does not depend on the request body.
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
          // `code` is the stable client contract (the Mini App keys its error
          // copy on it) — pass it through. The raw `message` can leak field-name
          // detail, so genericize it and log the original server-side.
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
        const { replayed, result } = await authenticateTelegram(app.pool.db, {
          idempotencyKey: idempotencyKeyFromInitData(parsed),
          telegramUser: {
            telegramUserId: parsed.user.id,
            username: parsed.user.username ?? null,
            firstName: parsed.user.first_name,
            lastName: parsed.user.last_name ?? null,
            photoUrl: parsed.user.photo_url ?? null,
          },
        });
        // `replayed` is internal idempotency state — kept here for server-side
        // observability only, deliberately NOT projected into the wire DTO.
        req.log.info({ replayed, isNew: result.isNew }, 'authenticateTelegram ok');
        return project(result);
      } catch (err) {
        if (err instanceof CommandError) {
          // Raw CommandError.message embeds idempotency keys, schema field
          // names and internal state — never echo it. Log the original
          // server-side, send the sanitized generic message to the client.
          const { status, message } = sanitizeCommandError(err);
          if (err.code === 'internal') {
            req.log.error({ err }, 'authenticateTelegram internal error');
          } else {
            req.log.warn({ err, code: err.code }, 'authenticateTelegram command error');
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
