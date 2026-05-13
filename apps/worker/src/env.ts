import { z } from 'zod';

export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  TASK_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  TASK_LEASE_MINUTES: z.coerce.number().int().positive().default(5),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function parseWorkerEnv(env: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return workerEnvSchema.parse(env);
}
