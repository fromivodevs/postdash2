/**
 * Pure view-model helpers for SourcesScreen.
 *
 * The screen's state machine is small (loading / error / empty / list)
 * but the per-row pending state + delete-candidate-modal flow is worth
 * extracting so the logic is unit-testable without React.
 */

import type { SourceSubscriptionProjection } from '@postdash/shared';

export type SourcesViewKind = 'loading' | 'error' | 'empty' | 'list';

export interface SourcesView {
  kind: SourcesViewKind;
  items: SourceSubscriptionProjection[];
}

export interface SelectSourcesViewInput {
  loading: boolean;
  errored: boolean;
  items: readonly SourceSubscriptionProjection[] | null | undefined;
}

export function selectSourcesView(input: SelectSourcesViewInput): SourcesView {
  if (input.loading) return { kind: 'loading', items: [] };
  if (input.errored) return { kind: 'error', items: [] };
  const items = input.items ?? [];
  if (items.length === 0) return { kind: 'empty', items: [] };
  return { kind: 'list', items: items.slice() };
}

/**
 * Renders the "last fetched" copy for a SourceCell subtitle.
 * Null/undefined → "пока не проверялся" (Phase 4 hasn't filled the field).
 * ISO timestamp → localised ru-RU string.
 */
export function formatLastFetched(lastFetchedAt: string | null | undefined): string {
  if (!lastFetchedAt) return 'пока не проверялся';
  const d = new Date(lastFetchedAt);
  if (Number.isNaN(d.getTime())) return 'пока не проверялся';
  return d.toLocaleString('ru-RU');
}

/**
 * True when a row is currently in flight for the matching mutation.
 * The screen tracks pendingToggleSourceId / pendingDeleteSourceId in two
 * separate useState slots — these helpers keep the JSX boolean logic
 * trivial and reusable in tests.
 */
export function isRowToggling(rowSourceId: string, pendingSourceId: string | null): boolean {
  return pendingSourceId === rowSourceId;
}

export function isRowDeleting(rowSourceId: string, pendingSourceId: string | null): boolean {
  return pendingSourceId === rowSourceId;
}
