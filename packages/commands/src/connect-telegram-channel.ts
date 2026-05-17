/**
 * ConnectTelegramChannel command.
 *
 * Redeems a connect code + binds a Telegram channel to a workspace via the
 * `TelegramChannelAdapter` (HTTP layer — injected dependency, never imported
 * directly from `@postdash/channel-adapters` to keep the layer boundary
 * documented in architecture doc Invariant 3).
 *
 * See architecture/channel-connection.md (Interface contracts) for the full
 * flow. High-level:
 *   1. Zod-validate input.
 *   2. Wrap in runIdempotent (ttl=24h — safe to cache because no plaintext
 *      surfaces in the result).
 *   3. Inside execute(tx):
 *      - Lock the code row via `lookupActiveCode` (FOR UPDATE).
 *      - Guard missing / expired / consumed.
 *      - Resolve connecting user from `invokedBy` discriminator.
 *      - assertWorkspaceRole(tx, code.workspaceId, userId, 'admin').
 *      - Call adapter.verifyConnection (inside-tx — see architecture doc
 *        decision "Adapter call inside runIdempotent transaction").
 *      - On adapter failure: throw CommandError, code STAYS active.
 *      - On adapter success: UPSERT content_channels, INSERT
 *        channel_connections (FK unique violation -> 'channel_taken'),
 *        UPDATE code -> consumed, INSERT operation_log.
 *   4. loadFromPointer({ objectId }): reload connection + content_channel
 *      for replay. Safe because no plaintext involved.
 */

import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import {
  MAX_EXTERNAL_CHAT_ID_LEN,
  narrowChannelType,
  narrowConnectionStatus,
  narrowVerifyStatus,
  type ChannelConnection,
  type ContentChannel,
} from '@postdash/domain';
import type { Database, DbOrTx } from '@postdash/db';
import {
  channelConnectCodes,
  channelConnections,
  contentChannels,
  operationLog,
  telegramIdentities,
} from '@postdash/db';
import { CommandError } from './errors.js';
import { runIdempotent } from './idempotency.js';
import { hashConnectCode, lookupActiveCode } from './connect-code-helpers.js';
import { assertWorkspaceRole } from './policies.js';

// NOTE: TelegramChannelAdapter / VerifyConnectionResult are intentionally
// re-declared here (not imported from @postdash/channel-adapters) to preserve
// the commands↛adapters layer boundary. The contract is mirrored by hand;
// see architecture/channel-connection.md Decision log.
export interface VerifyConnectionInput {
  externalChatId: string;
}

export type VerifyConnectionResult =
  | {
      ok: true;
      /**
       * Canonical numeric chat_id as a string. Telegram's `getChat` accepts
       * both `@username` and numeric `chat_id`; the adapter resolves to the
       * numeric form and we store THAT in `content_channels.external_id`
       * (NOT the user-typed @username). See architecture doc "Risks §2".
       */
      externalId: string;
      title: string;
      username: string | null;
      photoUrl: string | null;
      chatType: 'channel' | 'supergroup' | 'group' | 'private_chat';
      canPostMessages: true;
    }
  | {
      ok: false;
      errorCode:
        | 'bot_not_admin'
        | 'missing_post_permission'
        | 'chat_not_found'
        | 'bot_blocked'
        | 'unauthorized'
        | 'network'
        | 'unknown';
      detail: string;
    };

export interface TelegramChannelAdapter {
  verifyConnection(input: VerifyConnectionInput): Promise<VerifyConnectionResult>;
}

export const ConnectTelegramChannelInputSchema = z.object({
  // Cap 300 chars: the route composes `${headerIdempotencyKey}:${sha256Hex}`
  // where the header itself is capped at 200 and the sha256 hex digest is 64
  // (plus a `:` separator → 265 worst case). 300 leaves room for that
  // composition without artificially tightening the per-header cap on the
  // route side. See architecture/channel-connection.md Decision: "body-hash
  // suffix on idempotency key" (Phase 2 sub_loop 4 Fix W3).
  idempotencyKey: z.string().min(1).max(300),
  code: z.string().min(6).max(20),
  externalChatId: z.string().min(1).max(MAX_EXTERNAL_CHAT_ID_LEN),
  invokedBy: z.union([
    z.object({ source: z.literal('bot'), telegramUserId: z.number().int() }),
    z.object({ source: z.literal('miniapp'), userId: z.string().uuid() }),
  ]),
});
export type ConnectTelegramChannelInput = z.infer<typeof ConnectTelegramChannelInputSchema>;

export interface ConnectTelegramChannelResult {
  contentChannel: ContentChannel;
  channelConnection: ChannelConnection;
  workspaceId: string;
}

const COMMAND_TYPE = 'ConnectTelegramChannel';

export async function connectTelegramChannel(
  db: Database,
  adapter: TelegramChannelAdapter,
  input: ConnectTelegramChannelInput,
): Promise<{ replayed: boolean; result: ConnectTelegramChannelResult }> {
  const parsed = ConnectTelegramChannelInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CommandError(
      'validation_failed',
      `connectTelegramChannel: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const validated = parsed.data;

  // Pre-tx `userId` correlation: for the Mini App path the connecting user is
  // known up-front (verified by initData), so the idempotency row carries it
  // from INSERT. For the bot path we only learn the userId after an in-tx
  // `telegram_identities` lookup, so it stays null at INSERT and is backfilled
  // via `execute()` metadata below. `workspaceId` is always learned in-tx
  // (it lives on the connect-code row, not the input) and is likewise
  // backfilled — see `metadata` on the execute() return.
  const upfrontUserId =
    validated.invokedBy.source === 'miniapp' ? validated.invokedBy.userId : null;

  return runIdempotent<ConnectTelegramChannelResult>(
    db,
    {
      commandType: COMMAND_TYPE,
      idempotencyKey: validated.idempotencyKey,
      userId: upfrontUserId,
    },
    {
      execute: async (tx) => {
        const out = await doConnect(tx, adapter, validated);
        return {
          objectType: 'channel_connection',
          objectId: out.channelConnection.id,
          result: out,
          // Forensic-correlation metadata: surface the actual workspace + user
          // the connect bound, so the idempotency row reflects them even when
          // the upfront ctx values were null (bot path) or pre-lookup. NOT a
          // security control — the route layer enforces caller-vs-actual
          // workspace match before responding (defense-in-depth).
          metadata: {
            workspaceId: out.workspaceId,
            userId: out.channelConnection.connectedByUserId,
          },
        };
      },
      loadFromPointer: async ({ objectId }) => loadConnectionById(db, objectId),
    },
  );
}

async function doConnect(
  tx: DbOrTx,
  adapter: TelegramChannelAdapter,
  input: ConnectTelegramChannelInput,
): Promise<ConnectTelegramChannelResult> {
  const codeHash = hashConnectCode(input.code);

  // Lock + load the code row. FOR UPDATE serialises two concurrent redeems
  // on this same code — the second waits for the first to commit/rollback,
  // then observes the post-update status.
  const code = await lookupActiveCode(tx, codeHash);
  if (!code) {
    // No row matches the hash at all → unknown code.
    throw new CommandError('not_found', 'unknown code', { code: 'invalid_code' });
  }

  // Guards in priority order:
  //   1. status='consumed' before expiry-check: a consumed code that has
  //      also passed its TTL is still semantically "already used" (consumed
  //      wins) — the user shouldn't be told "expired" when they actually
  //      already used it.
  if (code.status === 'consumed') {
    throw new CommandError('conflict', 'code already used', { code: 'reused_code' });
  }
  //   2. status='expired' OR expires_at past: treat both as expired. Best-
  //      effort flip to 'expired' so the next caller short-circuits (the
  //      janitor in Phase 8 will eventually do this too). We do NOT raise
  //      on the UPDATE failure because the error path is still "expired".
  const expired = code.status === 'expired' || code.expiresAt.getTime() <= Date.now();
  if (expired) {
    // Mark expired so analytics + future lookups stay accurate. The filter
    // `status='active'` avoids clobbering a row a concurrent successor
    // already flipped (very unlikely under FOR UPDATE, but cheap insurance).
    await tx
      .update(channelConnectCodes)
      .set({ status: 'expired' })
      .where(and(eq(channelConnectCodes.id, code.id), eq(channelConnectCodes.status, 'active')));
    throw new CommandError('not_found', 'code expired', { code: 'expired_code' });
  }

  // Resolve the connecting user.
  // - miniapp path: the user authenticated via initData; userId is verified
  //   upstream by `readCurrentUser`.
  // - bot path: lookup telegram_identities; if the bot user hasn't auth'd
  //   yet via Mini App, we reject (they can't be a workspace admin without
  //   a users row).
  let connectingUserId: string;
  if (input.invokedBy.source === 'miniapp') {
    connectingUserId = input.invokedBy.userId;
  } else {
    const telegramUserId = BigInt(input.invokedBy.telegramUserId);
    const identityRows = await tx
      .select({ userId: telegramIdentities.userId, status: telegramIdentities.status })
      .from(telegramIdentities)
      .where(eq(telegramIdentities.telegramUserId, telegramUserId))
      .limit(1);
    const identity = identityRows[0];
    if (!identity) {
      throw new CommandError('forbidden', 'bot user has not authenticated via Mini App yet', {
        code: 'bot_user_unknown',
      });
    }
    if (identity.status !== 'active') {
      throw new CommandError('forbidden', `bot user telegram identity is ${identity.status}`, {
        code: 'bot_user_inactive',
      });
    }
    connectingUserId = identity.userId;
  }

  // Policy: the connector must be an admin/owner of the code's workspace.
  // Note: the workspace is fixed by the CODE, not by the caller — a member
  // of workspace A who knows workspace B's code still fails this check
  // because they're not an admin of B (architecture doc Invariant 5).
  await assertWorkspaceRole(tx, code.workspaceId, connectingUserId, 'admin');

  // Call the adapter INSIDE the tx (architecture doc decision "Adapter call
  // inside runIdempotent transaction"). The adapter has a 5s hard timeout so
  // the lock-hold is bounded.
  const verification = await adapter.verifyConnection({ externalChatId: input.externalChatId });

  if (!verification.ok) {
    // Adapter-failure path: throw mapped CommandError. The code stays
    // 'active' (we never UPDATE it on this path), so the user can retry
    // after fixing permissions in Telegram.
    throw mapAdapterFailure(verification.errorCode, verification.detail);
  }

  // UPSERT content_channels by (platform, external_id). Two flows for the
  // same Telegram chat (bot deep-link + Mini App manual) converge on one
  // row. ON CONFLICT refreshes the title/username/photo so a renamed channel
  // gets its updated metadata stored on the next connect attempt.
  // External_id is the canonical numeric chat_id from the adapter (not the
  // user-typed @username — see architecture doc Risks §2).
  const upserted = await tx
    .insert(contentChannels)
    .values({
      platform: 'telegram',
      externalId: verification.externalId,
      type: verification.chatType,
      title: verification.title,
      username: verification.username,
      photoUrl: verification.photoUrl,
    })
    .onConflictDoUpdate({
      target: [contentChannels.platform, contentChannels.externalId],
      set: {
        title: verification.title,
        username: verification.username,
        photoUrl: verification.photoUrl,
        type: verification.chatType,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  const contentChannelRow = upserted[0];
  if (!contentChannelRow) {
    throw new CommandError('internal', 'content_channels upsert returned no row');
  }

  // INSERT channel_connections. The unique constraint on content_channel_id
  // enforces "one workspace per channel in Phase 2" — a second workspace
  // trying to bind the same chat hits this and we map to 'channel_taken'.
  // The code STAYS active because the user can't fix this on their own
  // (it's an inter-workspace conflict, not a permissions issue) and we
  // don't want to burn a code on an unfixable error from their perspective.
  let connectionRow;
  try {
    const inserted = await tx
      .insert(channelConnections)
      .values({
        workspaceId: code.workspaceId,
        contentChannelId: contentChannelRow.id,
        status: 'connected',
        canPostMessages: true,
        lastVerifyStatus: 'ok',
        lastVerifyError: null,
        lastVerifiedAt: new Date(),
        connectedAt: new Date(),
        connectedByUserId: connectingUserId,
      })
      .returning();
    connectionRow = inserted[0];
  } catch (err) {
    if (
      isUniqueViolation(err) &&
      violatedConstraintIs(err, 'channel_connections_content_channel_unique')
    ) {
      throw new CommandError('conflict', 'channel is already connected to another workspace', {
        code: 'channel_taken',
      });
    }
    throw err;
  }
  if (!connectionRow) {
    throw new CommandError('internal', 'channel_connections insert returned no row');
  }

  // Consume the code. Filter on status='active' so a concurrent successor
  // (FOR UPDATE waited, then ran) can't double-consume — the second UPDATE
  // matches 0 rows. We don't raise on 0 rows because the only way that
  // happens under FOR UPDATE is if something concurrent already consumed,
  // and our own INSERT into channel_connections would have failed first.
  const consumedTelegramUserId =
    input.invokedBy.source === 'bot' ? BigInt(input.invokedBy.telegramUserId) : null;
  await tx
    .update(channelConnectCodes)
    .set({
      status: 'consumed',
      consumedAt: sql`now()`,
      consumedByTelegramUserId: consumedTelegramUserId,
      consumedByExternalChatId: verification.externalId,
    })
    .where(and(eq(channelConnectCodes.id, code.id), eq(channelConnectCodes.status, 'active')));

  // Audit. Note: NO plaintext code, NO code_hash in payloadSummary — only
  // domain metadata. The `source` discriminator helps forensic queries
  // distinguish bot-initiated vs Mini-App-initiated binds.
  await tx.insert(operationLog).values({
    workspaceId: code.workspaceId,
    userId: connectingUserId,
    telegramUserId: consumedTelegramUserId,
    commandType: COMMAND_TYPE,
    objectType: 'channel_connection',
    objectId: connectionRow.id,
    payloadSummary: {
      external_id: verification.externalId,
      platform: 'telegram',
      chat_type: verification.chatType,
      source: input.invokedBy.source,
    },
    result: 'success',
  });

  return {
    contentChannel: rowToContentChannel(contentChannelRow),
    channelConnection: rowToChannelConnection(connectionRow),
    workspaceId: code.workspaceId,
  };
}

function mapAdapterFailure(
  errorCode:
    | 'bot_not_admin'
    | 'missing_post_permission'
    | 'chat_not_found'
    | 'bot_blocked'
    | 'unauthorized'
    | 'network'
    | 'unknown',
  detail: string,
): CommandError {
  // All adapter failures are 'validation_failed' at the command-error level
  // (the user can fix them in Telegram + retry); the wire-level discrimination
  // is in details.code, which the route layer reads to pick HTTP status +
  // user-facing copy. `network`/`unknown` map to 'internal' instead — those
  // are server-side problems the user can't fix.
  const isUserFacing =
    errorCode === 'bot_not_admin' ||
    errorCode === 'missing_post_permission' ||
    errorCode === 'chat_not_found' ||
    errorCode === 'bot_blocked' ||
    errorCode === 'unauthorized';
  if (isUserFacing) {
    return new CommandError('validation_failed', `adapter: ${detail}`, { code: errorCode });
  }
  return new CommandError('internal', `adapter ${errorCode}: ${detail}`, { code: errorCode });
}

async function loadConnectionById(
  db: Database,
  connectionId: string,
): Promise<ConnectTelegramChannelResult> {
  const rows = await db
    .select({
      channel_connections: channelConnections,
      content_channels: contentChannels,
    })
    .from(channelConnections)
    .innerJoin(contentChannels, eq(contentChannels.id, channelConnections.contentChannelId))
    .where(eq(channelConnections.id, connectionId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new CommandError('not_found', `channel_connection ${connectionId} not found on replay`);
  }
  return {
    contentChannel: rowToContentChannel(row.content_channels),
    channelConnection: rowToChannelConnection(row.channel_connections),
    workspaceId: row.channel_connections.workspaceId,
  };
}

function rowToContentChannel(row: {
  id: string;
  platform: string;
  externalId: string;
  type: string;
  title: string;
  username: string | null;
  photoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ContentChannel {
  return {
    id: row.id,
    platform: 'telegram',
    externalId: row.externalId,
    type: narrowChannelType(row.type),
    title: row.title,
    username: row.username,
    photoUrl: row.photoUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToChannelConnection(row: {
  id: string;
  workspaceId: string;
  contentChannelId: string;
  status: string;
  canPostMessages: boolean | null;
  lastVerifyStatus: string | null;
  lastVerifyError: string | null;
  lastVerifiedAt: Date | null;
  connectedAt: Date | null;
  connectedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ChannelConnection {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    contentChannelId: row.contentChannelId,
    status: narrowConnectionStatus(row.status),
    canPostMessages: row.canPostMessages,
    lastVerifyStatus:
      row.lastVerifyStatus === null ? null : narrowVerifyStatus(row.lastVerifyStatus),
    lastVerifyError: row.lastVerifyError,
    lastVerifiedAt: row.lastVerifiedAt,
    connectedAt: row.connectedAt,
    connectedByUserId: row.connectedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Postgres unique-violation guard: code 23505. See authenticate-telegram.ts
 * for the same trick — drivers wrap differently, so string-match defensively.
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  return (err as { code?: unknown }).code === '23505';
}

/**
 * Narrow `23505` to a SPECIFIC unique constraint by name. Multiple unique
 * constraints exist on these tables (e.g. `content_channels_platform_external_unique`
 * vs `channel_connections_content_channel_unique`); we only want to map the
 * latter to 'channel_taken'. The former would indicate a different race
 * (two flows upserting the same chat) and should NOT be 'channel_taken'.
 *
 * Driver-dependent: postgres-js exposes `.constraint_name`; node-postgres
 * exposes `.constraint`. We check both.
 */
function violatedConstraintIs(err: unknown, constraintName: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { constraint?: unknown; constraint_name?: unknown };
  return e.constraint === constraintName || e.constraint_name === constraintName;
}

export const _internals = { COMMAND_TYPE };
