/**
 * Pure domain types for global sources + per-workspace subscriptions (Phase 3).
 *
 * No I/O, no SDK imports. DB row types live in @postdash/db; these are the
 * shapes domain logic + API projections work with.
 *
 * KEY INVARIANT: `Source` is GLOBAL (one row per canonical_url across all
 * workspaces). Per-workspace state lives in `WorkspaceSourceSubscription`.
 * See architecture/topics-and-sources.md.
 */

/** Source kind. RSS is the only Phase 3 fetcher; the rest are placeholders for Phase 4+. */
export type SourceType = 'rss' | 'website' | 'api' | 'manual';

/** Global source status. 'error' means too many fetch failures (Phase 4 marks this). */
export type SourceStatus = 'active' | 'disabled' | 'error';

/** Last-fetch outcome label. NULL until Phase 4 fetch worker runs. */
export type SourceFetchStatus = 'ok' | '4xx' | '5xx' | 'parse_error' | 'timeout';

export interface Source {
  id: string;
  type: SourceType;
  /** Raw URL as submitted (post-redirect-resolution, pre-canonicalize). For audit/display. */
  url: string;
  /** Deduplication key. UNIQUE in DB. Result of `canonicalize(url)`. */
  canonicalUrl: string;
  name: string | null;
  fetchIntervalMinutes: number;
  maxItemsPerFetch: number;
  reliabilityScore: string | null;
  lastFetchedAt: Date | null;
  lastFetchStatus: SourceFetchStatus | null;
  lastFetchError: string | null;
  /** Stamped from `CANONICALIZATION_RULE_VERSION` at insert. Phase 4 backfill uses it. */
  canonicalizationRuleVersion: string;
  status: SourceStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceSourceSubscription {
  id: string;
  workspaceId: string;
  sourceId: string;
  /** NULL = "use the workspace's default topic profile" (MVP single-profile UX). */
  topicProfileId: string | null;
  enabled: boolean;
  /** 0..100. 50 is neutral. Phase 5 matching uses this. */
  priority: number;
  customRules: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// Narrowers: bare text columns -> domain union types.
// =============================================================================

export function narrowSourceType(s: string): SourceType {
  if (s === 'website') return 'website';
  if (s === 'api') return 'api';
  if (s === 'manual') return 'manual';
  return 'rss';
}

export function narrowSourceStatus(s: string): SourceStatus {
  if (s === 'disabled') return 'disabled';
  if (s === 'error') return 'error';
  return 'active';
}

export function narrowSourceFetchStatus(s: string): SourceFetchStatus {
  switch (s) {
    case '4xx':
    case '5xx':
    case 'parse_error':
    case 'timeout':
      return s;
    default:
      return 'ok';
  }
}
