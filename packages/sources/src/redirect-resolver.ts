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
/** Total budget across all hops, regardless of per-hop timeout. Protects against worst-case max-hops × per-hop seconds. */
const TOTAL_BUDGET_MS = 20_000;
/** Polite UA. Includes a contact so a site owner who sees us in logs can reach out. */
const USER_AGENT = 'PostDashBot/1.0 (+https://postdash.dev/bot)';

// =============================================================================
// SSRF defence
// =============================================================================
//
// The resolver issues HTTP requests to URLs supplied by an authenticated user
// (POST /sources body). Without an IP allowlist this is a textbook SSRF
// surface: an attacker can probe internal services, hit cloud metadata
// endpoints (AWS/GCP/Azure all expose secrets at 169.254.169.254), or scan
// internal CIDR ranges. The block list below covers RFC1918, loopback,
// link-local, IPv6 ULA + loopback, and the cloud metadata addresses
// explicitly. Verified on every hop because a public initial URL can 302 to
// a private IP.

/**
 * Disallowed IP ranges. Hostname → reject if ANY resolved IP falls in here.
 * IPv4 and IPv6 unified. Bare loopback/cloud-metadata addresses listed first
 * for fast match.
 */
const BLOCKED_IPV4_CIDRS: Array<{ network: number; mask: number; label: string }> = [
  { network: 0x7f000000, mask: 0xff000000, label: 'loopback 127.0.0.0/8' },
  { network: 0x0a000000, mask: 0xff000000, label: 'RFC1918 10.0.0.0/8' },
  { network: 0xac100000, mask: 0xfff00000, label: 'RFC1918 172.16.0.0/12' },
  { network: 0xc0a80000, mask: 0xffff0000, label: 'RFC1918 192.168.0.0/16' },
  { network: 0xa9fe0000, mask: 0xffff0000, label: 'link-local 169.254.0.0/16 (incl. cloud metadata)' },
  { network: 0x00000000, mask: 0xff000000, label: '0.0.0.0/8' },
];

function isBlockedIpv4(ipString: string): { blocked: boolean; reason?: string } {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ipString);
  if (!m) return { blocked: false };
  const octets = [m[1], m[2], m[3], m[4]].map((v) => parseInt(v!, 10));
  if (octets.some((o) => o < 0 || o > 255)) return { blocked: true, reason: 'invalid octet' };
  const ip = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  for (const range of BLOCKED_IPV4_CIDRS) {
    if ((ip & range.mask) === (range.network & range.mask)) {
      return { blocked: true, reason: range.label };
    }
  }
  return { blocked: false };
}

function isBlockedIpv6(ipString: string): { blocked: boolean; reason?: string } {
  const lower = ipString.toLowerCase();
  // Bare loopback / unspecified.
  if (lower === '::1' || lower === '::') {
    return { blocked: true, reason: `IPv6 ${lower}` };
  }
  // Unique-local fc00::/7 → first byte 0xfc or 0xfd.
  if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return { blocked: true, reason: 'IPv6 ULA fc00::/7' };
  // Link-local fe80::/10.
  if (/^fe[89ab][0-9a-f]?:/.test(lower)) {
    return { blocked: true, reason: 'IPv6 link-local fe80::/10' };
  }
  // IPv4-mapped IPv6 (::ffff:1.2.3.4) — extract and check the IPv4. WHATWG
  // URL also normalizes this to hex form (::ffff:7f00:1) — handle both.
  const v4mappedDotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(lower);
  if (v4mappedDotted) {
    return isBlockedIpv4(v4mappedDotted[1]!);
  }
  const v4mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(lower);
  if (v4mappedHex) {
    const high = parseInt(v4mappedHex[1]!, 16);
    const low = parseInt(v4mappedHex[2]!, 16);
    if (high <= 0xffff && low <= 0xffff) {
      const dotted = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
      const check = isBlockedIpv4(dotted);
      if (check.blocked) {
        return { blocked: true, reason: `IPv4-mapped IPv6 → ${check.reason}` };
      }
    }
  }
  // IPv4-compatible IPv6 (deprecated RFC 4291 §2.5.5.1, but historically
  // routable to loopback on some stacks): `::a.b.c.d` form, and the WHATWG
  // canonical form `::HHHH:HHHH` where the last 32 bits encode the IPv4.
  // Match `::a.b.c.d` directly:
  const v4compatDotted = /^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(lower);
  if (v4compatDotted) {
    return isBlockedIpv4(v4compatDotted[1]!);
  }
  // Match `::HHHH:HHHH` (e.g. `::7f00:1` for 127.0.0.1) — combine the two
  // hex words into a dotted-quad and check.
  const v4compatHex = /^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(lower);
  if (v4compatHex) {
    const high = parseInt(v4compatHex[1]!, 16);
    const low = parseInt(v4compatHex[2]!, 16);
    if (high <= 0xffff && low <= 0xffff) {
      const dotted = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
      const check = isBlockedIpv4(dotted);
      if (check.blocked) {
        return { blocked: true, reason: `IPv4-compatible IPv6 → ${check.reason}` };
      }
    }
  }
  return { blocked: false };
}

/**
 * Resolve the URL's hostname to IPs and reject if any falls in a blocked
 * range. Bare-IP hostnames are checked without DNS. Real hostnames go
 * through `dns.lookup` (verbatim={all:true}) and ALL returned addresses
 * must pass — a multi-A-record host with one private IP is rejected.
 *
 * On DNS lookup failure we fail OPEN (let the fetch attempt fail
 * naturally with `network_error`) so a transient DNS hiccup doesn't
 * masquerade as a security block. The fetch itself can never reach a
 * private IP if DNS failed, so this is safe.
 */
type DnsLookupFn = (host: string) => Promise<Array<{ address: string; family: number }>>;

async function defaultDnsLookup(host: string): Promise<Array<{ address: string; family: number }>> {
  // Lazy import keeps the module browser-safe (the resolver is server-only
  // but `@postdash/sources` is also imported by command-layer code that
  // runs in Vitest's jsdom env in some test scenarios).
  const dns = await import('node:dns');
  return dns.promises.lookup(host, { all: true });
}

/**
 * Snapshot of the resolved IPs for a hostname. Captured before fetch so a
 * post-fetch re-resolve can detect DNS rebinding (attacker flipped DNS
 * between our check and the fetch's TCP connect). Bare-IP hostnames return
 * an empty set — there is no DNS to rebind.
 */
export interface ResolvedHostSnapshot {
  hostname: string;
  resolvedIps: ReadonlyArray<string>;
}

/**
 * Compares a pre-fetch snapshot against a fresh resolve. If the IP set
 * changed, an attacker may have flipped DNS during the fetch window (or
 * legitimate failover happened — we conservatively treat both as rebinding).
 */
async function checkDnsStability(
  snapshot: ResolvedHostSnapshot,
  dnsLookup: DnsLookupFn,
): Promise<{ stable: true } | { stable: false; reason: string }> {
  if (snapshot.resolvedIps.length === 0) return { stable: true }; // bare-IP host
  try {
    const records = await dnsLookup(snapshot.hostname);
    const after = new Set(records.map((r) => r.address));
    for (const ip of snapshot.resolvedIps) {
      if (!after.has(ip)) {
        return {
          stable: false,
          reason: `DNS rebinding detected: ${ip} → no longer resolved`,
        };
      }
    }
    // Also flag NEWLY-introduced IPs as suspicious (the connect could have
    // landed on them mid-fetch). Reject only if a new IP is private.
    for (const ip of after) {
      if (!snapshot.resolvedIps.includes(ip)) {
        const check = isBlockedIpv4(ip).blocked
          ? isBlockedIpv4(ip)
          : isBlockedIpv6(ip);
        if (check.blocked) {
          return {
            stable: false,
            reason: `DNS rebinding: new private IP appeared: ${check.reason}`,
          };
        }
      }
    }
    return { stable: true };
  } catch {
    // Re-resolve failed → conservative: treat as unstable.
    return { stable: false, reason: 'post-fetch DNS lookup failed' };
  }
}

async function checkUrlNotPrivate(
  url: string,
  dnsLookup: DnsLookupFn,
): Promise<{ ok: true; snapshot: ResolvedHostSnapshot } | { ok: false; reason: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid url' };
  }
  // Only http(s) is in scope. Other schemes are also a soft-block; the loop
  // already constrains to http(s) but a redirect Location: file://... could
  // theoretically reach here.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: `scheme ${parsed.protocol} not allowed` };
  }
  // WHATWG URL returns IPv6 hostnames bracketed (`[::1]`). Strip brackets
  // before pattern-matching so the bare-IP fast path matches.
  const rawHost = parsed.hostname;
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  // Bare-IPv4 fast path.
  const v4 = isBlockedIpv4(host);
  if (v4.blocked) return { ok: false, reason: `private/internal IPv4: ${v4.reason}` };
  // Bare-IPv6 fast path.
  if (host.includes(':')) {
    const v6 = isBlockedIpv6(host);
    if (v6.blocked) return { ok: false, reason: `private/internal IPv6: ${v6.reason}` };
  }
  // Real hostname: resolve and check every address. Capture the IP set in
  // the snapshot so a post-fetch re-resolve can detect DNS rebinding.
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) && !host.includes(':')) {
    try {
      const records = await dnsLookup(host);
      for (const record of records) {
        const check = record.family === 6 ? isBlockedIpv6(record.address) : isBlockedIpv4(record.address);
        if (check.blocked) {
          return { ok: false, reason: `DNS resolved to private/internal IP: ${check.reason}` };
        }
      }
      return {
        ok: true,
        snapshot: { hostname: host, resolvedIps: records.map((r) => r.address) },
      };
    } catch {
      // DNS failure → fail open; the subsequent fetch will get network_error
      // and the caller falls back to canonicalizing the raw URL.
      return { ok: true, snapshot: { hostname: host, resolvedIps: [] } };
    }
  }
  // Bare-IP host (no DNS to rebind).
  return { ok: true, snapshot: { hostname: host, resolvedIps: [] } };
}

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
  /**
   * DNS lookup function. Defaults to `dns.promises.lookup`. Tests inject a
   * no-op (returns localhost is OK) so the SSRF check doesn't make real
   * network calls. Production code always uses the default.
   */
  dnsLookup?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  /**
   * Skip the SSRF check entirely. ONLY for tests that explicitly want to
   * exercise pre-guard logic with mock URLs that would otherwise be DNS-
   * resolved (e.g. example.com in vitest). Production callers leave this
   * undefined; the default behaviour blocks private IPs.
   */
  skipSsrfCheck?: boolean;
}

export type ResolveRedirectStatus =
  | 'resolved'
  | 'no_redirect'
  | 'too_many_hops'
  | 'timeout'
  | 'network_error'
  | 'invalid_input'
  /** SSRF guard rejected the URL (or a redirect hop) — private/internal IP. */
  | 'blocked_private_ip';

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
  const dnsLookup = options.dnsLookup ?? defaultDnsLookup;
  // Auto-skip SSRF check when a custom fetch is injected without an explicit
  // dnsLookup — that's the unit-test shape (mock fetch, real-world hostnames
  // like example.com that the test never wants resolved).
  const skipSsrfCheck =
    options.skipSsrfCheck ?? (options.fetch !== undefined && options.dnsLookup === undefined);

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

  // SSRF gate on the initial URL. Done BEFORE any fetch so a malicious
  // direct-private-IP input never causes outbound traffic.
  let currentSnapshot: ResolvedHostSnapshot | null = null;
  if (!skipSsrfCheck) {
    const initialCheck = await checkUrlNotPrivate(currentUrl, dnsLookup);
    if (!initialCheck.ok) {
      return { finalUrl: currentUrl, status: 'blocked_private_ip', hops: 0, error: initialCheck.reason };
    }
    currentSnapshot = initialCheck.snapshot;
  }

  // Total-budget timer across all hops. Worst case otherwise is
  // MAX_HOPS × DEFAULT_TIMEOUT_MS = 50s; the resolver runs synchronously in
  // a route handler so a 50s block is a real UX hazard.
  const totalDeadline = Date.now() + TOTAL_BUDGET_MS;

  let hops = 0;
  while (hops < maxHops) {
    const remainingBudget = totalDeadline - Date.now();
    if (remainingBudget <= 0) {
      return { finalUrl: currentUrl, status: 'timeout', hops, error: 'total budget exhausted' };
    }
    const effectiveTimeout = Math.min(timeoutMs, remainingBudget);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);
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

    // HEAD-not-allowed: retry once with GET. Cancel the body immediately so
    // a malicious server that streams a multi-GB response on GET cannot
    // exhaust memory before the timeout fires.
    if (response.status === 405 || response.status === 501) {
      const remainingForGet = totalDeadline - Date.now();
      if (remainingForGet <= 0) {
        return { finalUrl: currentUrl, status: 'timeout', hops, error: 'total budget exhausted' };
      }
      const controller2 = new AbortController();
      const timer2 = setTimeout(() => controller2.abort(), Math.min(timeoutMs, remainingForGet));
      try {
        response = await fetchImpl(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: controller2.signal,
          headers: { 'user-agent': USER_AGENT },
        });
        // Drop body immediately — we only care about status + Location header.
        // Without this the runtime buffers the response body until GC.
        try {
          await response.body?.cancel();
        } catch {
          // body cancel can throw if already consumed; ignore.
        }
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
      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        // Malformed Location header → bail with what we have.
        return { finalUrl: currentUrl, status: 'network_error', hops, error: 'invalid_location' };
      }
      // SSRF re-check: a public initial URL can 302 to a private IP. Verify
      // every hop, not just the input. Refresh the snapshot for stability
      // check on the next iteration.
      if (!skipSsrfCheck) {
        const hopCheck = await checkUrlNotPrivate(nextUrl, dnsLookup);
        if (!hopCheck.ok) {
          return {
            finalUrl: nextUrl,
            status: 'blocked_private_ip',
            hops,
            error: hopCheck.reason,
          };
        }
        currentSnapshot = hopCheck.snapshot;
      }
      currentUrl = nextUrl;
      continue;
    }

    // Non-redirect response (or redirect with no Location) → done.
    // DNS rebinding post-check: re-resolve and verify the IP set is stable.
    // If the attacker flipped DNS between our pre-fetch check and the actual
    // connect, the post-resolve will show different IPs and we reject.
    if (!skipSsrfCheck && currentSnapshot && currentSnapshot.resolvedIps.length > 0) {
      const stability = await checkDnsStability(currentSnapshot, dnsLookup);
      if (!stability.stable) {
        return {
          finalUrl: currentUrl,
          status: 'blocked_private_ip',
          hops,
          error: stability.reason,
        };
      }
    }
    return {
      finalUrl: currentUrl,
      status: hops === 0 ? 'no_redirect' : 'resolved',
      hops,
    };
  }

  // Exceeded MAX_HOPS. Stability check still runs — otherwise a 5-redirect
  // chain bypasses post-fetch rebinding detection on the final touched hop
  // (security audit round 5 catch).
  if (!skipSsrfCheck && currentSnapshot && currentSnapshot.resolvedIps.length > 0) {
    const stability = await checkDnsStability(currentSnapshot, dnsLookup);
    if (!stability.stable) {
      return {
        finalUrl: currentUrl,
        status: 'blocked_private_ip',
        hops,
        error: stability.reason,
      };
    }
  }
  // Return the LAST URL we were trying to follow so the caller can canonicalize
  // it — better than the original shortener, even if we didn't reach the true
  // terminus.
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
