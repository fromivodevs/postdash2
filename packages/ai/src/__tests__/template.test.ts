import { describe, expect, it } from 'vitest';
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
});
