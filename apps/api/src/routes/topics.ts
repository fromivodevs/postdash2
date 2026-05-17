/**
 * Topic-profile HTTP routes (Phase 3).
 *
 *   POST   /topics           (10/min/user) -> TopicProfileProjection
 *   GET    /topics           (60/min/user) -> { items: TopicProfileProjection[] }
 *   PATCH  /topics/:id       (20/min/user) -> TopicProfileProjection
 *   DELETE /topics/:id       (10/min/user) -> 204
 *
 * Same shape as channels.ts:
 *   - preflight() validates bot token / pool / initData / current user.
 *   - All logic lives in @postdash/commands.
 *   - CommandError is sanitized via the Phase 1 table.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TelegramInitDataError } from '@postdash/shared';
import type { TopicProfileListProjection } from '@postdash/shared';
import {
  CommandError,
  createTopicProfile,
  deleteTopicProfile,
  listTopicProfiles,
  readCurrentUser,
  updateTopicProfile,
} from '@postdash/commands';
import { extractInitData } from '../auth/extract-initdata.js';
import { sanitizeCommandError, sanitizeInitDataError } from './error-mapping.js';
import { projectTopicProfile } from './topics-projection.js';

export interface TopicsRouteDeps {
  botToken: string;
  initDataMaxAgeSec: number;
}

const TopicBodySchema = z.object({
  name: z.string().min(1).max(200),
  language: z.enum(['ru', 'en']),
  main_topics: z.array(z.string().min(1).max(100)).max(50).default([]),
  keywords: z.array(z.string().min(1).max(100)).max(100).default([]),
  negative_keywords: z.array(z.string().min(1).max(100)).max(100).default([]),
  tone_profile: z.record(z.string(), z.unknown()).nullable().optional(),
});

const TopicPatchBodySchema = TopicBodySchema.partial();

export async function topicsRoute(app: FastifyInstance, deps: TopicsRouteDeps): Promise<void> {
  // POST /topics
  app.post(
    '/topics',
    {
      bodyLimit: 16_384, // generous for tone_profile JSON
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const guard = await preflight(app, deps, req, reply);
      if (!guard.ok) return undefined as never;

      const parsed = TopicBodySchema.safeParse(req.body);
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
        const result = await createTopicProfile(app.pool.db, {
          workspaceId: guard.currentUser.defaultWorkspace.id,
          userId: guard.currentUser.user.id,
          name: body.name,
          language: body.language,
          mainTopics: body.main_topics,
          keywords: body.keywords,
          negativeKeywords: body.negative_keywords,
          toneProfile: body.tone_profile ?? null,
        });
        // 200 (upsert semantics) — the same workspace POSTing a new topic
        // collapses onto the existing active profile.
        void reply.status(200).send(projectTopicProfile(result.profile));
        return undefined as never;
      } catch (err) {
        return handleCommandError(req, reply, err, 'createTopicProfile');
      }
    },
  );

  // GET /topics
  app.get(
    '/topics',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const guard = await preflight(app, deps, req, reply);
      if (!guard.ok) return undefined as never;
      try {
        const items = await listTopicProfiles(app.pool.db, {
          workspaceId: guard.currentUser.defaultWorkspace.id,
          userId: guard.currentUser.user.id,
        });
        const out: TopicProfileListProjection = { items: items.map(projectTopicProfile) };
        void reply.status(200).send(out);
        return undefined as never;
      } catch (err) {
        return handleCommandError(req, reply, err, 'listTopicProfiles');
      }
    },
  );

  // PATCH /topics/:id
  app.patch<{ Params: { id: string } }>(
    '/topics/:id',
    {
      bodyLimit: 16_384,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const guard = await preflight(app, deps, req, reply);
      if (!guard.ok) return undefined as never;

      const idValidation = z.string().uuid().safeParse(req.params.id);
      if (!idValidation.success) {
        void reply.status(400).send({
          error: 'BadRequest',
          code: 'validation_failed',
          message: 'invalid topic id',
        });
        return undefined as never;
      }

      const parsed = TopicPatchBodySchema.safeParse(req.body);
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
        const updated = await updateTopicProfile(app.pool.db, {
          topicProfileId: idValidation.data,
          workspaceId: guard.currentUser.defaultWorkspace.id,
          userId: guard.currentUser.user.id,
          ...(body.name !== undefined && { name: body.name }),
          ...(body.language !== undefined && { language: body.language }),
          ...(body.main_topics !== undefined && { mainTopics: body.main_topics }),
          ...(body.keywords !== undefined && { keywords: body.keywords }),
          ...(body.negative_keywords !== undefined && { negativeKeywords: body.negative_keywords }),
          ...(body.tone_profile !== undefined && { toneProfile: body.tone_profile }),
        });
        void reply.status(200).send(projectTopicProfile(updated));
        return undefined as never;
      } catch (err) {
        return handleCommandError(req, reply, err, 'updateTopicProfile');
      }
    },
  );

  // DELETE /topics/:id
  app.delete<{ Params: { id: string } }>(
    '/topics/:id',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const guard = await preflight(app, deps, req, reply);
      if (!guard.ok) return undefined as never;

      const idValidation = z.string().uuid().safeParse(req.params.id);
      if (!idValidation.success) {
        void reply.status(400).send({
          error: 'BadRequest',
          code: 'validation_failed',
          message: 'invalid topic id',
        });
        return undefined as never;
      }

      try {
        await deleteTopicProfile(app.pool.db, {
          topicProfileId: idValidation.data,
          workspaceId: guard.currentUser.defaultWorkspace.id,
          userId: guard.currentUser.user.id,
        });
        void reply.status(204).send();
        return undefined as never;
      } catch (err) {
        return handleCommandError(req, reply, err, 'deleteTopicProfile');
      }
    },
  );
}

// =============================================================================
// Shared preflight + error handling. Lifted from channels.ts and trimmed to
// the Phase 3 surface (no adapter, no bot username).
// =============================================================================

type PreflightOk = {
  ok: true;
  currentUser: import('@postdash/commands').ReadCurrentUserResult;
};
type PreflightFail = { ok: false };

async function preflight(
  app: FastifyInstance,
  deps: TopicsRouteDeps,
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
