/**
 * One-time redirect resolution at source creation.
 *
 * Per tg_mvp_plan/06-WORKERS-AND-INGESTION.md §9 rule 7: when a user adds
 * `bit.ly/x` we follow it ONCE to discover the real target (`medium.com/y`)
 * and store the resolved URL. Subsequent fetches use the resolved URL
 * directly — we do NOT follow redirects per fetch (that would re-resolve a
 * shortener thousands of times across the source's lifetime).
 *
 * Failures (timeout, network, max-hop) are NOT fatal: the caller falls back
 * to canonicalizing the raw input URL. Better to have a less-deduped source
 * than to reject the user's input on a transient HEAD failure.
 */

/** Max redirect hops we'll follow. bit.ly + cf-redirect + canonical = 3 hops on a normal day. 5 covers pathological chains. */
const MAX_HOPS = 5;
/** Per-request timeout. Sources behind slow CDNs sometimes need >5s; 10s is the human-tolerance line. */
const DEFAULT_TIMEOUT_MS = 10_000;
/** Polite UA. Includes a contact so a site owner who sees us in logs can reach out. */
const USER_AGENT = 'PostDashBot/1.0 (+https://postdash.dev/bot)';

export interface ResolveRedirectOptions {
  timeoutMs?: number;
  /**
   * `fetch` implementation. Defaults to global `fetch`. Tests inject a mock
   * so the resolver can be unit-tested without network access.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Max redirect hops. Default 5. Tests set lower values to exercise the
   * limit branch without building a 6-link chain.
   */
  maxHops?: number;
}

export type ResolveRedirectStatus =
  | 'resolved'
  | 'no_redirect'
  | 'too_many_hops'
  | 'timeout'
  | 'network_error'
  | 'invalid_input';

export interface ResolveRedirectResult {
  /**
   * Final URL after following redirects, OR the input URL when no redirect
   * occurred OR a failure fallback (callers should canonicalize this either
   * way — the canonicalizer is the truth-source for "what to store").
   */
  finalUrl: string;
  status: ResolveRedirectStatus;
  /**
   * Number of hops actually followed (0 if no redirect, MAX_HOPS if we
   * stopped at the cap). Useful for observability.
   */
  hops: number;
  /**
   * On `timeout` / `network_error`: short, log-safe error message (≤200 chars).
   * Mirrors the channel-connection convention of NOT surfacing stack traces.
   */
  error?: string;
}

/**
 * Follow HTTP redirects for `inputUrl` and return the final URL.
 *
 * Implementation note: we issue a `HEAD` request first because most CDNs
 * answer HEAD with the same redirect chain as GET, and HEAD avoids
 * downloading the body. If HEAD returns 405 / 403 (some servers explicitly
 * disallow HEAD), we fall back to GET with `redirect: 'manual'` so we can
 * inspect the chain without downloading the body more than once.
 *
 * `fetch()` with `redirect: 'follow'` would also work and is simpler, but
 * we'd lose the hop counter, AbortController-driven timeout would still need
 * to be wired by hand, and we couldn't enforce our own MAX_HOPS short of
 * trusting whatever the runtime's default is (Undici defaults to 20, Node's
 * built-in fetch to 20, browsers vary). Doing it by hand keeps the limit
 * deterministic and testable.
 */
export async function resolveRedirect(
  inputUrl: string,
  options: ResolveRedirectOptions = {},
): Promise<ResolveRedirectResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxHops = options.maxHops ?? MAX_HOPS;

  let currentUrl: string;
  try {
    // Trim + scheme-default so the resolver accepts the same inputs as the
    // canonicalizer (saves the caller a pre-validation step).
    const trimmed = inputUrl.trim();
    if (!trimmed) {
      return { finalUrl: inputUrl, status: 'invalid_input', hops: 0 };
    }
    const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    currentUrl = new URL(withScheme).toString();
  } catch {
    return { finalUrl: inputUrl, status: 'invalid_input', hops: 0 };
  }

  let hops = 0;
  while (hops < maxHops) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(currentUrl, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT },
      });
    } catch (err) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === 'AbortError';
      return {
        finalUrl: currentUrl,
        status: isAbort ? 'timeout' : 'network_error',
        hops,
        error: shortErrorMessage(err),
      };
    } finally {
      clearTimeout(timer);
    }

    // HEAD-not-allowed: retry once with GET (same body-discarding semantics
    // via `redirect: 'manual'` + ignored body). Doing this AFTER the HEAD
    // path keeps the common case (HEAD works) on the fast path.
    if (response.status === 405 || response.status === 501) {
      const controller2 = new AbortController();
      const timer2 = setTimeout(() => controller2.abort(), timeoutMs);
      try {
        response = await fetchImpl(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: controller2.signal,
          headers: { 'user-agent': USER_AGENT },
        });
      } catch (err) {
        clearTimeout(timer2);
        const isAbort = err instanceof Error && err.name === 'AbortError';
        return {
          finalUrl: currentUrl,
          status: isAbort ? 'timeout' : 'network_error',
          hops,
          error: shortErrorMessage(err),
        };
      } finally {
        clearTimeout(timer2);
      }
    }

    // Redirect: 3xx with a Location header. Resolve it relative to the
    // current URL (some sites emit relative Location headers).
    const isRedirect = response.status >= 300 && response.status < 400;
    const location = response.headers.get('location');
    if (isRedirect && location) {
      hops++;
      try {
        currentUrl = new URL(location, currentUrl).toString();
      } catch {
        // Malformed Location header → bail with what we have.
        return { finalUrl: currentUrl, status: 'network_error', hops, error: 'invalid_location' };
      }
      continue;
    }

    // Non-redirect response (or redirect with no Location) → done.
    return {
      finalUrl: currentUrl,
      status: hops === 0 ? 'no_redirect' : 'resolved',
      hops,
    };
  }

  // Exceeded MAX_HOPS. Return the LAST URL we were trying to follow so the
  // caller can canonicalize it — better than the original shortener, even if
  // we didn't reach the true terminus.
  return {
    finalUrl: currentUrl,
    status: 'too_many_hops',
    hops,
  };
}

function shortErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message ?? String(err);
    return msg.length > 200 ? msg.slice(0, 200) : msg;
  }
  const s = String(err);
  return s.length > 200 ? s.slice(0, 200) : s;
}

export const _internals = { MAX_HOPS, DEFAULT_TIMEOUT_MS, USER_AGENT };
