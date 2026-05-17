import { describe, expect, it, vi } from 'vitest';
import { IAMTokenCache } from '../iam-token.js';
import { YandexAIStudioDeepSeekProvider } from '../providers/yandex.js';
import { AIProviderError, type ScoreInput } from '../provider.js';

function makeProvider(fetchImpl: typeof globalThis.fetch): YandexAIStudioDeepSeekProvider {
  const iam = new IAMTokenCache('');
  iam._setForTest('test-token', Date.now() + 6 * 60 * 60 * 1000);
  return new YandexAIStudioDeepSeekProvider({
    folderId: 'folder-x',
    llmModelUri: 'gpt://folder-x/llm/latest',
    embedDocModelUri: 'emb://folder-x/text-search-doc/latest',
    embedQueryModelUri: 'emb://folder-x/text-search-query/latest',
    requestTimeoutMs: 5000,
    llmMaxTokens: 2000,
    llmTemperature: 0.3,
    embeddingDim: 256,
    iamToken: iam,
    fetch: fetchImpl,
  });
}

function completion(text: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      result: {
        alternatives: [
          {
            message: { role: 'assistant', text },
            status: 'ALTERNATIVE_STATUS_FINAL',
          },
        ],
        usage: { inputTextTokens: '120', completionTokens: '40', totalTokens: '160' },
        modelVersion: 'v1',
      },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function refused(): Response {
  return new Response(
    JSON.stringify({
      result: {
        alternatives: [
          {
            message: { role: 'assistant', text: '' },
            status: 'ALTERNATIVE_STATUS_CONTENT_FILTER',
          },
        ],
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const baseInput: ScoreInput = {
  workspace_id: '00000000-0000-0000-0000-000000000001',
  language: 'ru',
  topic_profile: {
    id: '00000000-0000-0000-0000-000000000002',
    workspace_id: '00000000-0000-0000-0000-000000000001',
    language: 'ru',
    main_topics: ['AI coding', 'developer tools'],
    keywords: ['cursor', 'copilot'],
    negative_keywords: ['crypto', 'nft'],
    tone_profile: {
      length: 'medium',
      style: 'expert',
      emoji: 'light',
      language: 'ru',
      cta_style: 'soft',
    },
  },
  news: {
    title: 'Cursor releases new AI feature',
    summary: 'Cursor IDE has launched a new feature that helps developers.',
    url: 'https://example.com/article',
    published_at: new Date('2026-05-15T10:00:00Z'),
  },
};

describe('YandexProvider.score', () => {
  it('parses a valid JSON response and clamps score', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      completion(
        JSON.stringify({
          score: 8.4,
          relevance_reason: 'Direct match for AI coding tools topic.',
          should_create_draft: true,
          risk_flags: [],
        }),
      ),
    ) as unknown as typeof globalThis.fetch;
    const p = makeProvider(fetchImpl);
    const r = await p.score(baseInput);
    expect(r.score).toBe(8.4);
    expect(r.relevance_reason).toMatch(/AI coding/);
    expect(r.should_create_draft).toBe(true);
    expect(r.risk_flags).toEqual([]);
    expect(r.used_model).toBe('yandex-deepseek-v3.2');
    expect(r.prompt_version).toMatch(/^yandex-deepseek-score@/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    expect(call[0]).toMatch(/completion$/);
  });

  it('clamps out-of-range score to [0,10]', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      completion(
        JSON.stringify({
          score: 42,
          relevance_reason: 'wild reasoner',
          should_create_draft: false,
          risk_flags: [],
        }),
      ),
    ) as unknown as typeof globalThis.fetch;
    const p = makeProvider(fetchImpl);
    const r = await p.score(baseInput);
    expect(r.score).toBe(10);
  });

  it('truncates over-long relevance_reason to 280 chars', async () => {
    const long = 'a'.repeat(400);
    const fetchImpl = vi.fn().mockResolvedValue(
      completion(
        JSON.stringify({
          score: 5,
          relevance_reason: long,
          should_create_draft: false,
          risk_flags: [],
        }),
      ),
    ) as unknown as typeof globalThis.fetch;
    const p = makeProvider(fetchImpl);
    const r = await p.score(baseInput);
    expect(r.relevance_reason.length).toBeLessThanOrEqual(280);
  });

  it('strips markdown fences when present', async () => {
    const wrapped =
      '```json\n{"score":7,"relevance_reason":"r","should_create_draft":false,"risk_flags":[]}\n```';
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(completion(wrapped)) as unknown as typeof globalThis.fetch;
    const p = makeProvider(fetchImpl);
    const r = await p.score(baseInput);
    expect(r.score).toBe(7);
  });

  it('repair-attempts once on parse failure', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn().mockImplementation(async () => {
      if (calls.length === 0) {
        calls.push('first');
        return completion('not valid json at all');
      }
      calls.push('repair');
      return completion(
        JSON.stringify({
          score: 6,
          relevance_reason: 'ok',
          should_create_draft: false,
          risk_flags: [],
        }),
      );
    }) as unknown as typeof globalThis.fetch;
    const p = makeProvider(fetchImpl);
    const r = await p.score(baseInput);
    expect(r.score).toBe(6);
    expect(calls).toEqual(['first', 'repair']);
  });

  it('throws parse_error when both attempts fail', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(completion('still not json')) as unknown as typeof globalThis.fetch;
    const p = makeProvider(fetchImpl);
    await expect(p.score(baseInput)).rejects.toMatchObject({ code: 'parse_error' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('surfaces ALTERNATIVE_STATUS_CONTENT_FILTER as refused', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(refused()) as unknown as typeof globalThis.fetch;
    const p = makeProvider(fetchImpl);
    await expect(p.score(baseInput)).rejects.toMatchObject({ code: 'refused' });
  });

  it('surfaces risk_flags=["refused"] as refused', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      completion(
        JSON.stringify({
          score: 0,
          relevance_reason: 'refused by model',
          should_create_draft: false,
          risk_flags: ['refused'],
        }),
      ),
    ) as unknown as typeof globalThis.fetch;
    const p = makeProvider(fetchImpl);
    await expect(p.score(baseInput)).rejects.toMatchObject({ code: 'refused' });
  });

  it('maps 500 to server_error and 400 to parse_error', async () => {
    const fetch500 = vi
      .fn()
      .mockResolvedValue(completion('{}', 500)) as unknown as typeof globalThis.fetch;
    await expect(makeProvider(fetch500).score(baseInput)).rejects.toMatchObject({
      code: 'server_error',
    });
    const fetch400 = vi
      .fn()
      .mockResolvedValue(completion('{}', 400)) as unknown as typeof globalThis.fetch;
    await expect(makeProvider(fetch400).score(baseInput)).rejects.toMatchObject({
      code: 'parse_error',
    });
    const fetch429 = vi
      .fn()
      .mockResolvedValue(completion('{}', 429)) as unknown as typeof globalThis.fetch;
    await expect(makeProvider(fetch429).score(baseInput)).rejects.toMatchObject({
      code: 'rate_limit',
    });
  });

  it('throws AIProviderError on network failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error('econnreset')) as unknown as typeof globalThis.fetch;
    await expect(makeProvider(fetchImpl).score(baseInput)).rejects.toBeInstanceOf(AIProviderError);
  });
});
