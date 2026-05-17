import { describe, expect, it } from 'vitest';
import { canonicalize, CANONICALIZATION_RULE_VERSION } from '../canonicalize.js';

describe('canonicalize: basics', () => {
  it('returns null for empty input', () => {
    expect(canonicalize('').canonical).toBeNull();
    expect(canonicalize('   ').canonical).toBeNull();
  });

  it('returns null for unparseable input', () => {
    expect(canonicalize('not a url at all !!!').canonical).toBeNull();
  });

  it('rejects non-http(s) schemes', () => {
    expect(canonicalize('ftp://example.com/feed').canonical).toBeNull();
    expect(canonicalize('mailto:test@example.com').canonical).toBeNull();
  });

  it('always stamps the current rule version', () => {
    const r = canonicalize('https://example.com/');
    expect(r.ruleVersion).toBe(CANONICALIZATION_RULE_VERSION);
  });
});

describe('canonicalize: rules 1–5 (generic normalization)', () => {
  it('rule 1: forces https and accepts schemeless input', () => {
    expect(canonicalize('http://example.com/foo').canonical).toBe('https://example.com/foo');
    expect(canonicalize('example.com/foo').canonical).toBe('https://example.com/foo');
  });

  it('rule 2: lowercases host, strips leading www., keeps m. subdomain', () => {
    expect(canonicalize('https://WWW.Example.COM/foo').canonical).toBe('https://example.com/foo');
    expect(canonicalize('https://www.example.com/foo').canonical).toBe('https://example.com/foo');
    // m.example.com is a different site (mobile), NOT a www-style alias.
    expect(canonicalize('https://m.example.com/foo').canonical).toBe('https://m.example.com/foo');
  });

  it('rule 3: strips trailing slash but keeps bare /', () => {
    expect(canonicalize('https://example.com/foo/').canonical).toBe('https://example.com/foo');
    expect(canonicalize('https://example.com/').canonical).toBe('https://example.com/');
    expect(canonicalize('https://example.com').canonical).toBe('https://example.com/');
  });

  it('rule 4: drops utm_*, fbclid, gclid, yclid, ref params', () => {
    const out = canonicalize(
      'https://example.com/post?utm_source=x&utm_medium=y&fbclid=abc&gclid=def&yclid=ghi&id=42',
    ).canonical;
    expect(out).toBe('https://example.com/post?id=42');
  });

  it('rule 4: drops Mailchimp, Hubspot, Instagram, Spotify tracking params', () => {
    const out = canonicalize(
      'https://example.com/post?mc_cid=1&mc_eid=2&_hsenc=3&_hsmi=4&igshid=5&si=6&id=42',
    ).canonical;
    expect(out).toBe('https://example.com/post?id=42');
  });

  it('rule 4: drops vendor-specific utm_* extensions via prefix match', () => {
    const out = canonicalize('https://example.com/post?utm_brand=foo&utm_xyz=bar&id=7').canonical;
    expect(out).toBe('https://example.com/post?id=7');
  });

  it('rule 4: alphabetizes remaining query params', () => {
    const out = canonicalize('https://example.com/p?z=1&a=2&m=3').canonical;
    expect(out).toBe('https://example.com/p?a=2&m=3&z=1');
  });

  it('rule 4: keeps content-defining params (id, p, slug, date)', () => {
    const out = canonicalize('https://example.com/p?id=42&slug=hello&date=2026-05-17').canonical;
    expect(out).toBe('https://example.com/p?date=2026-05-17&id=42&slug=hello');
  });

  it('rule 5: always drops fragment', () => {
    expect(canonicalize('https://example.com/page#section').canonical).toBe(
      'https://example.com/page',
    );
    expect(canonicalize('https://example.com/page?a=1#top').canonical).toBe(
      'https://example.com/page?a=1',
    );
  });

  it('drops default ports :80 / :443 after scheme normalization', () => {
    expect(canonicalize('http://example.com:80/foo').canonical).toBe('https://example.com/foo');
    expect(canonicalize('https://example.com:443/foo').canonical).toBe('https://example.com/foo');
  });

  it('keeps non-default ports', () => {
    expect(canonicalize('https://example.com:8080/foo').canonical).toBe(
      'https://example.com:8080/foo',
    );
  });
});

describe('canonicalize: rule 6 (site overrides)', () => {
  it('news.ycombinator.com → /item?id=<id> only (drops pagination, fragments)', () => {
    const r = canonicalize('https://news.ycombinator.com/item?id=12345&p=2#42');
    expect(r.canonical).toBe('https://news.ycombinator.com/item?id=12345');
    expect(r.appliedOverride).toBe(true);
  });

  it('news.ycombinator.com: non-numeric id falls back to generic', () => {
    const r = canonicalize('https://news.ycombinator.com/item?id=abc');
    expect(r.appliedOverride).toBe(false);
    expect(r.canonical).toContain('news.ycombinator.com/item?id=abc');
  });

  it('reddit.com/r/<sub>/comments/<id>/<slug>/ → /comments/<id>', () => {
    const r = canonicalize('https://reddit.com/r/programming/comments/abc12/hello_world/');
    expect(r.canonical).toBe('https://reddit.com/comments/abc12');
    expect(r.appliedOverride).toBe(true);
  });

  it('old.reddit.com and new.reddit.com both collapse to canonical', () => {
    expect(canonicalize('https://old.reddit.com/r/x/comments/aaa/title').canonical).toBe(
      'https://reddit.com/comments/aaa',
    );
    expect(canonicalize('https://new.reddit.com/r/x/comments/bbb/title/').canonical).toBe(
      'https://reddit.com/comments/bbb',
    );
  });

  it('twitter.com and x.com both collapse to x.com', () => {
    expect(canonicalize('https://twitter.com/user/status/1234567').canonical).toBe(
      'https://x.com/user/status/1234567',
    );
    expect(canonicalize('https://x.com/user/status/1234567?s=20').canonical).toBe(
      'https://x.com/user/status/1234567',
    );
    expect(canonicalize('https://mobile.twitter.com/user/status/1234567').canonical).toBe(
      'https://x.com/user/status/1234567',
    );
  });

  it('appliedOverride=false for non-matching paths on override hosts', () => {
    expect(canonicalize('https://x.com/explore').appliedOverride).toBe(false);
    expect(canonicalize('https://news.ycombinator.com/news').appliedOverride).toBe(false);
  });
});

describe('canonicalize: idempotence (same URL twice → same canonical)', () => {
  it('two URL forms of the same article collapse', () => {
    const a = canonicalize('http://www.Example.com/article?utm_source=foo&id=42#top').canonical;
    const b = canonicalize('https://example.com/article?id=42').canonical;
    expect(a).toBe(b);
  });

  it('canonicalizing the canonical form returns the same string', () => {
    const first = canonicalize('https://example.com/post?utm_source=x&id=7').canonical;
    expect(first).not.toBeNull();
    const second = canonicalize(first as string).canonical;
    expect(second).toBe(first);
  });
});
