/**
 * Content-hash helper for Phase 4 fetch_source handler.
 *
 * sha256(normalized concat) detects "feed updated existing item" without
 * re-running the full diff. Stored on `global_news_items.content_hash`:
 *   - matching hash on next fetch → skip (no change).
 *   - differing hash → was_updated=true, refresh text + schedule re-embed.
 *
 * Normalization rules (canonical, version-pinned via CONTENT_HASH_RULE_VERSION):
 *   - trim leading/trailing whitespace on each component;
 *   - missing summary → empty string (NOT 'undefined');
 *   - missing publishedAt → empty string (NOT a faked date — that would
 *     change every minute as `new Date()` ticked);
 *   - publishedAt → ISO 8601 string in UTC (`.toISOString()`);
 *   - join with `` (ASCII unit separator) to keep the components
 *     un-ambiguously delimited.
 */

import { createHash } from 'node:crypto';

/**
 * Bumped when the normalization rules above change so future migrations can
 * detect rows that need re-hashing. No backfill auto-runs; document the bump
 * in the migration that introduces it.
 */
export const CONTENT_HASH_RULE_VERSION = 'v1';

const SEP = '';

export interface ContentHashInput {
  title: string;
  summary?: string | undefined;
  publishedAt?: Date | undefined;
}

export function contentHash(input: ContentHashInput): string {
  const title = input.title.trim();
  const summary = (input.summary ?? '').trim();
  const publishedAt = input.publishedAt ? input.publishedAt.toISOString() : '';
  const concat = [title, summary, publishedAt].join(SEP);
  return createHash('sha256').update(concat, 'utf8').digest('hex');
}
