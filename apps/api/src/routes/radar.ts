/**
 * Radar HTTP route (Phase 5).
 *
 *   GET /radar?status=&min_score=&max_score=&page=&page_size= (60/min/user)
 *     → RadarListProjection { items, page, page_size, total }
 *
 * Same preflight pattern as topics.ts: bot token / pool / initData / current
 * user resolved through the Phase 1 helpers, errors sanitized via the shared
 * mapping table. Read-only — mutations (suppress, etc.) belong to a later phase.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TelegramInitDataError } from '@postdash/shared';
import {
  CommandError,
  WORKSPACE_NEWS_MATCH_STATUSES,
  listRadarMatches,
  readCurrentUser,
} from '@postdash/commands';
import { extractInitData } from '../auth/extract-initdata.js';
import { sanitizeCommandError, sanitizeInitDataError } from './error-mapping.js';
import { projectRadarList } from './radar-projection.js';

export interface RadarRouteDeps {
  botToken: string;
  initDataMaxAgeSec: number;
}

const QuerySchema = z.object({
  status: z.enum(WORKSPACE_NEWS_MATCH_STATUSES).or(z.literal('all')).default('candidate'),
  min_score: z.coerce.number().min(0).max(10).optional(),
  max_score: z.coerce.number().min(0).max(10).optional(),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(50).default(20),
});

export async function radarRoute(app: FastifyInstance, deps: RadarRouteDeps): Promise<void> {
  app.get(
    '/radar',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const guard = await preflight(app, deps, req, reply);
      if (!guard.ok) return undefined as never;

      const parsed = QuerySchema.safeParse(req.query);
      if (!parsed.success) {
        void reply.status(400).send({
          error: 'BadRequest',
          code: 'validation_failed',
          message: 'query parameters are invalid',
        });
        return undefined as never;
      }
      const q = parsed.data;
      try {
        const result = await listRadarMatches(app.pool.db, {
          workspaceId: guard.currentUser.defaultWorkspace.id,
          userId: guard.currentUser.user.id,
          status: q.status,
          ...(q.min_score !== undefined ? { minScore: q.min_score } : {}),
          ...(q.max_score !== undefined ? { maxScore: q.max_score } : {}),
          page: q.page,
          pageSize: q.page_size,
        });
        void reply.status(200).send(projectRadarList(result));
        return undefined as never;
      } catch (err) {
        return handleCommandError(req, reply, err, 'listRadarMatches');
      }
    },
  );
}

// =============================================================================
// Shared preflight + error handling (same shape as topics.ts).
// =============================================================================

type PreflightOk = {
  ok: true;
  currentUser: import('@postdash/commands').ReadCurrentUserResult;
};
type PreflightFail = { ok: false };

async function preflight(
  app: FastifyInstance,
  deps: RadarRouteDeps,
  req: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
): Promise<PreflightOk | PreflightFail> {
  if (!deps.botToken) {
    void reply.status(503).send({
      error: 'ConfigError',
      code: 'bot_token_missing',
      message: 'TELEGRAM_BOT_TOKEN is not configured',
    });
    return { ok: false };
  }
  if (!app.pool) {
    void reply.status(503).send({
      error: 'ConfigError',
      code: 'db_unavailable',
      message: 'database pool is not wired',
    });
    return { ok: false };
  }

  let parsed: import('@postdash/shared').ParsedInitData | null;
  try {
    parsed = extractInitData(req, deps.botToken, deps.initDataMaxAgeSec);
  } catch (err) {
    if (err instanceof TelegramInitDataError) {
      req.log.warn({ err, code: err.code }, 'telegram initData verification failed');
      void reply.status(401).send({
        error: 'TelegramInitDataError',
        code: err.code,
        message: sanitizeInitDataError(err),
      });
      return { ok: false };
    }
    throw err;
  }
  if (!parsed) {
    void reply.status(401).send({
      error: 'MissingAuthorization',
      code: 'missing_authorization',
      message: 'Authorization header is required',
    });
    return { ok: false };
  }

  try {
    const currentUser = await readCurrentUser(app.pool.db, {
      telegramUserId: parsed.user.id,
    });
    return { ok: true, currentUser };
  } catch (err) {
    if (err instanceof CommandError) {
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
      return { ok: false };
    }
    throw err;
  }
}

function handleCommandError(
  req: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
  err: unknown,
  context: string,
): never {
  if (err instanceof CommandError) {
    const { status, message } = sanitizeCommandError(err);
    if (err.code === 'internal') {
      req.log.error({ err }, `${context} internal error`);
    } else {
      req.log.warn({ err, code: err.code }, `${context} command error`);
    }
    void reply.status(status).send({
      error: 'CommandError',
      code: err.details?.['code'] ?? err.code,
      message,
    });
    return undefined as never;
  }
  throw err;
}
