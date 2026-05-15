/**
 * Channel-connection HTTP routes (Phase 2).
 *
 * Three endpoints, all gated on a verified Mini App initData + a known
 * workspace via `readCurrentUser`:
 *
 *   POST /channels/connect-codes  (5/min/user)   -> ConnectCodeProjection
 *   POST /channels/connect        (10/min/user)  -> ChannelProjection
 *   GET  /channels                (60/min/user)  -> { items: ChannelProjection[] }
 *
 * The route layer is intentionally thin: it extracts initData, resolves the
 * user + workspace, builds the command input, calls the command, and
 * projects the result. All real logic (idempotency, code redemption, adapter
 * call, DB writes) lives in `@postdash/commands`. See
 * architecture/channel-connection.md, "apps/api/src/routes/channels.ts".
 *
 * Error mapping note (Phase 2): `connectTelegramChannel` attaches a
 * `details.code` discriminator on CommandError. The route uses
 * `sanitizeChannelCommandError` to pick a non-default HTTP status (e.g.
 * `expired_code` -> 410, `channel_taken` -> 409) and echoes the wire `code`
 * in the response body. Routes that do NOT carry these details (e.g.
 * `createConnectCode` policy 403, list query) fall back to the Phase 1
 * `sanitizeCommandError` table.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  buildConnectDeepLink,
  TelegramInitDataError,
  type ChannelListProjection,
} from '@postdash/shared';
import {
  CommandError,
  connectTelegramChannel,
  createConnectCode,
  readCurrentUser,
  type TelegramChannelAdapter,
} from '@postdash/commands';
import {
  narrowChannelType,
  narrowConnectionStatus,
  narrowVerifyStatus,
} from '@postdash/domain';
import { channelConnections, contentChannels } from '@postdash/db';
import { extractInitData } from '../auth/extract-initdata.js';
import {
  sanitizeChannelCommandError,
  sanitizeCommandError,
  sanitizeInitDataError,
} from './error-mapping.js';
import {
  projectChannel,
  projectConnectCode,
  type DeepLinkBuilder,
} from './channels-projection.js';

export interface ChannelsRouteDeps {
  botToken: string;
  initDataMaxAgeSec: number;
  /**
   * Canonical bot @username WITHOUT the leading `@`. When empty/undefined the
   * routes return 503 — the deep-link can't be built without it, so failing
   * loudly is preferred over emitting a broken link.
   */
  botUsername: string;
  /**
   * Phase 2 dependency. `undefined` is a graceful 503 path: if
   * `bot.api.getMe()` failed at startup, we keep the rest of the API serving
   * but the channels route can't function. Mirrors the `app.pool` 503 pattern
   * already used by auth-telegram / me.
   */
  channelAdapter?: TelegramChannelAdapter | undefined;
}

const ConnectBodySchema = z.object({
  code: z.string().min(1).max(64),
  external_chat_id: z.string().min(1).max(128),
});

export async function channelsRoute(
  app: FastifyInstance,
  deps: ChannelsRouteDeps,
): Promise<void> {
  // ---------------------------------------------------------------------------
  // POST /channels/connect-codes
  // ---------------------------------------------------------------------------
  app.post(
    '/channels/connect-codes',
    {
      // Body is `{}`; the user + workspace are resolved from initData. Tight
      // bodyLimit rejects oversized payloads before the handler runs (same
      // shape as POST /auth/telegram).
      bodyLimit: 4096,
      config: {
        rateLimit: { max: 5, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const guard = await preflight(app, deps, req, reply, { requireAdapter: false });
      if (!guard.ok) return undefined as never;
      const { parsed, currentUser } = guard;

      const buildDeepLink: DeepLinkBuilder = (code) =>
        buildConnectDeepLink(deps.botUsername, code);

      try {
        // Idempotency key derived from a stable per-user, per-minute shape:
        //   cc:<workspace_id>:<user_id>:<auth_date_minute>
        // The auth_date comes from the verified initData (so it cannot be
        // spoofed by the client); flooring to whole minutes collapses a
        // double-click within ~60s onto the same key. A new minute mints a
        // fresh code, which is the desired UX (the user clicked "Создать
        // код" again deliberately). Plaintext code is NOT part of the key —
        // see architecture doc Invariant 1.
        const authDateMinute = Math.floor(parsed.auth_date / 60);
        const idempotencyKey = `cc:${currentUser.defaultWorkspace.id}:${currentUser.user.id}:${authDateMinute}`;

        const { result } = await createConnectCode(app.pool.db, {
          idempotencyKey,
          workspaceId: currentUser.defaultWorkspace.id,
          userId: currentUser.user.id,
        });

        const projection = projectConnectCode(
          {
            connectCodeId: result.connectCodeId,
            code: result.code,
            expiresAt: result.expiresAt,
          },
          buildDeepLink,
        );
        // 200 (not 201) because the operation is idempotent — a same-minute
        // replay returns the SAME logical resource at the SAME wire address.
        // Phase 1 POST /auth/telegram already established this convention.
        void reply.status(200).send(projection);
        return undefined as never;
      } catch (err) {
        return handleCommandError(req, reply, err, 'createConnectCode');
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /channels/connect
  // ---------------------------------------------------------------------------
  app.post(
    '/channels/connect',
    {
      bodyLimit: 4096,
      config: {
        rateLimit: { max: 10, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const guard = await preflight(app, deps, req, reply, { requireAdapter: true });
      if (!guard.ok) return undefined as never;
      const { currentUser, channelAdapter } = guard;

      // Idempotency-Key header is REQUIRED: connect is a side-effectful
      // command (consumes a code, inserts content_channels + channel_connections,
      // calls Telegram). A retried double-click without a stable key would
      // burn the code on the first call and 410-expired on the second.
      const rawIdempotency = req.headers['idempotency-key'];
      if (Array.isArray(rawIdempotency)) {
        void reply.status(400).send({
          error: 'BadRequest',
          code: 'invalid_idempotency_key',
          message: 'multiple Idempotency-Key headers are not allowed',
        });
        return undefined as never;
      }
      const idempotencyKey = (rawIdempotency ?? '').trim();
      if (!idempotencyKey) {
        void reply.status(400).send({
          error: 'BadRequest',
          code: 'missing_idempotency_key',
          message: 'Idempotency-Key header is required',
        });
        return undefined as never;
      }
      if (idempotencyKey.length > 200) {
        void reply.status(400).send({
          error: 'BadRequest',
          code: 'invalid_idempotency_key',
          message: 'Idempotency-Key header exceeds 200 chars',
        });
        return undefined as never;
      }

      const bodyParse = ConnectBodySchema.safeParse(req.body);
      if (!bodyParse.success) {
        void reply.status(400).send({
          error: 'BadRequest',
          code: 'validation_failed',
          message: 'request body is invalid',
        });
        return undefined as never;
      }
      const body = bodyParse.data;

      try {
        const { result } = await connectTelegramChannel(
          app.pool.db,
          channelAdapter,
          {
            idempotencyKey,
            code: body.code,
            externalChatId: body.external_chat_id,
            invokedBy: { source: 'miniapp', userId: currentUser.user.id },
          },
        );

        const projection = projectChannel({
          connection: result.channelConnection,
          contentChannel: result.contentChannel,
        });
        void reply.status(200).send(projection);
        return undefined as never;
      } catch (err) {
        return handleChannelCommandError(req, reply, err, 'connectTelegramChannel');
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /channels
  // ---------------------------------------------------------------------------
  app.get(
    '/channels',
    {
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      // Adapter not strictly required for read-only list. We still want a
      // bot-username for any future deep-link in the response, but list
      // currently has none — so botUsername empty is acceptable here.
      const guard = await preflight(app, deps, req, reply, {
        requireAdapter: false,
        requireBotUsername: false,
      });
      if (!guard.ok) return undefined as never;
      const { currentUser } = guard;

      try {
        // JOIN content_channels for the workspace's bindings. Status filter
        // intentionally omits 'revoked' (Phase 2 never sets it, but a future
        // re-verification flip might) — keeping it inclusive for now so the
        // Mini App can render broken/revoked states from the same response.
        const rows = await app.pool.db
          .select({
            connection: channelConnections,
            content_channel: contentChannels,
          })
          .from(channelConnections)
          .innerJoin(
            contentChannels,
            eq(contentChannels.id, channelConnections.contentChannelId),
          )
          .where(
            and(
              eq(channelConnections.workspaceId, currentUser.defaultWorkspace.id),
              // Defensive: list only non-revoked statuses. Drizzle's `inArray`
              // is the equivalent of `status IN (...)`.
              inArray(channelConnections.status, ['pending', 'connected', 'broken']),
            ),
          )
          .orderBy(desc(channelConnections.createdAt));

        const items = rows.map((row) =>
          projectChannel({
            connection: {
              id: row.connection.id,
              workspaceId: row.connection.workspaceId,
              contentChannelId: row.connection.contentChannelId,
              status: narrowConnectionStatus(row.connection.status),
              canPostMessages: row.connection.canPostMessages,
              lastVerifyStatus:
                row.connection.lastVerifyStatus === null
                  ? null
                  : narrowVerifyStatus(row.connection.lastVerifyStatus),
              lastVerifyError: row.connection.lastVerifyError,
              lastVerifiedAt: row.connection.lastVerifiedAt,
              connectedAt: row.connection.connectedAt,
              connectedByUserId: row.connection.connectedByUserId,
              createdAt: row.connection.createdAt,
              updatedAt: row.connection.updatedAt,
            },
            contentChannel: {
              id: row.content_channel.id,
              platform: 'telegram',
              externalId: row.content_channel.externalId,
              type: narrowChannelType(row.content_channel.type),
              title: row.content_channel.title,
              username: row.content_channel.username,
              photoUrl: row.content_channel.photoUrl,
              createdAt: row.content_channel.createdAt,
              updatedAt: row.content_channel.updatedAt,
            },
          }),
        );
        const out: ChannelListProjection = { items };
        void reply.status(200).send(out);
        return undefined as never;
      } catch (err) {
        return handleCommandError(req, reply, err, 'listChannels');
      }
    },
  );
}

/**
 * Common pre-handler: bot-token / pool / adapter presence, initData extraction,
 * and `readCurrentUser`. Returns a discriminated union so the calling handler
 * can early-return on failure without re-emitting status codes here.
 *
 * The `requireAdapter` switch controls whether a missing `channelAdapter`
 * triggers a 503 — list reads don't need the adapter, mutations do.
 */
type PreflightOk = {
  ok: true;
  parsed: import('@postdash/shared').ParsedInitData;
  currentUser: import('@postdash/commands').ReadCurrentUserResult;
  channelAdapter: TelegramChannelAdapter;
};
type PreflightFail = { ok: false };

async function preflight(
  app: FastifyInstance,
  deps: ChannelsRouteDeps,
  req: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
  opts: { requireAdapter: boolean; requireBotUsername?: boolean },
): Promise<PreflightOk | PreflightFail> {
  const requireBotUsername = opts.requireBotUsername ?? true;
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
  if (requireBotUsername && !deps.botUsername) {
    void reply.status(503).send({
      error: 'ConfigError',
      code: 'bot_username_missing',
      message: 'TELEGRAM_BOT_USERNAME is not configured',
    });
    return { ok: false };
  }
  if (opts.requireAdapter && !deps.channelAdapter) {
    void reply.status(503).send({
      error: 'ConfigError',
      code: 'channel_adapter_unavailable',
      message: 'Telegram channel adapter is not wired',
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
    return {
      ok: true,
      parsed,
      currentUser,
      // Non-null asserted by the requireAdapter guard above when the route
      // requested it; for adapter-not-required paths we substitute a no-op
      // sentinel that the route MUST NOT use.
      channelAdapter: (deps.channelAdapter ?? UNREACHABLE_ADAPTER) as TelegramChannelAdapter,
    };
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

/**
 * Adapter sentinel for routes that don't require the adapter at preflight
 * time (e.g. GET /channels). Accessing `verifyConnection` throws — the route
 * code path that bypassed `requireAdapter:true` must never call it.
 */
const UNREACHABLE_ADAPTER: TelegramChannelAdapter = {
  verifyConnection() {
    throw new Error(
      'channelAdapter accessed in a route that did not require it — this is a programmer error',
    );
  },
};

/** Phase 1-style CommandError sanitization (no details.code). */
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

/**
 * Phase 2-style CommandError sanitization that honours `details.code`.
 * Used by POST /channels/connect to translate `expired_code` -> 410 etc.
 */
function handleChannelCommandError(
  req: import('fastify').FastifyRequest,
  reply: import('fastify').FastifyReply,
  err: unknown,
  context: string,
): never {
  if (err instanceof CommandError) {
    const { status, message, wireCode } = sanitizeChannelCommandError(err);
    if (err.code === 'internal') {
      req.log.error({ err, wireCode }, `${context} internal error`);
    } else {
      req.log.warn(
        { err, code: err.code, wireCode },
        `${context} command error`,
      );
    }
    void reply.status(status).send({
      error: 'CommandError',
      code: wireCode,
      message,
    });
    return undefined as never;
  }
  throw err;
}

