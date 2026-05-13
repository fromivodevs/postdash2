import sensible from '@fastify/sensible';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { healthRoutes } from './routes/health.js';
import type { ApiEnv } from './env.js';

export async function buildApp(
  env: ApiEnv,
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
  await app.register(healthRoutes);

  return app;
}
