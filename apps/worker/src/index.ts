import { createAIProvider, parseAIEnv, IAMTokenCache, type IAMTokenStore } from '@postdash/ai';
import { createPool, parseDbEnv } from '@postdash/db';
import pino, { type LoggerOptions } from 'pino';
import { parseWorkerEnv } from './env.js';
import { WorkerLoop } from './loop.js';
import { systemStateIamStore } from './system-state-store.js';

const env = parseWorkerEnv();
const dbEnv = parseDbEnv();
const aiEnv = parseAIEnv();

const loggerOpts: LoggerOptions = { level: env.LOG_LEVEL };
if (env.NODE_ENV !== 'production') {
  loggerOpts.transport = { target: 'pino-pretty', options: { colorize: true } };
}
const logger = pino(loggerOpts);

const pool = createPool(dbEnv.DATABASE_URL);

// Wire the system_state-backed IAM token store into the AI provider factory
// so all worker processes share one token via the DB. This keeps
// `packages/ai` free of any DB dependency (see architecture/global-ingestion.md
// "Dependency graph": ai → injected IAMTokenStore, not → packages/db).
const iamStore: IAMTokenStore = systemStateIamStore(pool.db);
const ai = createAIProvider(aiEnv, { iamStore });

// Tag the provider with `_iamRefresh` so the refresh_iam_token task handler
// has a path to forceRefresh without leaking the IAMTokenCache type through
// the AIProvider interface. TemplateProvider gets a no-op; Yandex gets the
// real refresh. See apps/worker/src/handlers/refresh-iam-token.ts.
if (ai.name === 'yandex-deepseek') {
  // The factory created its own IAMTokenCache internally. To call
  // forceRefresh we'd need a reference. Construct a sibling cache that
  // shares the same store + token JSON — they converge via writethrough.
  const refreshable = new IAMTokenCache(aiEnv.YA_SA_KEY_JSON, { store: iamStore });
  (ai as unknown as { _iamRefresh?: () => Promise<void> })._iamRefresh = async () => {
    await refreshable.forceRefresh();
  };
}

logger.info({ provider: ai.name }, 'AI provider initialized');

const loop = new WorkerLoop({
  concurrency: env.WORKER_CONCURRENCY,
  pollIntervalMs: env.TASK_POLL_INTERVAL_MS,
  leaseMinutes: env.TASK_LEASE_MINUTES,
  logger,
  pool,
  ai,
});

const shutdown = async (signal: string): Promise<void> => {
  logger.warn({ signal }, 'shutting down worker');
  await loop.stop();
  await pool.close();
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

loop.start();
