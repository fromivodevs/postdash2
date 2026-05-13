import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

export interface Pool {
  readonly client: postgres.Sql;
  readonly db: ReturnType<typeof drizzle>;
  close(): Promise<void>;
}

export type Database = Pool['db'];

export interface PoolOptions {
  max?: number;
  idleTimeoutSec?: number;
  connectTimeoutSec?: number;
}

export function createPool(databaseUrl: string, opts: PoolOptions = {}): Pool {
  const client = postgres(databaseUrl, {
    max: opts.max ?? 10,
    idle_timeout: opts.idleTimeoutSec ?? 30,
    connect_timeout: opts.connectTimeoutSec ?? 5,
    prepare: false,
  });
  const db = drizzle(client);
  return {
    client,
    db,
    close: async () => {
      await client.end({ timeout: 5 });
    },
  };
}
