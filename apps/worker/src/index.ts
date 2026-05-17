import { createAIProvider, parseAIEnv, type IAMTokenStore } from '@postdash/ai';
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
//
// The provider exposes its IAMTokenCache as `provider.iamToken`; `WorkerLoop`
// detects the Yandex provider via `instanceof` and resolves the refresh hook
// from that single cache instance. There is no sibling cache here — every
// process holds exactly one IAMTokenCache, so `forceRefresh()` always operates
// on the in-memory state the provider actually reads from.
const iamStore: IAMTokenStore = systemStateIamStore(pool.db);
const ai = createAIProvider(aiEnv, { iamStore });

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
