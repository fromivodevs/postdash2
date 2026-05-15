/**
 * Bot-side `/start connect_<code>` handler.
 *
 * Phase 2 design (architecture/channel-connection.md Decision: "bot
 * /start connect_<code> validates code, but channel binding still happens in
 * Mini App"): the bot does NOT call `connectTelegramChannel`. The deep-link
 * payload arrives in a PRIVATE chat between the user and the bot — there is
 * no channel `chat_id` here, so a one-shot connect from the bot is
 * impossible. Instead this handler:
 *
 *   1. Validates the code via `validateConnectCode(db, code)` (read-only;
 *      does NOT consume).
 *   2. Replies with a short Russian message tuned to the validation result
 *      (active / expired / consumed / unknown).
 *
 * The Mini App's `ChannelScreen` carries the actual binding flow. The bot's
 * `START_MESSAGE` already includes an inline "Open dashboard" button that
 * forwards the user back into the Mini App with `?startapp=connect_<code>`.
 *
 * Logging: NEVER log the plaintext code (architecture doc Invariant 1).
 * `telegramUserId` and the validation result are safe and useful for
 * operators tracing a failed connect.
 */

import type { Database } from '@postdash/db';
import { validateConnectCode } from '@postdash/commands';
import type { BotLogger } from '../bot.js';

export interface StartConnectDeps {
  db: Database;
  /**
   * Reply hook. In production this is bound to the grammy Context's `ctx.reply`;
   * tests inject a vi.fn() to assert exact copy without a real bot.
   */
  reply: (text: string) => Promise<void>;
  /** Optional logger; falls back to silent. Tests can inject and assert. */
  log?: BotLogger;
}

export interface StartConnectInput {
  /** Plaintext code from the `/start connect_<code>` payload. */
  code: string;
  /** Telegram user id of the bot DM sender. Logged for forensics. */
  telegramUserId: number;
}

/**
 * Stable copy table. Russian text kept inline (not externalized into i18n
 * yet — Phase 2 is single-locale) so a code reviewer can see the exact
 * wording without chasing a JSON. The tests assert on these literals.
 */
const REPLY_COPY = {
  ok: 'Код принят. Открой Mini App и введи @username канала.',
  expired: 'Код истёк. Создай новый в Mini App.',
  consumed: 'Этот код уже использован.',
  unknown: 'Код не найден.',
  empty: 'Код не указан. Открой Mini App и создай новый.',
} as const;

export async function handleStartConnect(
  deps: StartConnectDeps,
  input: StartConnectInput,
): Promise<void> {
  // Trim and short-circuit on empty payload. A `/start connect_` without a
  // code is a degenerate deep-link (likely truncation); we surface a soft
  // "create a new one" hint rather than passing an empty string into
  // `validateConnectCode` (which would hash to a deterministic-empty-string
  // digest and return 'not_found' — same outcome, more confusing log).
  const code = input.code.trim();
  if (!code) {
    deps.log?.warn(
      { telegramUserId: input.telegramUserId },
      'start-connect received empty code payload',
    );
    await deps.reply(REPLY_COPY.empty);
    return;
  }

  // Read-only existence check. Does NOT consume the code — the real
  // redemption happens later via POST /channels/connect from the Mini App.
  // This is the "Phase 2 acts as validator only" path in the architecture
  // doc Data flow §B.
  const status = await validateConnectCode(deps.db, code);

  // Log on the result discriminator, NOT the plaintext code (Invariant 1).
  deps.log?.info(
    { telegramUserId: input.telegramUserId, validation: status },
    'start-connect code validated',
  );

  switch (status) {
    case 'ok':
      await deps.reply(REPLY_COPY.ok);
      return;
    case 'expired':
      await deps.reply(REPLY_COPY.expired);
      return;
    case 'consumed':
      await deps.reply(REPLY_COPY.consumed);
      return;
    case 'not_found':
      await deps.reply(REPLY_COPY.unknown);
      return;
  }
}

/** Exported for test assertions on exact copy. */
export const _replyCopy = REPLY_COPY;
