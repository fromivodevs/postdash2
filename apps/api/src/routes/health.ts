import type { FastifyInstance } from 'fastify';

export interface HealthResponse {
  status: 'ok';
  service: 'postdash-api';
  version: string;
  uptime_sec: number;
  time: string;
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', (): HealthResponse => {
    return {
      status: 'ok',
      service: 'postdash-api',
      version: process.env['npm_package_version'] ?? '0.0.0',
      uptime_sec: Math.round(process.uptime()),
      time: new Date().toISOString(),
    };
  });
}
