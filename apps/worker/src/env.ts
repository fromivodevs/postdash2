import { z, ZodError } from 'zod';

export const workerEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  TASK_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  TASK_LEASE_MINUTES: z.coerce.number().int().positive().default(5),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/**
 * Parse env with friendly fatal-on-error reporting (see apps/api/src/env.ts
 * for the rationale). On ZodError we summarize issues and exit cleanly;
 * DEBUG_ENV=1 still surfaces the raw stack for hard cases.
 */
export function parseWorkerEnv(env: NodeJS.ProcessEnv = process.env): WorkerEnv {
  try {
    return workerEnvSchema.parse(env);
  } catch (err) {
    if (err instanceof ZodError) {
      const lines = err.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `  - ${path}: ${issue.message}`;
      });
      // Under vitest, callers may want to assert schema rejections; exit(1)
      // would kill the test runner. Outside tests we want a clean fatal.
      if (process.env['VITEST']) {
        throw err;
      }
      console.error(`Configuration error in apps/worker:\n${lines.join('\n')}`);
      if (process.env['DEBUG_ENV'] === '1') {
        console.error(err);
      }
      process.exit(1);
    }
    throw err;
  }
}
