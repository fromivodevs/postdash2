import { describe, expect, it, vi } from 'vitest';
import { resolveRedirect } from '../redirect-resolver.js';

function mockFetchChain(steps: Array<{ url: string; status: number; location?: string }>) {
  let i = 0;
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const step = steps[i++];
    if (!step) {
      throw new Error(`unexpected extra fetch to ${url}`);
    }
    // Loose URL match: tests assert the chain by order, not by exact path.
    expect(url.startsWith(step.url)).toBe(true);
    const headers = new Headers();
    if (step.location) headers.set('location', step.location);
    return new Response(null, { status: step.status, headers });
  });
}

describe('resolveRedirect', () => {
  it('returns no_redirect for a 200 with hops=0', async () => {
    const f = mockFetchChain([{ url: 'https://example.com/', status: 200 }]);
    const r = await resolveRedirect('https://example.com/', { fetch: f });
    expect(r.status).toBe('no_redirect');
    expect(r.hops).toBe(0);
    expect(r.finalUrl).toBe('https://example.com/');
  });

  it('follows a single 301 redirect', async () => {
    const f = mockFetchChain([
      { url: 'https://bit.ly/x', status: 301, location: 'https://medium.com/y' },
      { url: 'https://medium.com/y', status: 200 },
    ]);
    const r = await resolveRedirect('https://bit.ly/x', { fetch: f });
    expect(r.status).toBe('resolved');
    expect(r.hops).toBe(1);
    expect(r.finalUrl).toBe('https://medium.com/y');
  });

  it('follows a chain of redirects within maxHops', async () => {
    const f = mockFetchChain([
      { url: 'https://t.co/a', status: 302, location: 'https://link.example/1' },
      { url: 'https://link.example/1', status: 301, location: 'https://final.example/post' },
      { url: 'https://final.example/post', status: 200 },
    ]);
    const r = await resolveRedirect('https://t.co/a', { fetch: f });
    expect(r.status).toBe('resolved');
    expect(r.hops).toBe(2);
    expect(r.finalUrl).toBe('https://final.example/post');
  });

  it('caps at maxHops and returns too_many_hops', async () => {
    const f = mockFetchChain([
      { url: 'https://a.example/', status: 301, location: 'https://b.example/' },
      { url: 'https://b.example/', status: 301, location: 'https://c.example/' },
      { url: 'https://c.example/', status: 301, location: 'https://d.example/' },
    ]);
    const r = await resolveRedirect('https://a.example/', { fetch: f, maxHops: 2 });
    expect(r.status).toBe('too_many_hops');
    expect(r.hops).toBe(2);
    expect(r.finalUrl).toBe('https://c.example/');
  });

  it('resolves a relative Location header against the current URL', async () => {
    const f = mockFetchChain([
      { url: 'https://example.com/old', status: 301, location: '/new' },
      { url: 'https://example.com/new', status: 200 },
    ]);
    const r = await resolveRedirect('https://example.com/old', { fetch: f });
    expect(r.status).toBe('resolved');
    expect(r.finalUrl).toBe('https://example.com/new');
  });

  it('retries with GET when HEAD returns 405', async () => {
    const f = mockFetchChain([
      { url: 'https://strict.example/', status: 405 },
      { url: 'https://strict.example/', status: 200 },
    ]);
    const r = await resolveRedirect('https://strict.example/', { fetch: f });
    expect(r.status).toBe('no_redirect');
    expect(r.hops).toBe(0);
  });

  it('classifies a network error as network_error and returns the input URL', async () => {
    const f = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const r = await resolveRedirect('https://offline.example/', { fetch: f });
    expect(r.status).toBe('network_error');
    expect(r.error).toContain('ECONNREFUSED');
    expect(r.finalUrl).toBe('https://offline.example/');
  });

  it('classifies an aborted request as timeout', async () => {
    const f = vi.fn(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const r = await resolveRedirect('https://slow.example/', { fetch: f, timeoutMs: 1 });
    expect(r.status).toBe('timeout');
  });

  it('returns invalid_input for unparseable URL', async () => {
    const f = vi.fn();
    const r = await resolveRedirect('not a url ::: at all', { fetch: f });
    expect(r.status).toBe('invalid_input');
    expect(f).not.toHaveBeenCalled();
  });

  it('returns invalid_input for empty / whitespace input without fetching', async () => {
    const f = vi.fn();
    const r = await resolveRedirect('   ', { fetch: f });
    expect(r.status).toBe('invalid_input');
    expect(f).not.toHaveBeenCalled();
  });

  it('defaults schemeless input to https before resolving', async () => {
    const f = mockFetchChain([{ url: 'https://example.com/', status: 200 }]);
    const r = await resolveRedirect('example.com', { fetch: f });
    expect(r.status).toBe('no_redirect');
    expect(r.finalUrl).toBe('https://example.com/');
  });
});
