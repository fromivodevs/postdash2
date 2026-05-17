/**
 * Idempotency wrapper for critical commands (Rule 10 in
 * tg_mvp_plan/02-ARCHITECTURE.md).
 *
 * Usage:
 *   const result = await runIdempotent(tx, {
 *     commandType: 'AuthenticateTelegram',
 *     idempotencyKey,
 *     ttlHours: 24,
 *   }, async () => doTheWork());
 *
 * Behaviour:
 * - First call with a given (commandType, idempotencyKey) acquires a row in
 *   command_idempotency with status='pending' (via ON CONFLICT DO NOTHING).
 *   If insert succeeds, we open ONE transaction and run work.execute(tx) +
 *   the status='success' UPDATE inside it, so the business rows, any
 *   operation_log entry the work writes, and the slot transition all commit
 *   atomically. On work() error we DELETE the row so a retry can re-acquire
 *   the slot — the actual error still propagates.
 * - Subsequent calls with the same key see the row exists. If status='success',
 *   we return the cached pointer. If status='pending', we surface
 *   idempotency_replay_in_progress unless the slot has aged past expires_at
 *   (the original holder crashed) — in that case we reclaim and retry once.
 *   There is no 'failed' status: a failed work() DELETEs its slot so a retry
 *   re-acquires cleanly. The only persisted states are 'pending' and 'success'.
 *
 * Pool-not-tx contract: `db` MUST be a pool Database, NOT a transaction handle.
 * The slot-acquire INSERT and the failure-path DELETE rely on autocommit — each
 * must commit independently of the work transaction. Passing a tx handle breaks
 * the crash-safety contract: the slot INSERT would not be independently
 * committed, so a crash could leave no slot at all (or a slot that rolls back
 * with the work), defeating the whole idempotency guarantee. The two types are
 * structurally similar enough that a runtime assertion is unreliable — callers
 * must honour this by construction.
 *
 * Crash-safety contract: because the success-UPDATE shares the work's
 * transaction, a process death between "work committed" and "slot marked
 * success" is impossible — either both commit or neither does. A crash leaves
 * the slot 'pending' AND zero business/operation_log rows, so a PENDING_TTL
 * reclaim is a genuinely fresh run with no duplicate operation_log entry.
 */

import { and, eq } from 'drizzle-orm';
import type { Database, DbOrTx } from '@postdash/db';
import { commandIdempotency } from '@postdash/db';
import { CommandError } from './errors.js';

export interface IdempotencyContext {
  commandType: string;
  idempotencyKey: string;
  workspaceId?: string | null;
  userId?: string | null;
  ttlHours?: number;
}

export interface IdempotentResult<T> {
  /** Was this a cache hit (replayed result) or fresh execution? */
  replayed: boolean;
  /** Result of work(). On replay this is reconstructed from the cached pointer. */
  result: T;
}

export interface IdempotentWork<T> {
  /**
   * Actually do the work. Receives the transaction handle that also carries
   * the slot's success-UPDATE — all DB writes the work performs MUST go
   * through this `tx` so they commit atomically with the slot transition.
   * Return { object_type, object_id, result }.
   *
   * The optional `metadata` shape lets a command surface the workspace/user
   * it ultimately acted on AFTER the in-tx lookups that resolve them (e.g.
   * `connectTelegramChannel` reads `workspaceId` from the connect-code row,
   * not from the input). When provided, those values are written to the
   * slot's pending->success UPDATE so the row carries accurate forensic
   * correlation. NOT a security control on its own (the route layer enforces
   * the caller-vs-actual workspace check) — purely audit metadata.
   */
  execute(tx: DbOrTx): Promise<{
    objectType: string;
    objectId: string;
    result: T;
    metadata?: {
      workspaceId?: string | null;
      userId?: string | null;
    };
  }>;
  /** Reconstruct T from a cached (object_type, object_id) pointer on replay. */
  loadFromPointer(pointer: { objectType: string; objectId: string }): Promise<T>;
}

const DEFAULT_TTL_HOURS = 24;
const MAX_RECLAIM_DEPTH = 1;

/**
 * Idempotency keys for the Telegram auth path are `tma:<64-char-hash>` — a
 * session-bound credential derived from initData. CommandError messages built
 * here reach server logs via `req.log.warn({ err })`, so the full key must
 * never be interpolated raw. This renders a log-safe label: commandType plus a
 * short prefix of the key, with the rest elided. The full key still goes to the
 * DB row (dedup needs it) — only the human-readable message is truncated.
 */
function commandLabel(ctx: IdempotencyContext): string {
  const key = ctx.idempotencyKey;
  const KEEP = 8;
  const shown = key.length > KEEP ? `${key.slice(0, KEEP)}…` : key;
  return `${ctx.commandType}:${shown}`;
}
/**
 * A freshly-acquired 'pending' slot expires fast. work() here is a single
 * sub-second DB transaction; 120s is a generous safety margin. The point is
 * that if the process dies between the work-transaction commit and the
 * status='success' UPDATE, the stuck 'pending' row is reclaimable in ~2min
 * instead of bricking the idempotency key for the full 24h success-TTL.
 * On success we extend expiresAt out to the full TTL.
 */
const PENDING_TTL_SEC = 120;

export function runIdempotent<T>(
  // `db` MUST be a pool `Database`, never a transaction handle — see the
  // "Pool-not-tx contract" section in this module's doc-comment. This is a
  // deliberately doc-enforced (not type-enforced) contract: branding the
  // Drizzle `Database` type to make a tx handle a compile error would have to
  // propagate a phantom tag through every `@postdash/db` query-builder type,
  // which is disproportionately invasive for a single-caller invariant. The
  // one caller (`authenticateTelegram`) honours it by construction.
  db: Database,
  ctx: IdempotencyContext,
  work: IdempotentWork<T>,
): Promise<IdempotentResult<T>> {
  return runIdempotentInternal(db, ctx, work, 0);
}

async function runIdempotentInternal<T>(
  db: Database,
  ctx: IdempotencyContext,
  work: IdempotentWork<T>,
  reclaimDepth: number,
): Promise<IdempotentResult<T>> {
  const ttlHours = ctx.ttlHours ?? DEFAULT_TTL_HOURS;
  const pendingExpiresAt = new Date(Date.now() + PENDING_TTL_SEC * 1000);

  // Try to acquire the slot atomically.
  const inserted = await db
    .insert(commandIdempotency)
    .values({
      commandType: ctx.commandType,
      idempotencyKey: ctx.idempotencyKey,
      workspaceId: ctx.workspaceId ?? null,
      userId: ctx.userId ?? null,
      status: 'pending',
      expiresAt: pendingExpiresAt,
    })
    .onConflictDoNothing({
      target: [commandIdempotency.commandType, commandIdempotency.idempotencyKey],
    })
    .returning({ id: commandIdempotency.id });

  const ownedRow = inserted[0];
  const ownsSlot = ownedRow !== undefined;

  if (!ownsSlot) {
    const existingRows = await db
      .select()
      .from(commandIdempotency)
      .where(
        and(
          eq(commandIdempotency.commandType, ctx.commandType),
          eq(commandIdempotency.idempotencyKey, ctx.idempotencyKey),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (!existing) {
      throw new CommandError('internal', 'idempotency row vanished after ON CONFLICT DO NOTHING');
    }

    if (existing.status === 'pending') {
      // If the original holder crashed before writing 'success' or DELETEing,
      // the row stays 'pending' until expires_at. Past that point reclaim it
      // so a recovered client isn't bricked for the rest of the TTL window.
      const expiresAtMs = new Date(existing.expiresAt).getTime();
      if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
        if (reclaimDepth >= MAX_RECLAIM_DEPTH) {
          throw new CommandError(
            'internal',
            `idempotency reclaim depth exceeded for ${ctx.commandType}`,
          );
        }
        // Filter by row id AND status so a racer that just flipped this row
        // to 'success' (or a successor that re-inserted) is not clobbered.
        await db
          .delete(commandIdempotency)
          .where(
            and(eq(commandIdempotency.id, existing.id), eq(commandIdempotency.status, 'pending')),
          );
        return runIdempotentInternal(db, ctx, work, reclaimDepth + 1);
      }
      throw new CommandError(
        'idempotency_replay_in_progress',
        `another caller is processing ${commandLabel(ctx)}`,
      );
    }
    // status === 'success' — the only other persisted state.
    if (!existing.resultObjectType || !existing.resultObjectId) {
      throw new CommandError('internal', `idempotency row marked success but pointer is missing`);
    }
    const result = await work.loadFromPointer({
      objectType: existing.resultObjectType,
      objectId: existing.resultObjectId,
    });
    return { replayed: true, result };
  }

  // We own the slot. Run the work AND the success-UPDATE inside ONE
  // transaction: the business rows, any operation_log entry the work writes,
  // and the slot's pending->success transition all commit atomically. A crash
  // mid-transaction rolls everything back, leaving the slot 'pending' with no
  // business/operation_log rows — a PENDING_TTL reclaim then re-runs the work
  // genuinely fresh, so there is never a duplicate operation_log row.
  //
  // All slot reads/writes filter on the row id we just inserted, so a
  // concurrent caller that reclaimed an expired pending row (or wrote a fresh
  // success) can never be clobbered by our success-UPDATE or failure-DELETE.
  const ownedId = ownedRow.id;
  try {
    const out = await db.transaction(async (tx) => {
      const result = await work.execute(tx);
      // Also filter on status='pending' so an UPDATE to 'success' that races
      // against a successor reclaiming our expired pending row reports the
      // affected rowcount. If 0 rows match, the slot was reclaimed underneath
      // us — we throw INSIDE the transaction so the work's writes roll back
      // too: nothing must commit under a slot we no longer own. On success we
      // extend expires_at from the short PENDING_TTL out to the full
      // success-TTL so the cached result survives for replay.
      // Backfill workspace_id / user_id on the slot row from execute()'s
      // metadata when present. The row already received whatever was passed in
      // `ctx` at INSERT time; execute() may surface a more accurate value once
      // in-tx lookups have run (e.g. connect-code -> workspaceId). The UPDATE
      // is unconditional on the metadata fields so a command that only learns
      // these in-tx can still record them — Drizzle's `.set()` omits undefined
      // keys, so leaving metadata absent is a true no-op.
      const slotPatch: {
        status: 'success';
        resultObjectType: string;
        resultObjectId: string;
        expiresAt: Date;
        workspaceId?: string | null;
        userId?: string | null;
      } = {
        status: 'success',
        resultObjectType: result.objectType,
        resultObjectId: result.objectId,
        expiresAt: new Date(Date.now() + ttlHours * 3_600_000),
      };
      if (result.metadata?.workspaceId !== undefined) {
        slotPatch.workspaceId = result.metadata.workspaceId;
      }
      if (result.metadata?.userId !== undefined) {
        slotPatch.userId = result.metadata.userId;
      }
      const updated = await tx
        .update(commandIdempotency)
        .set(slotPatch)
        .where(and(eq(commandIdempotency.id, ownedId), eq(commandIdempotency.status, 'pending')))
        .returning({ id: commandIdempotency.id });
      if (updated.length === 0) {
        throw new CommandError(
          'conflict',
          `idempotency slot was reclaimed during execution for ${ctx.commandType}`,
        );
      }
      return result;
    });
    return { replayed: false, result: out.result };
  } catch (err) {
    // Release the slot on failure so a retry can re-acquire it immediately.
    // The cleanup itself must never replace the original error — swallow any
    // DB hiccup during DELETE and surface the underlying CommandError/work
    // exception instead. Filter on `id` so a successor that already reclaimed
    // our expired slot and wrote a new row is left untouched.
    try {
      await db.delete(commandIdempotency).where(eq(commandIdempotency.id, ownedId));
    } catch {
      // Slot cleanup failed; the row will expire at its short PENDING_TTL
      // (~2min) or be reclaimed by the pending-past-expires_at path next call.
    }
    throw err;
  }
}

export const _testUtils = { DEFAULT_TTL_HOURS, MAX_RECLAIM_DEPTH, PENDING_TTL_SEC };
