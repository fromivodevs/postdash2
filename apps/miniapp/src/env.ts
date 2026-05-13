import { z } from 'zod';

// Zod `.default()` срабатывает только на undefined, не на пустую строку.
// Vite заполняет import.meta.env пустой строкой, если env-var присутствует
// в .env с пустым значением (e.g., VITE_API_URL=). Без preprocess это
// проваливается через .url() и Mini App падает на module load.
const emptyToUndefined = (v: unknown): unknown => (v === '' ? undefined : v);

const schema = z.object({
  VITE_API_URL: z.preprocess(emptyToUndefined, z.string().url().default('http://localhost:3000')),
  VITE_BUILD_VERSION: z.preprocess(emptyToUndefined, z.string().min(1).default('dev')),
});

export const miniappEnv = schema.parse(import.meta.env);
export type MiniappEnv = z.infer<typeof schema>;
