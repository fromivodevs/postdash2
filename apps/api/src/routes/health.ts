import type { FastifyInstance } from 'fastify';

export interface HealthResponse {
  status: 'ok';
  service: 'postdash-api';
  version: string;
  uptime_sec: number;
  time: string;
}

/**
 * Resolve a human-meaningful version string in priority order.
 *
 * `npm_package_version` is ONLY exported by npm/pnpm/yarn when launched via
 * `... run <script>`. Production usually starts with `node dist/index.js`,
 * which leaves that var unset and pins /health to "0.0.0" forever — useless
 * for triaging "which build is live". We try explicit deploy-time vars first:
 *   - APP_VERSION:        we set this in our deploy pipelines
 *   - COMMIT_SHA:         common convention across CI providers
 *   - RENDER_GIT_COMMIT:  injected automatically by Render
 *   - npm_package_version: dev fallback when started via `pnpm dev`
 *   - '0.0.0':            last-resort sentinel; means none of the above were set
 *
 * Each candidate is sanitised: trimmed, stripped of real control chars (C0/DEL),
 * and capped at 64 code points. This prevents whitespace / control chars that
 * sneak in via shell heredocs (`COMMIT_SHA="hello world\n"`) from breaking
 * downstream monitoring parsers that consume `/health.version` as JSON, while
 * still allowing printable Unicode (e.g. `v1.0.0-α`) — strip the controls,
 * keep the legible characters. If sanitisation empties the value (was all
 * whitespace / control), we fall through to the next candidate.
 */
const VERSION_MAX_LENGTH = 64;

export function sanitizeVersion(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  // Drop only real control chars (C0 range 0x00..0x1F and DEL 0x7F). Printable
  // Unicode (Greek, Cyrillic, emoji etc.) is preserved — a tag like
  // `v1.0.0-α` is legitimate. The length cap is applied in code points, not
  // UTF-16 code units, so it can't split a surrogate pair.
  const cleaned = [...raw]
    .filter((ch) => {
      const codePoint = ch.codePointAt(0);
      return codePoint !== undefined && codePoint > 0x1f && codePoint !== 0x7f;
    })
    .join('')
    .trim();
  if (cleaned.length === 0) return undefined;
  return [...cleaned].slice(0, VERSION_MAX_LENGTH).join('');
}

function resolveVersion(): string {
  return (
    sanitizeVersion(process.env['APP_VERSION']) ??
    sanitizeVersion(process.env['COMMIT_SHA']) ??
    sanitizeVersion(process.env['RENDER_GIT_COMMIT']) ??
    sanitizeVersion(process.env['npm_package_version']) ??
    '0.0.0'
  );
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', (): HealthResponse => {
    return {
      status: 'ok',
      service: 'postdash-api',
      version: resolveVersion(),
      uptime_sec: Math.round(process.uptime()),
      time: new Date().toISOString(),
    };
  });
}
