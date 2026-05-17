/**
 * Pure domain types for topic profiles (Phase 3).
 *
 * No I/O, no SDK imports. DB row types live in @postdash/db; these are the
 * shapes domain logic + API projections work with.
 *
 * See architecture/topics-and-sources.md.
 */

/** Languages supported by MVP topic profiles. Mirrors the CHECK constraint in 0003_phase3.sql. */
export type TopicProfileLanguage = 'ru' | 'en';

/** Embedding lifecycle. NULL row vector vs 'failed' is the same thing externally — keep three states for ops visibility. */
export type TopicProfileEmbeddingStatus = 'pending' | 'ok' | 'failed';

/** Active vs soft-disabled. 'disabled' MVP only via admin SQL; UI has no toggle yet. */
export type TopicProfileStatus = 'active' | 'disabled';

/**
 * Free-form tone descriptor consumed by Phase 6 draft generation. MVP keeps
 * the shape open (any string keys, any JSON values) so prompt iteration
 * doesn't need a migration; Phase 6 will introduce a stricter typed subset.
 */
export type ToneProfile = Record<string, unknown>;

export interface TopicProfile {
  id: string;
  workspaceId: string;
  name: string;
  language: TopicProfileLanguage;
  mainTopics: string[];
  keywords: string[];
  negativeKeywords: string[];
  toneProfile: ToneProfile | null;
  /** NULL until Phase 4 recompute_topic_embedding task fills it. */
  embeddingStatus: TopicProfileEmbeddingStatus;
  embeddingUpdatedAt: Date | null;
  status: TopicProfileStatus;
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// Narrowers: bare text columns -> domain union types.
// Same pattern as channel.ts (defined here so command + route code share one
// definition).
// =============================================================================

export function narrowTopicProfileLanguage(s: string): TopicProfileLanguage {
  return s === 'en' ? 'en' : 'ru';
}

export function narrowTopicProfileEmbeddingStatus(s: string): TopicProfileEmbeddingStatus {
  if (s === 'ok') return 'ok';
  if (s === 'failed') return 'failed';
  return 'pending';
}

export function narrowTopicProfileStatus(s: string): TopicProfileStatus {
  return s === 'disabled' ? 'disabled' : 'active';
}
