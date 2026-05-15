import { afterEach, describe, expect, it } from 'vitest';
import {
  AIProviderError,
  createAIProvider,
  TemplateProvider,
  YandexAIStudioDeepSeekProvider,
} from '../index.js';
import { parseAIEnv } from '../env.js';

describe('createAIProvider', () => {
  // Each test that touches process.env must restore it; otherwise NODE_ENV
  // leak between tests can flip placeholder-fallback semantics globally.
  // AI_FALLBACK_TO_TEMPLATE is read from the PARSED env (via parseAIEnv),
  // so tests pass it explicitly through env objects instead of process.env.
  const envSnapshot = {
    NODE_ENV: process.env['NODE_ENV'],
  };
  afterEach(() => {
    if (envSnapshot.NODE_ENV === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = envSnapshot.NODE_ENV;
  });

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

  it('falls back to TemplateProvider when YA_LLM_MODEL_URI is the .env.example placeholder', () => {
    const env = parseAIEnv({
      YA_SA_KEY_JSON: '{"id":"fake"}',
      YA_FOLDER_ID: 'folder-123',
      YA_LLM_MODEL_URI: 'gpt://your-folder-id/deepseek-ai/deepseek-v3.2-exp/latest',
      YA_EMBED_DOC_MODEL_URI: 'emb://your-folder-id/text-search-doc/latest',
      YA_EMBED_QUERY_MODEL_URI: 'emb://your-folder-id/text-search-query/latest',
    } as NodeJS.ProcessEnv);
    const provider = createAIProvider(env);
    expect(provider).toBeInstanceOf(TemplateProvider);
  });

  it('falls back to TemplateProvider when YA_FOLDER_ID is a literal placeholder', () => {
    const env = parseAIEnv({
      YA_SA_KEY_JSON: '{"id":"fake"}',
      YA_FOLDER_ID: '<your-folder-id>',
      YA_LLM_MODEL_URI: 'gpt://folder-123/deepseek-ai/deepseek-v3.2-exp/latest',
    } as NodeJS.ProcessEnv);
    const provider = createAIProvider(env);
    expect(provider).toBeInstanceOf(TemplateProvider);
  });

  it('throws in production when Yandex env contains placeholder values', () => {
    process.env['NODE_ENV'] = 'production';
    const env = parseAIEnv({
      YA_SA_KEY_JSON: '{"id":"fake"}',
      YA_FOLDER_ID: 'folder-123',
      YA_LLM_MODEL_URI: 'gpt://your-folder-id/deepseek-ai/deepseek-v3.2-exp/latest',
      YA_EMBED_DOC_MODEL_URI: 'emb://your-folder-id/text-search-doc/latest',
      YA_EMBED_QUERY_MODEL_URI: 'emb://your-folder-id/text-search-query/latest',
      AI_FALLBACK_TO_TEMPLATE: 'false',
    } as NodeJS.ProcessEnv);
    expect(() => createAIProvider(env)).toThrow(AIProviderError);
    expect(() => createAIProvider(env)).toThrow(/placeholder values in production/);
  });

  it('production + AI_FALLBACK_TO_TEMPLATE=true falls back to TemplateProvider', () => {
    process.env['NODE_ENV'] = 'production';
    const env = parseAIEnv({
      YA_SA_KEY_JSON: '{"id":"fake"}',
      YA_FOLDER_ID: 'folder-123',
      YA_LLM_MODEL_URI: 'gpt://your-folder-id/deepseek-ai/deepseek-v3.2-exp/latest',
      YA_EMBED_DOC_MODEL_URI: 'emb://your-folder-id/text-search-doc/latest',
      YA_EMBED_QUERY_MODEL_URI: 'emb://your-folder-id/text-search-query/latest',
      AI_FALLBACK_TO_TEMPLATE: 'true',
    } as NodeJS.ProcessEnv);
    const provider = createAIProvider(env);
    expect(provider).toBeInstanceOf(TemplateProvider);
  });
});
