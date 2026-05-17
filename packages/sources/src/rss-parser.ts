/**
 * RSS/Atom feed fetcher for Phase 4 `fetch_source` task handler.
 *
 * Thin wrapper over the `rss-parser` package — adds:
 *   1. AbortController-driven timeout (default 15s).
 *   2. Polite UA + redirect: 'follow' so we don't reinvent the redirect chain.
 *   3. Volume cap (`maxItems`) so a 500-item history dump on first fetch
 *      can't blow up the downstream pipeline.
 *   4. Status classification: 'ok' / '4xx' / '5xx' / 'parse_error' / 'timeout'
 *      / 'network_error' — matches `sources.last_fetch_status` CHECK.
 *
 * Returns ParsedItem[] WITHOUT canonicalization or content-hashing. Those
 * are handler-owned steps so the handler can also do the upsert and
 * `was_updated` detection within the same transaction.
 *
 * Edge cases covered (per tg_mvp_plan/12-EDGE-CASES.md §4):
 *   - 4.1 invalid XML / 4xx / 5xx → status reflects, items=[]
 *   - 4.3 feed flood → maxItems cap, rawCount preserved
 *   - 4.4 empty feed → status='ok', items=[], rawCount=0
 *   - 4.8 paywalled (no extracted_text in RSS) → summary fallback, item still yielded
 *
 * SSRF defence: this fetcher does NOT replicate the full SSRF dance from
 * `redirect-resolver.ts`. RSS sources are user-supplied at creation time
 * and pass through the redirect resolver's allowlist before being saved
 * to `sources.url`. Subsequent fetches use the stored URL; an attacker
 * who can mutate that row already controls the workspace's database. (A
 * follow-up Phase 4+ hardening can layer the same SSRF gate here using
 * `ResolvedHostSnapshot` from redirect-resolver.)
 */

// `rss-parser` ships CJS default-export. With NodeNext + esModuleInterop,
// `import Parser from 'rss-parser'` resolves to the constructor.
import Parser from 'rss-parser';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ITEMS = 50;
const USER_AGENT = 'PostDashBot/1.0 (+https://postdash.dev/bot)';

export interface ParsedItem {
  title: string;
  link: string;
  summary?: string;
  publishedAt?: Date;
  /** 'ru' | 'en' | 'other' heuristic. cyrillic count > 30% of letters → 'ru'. */
  language?: string;
}

export type FetchStatus = 'ok' | '4xx' | '5xx' | 'parse_error' | 'timeout' | 'network_error';

export interface FetchResult {
  status: FetchStatus;
  items: ParsedItem[];
  /** Pre-cap item count — for `tasks.status='skipped_volume_cap'` accounting. */
  rawCount: number;
  /** Short, log-safe error label (≤200 chars). Mirrors sources.last_fetch_error. */
  error?: string;
}

export interface FetchOptions {
  timeoutMs?: number;
  /** Injectable for tests. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  maxItems?: number;
}

export async function fetchRssSource(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxItems = opts.maxItems ?? DEFAULT_MAX_ITEMS;

  // Step 1: fetch the feed body with timeout. We do this manually instead of
  // letting `rss-parser` use its own request implementation — the package's
  // built-in fetcher uses `node:http`, which has no AbortController integration
  // before Node 20, and we can't inject a mock for unit tests.
  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/rss+xml, application/xml, text/xml, */*',
      },
    });
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      status: isAbort ? 'timeout' : 'network_error',
      items: [],
      rawCount: 0,
      error: shortMessage(err),
    };
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 500) {
    return { status: '5xx', items: [], rawCount: 0, error: `http ${response.status}` };
  }
  if (response.status >= 400) {
    return { status: '4xx', items: [], rawCount: 0, error: `http ${response.status}` };
  }

  let body: string;
  try {
    body = await response.text();
  } catch (err) {
    return { status: 'network_error', items: [], rawCount: 0, error: shortMessage(err) };
  }

  // Step 2: parse the XML.
  const parser = new Parser({
    timeout: timeoutMs,
    headers: { 'user-agent': USER_AGENT },
  });
  let feed: { items?: Array<Record<string, unknown>> };
  try {
    feed = await parser.parseString(body);
  } catch (err) {
    return { status: 'parse_error', items: [], rawCount: 0, error: shortMessage(err) };
  }

  const rawItems = feed.items ?? [];
  // Sort by published_at DESC so the cap takes the freshest items (matches
  // §10 step 4 of 06-WORKERS-AND-INGESTION.md). Items without dates sort
  // last — they're either older OR malformed; either way newer-dated wins.
  const dated = rawItems
    .map((raw) => normalizeItem(raw))
    .filter((it): it is ParsedItem => it !== null);
  dated.sort((a, b) => {
    const aTs = a.publishedAt?.getTime() ?? 0;
    const bTs = b.publishedAt?.getTime() ?? 0;
    return bTs - aTs;
  });

  return {
    status: 'ok',
    items: dated.slice(0, maxItems),
    rawCount: dated.length,
  };
}

function normalizeItem(raw: Record<string, unknown>): ParsedItem | null {
  // `rss-parser` field names vary by feed format (RSS 2.0, Atom). The wrapper
  // already harmonises common ones to `title` / `link` / `pubDate` /
  // `contentSnippet`, but we re-check defensively.
  const title = strField(raw, 'title');
  const link = strField(raw, 'link');
  if (!title || !link) return null;

  const summary =
    strField(raw, 'contentSnippet') ?? strField(raw, 'summary') ?? strField(raw, 'description');
  const dateRaw =
    strField(raw, 'isoDate') ?? strField(raw, 'pubDate') ?? strField(raw, 'published');
  let publishedAt: Date | undefined;
  if (dateRaw) {
    const t = Date.parse(dateRaw);
    if (Number.isFinite(t)) publishedAt = new Date(t);
  }

  const item: ParsedItem = {
    title,
    link,
    language: detectLanguage(title),
  };
  if (summary !== undefined) item.summary = summary;
  if (publishedAt !== undefined) item.publishedAt = publishedAt;
  return item;
}

function strField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Cheap language heuristic by title: count cyrillic letters / total letters.
 *  ≥30% cyrillic → 'ru', else 'en'.  No-letters case (numbers, URLs) → 'other'.
 *
 * Reused by the fetch handler to populate `global_news_items.language`.
 * Mixed-language feeds (title 'ru', body 'en') still embed correctly via
 * Yandex's robust embedding model (edge 5.5/11.2/11.6).
 */
export function detectLanguage(text: string): 'ru' | 'en' | 'other' {
  let cyr = 0;
  let lat = 0;
  for (const ch of text) {
    if (/[А-Яа-яЁё]/.test(ch)) cyr++;
    else if (/[A-Za-z]/.test(ch)) lat++;
  }
  const total = cyr + lat;
  if (total === 0) return 'other';
  return cyr / total >= 0.3 ? 'ru' : 'en';
}

function shortMessage(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message ?? String(err);
    return msg.length > 200 ? msg.slice(0, 200) : msg;
  }
  const s = String(err);
  return s.length > 200 ? s.slice(0, 200) : s;
}
