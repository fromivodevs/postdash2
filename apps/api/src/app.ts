import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { AIProviderError, type AIProvider } from '@postdash/ai';
import type { Pool } from '@postdash/db';
import { healthRoutes } from './routes/health.js';
import { readyRoutes } from './routes/ready.js';
import type { ApiEnv } from './env.js';

declare module 'fastify' {
  interface FastifyInstance {
    pool: Pool;
    ai: AIProvider;
  }
}

export interface AppDeps {
  pool?: Pool;
  ai?: AIProvider;
}

export async function buildApp(
  env: ApiEnv,
  deps: AppDeps = {},
  opts: FastifyServerOptions = {},
): Promise<FastifyInstance> {
  const isProd = env.NODE_ENV === 'production';
  const app = Fastify({
    logger: isProd
      ? { level: env.LOG_LEVEL }
      : {
          level: env.LOG_LEVEL,
          transport: { target: 'pino-pretty', options: { colorize: true } },
        },
    disableRequestLogging: env.NODE_ENV === 'test',
    ...opts,
  });

  await app.register(sensible);

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof AIProviderError) {
      const status = error.code === 'budget_exceeded' ? 402 : error.code === 'refused' ? 422 : 503;
      void reply.status(status).send({
        statusCode: status,
        error: 'AIProviderError',
        code: error.code,
        message: error.message,
      });
      return;
    }
    void reply.send(error);
  });

  if (deps.pool) {
    const pool = deps.pool;
    app.decorate('pool', pool);
    app.addHook('onClose', async () => {
      await pool.close();
    });
    await app.register(readyRoutes);
  }
  if (deps.ai) {
    app.decorate('ai', deps.ai);
  }

  await app.register(healthRoutes);

  return app;
}
