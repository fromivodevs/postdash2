/**
 * URL canonicalization for source deduplication.
 *
 * The single source of truth for "are these two URLs the same article" — used
 * at source creation (`createSource` command) to drop tracking params and pick
 * one canonical form, and at fetch time (Phase 4) to dedupe news items.
 *
 * Rules per tg_mvp_plan/06-WORKERS-AND-INGESTION.md §9:
 *
 *   1. Scheme        -> always https://
 *   2. Host          -> lowercase, strip leading 'www.' (NOT 'm.')
 *   3. Path          -> strip trailing slash (except bare '/')
 *   4. Query         -> drop tracking params; alphabetize the rest
 *   5. Fragment      -> always drop
 *   6. Site overrides -> news.ycombinator.com / reddit.com / x.com
 *
 * The version string is bumped when these rules change so Phase 4+ can
 * detect rows that need re-canonicalization.
 */

/**
 * Bumped whenever the rules below change. Stored on each `sources` row as
 * `canonicalization_rule_version`; a Phase 4+ backfill task compares this
 * against stored values to identify rows that need re-canonicalization.
 *
 * Bump policy: any behavioural change (added/removed tracker, new site
 * override, changed path normalization) is a bump. Comment-only or test-only
 * changes are NOT.
 */
export const CANONICALIZATION_RULE_VERSION = 'v1';

/**
 * Tracking / analytics params dropped from the query string. Lowercased keys
 * matched case-insensitively (Postgres + most CDNs treat query keys as
 * case-sensitive, but real-world taggers emit both `UTM_*` and `utm_*` — we
 * conflate them to be safe).
 */
const TRACKING_PARAM_NAMES = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'utm_reader',
  'utm_brand',
  'utm_social',
  'utm_social-type',
  'fbclid',
  'gclid',
  'yclid',
  'mc_cid',
  'mc_eid',
  '_hsenc',
  '_hsmi',
  'ref',
  'ref_src',
  'ref_url',
  'igshid',
  'si',
]);

/**
 * Catch-all matcher: any param whose name begins with `utm_` is treated as
 * tracking. Covers vendor-specific `utm_*` extensions not enumerated above.
 */
function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  if (TRACKING_PARAM_NAMES.has(lower)) return true;
  if (lower.startsWith('utm_')) return true;
  return false;
}

export interface CanonicalizeResult {
  /** Canonical URL string, or `null` if input could not be parsed. */
  canonical: string | null;
  /**
   * `true` when a site-specific override was applied (HN/Reddit/X). Useful
   * for tests and for surfacing "we normalized your URL" in the UI.
   */
  appliedOverride: boolean;
  /** Rule-set version stamped on the resulting row. Always present, even on parse failure. */
  ruleVersion: string;
}

/**
 * Canonicalize a URL. Returns a CanonicalizeResult; callers that just want
 * the string can read `.canonical`.
 *
 * Never throws — invalid input returns `{ canonical: null, ... }` so callers
 * can decide whether to surface a 400 or accept the raw input as a fallback.
 */
export function canonicalize(input: string): CanonicalizeResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { canonical: null, appliedOverride: false, ruleVersion: CANONICALIZATION_RULE_VERSION };
  }

  // Default to https if scheme is missing. Done BEFORE URL parsing because
  // `new URL('example.com/foo')` throws.
  const withScheme = hasScheme(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { canonical: null, appliedOverride: false, ruleVersion: CANONICALIZATION_RULE_VERSION };
  }

  // Rule 1: only http(s) is in scope. ftp/gopher/mailto are rejected outright;
  // they don't make sense as content sources.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { canonical: null, appliedOverride: false, ruleVersion: CANONICALIZATION_RULE_VERSION };
  }

  // Rule 1: force https.
  parsed.protocol = 'https:';

  // Rule 2: lowercase host, strip leading 'www.' (but NOT 'm.' — that's a
  // different mobile site, not a redirect alias).
  const lowerHost = parsed.hostname.toLowerCase();
  parsed.hostname = lowerHost.startsWith('www.') ? lowerHost.slice(4) : lowerHost;

  // Drop default ports. `new URL` already strips :80 from http: and :443 from
  // https:, but only when scheme matches at parse time — we just rewrote the
  // protocol, so re-check.
  if (parsed.port === '80' || parsed.port === '443') {
    parsed.port = '';
  }

  // Rule 5: drop fragment.
  parsed.hash = '';

  // Rule 4: query — drop trackers, alphabetize the rest.
  const cleanedParams = new URLSearchParams();
  const allParams: Array<[string, string]> = [];
  for (const [name, value] of parsed.searchParams.entries()) {
    if (!isTrackingParam(name)) {
      allParams.push([name, value]);
    }
  }
  allParams.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [name, value] of allParams) {
    cleanedParams.append(name, value);
  }
  // URLSearchParams.toString() handles encoding of values; we overwrite the
  // existing search string so the order matches our sort, not the input.
  const query = cleanedParams.toString();
  parsed.search = query ? `?${query}` : '';

  // Rule 3: strip trailing slash (except bare '/').
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }

  // Rule 6: site-specific overrides. These run AFTER the generic
  // normalizations so they can rely on already-lowercased host / fragment
  // removed / etc.
  const override = applySiteOverride(parsed);
  if (override) {
    return {
      canonical: override,
      appliedOverride: true,
      ruleVersion: CANONICALIZATION_RULE_VERSION,
    };
  }

  return {
    canonical: parsed.toString(),
    appliedOverride: false,
    ruleVersion: CANONICALIZATION_RULE_VERSION,
  };
}

/**
 * Returns true when the input already begins with ANY scheme (`http://`,
 * `ftp://`, `mailto:`, etc.). The non-http(s) reject branch above relies on
 * this: a `mailto:foo` input must NOT get an `https://` prefix and then be
 * accidentally accepted as `https://mailto:foo`. So this matches both
 * `scheme://` and `scheme:` (mailto/tel/data) forms.
 */
function hasScheme(url: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url);
}

/**
 * Site-specific canonicalizations. Returns the rewritten URL string when an
 * override applies, otherwise `null` (caller falls back to the generic form).
 *
 * Each override is a focused rewrite — we don't try to be comprehensive. The
 * principle: cover the cases where the SAME article shows up under MANY
 * distinct URLs that the generic rules don't collapse.
 */
function applySiteOverride(url: URL): string | null {
  // news.ycombinator.com: every story has the form ?id=NNNN. The site also
  // exposes /item?id=NNNN&p=2 for paginated comments — strip the `p` param.
  if (url.hostname === 'news.ycombinator.com' && url.pathname === '/item') {
    const id = url.searchParams.get('id');
    if (id && /^\d+$/.test(id)) {
      return `https://news.ycombinator.com/item?id=${id}`;
    }
  }

  // Reddit: /r/<sub>/comments/<id>/<slug>/ → /comments/<id>. Drops the slug
  // (mutable, often shortened by reddit itself), the subreddit (redundant —
  // the id is globally unique), and trailing path.
  if (
    url.hostname === 'reddit.com' ||
    url.hostname === 'old.reddit.com' ||
    url.hostname === 'new.reddit.com'
  ) {
    const m = /^\/r\/[^/]+\/comments\/([a-z0-9]+)(?:\/|$)/i.exec(url.pathname);
    if (m) {
      return `https://reddit.com/comments/${m[1]!.toLowerCase()}`;
    }
  }

  // Twitter / X: collapse twitter.com and x.com onto the same canonical
  // x.com form. /<user>/status/<id> is what every status URL eventually
  // reduces to (mobile.twitter.com is covered because Rule 2 already
  // stripped the `m.` prefix in the URL parse step? — no, mobile uses a
  // different prefix; handle it explicitly here).
  if (
    url.hostname === 'twitter.com' ||
    url.hostname === 'x.com' ||
    url.hostname === 'mobile.twitter.com' ||
    url.hostname === 'mobile.x.com'
  ) {
    const m = /^\/([^/]+)\/status\/(\d+)/.exec(url.pathname);
    if (m) {
      return `https://x.com/${m[1]}/status/${m[2]}`;
    }
  }

  return null;
}
