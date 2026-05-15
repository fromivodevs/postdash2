/**
 * Maps API failures to user-friendly Russian copy (§7).
 *
 * Hard rule from §7: never dump a raw `error.message` at the user. Every error
 * surfaced in the UI goes through this function, which turns an ApiError.code
 * (or a bare network failure) into a calm, actionable sentence.
 *
 * Pure function — no React, fully unit-testable. The ErrorState component and
 * any inline banner consume the result.
 */

import { ApiError } from '../../api/client.ts';

export interface ErrorCopy {
  /** Short heading for the full-screen ErrorState. */
  title: string;
  /** One- or two-sentence explanation. Never contains technical detail. */
  description: string;
  /** Whether a retry button makes sense (transient vs. terminal). */
  retryable: boolean;
}

/*
 * Keyed on the REAL `code` vocabulary the API emits in `{ error, code, message }`:
 *
 *   TelegramInitDataError: missing_hash, missing_user, missing_auth_date,
 *                          invalid_hash, expired, future_auth_date, parse_error
 *   route config:          bot_token_missing, db_unavailable
 *   missing auth:          missing_authorization
 *   CommandError:          validation_failed, idempotency_replay_in_progress,
 *                          not_found, forbidden, conflict, internal
 *
 * Codes are grouped by what the user can actually do about them — most of the
 * initData-integrity codes share one "reopen the app" message.
 */

/** initData failed integrity/shape checks — the launch payload is unusable. */
const SESSION_INVALID: ErrorCopy = {
  title: 'Сессия Telegram недействительна',
  description: 'Переоткрой приложение через Telegram-бота, чтобы продолжить.',
  retryable: false,
};

/** initData is structurally fine but too old (or clock-skewed into the future). */
const SESSION_EXPIRED: ErrorCopy = {
  title: 'Сессия устарела',
  description: 'Переоткрой приложение через Telegram-бота — данные входа устарели.',
  retryable: false,
};

/** Server-side fault the user cannot fix — retry later. */
const TECH_FAILURE: ErrorCopy = {
  title: 'Технический сбой',
  description: 'Что-то сломалось на нашей стороне. Попробуй позже.',
  retryable: true,
};

/** No Authorization header (or app opened outside Telegram). */
const AUTH_MISSING: ErrorCopy = {
  title: 'Открой через Telegram',
  description: 'Это приложение работает только внутри Telegram-бота.',
  retryable: false,
};

const BY_CODE: Record<string, ErrorCopy> = {
  // TelegramInitDataError — integrity/shape failures.
  missing_hash: SESSION_INVALID,
  missing_user: SESSION_INVALID,
  missing_auth_date: SESSION_INVALID,
  invalid_hash: SESSION_INVALID,
  parse_error: SESSION_INVALID,
  // TelegramInitDataError — staleness.
  expired: SESSION_EXPIRED,
  future_auth_date: SESSION_EXPIRED,

  // Route config / infrastructure faults.
  bot_token_missing: TECH_FAILURE,
  db_unavailable: TECH_FAILURE,

  // Missing Authorization header — open the app through the bot.
  missing_authorization: AUTH_MISSING,

  // CommandError (sanitized).
  validation_failed: {
    title: 'Проверь введённые данные',
    description: 'Что-то заполнено неверно. Поправь и попробуй ещё раз.',
    retryable: false,
  },
  idempotency_replay_in_progress: {
    title: 'Запрос ещё обрабатывается',
    description: 'Подожди пару секунд — мы заканчиваем предыдущую операцию.',
    retryable: true,
  },
  // `not_found` on /me is expected and handled by the POST fallback, so it
  // rarely reaches the UI; the copy here is the safety net if it ever does.
  not_found: {
    title: 'Не найдено',
    description: 'Мы не смогли найти то, что ты открываешь. Попробуй вернуться назад.',
    retryable: false,
  },
  forbidden: {
    title: 'Доступ ограничен',
    description: 'У тебя нет прав на это действие. Обратись к владельцу команды.',
    retryable: false,
  },
  conflict: {
    title: 'Конфликт изменений',
    description: 'Кто-то уже изменил эти данные. Обнови экран и попробуй снова.',
    retryable: true,
  },
  internal: TECH_FAILURE,
};

const HTTP_STATUS_FALLBACK: ErrorCopy = {
  title: 'Что-то пошло не так',
  description: 'Сервер вернул ошибку. Попробуй ещё раз через минуту.',
  retryable: true,
};

const SERVER_FALLBACK: ErrorCopy = {
  title: 'Сервис временно недоступен',
  description: 'Мы уже знаем о проблеме. Попробуй обновить через пару минут.',
  retryable: true,
};

const NETWORK_FALLBACK: ErrorCopy = {
  title: 'Нет связи',
  description: 'Кажется, пропал интернет. Проверь сеть и попробуй снова.',
  retryable: true,
};

/**
 * Converts any thrown value into displayable copy.
 *
 * - ApiError with a known `code`  -> tailored message
 * - ApiError 5xx                  -> generic "service down"
 * - ApiError 4xx (unknown code)   -> generic "request error"
 * - "initData is missing" Error   -> "open in Telegram"
 * - anything else (TypeError etc) -> network failure
 */
export function errorToCopy(error: unknown): ErrorCopy {
  if (error instanceof ApiError) {
    const known = error.code ? BY_CODE[error.code] : undefined;
    if (known) return known;
    if (error.status >= 500) return SERVER_FALLBACK;
    return HTTP_STATUS_FALLBACK;
  }
  if (error instanceof Error && error.message === 'initData is missing') {
    return AUTH_MISSING;
  }
  return NETWORK_FALLBACK;
}
