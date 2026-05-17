/**
 * Radar API client (Phase 5).
 *
 * Minimal wrapper around GET /radar — same pattern as topics.ts / sources.ts.
 * No retry / no cache here — React Query handles those at the call site.
 */

import { apiFetch } from './client.ts';
import type { RadarListProjection, RadarMatchStatus } from './types.ts';

export interface GetRadarInput {
  status?: RadarMatchStatus | 'all';
  minScore?: number;
  maxScore?: number;
  page?: number;
  pageSize?: number;
}

export function getRadar(
  initData: string,
  input: GetRadarInput = {},
  signal?: AbortSignal,
): Promise<RadarListProjection> {
  const params = new URLSearchParams();
  if (input.status) params.set('status', input.status);
  if (input.minScore !== undefined) params.set('min_score', String(input.minScore));
  if (input.maxScore !== undefined) params.set('max_score', String(input.maxScore));
  if (input.page !== undefined) params.set('page', String(input.page));
  if (input.pageSize !== undefined) params.set('page_size', String(input.pageSize));
  const qs = params.toString();
  const path = qs ? `/radar?${qs}` : '/radar';
  return apiFetch<RadarListProjection>(path, {
    method: 'GET',
    initData,
    ...(signal ? { signal } : {}),
  });
}
