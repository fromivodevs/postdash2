/**
 * Sources API client (Phase 3).
 *
 * Mirrors topics.ts. The `:source_id` URL parameter is the GLOBAL source id
 * (sources.id) — see apps/api/src/routes/sources.ts for the rationale.
 */

import { apiFetch } from './client.ts';
import type { SourceSubscriptionListProjection, SourceSubscriptionProjection } from './types.ts';

export interface PostSourceInput {
  url: string;
  type: 'rss' | 'website' | 'api' | 'manual';
  name?: string;
  topic_profile_id?: string;
  fetch_interval_minutes?: number;
}

export interface PatchSourceInput {
  enabled?: boolean;
  priority?: number;
  topic_profile_id?: string | null;
}

export function postSource(
  initData: string,
  input: PostSourceInput,
  signal?: AbortSignal,
): Promise<SourceSubscriptionProjection> {
  return apiFetch<SourceSubscriptionProjection>('/sources', {
    method: 'POST',
    initData,
    json: input,
    ...(signal ? { signal } : {}),
  });
}

export function getSources(
  initData: string,
  signal?: AbortSignal,
): Promise<SourceSubscriptionListProjection> {
  return apiFetch<SourceSubscriptionListProjection>('/sources', {
    method: 'GET',
    initData,
    ...(signal ? { signal } : {}),
  });
}

export function patchSource(
  initData: string,
  sourceId: string,
  patch: PatchSourceInput,
  signal?: AbortSignal,
): Promise<SourceSubscriptionProjection> {
  return apiFetch<SourceSubscriptionProjection>(`/sources/${encodeURIComponent(sourceId)}`, {
    method: 'PATCH',
    initData,
    json: patch,
    ...(signal ? { signal } : {}),
  });
}

export function deleteSource(
  initData: string,
  sourceId: string,
  signal?: AbortSignal,
): Promise<void> {
  return apiFetch<void>(`/sources/${encodeURIComponent(sourceId)}`, {
    method: 'DELETE',
    initData,
    ...(signal ? { signal } : {}),
  });
}
