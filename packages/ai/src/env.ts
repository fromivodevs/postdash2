import { z } from 'zod';

export const aiEnvSchema = z.object({
  YA_SA_KEY_JSON: z.string().default(''),
  YA_FOLDER_ID: z.string().default(''),
  YA_LLM_MODEL_URI: z.string().default(''),
  YA_EMBED_DOC_MODEL_URI: z.string().default(''),
  YA_EMBED_QUERY_MODEL_URI: z.string().default(''),
  YA_LLM_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  YA_LLM_MAX_TOKENS: z.coerce.number().int().positive().default(2000),
  YA_LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3),

  AI_INPUT_RUB_PER_1M_TOKENS: z.coerce.number().nonnegative().default(8),
  AI_OUTPUT_RUB_PER_1M_TOKENS: z.coerce.number().nonnegative().default(24),
  AI_EMBED_RUB_PER_1M_TOKENS: z.coerce.number().nonnegative().default(2),
  AI_DAILY_CAP_RUB_PER_WORKSPACE: z.coerce.number().nonnegative().default(200),
  AI_FALLBACK_TO_TEMPLATE: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .default(true)
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true')),
  AI_EMBEDDING_DIM: z.coerce.number().int().positive().default(256),
  AI_DEDUPE_COSINE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.15),
  AI_DEDUPE_WINDOW_HOURS: z.coerce.number().int().positive().default(48),
});

export type AIEnv = z.infer<typeof aiEnvSchema>;

export function parseAIEnv(env: NodeJS.ProcessEnv = process.env): AIEnv {
  return aiEnvSchema.parse(env);
}
