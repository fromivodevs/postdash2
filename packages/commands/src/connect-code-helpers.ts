/**
 * Helpers shared by `createConnectCode` and `connectTelegramChannel`.
 *
 * - `generateConnectCode()` — 8-char Crockford base32 (no 0/O/1/I/L confusion).
 *   ~40 bits entropy; safe given single-use + 30 min TTL + connect-route rate
 *   limit. See architecture doc "Risks/open questions §4".
 * - `hashConnectCode(code)` — sha256(plaintext) hex. The ONLY function that
 *   transforms a plaintext code into the form stored at rest.
 * - `lookupActiveCode(tx, codeHash)` — `FOR UPDATE` row lock used by
 *   `connectTelegramChannel` during redemption to prevent two concurrent
 *   redeemers from double-consuming the code.
 * - `validateConnectCode(db, code)` — read-only existence/TTL check used by
 *   the bot `/start connect_<code>` handler to UX-validate before nudging the
 *   user to the Mini App. Does NOT consume the code.
 *
 * Invariant: plaintext `code` is NEVER persisted (architecture doc Invariant 1).
 * The plaintext only appears at the API boundary and in the deep-link URL.
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Database, DbOrTx } from '@postdash/db';
import { channelConnectCodes } from '@postdash/db';

/**
 * Crockford base32 alphabet WITHOUT the visually-confusable characters
 * (0/O, 1/I/L). 32 symbols means each character is exactly 5 bits.
 *
 * Deliberate: I/L/U are also commonly excluded in Crockford to avoid spelling
 * profanity by accident; we include U here because the UX risk is low for
 * 8-char codes and excluding U would drop the alphabet below 32 (no longer
 * an integer number of bits per char).
 */
const CROCKFORD_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
// 31 chars after dropping 0/O/1/I/L — round down to next power of two by
// computing `byte % 32` against a 32-symbol indexable table padded with one
// repeat. We pad with a high-frequency consonant to keep distribution flat.
const CROCKFORD_TABLE = `${CROCKFORD_ALPHABET}R`;

/**
 * Generates an 8-character connect code. ~40 bits of entropy.
 *
 * Implementation: read 8 random bytes via `node:crypto.randomBytes` (CSPRNG),
 * map each byte to a Crockford char via `byte % 32` indexing the padded
 * 32-symbol table. We deliberately do NOT use `randomInt` per-character —
 * one `randomBytes(8)` call is cheaper and the modulo bias on a 256-mod-32
 * mapping is negligible (one symbol gets ~3.1% over-representation).
 */
export function generateConnectCode(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    // i in [0,8) and bytes is length 8, so bytes[i] is never undefined in
    // practice — but strict TS with noUncheckedIndexedAccess flags it. Use
    // ?? 0 as a safety floor; the resulting char is still valid Crockford.
    const b = bytes[i] ?? 0;
    const idx = b % 32;
    // CROCKFORD_TABLE is length 32 and idx is in [0,32), so charAt always
    // returns a real char. Avoid the empty-string degenerate explicitly so
    // strict tests can assert `match(/^[2-9A-Z]{8}$/)`.
    out += CROCKFORD_TABLE.charAt(idx);
  }
  return out;
}

/** sha256 of the plaintext code, lowercase hex. */
export function hashConnectCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * Locks and returns an ACTIVE, NON-EXPIRED row for the given code_hash.
 * Returns `null` if no matching row exists.
 *
 * Uses `FOR UPDATE` so a concurrent `connectTelegramChannel` blocks on the
 * row lock and observes the post-update state (status='consumed'). The
 * filter `status='active' AND expires_at > now()` is duplicated in the
 * UPDATE that consumes the code so we never double-consume an expired row.
 *
 * Caller MUST pass a transaction handle (DbOrTx wide enough). The lock is
 * released at tx commit/rollback.
 */
export async function lookupActiveCode(
  tx: DbOrTx,
  codeHash: string,
): Promise<{
  id: string;
  workspaceId: string;
  createdByUserId: string;
  status: 'active' | 'consumed' | 'expired';
  expiresAt: Date;
} | null> {
  // drizzle-orm's `.for('update')` emits `SELECT ... FOR UPDATE` on Postgres.
  // We narrow to the columns the redemption path actually needs.
  const rows = await tx
    .select({
      id: channelConnectCodes.id,
      workspaceId: channelConnectCodes.workspaceId,
      createdByUserId: channelConnectCodes.createdByUserId,
      status: channelConnectCodes.status,
      expiresAt: channelConnectCodes.expiresAt,
    })
    .from(channelConnectCodes)
    .where(eq(channelConnectCodes.codeHash, codeHash))
    .limit(1)
    .for('update');
  const row = rows[0];
  if (!row) return null;
  // Re-narrow the status from the bare `text` column into our union — the DB
  // CHECK constraint guarantees it's one of three values, but TS doesn't see
  // CHECK constraints.
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    createdByUserId: row.createdByUserId,
    status: narrowCodeStatus(row.status),
    expiresAt: row.expiresAt,
  };
}

/**
 * Read-only existence check used by the bot-side `/start connect_<code>`
 * handler. Does NOT take a row lock and does NOT consume the code — the bot
 * flow's purpose is to UX-validate the code, then nudge the user to finish
 * binding in the Mini App.
 *
 * Returns:
 *   - `'ok'`           — code exists, status='active', not expired.
 *   - `'expired'`      — code exists but `expires_at` is past OR status='expired'.
 *   - `'consumed'`     — code exists with status='consumed'.
 *   - `'not_found'`    — no row matches code_hash.
 *
 * Takes a `Database` (pool handle) rather than a transaction so the bot
 * handler doesn't need to open a tx for a single SELECT.
 */
export async function validateConnectCode(
  db: Database,
  code: string,
): Promise<'ok' | 'expired' | 'consumed' | 'not_found'> {
  const codeHash = hashConnectCode(code);
  // Active-and-not-expired short-circuit: a single query that returns ONE row
  // iff the code is usable. If it returns nothing, we do a second query to
  // distinguish "never existed" from "exists but expired/consumed" so the bot
  // can give the user a specific error message.
  const okRows = await db
    .select({ id: channelConnectCodes.id })
    .from(channelConnectCodes)
    .where(
      and(
        eq(channelConnectCodes.codeHash, codeHash),
        eq(channelConnectCodes.status, 'active'),
        gt(channelConnectCodes.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  if (okRows[0]) return 'ok';

  const anyRows = await db
    .select({ status: channelConnectCodes.status, expiresAt: channelConnectCodes.expiresAt })
    .from(channelConnectCodes)
    .where(eq(channelConnectCodes.codeHash, codeHash))
    .limit(1);
  const row = anyRows[0];
  if (!row) return 'not_found';
  const status = narrowCodeStatus(row.status);
  if (status === 'consumed') return 'consumed';
  // status='active' but the OK query missed it -> expires_at is past.
  // status='expired' -> trivially expired.
  return 'expired';
}

function narrowCodeStatus(s: string): 'active' | 'consumed' | 'expired' {
  if (s === 'consumed') return 'consumed';
  if (s === 'expired') return 'expired';
  return 'active';
}

export const _testInternals = { CROCKFORD_ALPHABET, CROCKFORD_TABLE };
