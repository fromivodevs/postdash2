import type { FastifyInstance } from 'fastify';

export interface ReadyResponse {
  status: 'ready' | 'not_ready';
  db?: 'ok' | 'unreachable';
  /** Stable machine-readable code; never carries driver internals. */
  code?: string;
  /** Static, client-safe message. The raw driver error is logged server-side. */
  message?: string;
  time: string;
}

export async function readyRoutes(app: FastifyInstance): Promise<void> {
  // Liveness == /health. Readiness == /ready (pings DB).
  // Orchestrators (Render, Fly, etc.) treat them differently:
  // - /health 200 → process is alive; safe to keep instance.
  // - /ready 200 → safe to route traffic. 503 during DB cold-start or outage.
  app.get(
    '/ready',
    {
      // /ready pings the DB on every call, so an unauthenticated flood could
      // saturate the connection pool. Cap it — orchestrator probes poll well
      // under 60/min, so this never throttles a legitimate readiness check.
      // /health stays unlimited: it touches nothing.
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (req, reply): Promise<ReadyResponse> => {
      const now = new Date().toISOString();
      try {
        await app.pool.ping();
        return { status: 'ready', db: 'ok', time: now };
      } catch (err) {
        // The raw driver error string can leak connection-string fragments, host
        // names and internal topology. Log it server-side; return only a static
        // code + message to the (potentially public) readiness probe.
        req.log.error({ err }, 'database ping failed');
        reply.status(503);
        return {
          status: 'not_ready',
          db: 'unreachable',
          code: 'db_ping_failed',
          message: 'database ping failed',
          time: now,
        };
      }
    },
  );
}
