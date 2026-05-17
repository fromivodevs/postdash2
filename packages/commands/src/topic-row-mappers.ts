/**
 * Phase 3 row -> domain mappers for topic_profiles, sources, and
 * workspace_source_subscriptions.
 *
 * Same pattern as row-mappers.ts (Phase 1/2): one place where DB column
 * narrowing happens, so the read path and the write path can't drift.
 */

import {
  narrowSourceFetchStatus,
  narrowSourceStatus,
  narrowSourceType,
  narrowTopicProfileEmbeddingStatus,
  narrowTopicProfileLanguage,
  narrowTopicProfileStatus,
  type Source,
  type ToneProfile,
  type TopicProfile,
  type WorkspaceSourceSubscription,
} from '@postdash/domain';

export function rowToTopicProfile(row: {
  id: string;
  workspaceId: string;
  name: string;
  language: string;
  mainTopics: string[];
  keywords: string[];
  negativeKeywords: string[];
  toneProfile: unknown;
  embeddingStatus: string;
  embeddingUpdatedAt: Date | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): TopicProfile {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    language: narrowTopicProfileLanguage(row.language),
    mainTopics: row.mainTopics,
    keywords: row.keywords,
    negativeKeywords: row.negativeKeywords,
    toneProfile: isToneProfile(row.toneProfile) ? row.toneProfile : null,
    embeddingStatus: narrowTopicProfileEmbeddingStatus(row.embeddingStatus),
    embeddingUpdatedAt: row.embeddingUpdatedAt,
    status: narrowTopicProfileStatus(row.status),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isToneProfile(v: unknown): v is ToneProfile {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function rowToSource(row: {
  id: string;
  type: string;
  url: string;
  canonicalUrl: string;
  name: string | null;
  fetchIntervalMinutes: number;
  maxItemsPerFetch: number;
  reliabilityScore: string | null;
  lastFetchedAt: Date | null;
  lastFetchStatus: string | null;
  lastFetchError: string | null;
  canonicalizationRuleVersion: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): Source {
  return {
    id: row.id,
    type: narrowSourceType(row.type),
    url: row.url,
    canonicalUrl: row.canonicalUrl,
    name: row.name,
    fetchIntervalMinutes: row.fetchIntervalMinutes,
    maxItemsPerFetch: row.maxItemsPerFetch,
    reliabilityScore: row.reliabilityScore,
    lastFetchedAt: row.lastFetchedAt,
    lastFetchStatus:
      row.lastFetchStatus === null ? null : narrowSourceFetchStatus(row.lastFetchStatus),
    lastFetchError: row.lastFetchError,
    canonicalizationRuleVersion: row.canonicalizationRuleVersion,
    status: narrowSourceStatus(row.status),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function rowToSubscription(row: {
  id: string;
  workspaceId: string;
  sourceId: string;
  topicProfileId: string | null;
  enabled: boolean;
  priority: number;
  customRules: unknown;
  createdAt: Date;
  updatedAt: Date;
}): WorkspaceSourceSubscription {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sourceId: row.sourceId,
    topicProfileId: row.topicProfileId,
    enabled: row.enabled,
    priority: row.priority,
    customRules: isObject(row.customRules) ? (row.customRules as Record<string, unknown>) : {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
