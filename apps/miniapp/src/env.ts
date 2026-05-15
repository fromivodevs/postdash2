import { z, ZodError } from 'zod';

// Zod `.default()` срабатывает только на undefined, не на пустую строку.
// Vite заполняет import.meta.env пустой строкой, если env-var присутствует
// в .env с пустым значением (e.g., VITE_API_URL=). Без preprocess это
// проваливается через .url() и Mini App падает на module load.
const emptyToUndefined = (v: unknown): unknown => (v === '' ? undefined : v);

const schema = z.object({
  VITE_API_URL: z.preprocess(emptyToUndefined, z.string().url().default('http://localhost:3000')),
  VITE_BUILD_VERSION: z.preprocess(emptyToUndefined, z.string().min(1).default('dev')),
  // Canonical bot @username WITHOUT the leading `@` (e.g. `postdash_bot`).
  // Mirrors apps/api/src/env.ts TELEGRAM_BOT_USERNAME — used by ChannelScreen's
  // PendingView to render the connect deep-link via `buildConnectDeepLink`.
  //
  // emptyToUndefined coerces an empty/missing value to undefined so the regex
  // never runs against ''. The trailing `.transform` collapses the optional
  // back to '' so the consumer always reads a string. When unset, the
  // PendingView hides the deep-link copy button rather than producing a broken
  // `https://t.me/?start=...` URL.
  VITE_TELEGRAM_BOT_USERNAME: z
    .preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(
          /^[A-Za-z0-9_]+$/,
          'VITE_TELEGRAM_BOT_USERNAME may only contain A-Za-z0-9_ (Telegram username charset; no leading @)',
        )
        .optional(),
    )
    .transform((v) => v ?? ''),
});

/**
 * Parse with the same friendly-fatal contract as the backend env wrappers
 * (see apps/api/src/env.ts, packages/ai/src/env.ts). On Zod failure we print
 * a per-field summary so a misconfigured Vite env doesn't manifest as an
 * opaque ZodError in the browser console + a white screen.
 *
 * We do NOT call process.exit here — this module runs in the browser/Vite
 * build pipeline where process is either absent or shimmed. Re-throwing lets
 * Vite surface the error in dev overlay / fail the build cleanly.
 */
function parseMiniappEnv(): z.infer<typeof schema> {
  try {
    return schema.parse(import.meta.env);
  } catch (err) {
    if (err instanceof ZodError) {
      const lines = err.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `  - ${path}: ${issue.message}`;
      });
      console.error(`Configuration error in apps/miniapp:\n${lines.join('\n')}`);
    }
    throw err;
  }
}

export const miniappEnv = parseMiniappEnv();
export type MiniappEnv = z.infer<typeof schema>;
