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
 * (0/O, 1/I/L). 31 symbols — one short of a power of two.
 *
 * Deliberate: I/L/U are also commonly excluded in Crockford to avoid spelling
 * profanity by accident; we include U here because the UX risk is low for
 * 8-char codes and excluding U too would drop the alphabet to 30 (further
 * from a power of two, not closer).
 *
 * Distribution note: an earlier revision padded this to 32 chars with an
 * extra 'R' so a flat `byte % 32` mapping worked, but that doubled the
 * frequency of 'R'. The current generator uses rejection sampling against
 * the 31-symbol alphabet so every character is exactly equiprobable.
 */
const CROCKFORD_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
/**
 * Largest multiple of 31 that fits in a byte (31 * 8 = 248). Bytes >= 248
 * are rejected to keep the modulo unbiased. Acceptance rate: 248/256 ≈
 * 96.9% — every 8th byte on average is re-rolled, which is cheap.
 */
const ACCEPT_CEIL = 248;

/**
 * Generates an 8-character connect code. ~40 bits of entropy
 * (log2(31^8) ≈ 39.6 bits — close enough to the documented 40-bit target).
 *
 * Implementation: stream random bytes from `node:crypto.randomBytes` (CSPRNG)
 * and rejection-sample against a 31-symbol Crockford alphabet. Rejection is
 * mandatory because 256 is not a multiple of 31 — a plain `byte % 31` mapping
 * would over-represent the first 8 symbols (`2..9`) by ~1/31. We oversize
 * the initial draw to keep the expected number of random reads at 1.
 */
export function generateConnectCode(): string {
  let out = '';
  // 16 bytes is ~2x the expected need (acceptance rate ~96.9%); covers 8
  // accepted bytes with overwhelming probability in a single CSPRNG call.
  let pool = randomBytes(16);
  let cursor = 0;
  while (out.length < 8) {
    if (cursor >= pool.length) {
      // Extremely unlikely (>16 rejects in a row): top up the pool.
      pool = randomBytes(16);
      cursor = 0;
    }
    const b = pool[cursor] ?? 0;
    cursor += 1;
    if (b >= ACCEPT_CEIL) continue; // reject to avoid modulo bias
    const idx = Math.floor(b / 8); // b in [0,248) -> idx in [0,31)
    // CROCKFORD_ALPHABET has length 31; idx is bounded by construction.
    out += CROCKFORD_ALPHABET.charAt(idx);
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

export const _testInternals = { CROCKFORD_ALPHABET };
