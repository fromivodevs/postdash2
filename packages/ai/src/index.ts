import { AIProviderError, type AIProvider } from './provider.js';
import { TemplateProvider } from './providers/template.js';
import { YandexAIStudioDeepSeekProvider } from './providers/yandex.js';
import { IAMTokenCache, type IAMTokenStore } from './iam-token.js';
import type { AIEnv } from './env.js';

export * from './provider.js';
export { TemplateProvider } from './providers/template.js';
export { YandexAIStudioDeepSeekProvider } from './providers/yandex.js';
export { IAMTokenCache, type IAMTokenStore, type IAMTokenCacheOptions } from './iam-token.js';
export { aiEnvSchema, parseAIEnv, type AIEnv } from './env.js';

/**
 * Known placeholder fragments that ship in `.env.example`. If any of these
 * appear inside a Yandex env var, we treat the var as "not configured" — the
 * operator copied .env.example but never filled the value. This catches the
 * common footgun where the URI is non-empty but still literal
 * `gpt://your-folder-id/...`, which otherwise selects YandexProvider and dies
 * deep in the request pipeline with an opaque 4xx.
 */
const PLACEHOLDER_FRAGMENTS = [
  'your-folder-id',
  'your-bot-token',
  'your-sa-key',
  'YOUR_',
  '<your',
  '<YOUR',
];

function looksLikePlaceholder(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return false;
  if (v.startsWith('gpt://your-') || v.startsWith('emb://your-')) return true;
  if (v.startsWith('<') && v.endsWith('>')) return true;
  return PLACEHOLDER_FRAGMENTS.some((frag) => v.includes(frag));
}

/**
 * Selects AI provider based on env. If Yandex credentials are present
 * (YA_SA_KEY_JSON + YA_FOLDER_ID + YA_LLM_MODEL_URI), returns the Yandex
 * provider. Otherwise returns TemplateProvider — useful for dev without
 * Yandex Cloud setup and as a fallback when AI_FALLBACK_TO_TEMPLATE=true.
 *
 * Also detects known placeholder strings (e.g. literal `gpt://your-folder-id/...`
 * from .env.example) and falls back to TemplateProvider with a clear warning,
 * so a half-filled .env doesn't silently route traffic to a broken Yandex
 * config.
 *
 * Production guard: if NODE_ENV=production AND placeholders are detected, we
 * HARD-FAIL with AIProviderError instead of silently degrading to template
 * mode. To intentionally ship template-only to prod, set
 * AI_FALLBACK_TO_TEMPLATE=true — this is the explicit opt-in.
 */
export interface CreateAIProviderOptions {
  /** Cross-process IAM token store. Wired by the worker (system_state). */
  iamStore?: IAMTokenStore;
  /** Injectable fetch (tests). */
  fetch?: typeof globalThis.fetch;
}

export function createAIProvider(env: AIEnv, opts: CreateAIProviderOptions = {}): AIProvider {
  const yandexFields: Array<[name: string, value: string]> = [
    ['YA_SA_KEY_JSON', env.YA_SA_KEY_JSON],
    ['YA_FOLDER_ID', env.YA_FOLDER_ID],
    ['YA_LLM_MODEL_URI', env.YA_LLM_MODEL_URI],
    ['YA_EMBED_DOC_MODEL_URI', env.YA_EMBED_DOC_MODEL_URI],
    ['YA_EMBED_QUERY_MODEL_URI', env.YA_EMBED_QUERY_MODEL_URI],
  ];

  const placeholderHits = yandexFields.filter(([, v]) => looksLikePlaceholder(v));
  if (placeholderHits.length > 0) {
    const names = placeholderHits.map(([name]) => name).join(', ');
    const isProduction = process.env['NODE_ENV'] === 'production';
    // Read fallback flag from the PARSED env (zod-coerced boolean) instead of
    // raw process.env. Keeping all config reads inside `AIEnv` means tests can
    // override behaviour via parseAIEnv() and avoids subtle "true vs 'true'"
    // type confusion at the boundary.
    const fallbackOptIn = env.AI_FALLBACK_TO_TEMPLATE;
    if (isProduction && !fallbackOptIn) {
      throw new AIProviderError(
        `Yandex AI provider env contains placeholder values in production (${names}). ` +
          `Either set valid Yandex creds or set AI_FALLBACK_TO_TEMPLATE=true to ` +
          `explicitly opt into template-only mode.`,
        'not_implemented',
      );
    }
    console.warn(
      `[ai] Yandex env contains placeholder values (${names}); falling back to TemplateProvider. Update .env to use Yandex.`,
    );
    return new TemplateProvider();
  }

  const hasYandex =
    env.YA_SA_KEY_JSON.trim().length > 0 &&
    env.YA_FOLDER_ID.trim().length > 0 &&
    env.YA_LLM_MODEL_URI.trim().length > 0;

  if (!hasYandex) {
    return new TemplateProvider();
  }

  const iamOpts: { store?: IAMTokenStore; fetch?: typeof globalThis.fetch } = {};
  if (opts.iamStore !== undefined) iamOpts.store = opts.iamStore;
  if (opts.fetch !== undefined) iamOpts.fetch = opts.fetch;
  const iamToken = new IAMTokenCache(env.YA_SA_KEY_JSON, iamOpts);
  const yandexOpts: YandexCtorOpts = {
    folderId: env.YA_FOLDER_ID,
    llmModelUri: env.YA_LLM_MODEL_URI,
    embedDocModelUri: env.YA_EMBED_DOC_MODEL_URI,
    embedQueryModelUri: env.YA_EMBED_QUERY_MODEL_URI,
    requestTimeoutMs: env.YA_LLM_REQUEST_TIMEOUT_MS,
    llmMaxTokens: env.YA_LLM_MAX_TOKENS,
    llmTemperature: env.YA_LLM_TEMPERATURE,
    embeddingDim: env.AI_EMBEDDING_DIM,
    iamToken,
  };
  if (opts.fetch !== undefined) yandexOpts.fetch = opts.fetch;
  return new YandexAIStudioDeepSeekProvider(yandexOpts);
}

// Local alias to keep the optional `fetch` field exactOptionalPropertyTypes-safe.
type YandexCtorOpts = ConstructorParameters<typeof YandexAIStudioDeepSeekProvider>[0];
