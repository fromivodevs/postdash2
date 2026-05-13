import { describe, expect, it } from 'vitest';
import { createAIProvider, TemplateProvider, YandexAIStudioDeepSeekProvider } from '../index.js';
import { parseAIEnv } from '../env.js';

describe('createAIProvider', () => {
  it('returns TemplateProvider when Yandex creds are absent', () => {
    const env = parseAIEnv({
      YA_SA_KEY_JSON: '',
      YA_FOLDER_ID: '',
      YA_LLM_MODEL_URI: '',
    } as NodeJS.ProcessEnv);
    const provider = createAIProvider(env);
    expect(provider).toBeInstanceOf(TemplateProvider);
    expect(provider.name).toBe('template');
  });

  it('returns YandexAIStudioDeepSeekProvider when creds are present', () => {
    const env = parseAIEnv({
      YA_SA_KEY_JSON: '{"id":"fake"}',
      YA_FOLDER_ID: 'folder-123',
      YA_LLM_MODEL_URI: 'gpt://folder-123/deepseek-ai/deepseek-v3.2-exp/latest',
      YA_EMBED_DOC_MODEL_URI: 'emb://folder-123/text-search-doc/latest',
      YA_EMBED_QUERY_MODEL_URI: 'emb://folder-123/text-search-query/latest',
    } as NodeJS.ProcessEnv);
    const provider = createAIProvider(env);
    expect(provider).toBeInstanceOf(YandexAIStudioDeepSeekProvider);
    expect(provider.name).toBe('yandex-deepseek');
  });

  it('falls back to TemplateProvider when only some Yandex creds are present', () => {
    const env = parseAIEnv({
      YA_SA_KEY_JSON: '{"id":"fake"}',
      YA_FOLDER_ID: '',
      YA_LLM_MODEL_URI: 'gpt://folder-123/deepseek-ai/deepseek-v3.2-exp/latest',
    } as NodeJS.ProcessEnv);
    const provider = createAIProvider(env);
    expect(provider).toBeInstanceOf(TemplateProvider);
  });
});
