import type { AIProvider } from './provider.js';
import { TemplateProvider } from './providers/template.js';
import { YandexAIStudioDeepSeekProvider } from './providers/yandex.js';
import { IAMTokenCache } from './iam-token.js';
import type { AIEnv } from './env.js';

export * from './provider.js';
export { TemplateProvider } from './providers/template.js';
export { YandexAIStudioDeepSeekProvider } from './providers/yandex.js';
export { IAMTokenCache } from './iam-token.js';
export { aiEnvSchema, parseAIEnv, type AIEnv } from './env.js';

/**
 * Selects AI provider based on env. If Yandex credentials are present
 * (YA_SA_KEY_JSON + YA_FOLDER_ID + YA_LLM_MODEL_URI), returns the Yandex
 * provider. Otherwise returns TemplateProvider — useful for dev without
 * Yandex Cloud setup and as a fallback when AI_FALLBACK_TO_TEMPLATE=true.
 */
export function createAIProvider(env: AIEnv): AIProvider {
  const hasYandex =
    env.YA_SA_KEY_JSON.trim().length > 0 &&
    env.YA_FOLDER_ID.trim().length > 0 &&
    env.YA_LLM_MODEL_URI.trim().length > 0;

  if (!hasYandex) {
    return new TemplateProvider();
  }

  return new YandexAIStudioDeepSeekProvider({
    folderId: env.YA_FOLDER_ID,
    llmModelUri: env.YA_LLM_MODEL_URI,
    embedDocModelUri: env.YA_EMBED_DOC_MODEL_URI,
    embedQueryModelUri: env.YA_EMBED_QUERY_MODEL_URI,
    requestTimeoutMs: env.YA_LLM_REQUEST_TIMEOUT_MS,
    llmMaxTokens: env.YA_LLM_MAX_TOKENS,
    llmTemperature: env.YA_LLM_TEMPERATURE,
    iamToken: new IAMTokenCache(env.YA_SA_KEY_JSON),
  });
}
