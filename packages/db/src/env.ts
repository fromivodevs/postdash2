import { z } from 'zod';

export const dbEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
});

export type DbEnv = z.infer<typeof dbEnvSchema>;

export function parseDbEnv(env: NodeJS.ProcessEnv = process.env): DbEnv {
  return dbEnvSchema.parse(env);
}
