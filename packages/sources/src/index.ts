/**
 * Source fetchers + URL canonicalization.
 *
 * Phase 3: URL canonicalization rules + one-time redirect resolution.
 * Phase 4+: RSS parsing, fetch workers, volume cap.
 *
 * См. tg_mvp_plan/06-WORKERS-AND-INGESTION.md §9.
 */

export {
  canonicalize,
  CANONICALIZATION_RULE_VERSION,
  type CanonicalizeResult,
} from './canonicalize.js';
export {
  resolveRedirect,
  type ResolveRedirectOptions,
  type ResolveRedirectResult,
  type ResolveRedirectStatus,
  type ResolvedHostSnapshot,
} from './redirect-resolver.js';
export {
  fetchRssSource,
  detectLanguage,
  type ParsedItem,
  type FetchResult,
  type FetchOptions,
  type FetchStatus,
} from './rss-parser.js';
export { contentHash, CONTENT_HASH_RULE_VERSION, type ContentHashInput } from './content-hash.js';
