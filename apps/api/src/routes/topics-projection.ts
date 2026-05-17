/**
 * Phase 3 projection helpers: domain types -> wire types.
 *
 * Same pattern as channels-projection.ts: keep the "Date -> ISO string"
 * conversion and the snake_case key rename in ONE place so route handlers
 * stay focused on transport concerns (status code, header), not shape
 * conversion.
 */

import type { Source, TopicProfile, WorkspaceSourceSubscription } from '@postdash/domain';
import type { SourceSubscriptionProjection, TopicProfileProjection } from '@postdash/shared';

export function projectTopicProfile(profile: TopicProfile): TopicProfileProjection {
  return {
    id: profile.id,
    workspace_id: profile.workspaceId,
    name: profile.name,
    language: profile.language,
    main_topics: profile.mainTopics,
    keywords: profile.keywords,
    negative_keywords: profile.negativeKeywords,
    tone_profile: profile.toneProfile,
    embedding_status: profile.embeddingStatus,
    status: profile.status,
    created_at: profile.createdAt.toISOString(),
    updated_at: profile.updatedAt.toISOString(),
  };
}

export function projectSourceSubscription(input: {
  subscription: WorkspaceSourceSubscription;
  source: Source;
}): SourceSubscriptionProjection {
  return {
    subscription_id: input.subscription.id,
    enabled: input.subscription.enabled,
    priority: input.subscription.priority,
    topic_profile_id: input.subscription.topicProfileId,
    created_at: input.subscription.createdAt.toISOString(),
    source: {
      id: input.source.id,
      type: input.source.type,
      url: input.source.url,
      canonical_url: input.source.canonicalUrl,
      name: input.source.name,
      fetch_interval_minutes: input.source.fetchIntervalMinutes,
      last_fetched_at: input.source.lastFetchedAt
        ? input.source.lastFetchedAt.toISOString()
        : null,
      last_fetch_status: input.source.lastFetchStatus,
      last_fetch_error: input.source.lastFetchError,
      status: input.source.status,
    },
  };
}
