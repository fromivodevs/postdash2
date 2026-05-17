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
  | { kind: 'list'; items: RadarMatchProjection[] };

export interface RadarViewInput {
  loading: boolean;
  errored: boolean;
  items: RadarMatchProjection[] | undefined;
}

export function selectRadarView(input: RadarViewInput): RadarView {
  if (input.loading) return { kind: 'loading' };
  if (input.errored) return { kind: 'error' };
  if (!input.items || input.items.length === 0) return { kind: 'empty' };
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

export const RADAR_FILTER_OPTIONS: ReadonlyArray<{
  value: RadarMatchProjection['status'] | 'all';
  label: string;
}> = Object.freeze([
  { value: 'candidate', label: 'Кандидаты' },
  { value: 'low_score', label: 'Низкий скор' },
  { value: 'ai_refused', label: 'AI отказал' },
  { value: 'all', label: 'Все' },
]);
