/**
 * Pure view-model helpers for `RadarScreen` (Phase 5).
 *
 * `selectRadarView` mirrors the discriminated-union pattern from
 * `selectSourcesView` — keeps the JSX free of nested ternaries and gives the
 * test surface the same shape as the screen renders. The screen itself only
 * dispatches on the union; no business logic lives there.
 *
 * `formatScore` and `formatPublishedAt` are small helpers extracted so the
 * test covers the locale + null-handling edge cases without DOM.
 */

import type { RadarMatchProjection } from '../api/types.ts';

export type RadarView =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'empty' }
  | { kind: 'filter-empty' }
  | { kind: 'list'; items: RadarMatchProjection[] };

export interface RadarViewInput {
  loading: boolean;
  errored: boolean;
  items: RadarMatchProjection[] | undefined;
  /**
   * True when the user-selected status filter is something other than the
   * default ('candidate'). Lets the empty-state branch distinguish "workspace
   * has no data yet" (show onboarding CTAs) from "this filter happens to be
   * empty" (offer a reset chip).
   */
  filterActive?: boolean;
}

export function selectRadarView(input: RadarViewInput): RadarView {
  if (input.loading) return { kind: 'loading' };
  if (input.errored) return { kind: 'error' };
  if (!input.items || input.items.length === 0) {
    return input.filterActive ? { kind: 'filter-empty' } : { kind: 'empty' };
  }
  return { kind: 'list', items: input.items };
}

/**
 * Score formatter: ".0" suffix for integers, one decimal otherwise. Null →
 * em-dash so the UI doesn't render "null" or empty when filter rows have no
 * score (filtered_negative / hidden / ai_refused).
 */
export function formatScore(score: number | null): string {
  if (score === null) return '—';
  if (!Number.isFinite(score)) return '—';
  return Number.isInteger(score) ? `${score}.0` : score.toFixed(1);
}

/**
 * Status → human label (RU). Single source of truth so the badge component
 * doesn't switch-case the same values in two places.
 */
export function statusLabel(status: RadarMatchProjection['status']): string {
  switch (status) {
    case 'candidate':
      return 'Кандидат';
    case 'low_score':
      return 'Низкий скор';
    case 'filtered_negative':
      return 'Фильтр: минус-слово';
    case 'hidden':
      return 'Скрыто';
    case 'ai_refused':
      return 'AI отказал';
    case 'suppressed':
      return 'Скрыто пользователем';
  }
}

/**
 * Tone color for the status badge — matches the §7 baseline (neutral /
 * warning / danger). Phase 5 keeps this minimal; richer styling lands in
 * later UI passes.
 */
export type BadgeTone = 'neutral' | 'positive' | 'warning' | 'danger';
export function statusTone(status: RadarMatchProjection['status']): BadgeTone {
  switch (status) {
    case 'candidate':
      return 'positive';
    case 'low_score':
      return 'neutral';
    case 'filtered_negative':
    case 'hidden':
    case 'suppressed':
      return 'neutral';
    case 'ai_refused':
      return 'warning';
  }
}

/**
 * Format an ISO published_at into a short relative phrase. Reused by the
 * NewsCell. Falls back to absolute date when delta exceeds 7 days.
 */
export function formatPublishedAt(iso: string | null, nowMs: number = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const deltaMin = Math.max(0, Math.round((nowMs - t) / 60_000));
  if (deltaMin < 1) return 'только что';
  if (deltaMin < 60) return `${deltaMin} мин назад`;
  const deltaH = Math.round(deltaMin / 60);
  if (deltaH < 24) return `${deltaH} ч назад`;
  const deltaD = Math.round(deltaH / 24);
  if (deltaD < 7) return `${deltaD} д назад`;
  try {
    return new Date(t).toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return new Date(t).toISOString().slice(0, 10);
  }
}

/**
 * Russian plural agreement. Picks between the three forms a cardinal noun
 * needs in Russian (one / few / many), driven by the count's last two
 * digits per Unicode CLDR rules:
 *   - one:   N % 10 === 1 AND N % 100 !== 11        → "1 источник"
 *   - few:   N % 10 in 2..4 AND N % 100 NOT in 12..14 → "2 источника"
 *   - many:  everything else (0, 5..20, 25..30, ...)  → "5 источников"
 *
 * Bare "источников" used to render for every count, which read as
 * "5 источников" for the singular case too — small but visible UX paper-cut.
 */
export function pluralizeRu(
  n: number,
  forms: readonly [one: string, few: string, many: string],
): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

export const RADAR_FILTER_OPTIONS: ReadonlyArray<{
  value: RadarMatchProjection['status'] | 'all';
  label: string;
}> = Object.freeze([
  { value: 'candidate', label: 'Кандидаты' },
  { value: 'low_score', label: 'Низкий скор' },
  { value: 'ai_refused', label: 'AI отказал' },
  { value: 'all', label: 'Все' },
]);

/**
 * Whitelist URL protocols we are willing to render as an `<a href>` in the
 * radar card. A malicious RSS source could publish `javascript:doSomething()`
 * as a news URL; without this gate, clicking it inside the Telegram WebView
 * would execute attacker-controlled JS. Accept only http/https. Reject
 * `javascript:`, `data:`, `vbscript:`, `file:`, empty, and any input that
 * fails `new URL(...)` parsing.
 *
 * Additionally rejects:
 *   - URLs containing userinfo (`https://attacker.com@evil.com`) — `new URL`
 *     parses host=`evil.com` while the user reading the href left-to-right
 *     sees `attacker.com`. Treat any userinfo presence as hostile.
 *   - URLs whose hostname contains non-ASCII characters — IDN homograph
 *     bypass (Cyrillic 'а' looks like Latin 'a', etc.). Rejecting all raw-
 *     Unicode IDN is the MVP-safe call; punycode-encoded hosts (`xn--...`)
 *     stay ASCII and remain accepted.
 */
export function isSafeExternalUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const proto = parsed.protocol.toLowerCase();
  if (proto !== 'http:' && proto !== 'https:') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  // IDN guard. WHATWG `URL` already converts raw-Unicode hostnames to
  // punycode (xn--...) form, so `parsed.hostname` is always ASCII. Reject
  // two markers:
  //   (a) any non-ASCII codepoint slipped past the parser (defence in
  //       depth — should never trigger on a spec-compliant runtime).
  //   (b) any label starting with `xn--` — that's the punycode marker for
  //       an IDN. We don't try to whitelist specific scripts; MVP-safe is
  //       "reject all IDN".
  for (let i = 0; i < parsed.hostname.length; i++) {
    if (parsed.hostname.charCodeAt(i) > 0x7f) return false;
  }
  for (const label of parsed.hostname.split('.')) {
    if (label.toLowerCase().startsWith('xn--')) return false;
  }
  return true;
}
