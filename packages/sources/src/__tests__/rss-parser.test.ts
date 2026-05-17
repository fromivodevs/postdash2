import { describe, expect, it, vi } from 'vitest';
import { detectLanguage, fetchRssSource } from '../rss-parser.js';

const SAMPLE_RSS = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Sample</title>
    <link>https://example.com</link>
    <description>desc</description>
    <item>
      <title>Hello world</title>
      <link>https://example.com/a</link>
      <description>summary A</description>
      <pubDate>Sat, 02 May 2026 00:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Second</title>
      <link>https://example.com/b</link>
      <description>summary B</description>
      <pubDate>Fri, 01 May 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

function mockFetch(body: string, status = 200): typeof globalThis.fetch {
  return vi
    .fn()
    .mockResolvedValue(
      new Response(body, { status, headers: { 'content-type': 'application/rss+xml' } }),
    ) as unknown as typeof globalThis.fetch;
}

describe('fetchRssSource', () => {
  it('parses RSS feed into items', async () => {
    const r = await fetchRssSource('https://x', { fetch: mockFetch(SAMPLE_RSS) });
    expect(r.status).toBe('ok');
    expect(r.items).toHaveLength(2);
    expect(r.items[0]?.title).toBe('Hello world');
    expect(r.items[0]?.link).toBe('https://example.com/a');
    expect(r.items[0]?.summary).toBe('summary A');
    expect(r.items[0]?.publishedAt).toBeInstanceOf(Date);
  });

  it('caps to maxItems and reports rawCount', async () => {
    const r = await fetchRssSource('https://x', { fetch: mockFetch(SAMPLE_RSS), maxItems: 1 });
    expect(r.status).toBe('ok');
    expect(r.items).toHaveLength(1);
    expect(r.rawCount).toBe(2);
  });

  it('sorts items by publishedAt DESC (fresh first)', async () => {
    const r = await fetchRssSource('https://x', { fetch: mockFetch(SAMPLE_RSS) });
    expect(r.items[0]?.title).toBe('Hello world'); // 2026-05-02 > 2026-05-01
  });

  it('returns 4xx status for HTTP 404', async () => {
    const r = await fetchRssSource('https://x', { fetch: mockFetch('', 404) });
    expect(r.status).toBe('4xx');
    expect(r.items).toHaveLength(0);
  });

  it('returns 5xx status for HTTP 503', async () => {
    const r = await fetchRssSource('https://x', { fetch: mockFetch('', 503) });
    expect(r.status).toBe('5xx');
  });

  it('returns parse_error for malformed XML', async () => {
    const r = await fetchRssSource('https://x', { fetch: mockFetch('<<not-xml>>') });
    expect(r.status).toBe('parse_error');
  });

  it('returns ok with empty items for empty feed', async () => {
    const empty = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title><link>https://x</link><description>d</description></channel></rss>`;
    const r = await fetchRssSource('https://x', { fetch: mockFetch(empty) });
    expect(r.status).toBe('ok');
    expect(r.items).toHaveLength(0);
    expect(r.rawCount).toBe(0);
  });

  it('returns timeout when AbortError fires', async () => {
    const r = await fetchRssSource('https://x', {
      timeoutMs: 1,
      fetch: vi.fn().mockImplementation(
        () =>
          new Promise((_, reject) => {
            const e = new Error('Aborted');
            e.name = 'AbortError';
            setTimeout(() => reject(e), 5);
          }),
      ) as unknown as typeof globalThis.fetch,
    });
    expect(r.status).toBe('timeout');
  });

  it('skips items missing title or link', async () => {
    const partial = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title><link>https://x</link><description>d</description>
      <item><link>https://x/a</link></item>
      <item><title>good</title><link>https://x/b</link></item>
    </channel></rss>`;
    const r = await fetchRssSource('https://x', { fetch: mockFetch(partial) });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.title).toBe('good');
  });
});

describe('detectLanguage', () => {
  it('detects cyrillic-dominated title as ru', () => {
    expect(detectLanguage('Привет мир from Yandex')).toBe('ru');
  });
  it('detects latin-dominated title as en', () => {
    expect(detectLanguage('OpenAI launches GPT-5 model')).toBe('en');
  });
  it('returns other for numbers/punctuation only', () => {
    expect(detectLanguage('12345 ???')).toBe('other');
  });
  it('handles mixed cyrillic+latin (>=30% cyrillic → ru)', () => {
    // 'AI Привет' — 5 latin + 6 cyrillic = 54% cyrillic
    expect(detectLanguage('AI Привет')).toBe('ru');
  });
});
