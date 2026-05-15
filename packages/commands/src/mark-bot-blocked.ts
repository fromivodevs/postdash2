/**
 * Side-effect command: mark a telegram_identities row as blocked_bot.
 *
 * The bot module fires this on `my_chat_member` updates where the new chat
 * member status is `'kicked'` in the private chat with the user — i.e. the
 * user blocked the bot. We deliberately do NOT fire on `'left'` (that's the
 * bot itself leaving, which doesn't happen for private chats anyway).
 *
 * Cleared automatically the next time the same user calls /auth/telegram —
 * see `authenticateTelegram` in this package.
 *
 * Not wrapped in `runIdempotent`: this command is *naturally* idempotent.
 * The UPDATE's WHERE clause excludes rows already in `blocked_bot` (and
 * `revoked`), so a redelivered `my_chat_member` webhook matches 0 rows on the
 * second hit and writes neither a status change nor an operation_log entry.
 * An idempotency slot would add a table row and a failure mode for no gain.
 */

import { and, eq, ne } from 'drizzle-orm';
import type { Database } from '@postdash/db';
import { operationLog, telegramIdentities } from '@postdash/db';
import { CommandError } from './errors.js';

const COMMAND_TYPE = 'MarkBotBlocked';

export interface MarkBotBlockedInput {
  telegramUserId: number;
}

export async function markBotBlocked(
  db: Database,
  input: MarkBotBlockedInput,
): Promise<{ updated: boolean }> {
  if (!Number.isSafeInteger(input.telegramUserId)) {
    throw new CommandError('validation_failed', 'telegramUserId is not a safe integer');
  }
  const telegramUserId = BigInt(input.telegramUserId);

  return db.transaction(async (tx) => {
    // Filter by status so:
    //   (a) a 'revoked' identity is never downgraded to soft-state blocked_bot
    //       (admin kill-switch invariant), and
    //   (b) an already-'blocked_bot' row is a no-op on Telegram webhook
    //       redelivery — UPDATE returns 0 rows, no audit churn.
    // lastSeenAt is NOT bumped here: a 'kicked' event is not a positive
    // presence signal, and conflating event-time with last-active would
    // mislead admin queries. operation_log.created_at is the canonical
    // timestamp for the state-change event.
    const updated = await tx
      .update(telegramIdentities)
      .set({ status: 'blocked_bot' })
      .where(
        and(
          eq(telegramIdentities.telegramUserId, telegramUserId),
          ne(telegramIdentities.status, 'revoked'),
          ne(telegramIdentities.status, 'blocked_bot'),
        ),
      )
      .returning({ id: telegramIdentities.id, userId: telegramIdentities.userId });
    const row = updated[0];
    if (!row) {
      return { updated: false };
    }
    await tx.insert(operationLog).values({
      userId: row.userId,
      telegramUserId,
      commandType: COMMAND_TYPE,
      objectType: 'telegram_identity',
      objectId: row.id,
      payloadSummary: { newStatus: 'blocked_bot' },
      result: 'success',
    });
    return { updated: true };
  });
}
