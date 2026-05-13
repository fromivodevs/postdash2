import type { FastifyInstance } from 'fastify';

export interface ReadyResponse {
  status: 'ready' | 'not_ready';
  db?: 'ok' | 'unreachable';
  error?: string;
  time: string;
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function readyRoutes(app: FastifyInstance): Promise<void> {
  // Liveness == /health. Readiness == /ready (pings DB).
  // Orchestrators (Render, Fly, etc.) treat them differently:
  // - /health 200 → process is alive; safe to keep instance.
  // - /ready 200 → safe to route traffic. 503 during DB cold-start or outage.
  app.get('/ready', async (_req, reply): Promise<ReadyResponse> => {
    const now = new Date().toISOString();
    try {
      await app.pool.ping();
      return { status: 'ready', db: 'ok', time: now };
    } catch (err) {
      reply.status(503);
      return {
        status: 'not_ready',
        db: 'unreachable',
        error: err instanceof Error ? err.message : String(err),
        time: now,
      };
    }
  });
}
