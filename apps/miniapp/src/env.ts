import { z } from 'zod';

const schema = z.object({
  VITE_API_URL: z.string().url().default('http://localhost:3000'),
  VITE_BUILD_VERSION: z.string().default('dev'),
});

export const miniappEnv = schema.parse(import.meta.env);
export type MiniappEnv = z.infer<typeof schema>;
