import { z, ZodError } from 'zod';

export const dbEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
});

export type DbEnv = z.infer<typeof dbEnvSchema>;

/**
 * Parse env with friendly fatal-on-error reporting (see apps/api/src/env.ts
 * for the rationale). On ZodError we summarize issues and exit cleanly;
 * DEBUG_ENV=1 still surfaces the raw stack for hard cases.
 */
export function parseDbEnv(env: NodeJS.ProcessEnv = process.env): DbEnv {
  try {
    return dbEnvSchema.parse(env);
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
      console.error(`Configuration error in packages/db:\n${lines.join('\n')}`);
      if (process.env['DEBUG_ENV'] === '1') {
        console.error(err);
      }
      process.exit(1);
    }
    throw err;
  }
}
