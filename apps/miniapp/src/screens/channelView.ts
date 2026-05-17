/**
 * Pure view-state model for ChannelScreen (Phase 2).
 *
 * Splitting the state-machine decision out of the React component keeps the
 * mapping from `GET /channels` -> rendered view unit-testable without
 * @testing-library or jsdom (this repo's miniapp tests are pure-logic only —
 * see screens/onboarding/__tests__/wizardSteps.test.ts for the pattern).
 *
 * The four views mirror the architecture doc's state machine
 * (architecture/channel-connection.md "Mini App: ChannelScreen.tsx"):
 *
 *   no items                                  -> not_connected
 *   item.status === 'pending'                 -> pending
 *   item.status === 'connected'               -> connected
 *   item.status === 'broken' | 'revoked'      -> broken
 *
 * The `pending` view is also reached transiently *after* a successful
 * `POST /channels/connect-codes` even when `GET /channels` hasn't refetched
 * yet, because the freshly issued code is only available in the POST response
 * — that's the `codeOverride` input.
 */

import type {
  ChannelListProjection,
  ChannelProjection,
  ConnectCodeProjection,
} from '../api/types.ts';

/**
 * Screen-local view-model for an in-memory connect code. Two legitimate
 * sources, distinguished by the `source` discriminant:
 *
 *   - `fresh-post`  — POST /channels/connect-codes response, contains the
 *                     full `ConnectCodeProjection` (id, code, deep_link,
 *                     expires_at).
 *   - `deep-link`   — code extracted from `?code=<…>` deep-link query; we
 *                     don't have expires_at/projection id here, only the
 *                     plaintext code. Don't pretend to be a real projection.
 *
 * Using a discriminated union avoids the previous "synthesise a fake
 * ConnectCodeProjection with id='deep-link'" pattern, which masqueraded as a
 * server type while violating ConnectCodeProjectionSchema's UUID constraint.
 */
export type PendingCodeViewModel =
  | { source: 'fresh-post'; projection: ConnectCodeProjection }
  | { source: 'deep-link'; code: string };

export type ChannelView =
  | { kind: 'not_connected' }
  | { kind: 'pending'; channel: ChannelProjection | null; code: PendingCodeViewModel | null }
  | { kind: 'connected'; channel: ChannelProjection }
  | { kind: 'broken'; channel: ChannelProjection };

export interface SelectChannelViewInput {
  /** Latest `GET /channels` payload, or null while the query is loading. */
  channels: ChannelListProjection | null;
  /**
   * Freshly issued code from `POST /channels/connect-codes`, or a code
   * extracted from a deep-link query param. The plaintext code is never
   * re-served by `GET /channels`, so the screen has to remember it locally.
   */
  codeOverride: PendingCodeViewModel | null;
}

/**
 * Maps the channel-list + freshly-issued-code inputs to the view that
 * ChannelScreen should render.
 *
 * Ordering rules:
 *   1. A freshly-issued `codeOverride` always shows PendingView — even if
 *      `channels` is still empty (the connection row is created only after a
 *      successful `POST /channels/connect`, so right after code creation the
 *      list is legitimately empty).
 *   2. The first non-revoked item drives the view. We intentionally do NOT
 *      filter out revoked items in Phase 2 — `revoked` is reserved for Phase 9
 *      and would surface as BrokenView (same shape) if it ever leaked back.
 */
export function selectChannelView(input: SelectChannelViewInput): ChannelView {
  const firstChannel = input.channels?.items[0] ?? null;

  if (input.codeOverride && (!firstChannel || firstChannel.status === 'pending')) {
    return { kind: 'pending', channel: firstChannel, code: input.codeOverride };
  }

  if (!firstChannel) {
    return { kind: 'not_connected' };
  }

  switch (firstChannel.status) {
    case 'pending':
      return { kind: 'pending', channel: firstChannel, code: input.codeOverride };
    case 'connected':
      return { kind: 'connected', channel: firstChannel };
    case 'broken':
    case 'revoked':
      return { kind: 'broken', channel: firstChannel };
  }
}

/**
 * Reads the connect-code from the current URL's `?code=` query param.
 *
 * The Mini App deep-link `?startapp=connect_<code>` is normalised by
 * `routing/routes.ts` to `/channel?code=<code>` *before* the first React
 * render, so by the time ChannelScreen mounts the code lives on the location
 * search string. We re-parse it here (instead of accepting it through router
 * state) because wouter's location does not synchronously expose search and
 * we want the value available on the first paint.
 *
 * `URLSearchParams` lifts the URL-decode + sanitisation; an out-of-range
 * input is treated as "no code" rather than thrown. Pure function so the
 * component stays trivial to test.
 */
export function parseConnectCodeFromSearch(search: string): string | null {
  if (!search) return null;
  const normalized = search.startsWith('?') ? search.slice(1) : search;
  if (!normalized) return null;
  try {
    const params = new URLSearchParams(normalized);
    const code = params.get('code');
    if (!code) return null;
    // Mirror routing/routes.ts MAX_DEEP_LINK_ID_LENGTH — defence against the
    // user navigating directly to /channel?code=<huge string>.
    if (code.length > 64) return null;
    return code;
  } catch {
    return null;
  }
}

/**
 * Maps a `ChannelApiError.code` to the inline-banner copy ChannelScreen renders
 * after a failed `POST /channels/connect`.
 *
 * Returns `null` for codes that the screen handles via a different UI affordance
 * (e.g. `expired_code` / `reused_code` swap the banner for a "Создать новый
 * код" action button — the screen owns that branch) or for unknown codes (the
 * screen falls back to the global ErrorState / a generic Snackbar).
 */
export interface ChannelErrorCopy {
  header: string;
  description: string;
}

export function channelErrorCopy(code: string | undefined): ChannelErrorCopy | null {
  switch (code) {
    case 'bot_not_admin':
      return {
        header: 'Бот не админ',
        description: 'Сделай бота администратором канала и попробуй снова.',
      };
    case 'missing_post_permission':
      return {
        header: 'Нет права постить',
        description: 'Включи «Posting» в правах бота в настройках канала.',
      };
    case 'chat_not_found':
      return {
        header: 'Канал не найден',
        description: 'Проверь @username канала или chat_id и попробуй снова.',
      };
    case 'channel_taken':
      return {
        header: 'Канал занят',
        description: 'Этот канал уже подключён к другому workspace.',
      };
    case 'bot_blocked':
      return {
        header: 'Бот заблокирован',
        description: 'Канал заблокировал бота. Разблокируй и попробуй снова.',
      };
    case 'unauthorized':
      return {
        header: 'Нет доступа',
        description: 'Бот не авторизован для этого канала.',
      };
    default:
      return null;
  }
}

/**
 * True when the error code indicates the current connect code is dead and the
 * screen should swap the "Подключить" affordance for "Создать новый код".
 */
export function isDeadCodeError(code: string | undefined): boolean {
  return code === 'expired_code' || code === 'reused_code';
}

/**
 * Human-readable copy for the verify-status badge on BrokenView (§7). Falls
 * back to a generic message when the server hasn't recorded a known status.
 */
export function verifyStatusCopy(status: string | null): string {
  switch (status) {
    case 'bot_not_admin':
      return 'Бот больше не админ в канале';
    case 'missing_post_permission':
      return 'У бота отозвано право постить';
    case 'chat_not_found':
      return 'Канал не найден (удалён или переименован)';
    case 'bot_blocked':
      return 'Бот заблокирован каналом';
    case 'unauthorized':
      return 'Бот не авторизован для канала';
    case 'network':
      return 'Не удалось связаться с Telegram';
    case 'unknown':
    case null:
      return 'Подключение перестало работать';
    case 'ok':
      // Shouldn't end up on BrokenView with status='ok' but copy is safe.
      return 'Подключение временно недоступно';
    default:
      return 'Подключение перестало работать';
  }
}
