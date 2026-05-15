/**
 * CreateConnectCode command.
 *
 * Mints a one-time, 30-minute, TTL-bound connect code for a workspace.
 *
 * Behaviour (see architecture/channel-connection.md):
 *   1. Zod-validate input (workspaceId UUID, userId UUID, idempotencyKey ≤200).
 *   2. Wrap in `runIdempotent({ commandType: 'CreateConnectCode',
 *      ttlHours: 1 })`. TTL is 1h (vs default 24h) because a successful
 *      replay can NOT return the plaintext code (only sha256 is persisted),
 *      so the cached pointer is intentionally short-lived to bias clients
 *      toward minting a fresh code instead.
 *   3. Inside execute(tx):
 *      - assertWorkspaceRole(tx, ws, user, 'admin'). Editors/viewers get 403.
 *      - Generate 8-char Crockford code (~40 bits) + sha256(code) hex.
 *      - INSERT channel_connect_codes (status='active', expires=now+30m).
 *      - INSERT operation_log (NO plaintext code, NO code_hash in payload).
 *      - Return pointer { object_type: 'channel_connect_code', object_id }.
 *   4. loadFromPointer({ objectId }): FAIL with conflict — the plaintext code
 *      was never persisted, so a replay can't reconstruct it. Documented
 *      in architecture doc Decision "Replay of CreateConnectCode is impossible".
 *
 * SECURITY: plaintext code MUST surface to the caller exactly once in the
 * fresh execute() return. NEVER log it, NEVER store it.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { Database, DbOrTx } from '@postdash/db';
import { channelConnectCodes, operationLog } from '@postdash/db';
import { CommandError } from './errors.js';
import { runIdempotent } from './idempotency.js';
import { generateConnectCode, hashConnectCode } from './connect-code-helpers.js';
import { assertWorkspaceRole } from './policies.js';

export const CreateConnectCodeInputSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
});
export type CreateConnectCodeInput = z.infer<typeof CreateConnectCodeInputSchema>;

export interface CreateConnectCodeResult {
  /**
   * Plaintext code (8 Crockford chars). The caller (the API route) MUST
   * surface it to the user once and never log it. NOT reconstructible on
   * replay — see `loadFromPointer` below.
   */
  code: string;
  /** DB row id; used by tests + idempotency pointer. */
  connectCodeId: string;
  workspaceId: string;
  expiresAt: Date;
}

const COMMAND_TYPE = 'CreateConnectCode';
const TTL_MINUTES = 30;
const IDEMPOTENCY_TTL_HOURS = 1;

export async function createConnectCode(
  db: Database,
  input: CreateConnectCodeInput,
): Promise<{ replayed: boolean; result: CreateConnectCodeResult }> {
  const parsed = CreateConnectCodeInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CommandError(
      'validation_failed',
      `createConnectCode: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const { idempotencyKey, workspaceId, userId } = parsed.data;

  return runIdempotent<CreateConnectCodeResult>(
    db,
    {
      commandType: COMMAND_TYPE,
      idempotencyKey,
      workspaceId,
      userId,
      ttlHours: IDEMPOTENCY_TTL_HOURS,
    },
    {
      execute: async (tx) => {
        const out = await doCreateConnectCode(tx, { workspaceId, userId });
        return {
          objectType: 'channel_connect_code',
          objectId: out.connectCodeId,
          result: out,
        };
      },
      // Replay of a successful CreateConnectCode is intentionally a hard fail:
      // we never retained the plaintext code, so we cannot reconstruct the
      // exact response the original call returned. Returning a different
      // plaintext would silently break the user's deep-link; returning
      // `code: null` would change the response shape on replay. Failing with
      // 'conflict' makes the contract explicit — the route layer maps it to
      // 409 + `code: 'idempotency_replay_impossible'`, and the client is
      // expected to mint a new code with a fresh idempotency key.
      loadFromPointer: async () => {
        throw new CommandError(
          'conflict',
          'idempotency replay impossible: connect code plaintext is not retained',
          { code: 'idempotency_replay_impossible' },
        );
      },
    },
  );
}

interface DoCreateInput {
  workspaceId: string;
  userId: string;
}

async function doCreateConnectCode(
  tx: DbOrTx,
  input: DoCreateInput,
): Promise<CreateConnectCodeResult> {
  // Policy: only owners and admins can mint codes.
  await assertWorkspaceRole(tx, input.workspaceId, input.userId, 'admin');

  const code = generateConnectCode();
  const codeHash = hashConnectCode(code);
  // expires_at as a Date computed in JS, NOT `now() + interval ...` in SQL.
  // Two reasons: (a) returning the value to the caller requires we know the
  // wall-clock value; using SQL `now()` would require a RETURNING clause AND
  // a second round-trip to format it. (b) idempotency replay must converge
  // on the same expires_at — pinning it here makes the value deterministic
  // for a given execute() pass.
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60 * 1000);

  const inserted = await tx
    .insert(channelConnectCodes)
    .values({
      workspaceId: input.workspaceId,
      createdByUserId: input.userId,
      codeHash,
      status: 'active',
      expiresAt,
    })
    .returning({ id: channelConnectCodes.id });
  const row = inserted[0];
  if (!row) {
    throw new CommandError('internal', 'channel_connect_codes insert returned no row');
  }

  // operation_log MUST NOT carry the plaintext code or the code_hash.
  // payloadSummary records only the TTL window so an auditor can see "a code
  // was minted with a 30-minute TTL" without learning what the code was.
  await tx.insert(operationLog).values({
    workspaceId: input.workspaceId,
    userId: input.userId,
    commandType: COMMAND_TYPE,
    objectType: 'channel_connect_code',
    objectId: row.id,
    payloadSummary: {
      expires_in_seconds: TTL_MINUTES * 60,
    },
    result: 'success',
  });

  return {
    code,
    connectCodeId: row.id,
    workspaceId: input.workspaceId,
    expiresAt,
  };
}

/**
 * Test-internals: exposed so DB-backed tests can poke the boundary without
 * duplicating constants. `sql` import kept for future inline-SQL needs
 * (current implementation goes through Drizzle's query builder).
 */
export const _internals = { TTL_MINUTES, IDEMPOTENCY_TTL_HOURS, COMMAND_TYPE, sql };
