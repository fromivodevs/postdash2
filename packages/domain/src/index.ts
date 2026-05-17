/**
 * Pure business types (no I/O, no SDK imports).
 *
 * Phase 1+: identity / workspace types.
 * Phase 2+: ContentChannel, ChannelConnection.
 * Phase 3+: TopicProfile, Source.
 * Phase 4+: NewsItem, NewsCluster.
 *
 * См. tg_mvp_plan/02-ARCHITECTURE.md §3.6 (Domain Core).
 */

export * from './identity.js';
export * from './channel.js';
export * from './topic.js';
export * from './source.js';
