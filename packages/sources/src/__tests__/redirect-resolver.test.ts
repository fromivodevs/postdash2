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

describe('resolveRedirect: SSRF defence', () => {
  // SSRF tests force-enable the check (would otherwise be auto-skipped when
  // a mock fetch is injected without an explicit dnsLookup).
  const dnsAllPublic = async () => [{ address: '93.184.216.34', family: 4 } as const];

  it('blocks loopback IPv4 (127.0.0.1) before any fetch', async () => {
    const f = vi.fn();
    const r = await resolveRedirect('http://127.0.0.1/admin', {
      fetch: f,
      skipSsrfCheck: false,
      dnsLookup: dnsAllPublic,
    });
    expect(r.status).toBe('blocked_private_ip');
    expect(r.error).toContain('127.0.0.0/8');
    expect(f).not.toHaveBeenCalled();
  });

  it('blocks AWS metadata endpoint (169.254.169.254) before any fetch', async () => {
    const f = vi.fn();
    const r = await resolveRedirect('http://169.254.169.254/latest/meta-data/', {
      fetch: f,
      skipSsrfCheck: false,
      dnsLookup: dnsAllPublic,
    });
    expect(r.status).toBe('blocked_private_ip');
    expect(r.error).toContain('169.254.0.0/16');
    expect(f).not.toHaveBeenCalled();
  });

  it.each([
    ['http://10.0.0.5/', '10.0.0.0/8'],
    ['http://172.16.5.5/', '172.16.0.0/12'],
    ['http://192.168.1.1/', '192.168.0.0/16'],
  ])('blocks RFC1918 range: %s', async (url, expectedReason) => {
    const f = vi.fn();
    const r = await resolveRedirect(url, {
      fetch: f,
      skipSsrfCheck: false,
      dnsLookup: dnsAllPublic,
    });
    expect(r.status).toBe('blocked_private_ip');
    expect(r.error).toContain(expectedReason);
    expect(f).not.toHaveBeenCalled();
  });

  it('blocks IPv6 loopback ::1', async () => {
    const f = vi.fn();
    const r = await resolveRedirect('http://[::1]/', {
      fetch: f,
      skipSsrfCheck: false,
      dnsLookup: dnsAllPublic,
    });
    expect(r.status).toBe('blocked_private_ip');
    expect(f).not.toHaveBeenCalled();
  });

  it('blocks a redirect hop that targets a private IP (302 → 169.254.x)', async () => {
    const f = mockFetchChain([
      { url: 'https://public.example/', status: 302, location: 'http://169.254.169.254/secrets' },
    ]);
    const r = await resolveRedirect('https://public.example/', {
      fetch: f,
      skipSsrfCheck: false,
      dnsLookup: dnsAllPublic,
    });
    expect(r.status).toBe('blocked_private_ip');
    expect(r.error).toContain('169.254.0.0/16');
  });

  it('allows public IPs when DNS lookup returns a public address', async () => {
    const f = mockFetchChain([{ url: 'https://example.com/', status: 200 }]);
    const r = await resolveRedirect('https://example.com/', {
      fetch: f,
      skipSsrfCheck: false,
      dnsLookup: dnsAllPublic,
    });
    expect(r.status).toBe('no_redirect');
  });

  it.each([
    ['http://[::ffff:127.0.0.1]/', '127.0.0.0/8'],
    ['http://[::ffff:169.254.169.254]/', '169.254.0.0/16'],
    ['http://[::ffff:10.0.0.1]/', '10.0.0.0/8'],
  ])('blocks IPv4-mapped IPv6: %s', async (url, expectedReason) => {
    const f = vi.fn();
    const r = await resolveRedirect(url, {
      fetch: f,
      skipSsrfCheck: false,
      dnsLookup: dnsAllPublic,
    });
    expect(r.status).toBe('blocked_private_ip');
    expect(r.error).toContain(expectedReason);
    expect(f).not.toHaveBeenCalled();
  });

  it.each([
    // ::a.b.c.d form (deprecated IPv4-compat)
    ['http://[::127.0.0.1]/'],
    // WHATWG canonical form ::HHHH:HHHH for the same address (`127.0.0.1` = 0x7f00:0001)
    ['http://[::7f00:1]/'],
  ])('blocks deprecated IPv4-compatible IPv6: %s', async (url) => {
    const f = vi.fn();
    const r = await resolveRedirect(url, {
      fetch: f,
      skipSsrfCheck: false,
      dnsLookup: dnsAllPublic,
    });
    expect(r.status).toBe('blocked_private_ip');
    expect(f).not.toHaveBeenCalled();
  });

  it('detects DNS rebinding: post-fetch resolve drops the pre-check IP', async () => {
    // T0: dns.lookup returns 93.184.216.34 (public) → check passes
    // T1: fetch runs (200 OK)
    // T2: post-fetch dns.lookup returns 10.0.0.1 (private — attacker flipped)
    //     → reject with blocked_private_ip
    let call = 0;
    const dns = async () => {
      call++;
      if (call === 1) return [{ address: '93.184.216.34', family: 4 } as const];
      return [{ address: '10.0.0.1', family: 4 } as const];
    };
    const f = mockFetchChain([{ url: 'https://flippy.example/', status: 200 }]);
    const r = await resolveRedirect('https://flippy.example/', {
      fetch: f,
      skipSsrfCheck: false,
      dnsLookup: dns,
    });
    expect(r.status).toBe('blocked_private_ip');
    expect(r.error).toContain('rebinding');
  });

  it('detects DNS rebinding: NEW private IP appears in the resolved set', async () => {
    // T0: dns returns [public_a]
    // T2: dns returns [public_a, private_b] — old IP still there but a new
    //     private IP was added. Connect might have landed on either.
    let call = 0;
    const dns = async () => {
      call++;
      if (call === 1) return [{ address: '93.184.216.34', family: 4 } as const];
      return [
        { address: '93.184.216.34', family: 4 } as const,
        { address: '169.254.169.254', family: 4 } as const,
      ];
    };
    const f = mockFetchChain([{ url: 'https://hybrid.example/', status: 200 }]);
    const r = await resolveRedirect('https://hybrid.example/', {
      fetch: f,
      skipSsrfCheck: false,
      dnsLookup: dns,
    });
    expect(r.status).toBe('blocked_private_ip');
    expect(r.error).toContain('rebinding');
  });

  it('accepts when post-fetch DNS returns same IP set (no rebinding)', async () => {
    const dns = async () => [{ address: '93.184.216.34', family: 4 } as const];
    const f = mockFetchChain([{ url: 'https://stable.example/', status: 200 }]);
    const r = await resolveRedirect('https://stable.example/', {
      fetch: f,
      skipSsrfCheck: false,
      dnsLookup: dns,
    });
    expect(r.status).toBe('no_redirect');
  });

  it('accepts when post-fetch adds a new PUBLIC IP (load-balancer expansion is not rebinding)', async () => {
    let call = 0;
    const dns = async () => {
      call++;
      if (call === 1) return [{ address: '93.184.216.34', family: 4 } as const];
      return [
        { address: '93.184.216.34', family: 4 } as const,
        // Another public IP — common for load-balanced services.
        { address: '93.184.216.35', family: 4 } as const,
      ];
    };
    const f = mockFetchChain([{ url: 'https://lb.example/', status: 200 }]);
    const r = await resolveRedirect('https://lb.example/', {
      fetch: f,
      skipSsrfCheck: false,
      dnsLookup: dns,
    });
    expect(r.status).toBe('no_redirect');
  });

  it('runs DNS stability check before too_many_hops return (no bypass via max-hop chain)', async () => {
    // dns call sequence for a maxHops=2 chain:
    //   call 1: initial SSRF check on https://a.example/        → public
    //   call 2: per-hop check on https://a.example/2 (hop 1)    → public
    //   call 3: per-hop check on https://a.example/3 (hop 2)    → public
    //   call 4: too_many_hops post-stability check              → PRIVATE (attacker flip)
    // Without the fix, too_many_hops would return without call 4 firing.
    let call = 0;
    const dns = async () => {
      call++;
      if (call < 4) return [{ address: '93.184.216.34', family: 4 } as const];
      return [{ address: '10.0.0.1', family: 4 } as const];
    };
    const f = mockFetchChain([
      { url: 'https://a.example/', status: 301, location: 'https://a.example/2' },
      { url: 'https://a.example/2', status: 301, location: 'https://a.example/3' },
    ]);
    const r = await resolveRedirect('https://a.example/', {
      fetch: f,
      skipSsrfCheck: false,
      dnsLookup: dns,
      maxHops: 2,
    });
    expect(r.status).toBe('blocked_private_ip');
    expect(r.error).toContain('rebinding');
  });

  it('honours a dnsLookup that returns mixed v4+v6 families (authoritative resolve shape)', async () => {
    // The new defaultDnsLookup merges resolve4+resolve6 results; emulate that
    // shape via the injected dnsLookup. Both families public → no block.
    const dns = async () => [
      { address: '93.184.216.34', family: 4 } as const,
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 } as const,
    ];
    const f = mockFetchChain([{ url: 'https://dual.example/', status: 200 }]);
    const r = await resolveRedirect('https://dual.example/', {
      fetch: f,
      skipSsrfCheck: false,
      dnsLookup: dns,
    });
    expect(r.status).toBe('no_redirect');
  });

  it('blocks when v6 record is link-local even if v4 is public (any-private-rejects)', async () => {
    const dns = async () => [
      { address: '93.184.216.34', family: 4 } as const,
      { address: 'fe80::1', family: 6 } as const,
    ];
    const f = vi.fn();
    const r = await resolveRedirect('https://mixed-v6.example/', {
      fetch: f,
      skipSsrfCheck: false,
      dnsLookup: dns,
    });
    expect(r.status).toBe('blocked_private_ip');
    expect(r.error).toContain('fe80::/10');
    expect(f).not.toHaveBeenCalled();
  });

  it('skips DNS stability check for bare-IP hosts (no DNS to rebind)', async () => {
    const dns = vi.fn(); // should not be called
    const f = mockFetchChain([{ url: 'https://93.184.216.34/', status: 200 }]);
    const r = await resolveRedirect('https://93.184.216.34/', {
      fetch: f,
      skipSsrfCheck: false,
      dnsLookup: dns,
    });
    expect(r.status).toBe('no_redirect');
    expect(dns).not.toHaveBeenCalled();
  });

  it('blocks when ANY of multiple DNS addresses is private (mixed A-records)', async () => {
    const mixed = async () => [
      { address: '93.184.216.34', family: 4 } as const,
      { address: '10.0.0.5', family: 4 } as const,
    ];
    const f = vi.fn();
    const r = await resolveRedirect('https://mixed.example/', {
      fetch: f,
      skipSsrfCheck: false,
      dnsLookup: mixed,
    });
    expect(r.status).toBe('blocked_private_ip');
    expect(f).not.toHaveBeenCalled();
  });
});
