/**
 * Shared helpers for DB-backed command tests.
 *
 * Strategy: each test file creates a unique Postgres schema, points its
 * `search_path` at it, runs Phase 1 + Phase 2 migrations against that schema,
 * and DROPs it in `afterAll`. This keeps tests parallel-safe and isolated
 * from any existing rows in the `public` schema.
 *
 * Gated by SKIP_DB_TESTS=1, or skipped automatically when no explicit Neon
 * TEST_DATABASE_URL/DATABASE_URL is present. RUN_DB_TESTS=1 makes the URL
 * mandatory for phase validation.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import type { Database } from '@postdash/db';
import { runMigrations, type MigrationFile } from '@postdash/db/migrate';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'db', 'migrations');

const RAW_TEST_DB_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
export const DB_REQUIRED = process.env['RUN_DB_TESTS'] === '1';
export const SKIP_DB = process.env['SKIP_DB_TESTS'] === '1' || (!DB_REQUIRED && !RAW_TEST_DB_URL);
export const TEST_DB_URL = RAW_TEST_DB_URL ?? '';

const FORWARD_FILES = ['0001_phase1.sql', '0002_phase2.sql'];

function loadForwardMigrations(): MigrationFile[] {
  return FORWARD_FILES.map((name) => ({
    name,
    body: readFileSync(join(MIGRATIONS_DIR, name), 'utf8'),
  }));
}

export interface TestDbHandle {
  /** Scoped postgres.js client (search_path pinned to per-test schema). */
  client: postgres.Sql;
  /** Drizzle Database handle backed by the scoped client. */
  db: Database;
  /** Name of the per-test schema (for diagnostic logging). */
  schema: string;
  /** Drop the schema and close the connection. Idempotent. */
  cleanup(): Promise<void>;
}

/**
 * Provision a fresh test schema, run all forward migrations against it,
 * and return a Drizzle Database whose connections see only that schema.
 *
 * Call in `beforeAll`; pass the returned `cleanup` to `afterAll`.
 */
export async function setupTestDb(testName: string): Promise<TestDbHandle> {
  if (!TEST_DB_URL) {
    throw new Error('RUN_DB_TESTS=1 requires TEST_DATABASE_URL or DATABASE_URL pointing at Neon');
  }

  const schema = `postdash_test_${testName}_${Math.random().toString(36).slice(2, 10)}`;
  // Admin client without scoped search_path — used once to CREATE SCHEMA.
  const admin = postgres(TEST_DB_URL, { max: 1, connect_timeout: 10, prepare: false });
  try {
    await admin.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const client = postgres(TEST_DB_URL, {
    max: 4,
    connect_timeout: 10,
    prepare: false,
    connection: { search_path: schema },
  });
  // postgres.js needs pgcrypto for gen_random_uuid(); install in the test
  // schema's reach (pgcrypto is usually in `public` already on dev DBs, but
  // make this explicit so a CI image without it fails LOUD instead of in
  // some random INSERT).
  await client.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  await runMigrations(client, { files: loadForwardMigrations() });

  const db = drizzle(client);
  return {
    client,
    db: db as unknown as Database,
    schema,
    cleanup: async () => {
      try {
        await client.end({ timeout: 5 });
      } catch {
        // ignore; the schema-drop admin client below will still run.
      }
      const admin2 = postgres(TEST_DB_URL, { max: 1, connect_timeout: 10, prepare: false });
      try {
        await admin2.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin2.end({ timeout: 5 });
      }
    },
  };
}

/**
 * Insert a fresh user + workspace + owner-membership. Returns the IDs the
 * tests need. Optional `role` overrides the membership role (default 'owner');
 * pass 'editor' / 'viewer' / 'admin' to exercise policy checks.
 */
export async function seedUserAndWorkspace(
  db: Database,
  opts: {
    role?: 'owner' | 'admin' | 'editor' | 'viewer';
    telegramUserId?: bigint | null;
  } = {},
): Promise<{ userId: string; workspaceId: string; identityId: string | null }> {
  const userRows = await db.execute<{ id: string }>(
    sql`INSERT INTO users (status) VALUES ('active') RETURNING id`,
  );
  const userRow = userRows[0];
  if (!userRow) throw new Error('users insert returned no row');
  const userId = userRow.id;

  const wsRows = await db.execute<{ id: string }>(
    sql`INSERT INTO workspaces (name, created_by_user_id, status)
        VALUES ('test ws', ${userId}, 'active') RETURNING id`,
  );
  const wsRow = wsRows[0];
  if (!wsRow) throw new Error('workspaces insert returned no row');
  const workspaceId = wsRow.id;

  await db.execute(
    sql`INSERT INTO workspace_members (workspace_id, user_id, role, status)
        VALUES (${workspaceId}, ${userId}, ${opts.role ?? 'owner'}, 'active')`,
  );
  await db.execute(
    sql`UPDATE users SET last_active_workspace_id = ${workspaceId} WHERE id = ${userId}`,
  );

  let identityId: string | null = null;
  if (opts.telegramUserId !== undefined && opts.telegramUserId !== null) {
    const identRows = await db.execute<{ id: string }>(
      sql`INSERT INTO telegram_identities
            (user_id, telegram_user_id, username, first_name, status)
          VALUES (${userId}, ${opts.telegramUserId}, 'tester', 'Test', 'active')
          RETURNING id`,
    );
    const identRow = identRows[0];
    if (!identRow) throw new Error('telegram_identities insert returned no row');
    identityId = identRow.id;
    await db.execute(
      sql`UPDATE users SET primary_telegram_identity_id = ${identityId} WHERE id = ${userId}`,
    );
  }

  return { userId, workspaceId, identityId };
}
