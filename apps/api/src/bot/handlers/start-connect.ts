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
  /**
   * Soft failure copy for the DB timeout path. Telegram /start updates have
   * a ~10s budget end-to-end; if `validateConnectCode` (2 SELECTs) doesn't
   * answer within 2s we surrender the validation step and tell the user to
   * retry. A retry storm under DB pressure would amplify load — the user-
   * facing copy keeps it generic so it works for any transient backend issue.
   */
  timeout: 'Что-то пошло не так. Попробуй позже.',
} as const;

/**
 * Hard ceiling on `validateConnectCode` round-trip time inside the bot
 * handler. Two DB SELECTs against a healthy pool finish in ~10-50ms; 2s is
 * an order of magnitude headroom that still leaves the /start handler well
 * inside Telegram's ~10s budget if the user-visible `ctx.reply` then takes
 * another second. Pool saturation or a slow Postgres would otherwise let
 * this handler hang for the full Telegram budget and trigger /start retries
 * that amplify load.
 */
const VALIDATE_CONNECT_CODE_TIMEOUT_MS = 2000;

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
  //
  // Bounded by `VALIDATE_CONNECT_CODE_TIMEOUT_MS`: pool saturation or a slow
  // PG instance would otherwise let this handler hang up to Telegram's full
  // ~10s /start budget; on the timeout path we surrender the validation step
  // and surface a generic Russian reply so the user can retry. The bot
  // handler itself must never throw — grammy's catch boundary above would
  // log the crash, but we'd lose the user-facing reply.
  // Tagged-object sentinel distinct from any real `validateConnectCode`
  // resolution so we can detect a timeout WITHOUT throwing — Promise.race
  // wins on this marker when the DB query takes too long, the marker is
  // checked, and the handler returns a generic Russian reply. Non-timeout
  // DB errors propagate up to bot.ts's per-/start try/catch (already wraps
  // `handleStartConnect`) so they reach the default-reply-and-log path,
  // distinct from this 2s surrender. We deliberately avoid rejecting the
  // timeout promise: rejection wins the race and we'd need to disambiguate
  // "timed out" from "DB exploded" by error-type sniffing — error-class
  // comparisons across async boundaries are brittle.
  type TimeoutMarker = { readonly __timeout: true };
  const TIMEOUT_SENTINEL: TimeoutMarker = { __timeout: true };
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<TimeoutMarker>((resolve) => {
    timeoutHandle = setTimeout(
      () => resolve(TIMEOUT_SENTINEL),
      VALIDATE_CONNECT_CODE_TIMEOUT_MS,
    );
  });
  let raceResult: Awaited<ReturnType<typeof validateConnectCode>> | TimeoutMarker;
  try {
    raceResult = await Promise.race([
      validateConnectCode(deps.db, code),
      timeoutPromise,
    ]);
  } finally {
    // Clear the timer regardless of which promise resolved first so the
    // event loop isn't held open by a pending 2s timer when the DB
    // resolved first.
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
  if ('__timeout' in raceResult) {
    deps.log?.warn(
      { telegramUserId: input.telegramUserId, timeoutMs: VALIDATE_CONNECT_CODE_TIMEOUT_MS },
      `[start-connect] validateConnectCode timed out after ${VALIDATE_CONNECT_CODE_TIMEOUT_MS}ms`,
    );
    await deps.reply(REPLY_COPY.timeout);
    return;
  }
  const result = raceResult;

  // Log on the result discriminator, NOT the plaintext code (Invariant 1).
  deps.log?.info(
    { telegramUserId: input.telegramUserId, validation: result.status },
    'start-connect code validated',
  );

  switch (result.status) {
    case 'ok':
      await deps.reply(REPLY_COPY.ok);
      return;
    case 'expired':
      await deps.reply(REPLY_COPY.expired);
      return;
    case 'consumed':
      await deps.reply(REPLY_COPY.consumed);
      return;
    case 'unknown':
      await deps.reply(REPLY_COPY.unknown);
      return;
  }
}

/** Exported for test assertions on exact copy. */
export const _replyCopy = REPLY_COPY;
