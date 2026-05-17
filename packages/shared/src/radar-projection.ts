/**
 * Wire-format contract for Phase 5 Radar reads — single typed source of truth
 * for the workspace_news_matches projection shared by `apps/api/src/routes/radar.ts`
 * and `apps/miniapp/src/api/radar.ts`.
 *
 * Layer note: lives in `@postdash/shared` (leaf utility). MUST NOT import
 * `@postdash/db` or `@postdash/commands`.
 *
 * Field naming: snake_case to match channel-projection and topic-source-projection
 * conventions.
 */

import { z } from 'zod';

export const RADAR_MATCH_STATUSES = [
  'candidate',
  'filtered_negative',
  'hidden',
  'ai_refused',
  'low_score',
  'suppressed',
] as const;
export type RadarMatchStatus = (typeof RADAR_MATCH_STATUSES)[number];

export const RadarMatchProjectionSchema = z.object({
  match_id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  news_item_id: z.string().uuid(),
  cluster_id: z.string().uuid().nullable(),
  // score is a number (0..10) when present; null for non-scored statuses
  // (filtered_negative / hidden / ai_refused).
  score: z.number().min(0).max(10).nullable(),
  relevance_reason: z.string().max(280).nullable(),
  should_create_draft: z.boolean(),
  risk_flags: z.array(z.string()),
  // score_components is forwarded verbatim — the Mini App may show a tooltip
  // breakdown. Keys: llm, cosine, freshness, reliability, weighted.
  score_components: z.record(z.string(), z.unknown()),
  ai_provider: z.string().nullable(),
  used_model: z.string().nullable(),
  prompt_version: z.string().nullable(),
  status: z.enum(RADAR_MATCH_STATUSES),
  scored_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  news: z.object({
    title: z.string(),
    url: z.string(),
    canonical_url: z.string(),
    summary: z.string().nullable(),
    published_at: z.string().nullable(),
    language: z.enum(['ru', 'en', 'other']).nullable(),
  }),
  source: z.object({
    id: z.string().uuid(),
    name: z.string().nullable(),
    canonical_url: z.string(),
  }),
  // cluster meta is present only when the row has cluster_id.
  cluster: z
    .object({
      sources_count: z.number().int().positive(),
    })
    .nullable(),
});
export type RadarMatchProjection = z.infer<typeof RadarMatchProjectionSchema>;

export const RadarListProjectionSchema = z.object({
  items: z.array(RadarMatchProjectionSchema),
  page: z.number().int().positive(),
  page_size: z.number().int().positive(),
  total: z.number().int().nonnegative(),
});
export type RadarListProjection = z.infer<typeof RadarListProjectionSchema>;
