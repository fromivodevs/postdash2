import { describe, expect, it } from 'vitest';
import { TELEGRAM_POST_MAX_LENGTH } from '@postdash/shared';
import { TemplateProvider } from '../providers/template.js';
import {
  AIProviderError,
  DraftOutputSchema,
  ScoreOutputSchema,
  type DraftInput,
  type ScoreInput,
} from '../provider.js';

const WORKSPACE = '11111111-1111-1111-1111-111111111111';
const TOPIC_ID = '22222222-2222-2222-2222-222222222222';

const baseTopic = {
  id: TOPIC_ID,
  workspace_id: WORKSPACE,
  language: 'ru' as const,
  main_topics: ['AI'],
  keywords: ['DeepSeek'],
  negative_keywords: [],
  tone_profile: {
    length: 'medium' as const,
    style: 'expert' as const,
    emoji: 'light' as const,
    language: 'ru' as const,
    cta_style: 'soft' as const,
  },
};

const baseNews = {
  title: 'DeepSeek 3.2 в Yandex AI Studio',
  url: 'https://example.com/news/deepseek-32',
  summary: 'Yandex добавил DeepSeek 3.2 в свой Foundation Models каталог.',
};

describe('TemplateProvider', () => {
  const provider = new TemplateProvider();

  it('has stable name', () => {
    expect(provider.name).toBe('template');
  });

  it('score returns fallback marker', async () => {
    const input: ScoreInput = {
      workspace_id: WORKSPACE,
      topic_profile: baseTopic,
      news: baseNews,
      language: 'ru',
    };
    const out = await provider.score(input);
    const parsed = ScoreOutputSchema.parse(out);
    expect(parsed.score).toBe(5);
    expect(parsed.should_create_draft).toBe(false);
    expect(parsed.risk_flags).toContain('fallback');
  });

  it('generateDraft returns Format A with source URL', async () => {
    const input: DraftInput = {
      workspace_id: WORKSPACE,
      topic_profile: baseTopic,
      tone_profile: baseTopic.tone_profile,
      news: baseNews,
      format: 'short_news',
      language: 'ru',
    };
    const out = await provider.generateDraft(input);
    const parsed = DraftOutputSchema.parse(out);
    expect(parsed.post_text).toContain(baseNews.title);
    expect(parsed.post_text).toContain(baseNews.url);
    expect(parsed.source_links).toContain(baseNews.url);
    expect(parsed.risk_flags).toContain('fallback');
  });

  it('embed throws not_implemented', async () => {
    await expect(provider.embed({ text: 'hi', kind: 'doc' })).rejects.toBeInstanceOf(
      AIProviderError,
    );
  });

  it('generateDraft truncates very long extracted_text', async () => {
    const longText = 'a'.repeat(2000);
    const input: DraftInput = {
      workspace_id: WORKSPACE,
      topic_profile: baseTopic,
      tone_profile: baseTopic.tone_profile,
      news: { ...baseNews, summary: undefined, extracted_text: longText },
      format: 'short_news',
      language: 'ru',
    };
    const out = await provider.generateDraft(input);
    expect(out.post_text.length).toBeLessThan(longText.length);
  });

  it('generateDraft truncation is surrogate-pair-safe (no lone surrogates from emoji)', async () => {
    // Title is a long run of an emoji whose UTF-16 representation is a surrogate
    // pair ('😀' for '😀', 2 code units each). A naive `String#slice`
    // on the resulting `rawText` may cut the boundary inside a pair, producing
    // a lone surrogate. We assert (a) no orphan surrogates remain, and (b) a
    // UTF-8 encode/decode roundtrip is a no-op (lossless), which is the
    // canonical check for well-formed UTF-16.
    const emoji = '😀';
    const hugeTitle = emoji.repeat(TELEGRAM_POST_MAX_LENGTH);
    const input: DraftInput = {
      workspace_id: WORKSPACE,
      topic_profile: baseTopic,
      tone_profile: baseTopic.tone_profile,
      news: {
        title: hugeTitle,
        url: 'https://example.com/emoji',
        summary: undefined,
      },
      format: 'short_news',
      language: 'ru',
    };
    const out = await provider.generateDraft(input);

    // No lone surrogates: every high surrogate (D800..DBFF) must be followed by
    // a low surrogate (DC00..DFFF), and no low surrogate may appear unpaired.
    for (let i = 0; i < out.post_text.length; i++) {
      const code = out.post_text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = out.post_text.charCodeAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xdc00);
        expect(next).toBeLessThanOrEqual(0xdfff);
        i++; // skip the low surrogate we just verified
      } else {
        expect(code < 0xdc00 || code > 0xdfff).toBe(true);
      }
    }

    // UTF-8 roundtrip: lossless iff input is well-formed UTF-16.
    expect(Buffer.from(out.post_text, 'utf8').toString('utf8')).toBe(out.post_text);
  });

  it('generateDraft caps post_text at TELEGRAM_POST_MAX_LENGTH with ellipsis when title is huge', async () => {
    // Title alone exceeds the cap → final post_text must be truncated and
    // still pass DraftOutputSchema.parse (provider contract).
    const hugeTitle = 'Z'.repeat(TELEGRAM_POST_MAX_LENGTH + 500);
    const input: DraftInput = {
      workspace_id: WORKSPACE,
      topic_profile: baseTopic,
      tone_profile: baseTopic.tone_profile,
      news: {
        title: hugeTitle,
        url: 'https://example.com/huge',
        summary: 'tail summary',
      },
      format: 'short_news',
      language: 'ru',
    };
    const out = await provider.generateDraft(input);
    const parsed = DraftOutputSchema.parse(out);
    expect(parsed.post_text.length).toBe(TELEGRAM_POST_MAX_LENGTH);
    expect(parsed.post_text.endsWith('…')).toBe(true);
  });
});
