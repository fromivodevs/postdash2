/**
 * Wire-format contract for Phase 3 reads — single typed source of truth for
 * topic profiles + source subscriptions, shared by `apps/api/src/routes`
 * and `apps/miniapp/src/api`.
 *
 * Layer note: lives in `@postdash/shared` (leaf utility). MUST NOT import
 * `@postdash/db` or `@postdash/commands`.
 *
 * Field naming: snake_case to match channel-projection and the rest of the
 * Phase 1/2 wire contracts.
 */

import { z } from 'zod';

// =============================================================================
// Topic profile
// =============================================================================

export const TopicProfileProjectionSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  name: z.string(),
  language: z.enum(['ru', 'en']),
  main_topics: z.array(z.string()),
  keywords: z.array(z.string()),
  negative_keywords: z.array(z.string()),
  tone_profile: z.record(z.string(), z.unknown()).nullable(),
  embedding_status: z.enum(['pending', 'ok', 'failed']),
  status: z.enum(['active', 'disabled']),
  created_at: z.string(),
  updated_at: z.string(),
});
export type TopicProfileProjection = z.infer<typeof TopicProfileProjectionSchema>;

export const TopicProfileListProjectionSchema = z.object({
  items: z.array(TopicProfileProjectionSchema),
});
export type TopicProfileListProjection = z.infer<typeof TopicProfileListProjectionSchema>;

// =============================================================================
// Source subscription (subscription + nested global source)
// =============================================================================

export const SourceProjectionSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(['rss', 'website', 'api', 'manual']),
  url: z.string(),
  canonical_url: z.string(),
  name: z.string().nullable(),
  fetch_interval_minutes: z.number().int(),
  // last_fetched_at / last_fetch_status / last_fetch_error are Phase 4 fields
  // (the fetch worker writes them). Phase 3 returns them as `null` for every
  // row; the Mini App "Sources" screen renders placeholders.
  last_fetched_at: z.string().nullable(),
  last_fetch_status: z.enum(['ok', '4xx', '5xx', 'parse_error', 'timeout']).nullable(),
  last_fetch_error: z.string().nullable(),
  status: z.enum(['active', 'disabled', 'error']),
});
export type SourceProjection = z.infer<typeof SourceProjectionSchema>;

export const SourceSubscriptionProjectionSchema = z.object({
  subscription_id: z.string().uuid(),
  source: SourceProjectionSchema,
  enabled: z.boolean(),
  priority: z.number().int(),
  topic_profile_id: z.string().uuid().nullable(),
  created_at: z.string(),
});
export type SourceSubscriptionProjection = z.infer<typeof SourceSubscriptionProjectionSchema>;

export const SourceSubscriptionListProjectionSchema = z.object({
  items: z.array(SourceSubscriptionProjectionSchema),
});
export type SourceSubscriptionListProjection = z.infer<
  typeof SourceSubscriptionListProjectionSchema
>;
