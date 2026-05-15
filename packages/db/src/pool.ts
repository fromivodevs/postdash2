import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

export interface Pool {
  readonly client: postgres.Sql;
  readonly db: ReturnType<typeof drizzle>;
  /**
   * Driver-agnostic liveness probe. Runs `SELECT 1` under the hood, but
   * routes consuming this should depend on `Pool.ping()`, not on the
   * concrete postgres.Sql tagged-template shape. Lets us swap the db
   * driver without touching call sites.
   */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export type Database = Pool['db'];

/**
 * Type of `tx` inside `db.transaction(async (tx) => ...)`. Used by code that
 * runs partly inside and partly outside a transaction (e.g. idempotent
 * commands). Both Database and DbTx expose the same query API.
 */
export type DbTx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Either a top-level Database handle or a transaction handle. */
export type DbOrTx = Database | DbTx;

export interface PoolOptions {
  max?: number;
  idleTimeoutSec?: number;
  connectTimeoutSec?: number;
}

export function createPool(databaseUrl: string, opts: PoolOptions = {}): Pool {
  // connect_timeout=30s: managed Postgres providers (Neon free-tier) may sleep
  // after idle and need 10-15s to wake on first request. Local Postgres still
  // fails fast since it's instant when up.
  const client = postgres(databaseUrl, {
    max: opts.max ?? 10,
    idle_timeout: opts.idleTimeoutSec ?? 30,
    connect_timeout: opts.connectTimeoutSec ?? 30,
    prepare: false,
  });
  const db = drizzle(client);
  return {
    client,
    db,
    ping: async () => {
      await client`SELECT 1`;
    },
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}
