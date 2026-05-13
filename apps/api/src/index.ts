import { createAIProvider, parseAIEnv } from '@postdash/ai';
import { createPool, parseDbEnv } from '@postdash/db';
import { buildApp } from './app.js';
import { parseApiEnv } from './env.js';

const env = parseApiEnv();
const dbEnv = parseDbEnv();
const aiEnv = parseAIEnv();

const pool = createPool(dbEnv.DATABASE_URL);
const ai = createAIProvider(aiEnv);

const app = await buildApp(env, { pool, ai });

const onSignal = async (signal: string): Promise<void> => {
  app.log.warn({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};

process.once('SIGINT', () => void onSignal('SIGINT'));
process.once('SIGTERM', () => void onSignal('SIGTERM'));

try {
  await app.listen({ host: env.API_HOST, port: env.API_PORT });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
