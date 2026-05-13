import { createAIProvider, parseAIEnv } from '@postdash/ai';
import { createPool, parseDbEnv } from '@postdash/db';
import pino, { type LoggerOptions } from 'pino';
import { parseWorkerEnv } from './env.js';
import { WorkerLoop } from './loop.js';

const env = parseWorkerEnv();
const dbEnv = parseDbEnv();
const aiEnv = parseAIEnv();

const loggerOpts: LoggerOptions = { level: env.LOG_LEVEL };
if (env.NODE_ENV !== 'production') {
  loggerOpts.transport = { target: 'pino-pretty', options: { colorize: true } };
}
const logger = pino(loggerOpts);

const pool = createPool(dbEnv.DATABASE_URL);
const ai = createAIProvider(aiEnv);

logger.info({ provider: ai.name }, 'AI provider initialized');

const loop = new WorkerLoop({
  concurrency: env.WORKER_CONCURRENCY,
  pollIntervalMs: env.TASK_POLL_INTERVAL_MS,
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
