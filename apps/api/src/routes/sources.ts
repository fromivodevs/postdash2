/**
 * Source HTTP routes (Phase 3).
 *
 *   POST   /sources               (10/min/user) -> SourceSubscriptionProjection
 *   GET    /sources               (60/min/user) -> { items: SourceSubscriptionProjection[] }
 *   PATCH  /sources/:source_id    (20/min/user) -> SourceSubscriptionProjection
 *   DELETE /sources/:source_id    (10/min/user) -> 204
 *
 * Same self-503 contract as channels.ts / topics.ts. All redirect-resolution
 * + canonicalization + DB mutation logic lives in `@postdash/commands`.
 *
 * The ":source_id" URL parameter is the GLOBAL source id (sources.id), not
 * the per-workspace subscription id. The MVP single-profile UX makes
 * (workspace_id, source_id) uniquely identify a subscription; Phase 5+
 * multi-profile will need to switch the URL to /subscriptions/:id.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TelegramInitDataError } from '@postdash/shared';
import type { SourceSubscriptionListProjection } from '@postdash/shared';
import {
  CommandError,
  createSource,
  deleteSourceSubscription,
  listSources,
  readCurrentUser,
  updateSourceSubscription,
} from '@postdash/commands';
// listSources is still used by GET /sources; keep the import.
import { extractInitData } from '../auth/extract-initdata.js';
import { sanitizeCommandError, sanitizeInitDataError } from './error-mapping.js';
import { projectSourceSubscription } from './topics-projection.js';

export interface SourcesRouteDeps {
  botToken: string;
  initDataMaxAgeSec: number;
}

const CreateSourceBodySchema = z.object({
  url: z.string().min(1).max(2000),
  type: z.enum(['rss', 'website', 'api', 'manual']),
  name: z.string().min(1).max(200).optional(),
  topic_profile_id: z.string().uuid().optional(),
  fetch_interval_minutes: z.number().int().min(1).max(10080).optional(),
});

const UpdateSourceBodySchema = z.object({
  enabled: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  topic_profile_id: z.string().uuid().nullable().optional(),
});

export async function sourcesRoute(app: FastifyInstance, deps: SourcesRouteDeps): Promise<void> {
  // POST /sources
  app.post(
    '/sources',
    {
      bodyLimit: 4096,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const guard = await preflight(app, deps, req, reply);
      if (!guard.ok) return undefined as never;

      const parsed = CreateSourceBodySchema.safeParse(req.body);
      if (!parsed.success) {
        void reply.status(400).send({
          error: 'BadRequest',
          code: 'validation_failed',
          message: 'request body is invalid',
        });
        return undefined as never;
      }
      const body = parsed.data;

      try {
        const result = await createSource(app.pool.db, {
          workspaceId: guard.currentUser.defaultWorkspace.id,
          userId: guard.currentUser.user.id,
          url: body.url,
          type: body.type,
          ...(body.name !== undefined && { name: body.name }),
          ...(body.topic_profile_id !== undefined && { topicProfileId: body.topic_profile_id }),
          ...(body.fetch_interval_minutes !== undefined && {
            fetchIntervalMinutes: body.fetch_interval_minutes,
          }),
        });
        void reply
          .status(200)
          .send(projectSourceSubscription({ subscription: result.subscription, source: result.source }));
        return undefined as never;
      } catch (err) {
        return handleCommandError(req, reply, err, 'createSource');
      }
    },
  );

  // GET /sources
  app.get(
    '/sources',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const guard = await preflight(app, deps, req, reply);
      if (!guard.ok) return undefined as never;
      try {
        const items = await listSources(app.pool.db, {
          workspaceId: guard.currentUser.defaultWorkspace.id,
          userId: guard.currentUser.user.id,
        });
        const out: SourceSubscriptionListProjection = {
          items: items.map(projectSourceSubscription),
        };
        void reply.status(200).send(out);
        return undefined as never;
      } catch (err) {
        return handleCommandError(req, reply, err, 'listSources');
      }
    },
  );

  // PATCH /sources/:source_id
  app.patch<{ Params: { source_id: string } }>(
    '/sources/:source_id',
    {
      bodyLimit: 4096,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const guard = await preflight(app, deps, req, reply);
      if (!guard.ok) return undefined as never;

      const idValidation = z.string().uuid().safeParse(req.params.source_id);
      if (!idValidation.success) {
        void reply.status(400).send({
          error: 'BadRequest',
          code: 'validation_failed',
          message: 'invalid source id',
        });
        return undefined as never;
      }

      const parsed = UpdateSourceBodySchema.safeParse(req.body);
      if (!parsed.success) {
        void reply.status(400).send({
          error: 'BadRequest',
          code: 'validation_failed',
          message: 'request body is invalid',
        });
        return undefined as never;
      }
      const body = parsed.data;

      try {
        const updated = await updateSourceSubscription(app.pool.db, {
          workspaceId: guard.currentUser.defaultWorkspace.id,
          userId: guard.currentUser.user.id,
          sourceId: idValidation.data,
          ...(body.enabled !== undefined && { enabled: body.enabled }),
          ...(body.priority !== undefined && { priority: body.priority }),
          ...(body.topic_profile_id !== undefined && { topicProfileId: body.topic_profile_id }),
        });
        // updateSourceSubscription returns the joined source row directly —
        // no second query needed (prev. version re-ran listSources for the
        // whole workspace, an N-row read just to project one).
        void reply.status(200).send(projectSourceSubscription(updated));
        return undefined as never;
      } catch (err) {
        return handleCommandError(req, reply, err, 'updateSourceSubscription');
      }
    },
  );

  // DELETE /sources/:source_id
  app.delete<{ Params: { source_id: string } }>(
    '/sources/:source_id',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const guard = await preflight(app, deps, req, reply);
      if (!guard.ok) return undefined as never;

      const idValidation = z.string().uuid().safeParse(req.params.source_id);
      if (!idValidation.success) {
        void reply.status(400).send({
          error: 'BadRequest',
          code: 'validation_failed',
          message: 'invalid source id',
        });
        return undefined as never;
      }

      try {
        await deleteSourceSubscription(app.pool.db, {
          workspaceId: guard.currentUser.defaultWorkspace.id,
          userId: guard.currentUser.user.id,
          sourceId: idValidation.data,
        });
        void reply.status(204).send();
        return undefined as never;
      } catch (err) {
        return handleCommandError(req, reply, err, 'deleteSourceSubscription');
      }
    },
  );
}

// =============================================================================
// Same preflight + handler shape as topics.ts (kept local to avoid
// premature shared-helper extraction).
// =============================================================================

type PreflightOk = {
  ok: true;
  currentUser: import('@postdash/commands').ReadCurrentUserResult;
};
type PreflightFail = { ok: false };

async function preflight(
  app: FastifyInstance,
  deps: SourcesRouteDeps,
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
