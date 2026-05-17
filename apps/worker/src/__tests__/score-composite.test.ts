import { describe, expect, it } from 'vitest';
import { computeComposite } from '../handlers/score-workspace-match.js';

describe('computeComposite (score weights)', () => {
  it('produces weighted average per §3 (50/30/10/10)', () => {
    // LLM=8, cosine raw=0.6 → (0.6+1)/2*10 = 8, freshness 1h ago ≈ exp(-1/24)*10 ≈ 9.59,
    // reliability raw=0.8 → 8.
    // weighted = 0.5*8 + 0.3*8 + 0.1*9.59 + 0.1*8 ≈ 8.16.
    const out = computeComposite({
      llm: 8,
      cosineRaw: 0.6,
      publishedAt: new Date(Date.now() - 60 * 60 * 1000),
      reliabilityRaw: 0.8,
    });
    expect(out.llm).toBe(8);
    expect(out.cosine).toBeCloseTo(8, 1);
    expect(out.freshness).toBeGreaterThan(9);
    expect(out.reliability).toBe(8);
    expect(out.weighted).toBeGreaterThan(8);
    expect(out.weighted).toBeLessThan(8.3);
  });

  it('clamps llm component to [0,10]', () => {
    const high = computeComposite({
      llm: 42,
      cosineRaw: 1,
      publishedAt: new Date(),
      reliabilityRaw: 1,
    });
    expect(high.llm).toBe(10);
    expect(high.weighted).toBeLessThanOrEqual(10);
    const low = computeComposite({
      llm: -5,
      cosineRaw: -1,
      publishedAt: new Date('2000-01-01'),
      reliabilityRaw: 0,
    });
    expect(low.llm).toBe(0);
    expect(low.cosine).toBe(0);
    expect(low.freshness).toBe(0);
    expect(low.reliability).toBe(0);
    expect(low.weighted).toBe(0);
  });

  it('uses neutral 5 for missing publishedAt and reliability', () => {
    const out = computeComposite({
      llm: 0,
      cosineRaw: null,
      publishedAt: null,
      reliabilityRaw: null,
    });
    expect(out.cosine).toBe(0);
    expect(out.freshness).toBe(5);
    expect(out.reliability).toBe(5);
    // weighted = 0.5*0 + 0.3*0 + 0.1*5 + 0.1*5 = 1.0
    expect(out.weighted).toBeCloseTo(1, 3);
  });

  it('freshness decays exponentially with hours', () => {
    const oneDay = computeComposite({
      llm: 0,
      cosineRaw: null,
      publishedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      reliabilityRaw: null,
    });
    const oneWeek = computeComposite({
      llm: 0,
      cosineRaw: null,
      publishedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      reliabilityRaw: null,
    });
    expect(oneDay.freshness).toBeGreaterThan(oneWeek.freshness);
    // 24h → e^-1 ≈ 0.367 → ~3.67
    expect(oneDay.freshness).toBeCloseTo(Math.exp(-1) * 10, 1);
  });
});
