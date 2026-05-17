/**
 * Topic-profile API client (Phase 3).
 *
 * Same minimal wrapper pattern as channels.ts: thin HTTP fns over
 * `apiFetch`. No retry / no cache here — React Query handles those at the
 * call site.
 *
 * Errors stay as `ApiError` (generic) because the topic routes don't carry
 * domain wire codes the screen needs to dispatch on — they're all standard
 * 400/403/404/500.
 */

import { apiFetch } from './client.ts';
import type { TopicProfileListProjection, TopicProfileProjection } from './types.ts';

export interface PostTopicInput {
  name: string;
  language: 'ru' | 'en';
  main_topics?: string[];
  keywords?: string[];
  negative_keywords?: string[];
  tone_profile?: Record<string, unknown> | null;
}

export function postTopic(
  initData: string,
  input: PostTopicInput,
  signal?: AbortSignal,
): Promise<TopicProfileProjection> {
  return apiFetch<TopicProfileProjection>('/topics', {
    method: 'POST',
    initData,
    json: input,
    ...(signal ? { signal } : {}),
  });
}

export function getTopics(
  initData: string,
  signal?: AbortSignal,
): Promise<TopicProfileListProjection> {
  return apiFetch<TopicProfileListProjection>('/topics', {
    method: 'GET',
    initData,
    ...(signal ? { signal } : {}),
  });
}

export function patchTopic(
  initData: string,
  id: string,
  patch: Partial<PostTopicInput>,
  signal?: AbortSignal,
): Promise<TopicProfileProjection> {
  return apiFetch<TopicProfileProjection>(`/topics/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    initData,
    json: patch,
    ...(signal ? { signal } : {}),
  });
}

export function deleteTopic(initData: string, id: string, signal?: AbortSignal): Promise<void> {
  return apiFetch<void>(`/topics/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    initData,
    ...(signal ? { signal } : {}),
  });
}
