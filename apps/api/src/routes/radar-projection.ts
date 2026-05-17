/**
 * Phase 5 wire projection for workspace_news_matches.
 *
 * Domain `RadarMatchRow` (from @postdash/commands) → `RadarMatchProjection`
 * (from @postdash/shared, snake_case wire schema). Same pattern as
 * topics-projection.ts and channels projection — one place where the
 * domain↔wire boundary lives so the Mini App's API client and the API
 * routes can't drift.
 */

import type { RadarListResult, RadarMatchRow } from '@postdash/commands';
import type { RadarListProjection, RadarMatchProjection } from '@postdash/shared';

export function projectRadarMatch(row: RadarMatchRow): RadarMatchProjection {
  return {
    match_id: row.matchId,
    workspace_id: row.workspaceId,
    news_item_id: row.newsItemId,
    cluster_id: row.clusterId,
    score: row.score,
    relevance_reason: row.relevanceReason,
    should_create_draft: row.shouldCreateDraft,
    risk_flags: row.riskFlags,
    score_components: row.scoreComponents,
    ai_provider: row.aiProvider,
    used_model: row.usedModel,
    prompt_version: row.promptVersion,
    status: row.status,
    scored_at: row.scoredAt === null ? null : row.scoredAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    news: {
      title: row.news.title,
      url: row.news.url,
      canonical_url: row.news.canonicalUrl,
      summary: row.news.summary,
      published_at: row.news.publishedAt === null ? null : row.news.publishedAt.toISOString(),
      language: narrowLanguage(row.news.language),
    },
    source: {
      id: row.source.id,
      name: row.source.name,
      canonical_url: row.source.canonicalUrl,
    },
    cluster: row.cluster === null ? null : { sources_count: row.cluster.sourcesCount },
  };
}

export function projectRadarList(result: RadarListResult): RadarListProjection {
  return {
    items: result.items.map(projectRadarMatch),
    page: result.page,
    page_size: result.pageSize,
    total: result.total,
  };
}

function narrowLanguage(s: string | null): 'ru' | 'en' | 'other' | null {
  if (s === null) return null;
  if (s === 'ru' || s === 'en' || s === 'other') return s;
  return 'other';
}
