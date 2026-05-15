/**
 * Tests for the SQL migrator: concurrency lock + checksum drift detection.
 *
 * Requires a real Postgres instance (docker-compose service on 127.0.0.1:5432
 * by default; override with TEST_DATABASE_URL or DATABASE_URL). Skipped wholesale
 * when SKIP_DB_TESTS=1 (CI gate for environments without a DB).
 *
 * Isolation strategy: each test run gets a unique schema name (postdash_migrate_test_<rand>),
 * we point `search_path` at it, run migrations against tables created inside it,
 * and DROP SCHEMA ... CASCADE in afterAll. The `_migrations` table lives in
 * that schema too, so checksum/concurrency assertions are scoped per-test-file
 * and don't fight the real Phase 0/1 _migrations rows in `public`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { buildDriftPolicy, runMigrations, type MigrationFile } from '../migrate.js';

// Pure unit tests — no DB required, so this block runs even with SKIP_DB_TESTS=1.
describe('buildDriftPolicy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns when the env var has only boolean-looking tokens (no .sql, no wildcard)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const policy = buildDriftPolicy('true');
    expect(policy.isGlobal).toBe(false);
    // No filename matched, so strict mode is effectively active.
    expect(policy.isAllowed('0001_phase1.sql')).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('MIGRATE_ALLOW_CHECKSUM_DRIFT contains no .sql filenames'),
    );
  });

  it('does NOT warn when at least one token is a .sql filename', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const policy = buildDriftPolicy('0001_phase1.sql');
    expect(policy.isAllowed('0001_phase1.sql')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does NOT warn for the wildcard form', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // `*` short-circuits to global before the no-op check.
    const policy = buildDriftPolicy('*');
    expect(policy.isGlobal).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does NOT warn for the empty-string form (default strict mode)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const policy = buildDriftPolicy('');
    expect(policy.isGlobal).toBe(false);
    expect(policy.isAllowed('0001_phase1.sql')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

const SKIP = process.env['SKIP_DB_TESTS'] === '1';
const DB_REQUIRED = process.env['RUN_DB_TESTS'] === '1';
const TEST_DB_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgresql://postdash:postdash@127.0.0.1:5432/postdash';

// vitest `describe.skipIf` short-circuits the whole block when SKIP_DB_TESTS=1,
// so no postgres client is ever created and CI without a DB stays green.
describe.skipIf(SKIP)('runMigrations', () => {
  const schema = `postdash_migrate_test_${Math.random().toString(36).slice(2, 10)}`;

  // Admin pool for schema bookkeeping (CREATE / DROP). Per-test work happens
  // through `scopedClient(testSchema)` which sets a search_path startup
  // parameter on its connections.
  let sql: postgres.Sql | undefined;

  beforeAll(async () => {
    try {
      sql = postgres(TEST_DB_URL, { max: 5, connect_timeout: 10, prepare: false });
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    } catch (err) {
      if (sql) {
        await sql.end({ timeout: 5 });
        sql = undefined;
      }
      if (DB_REQUIRED) throw err;
      console.warn(
        `[migrate.test] skipping DB-backed migration tests: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  afterAll(async () => {
    if (sql) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end({ timeout: 5 });
    }
  });

  // Helper that asserts the admin pool is initialized — runs inside `it()`,
  // which always runs after `beforeAll`, so `sql` is guaranteed non-undefined.
  function adminSql(): postgres.Sql {
    if (!sql) throw new Error('admin sql pool not initialized (beforeAll did not run)');
    return sql;
  }

  /**
   * Build a fresh Sql client whose every query runs with search_path set to
   * the per-test schema. Lets each test apply its own toy migrations without
   * colliding with sibling tests' _migrations rows.
   *
   * postgres.js `connection.search_path` is sent as a startup parameter, so it
   * applies to every query on every backend the pool opens — no per-query SET
   * needed.
   */
  function scopedClient(testSchema: string): postgres.Sql {
    return postgres(TEST_DB_URL, {
      max: 1,
      connect_timeout: 10,
      prepare: false,
      connection: { search_path: testSchema },
    });
  }

  async function resetSchema(testSchema: string): Promise<void> {
    const s = adminSql();
    await s.unsafe(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
    await s.unsafe(`CREATE SCHEMA "${testSchema}"`);
  }

  it('serializes parallel runs via advisory lock (no double-apply)', async () => {
    if (!sql) return;
    const testSchema = `${schema}_concurrency`;
    await resetSchema(testSchema);

    // A migration whose body inserts exactly one row. If two parallel runs
    // both apply the body, we'd see count(*) = 2 — the test would fail.
    const files: MigrationFile[] = [
      {
        name: '0001_concurrency_marker.sql',
        body: `
          CREATE TABLE concurrency_check (
            id SERIAL PRIMARY KEY,
            marker TEXT NOT NULL
          );
          INSERT INTO concurrency_check (marker) VALUES ('applied');
        `,
      },
    ];

    const clientA = scopedClient(testSchema);
    const clientB = scopedClient(testSchema);
    try {
      await Promise.all([runMigrations(clientA, { files }), runMigrations(clientB, { files })]);

      const s = adminSql();
      const rows = await s.unsafe<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM "${testSchema}".concurrency_check`,
      );
      expect(rows[0]?.count).toBe('1');

      const ledger = await s.unsafe<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM "${testSchema}"._migrations WHERE name = '0001_concurrency_marker.sql'`,
      );
      expect(ledger[0]?.count).toBe('1');
    } finally {
      await clientA.end({ timeout: 5 });
      await clientB.end({ timeout: 5 });
    }
  });

  it('rejects an edited migration with a checksum-mismatch error', async () => {
    if (!sql) return;
    const testSchema = `${schema}_checksum_reject`;
    await resetSchema(testSchema);

    const original: MigrationFile = {
      name: '0001_checksum.sql',
      body: `CREATE TABLE checksum_demo (id INT);`,
    };
    const edited: MigrationFile = {
      name: '0001_checksum.sql',
      body: `CREATE TABLE checksum_demo (id INT); -- edited!`,
    };

    const client = scopedClient(testSchema);
    try {
      await runMigrations(client, { files: [original] });
      await expect(runMigrations(client, { files: [edited] })).rejects.toThrow(
        /0001_checksum\.sql.*checksum mismatch/,
      );
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it('allows drift when MIGRATE_ALLOW_CHECKSUM_DRIFT contains the migration filename', async () => {
    if (!sql) return;
    const testSchema = `${schema}_checksum_namelist`;
    await resetSchema(testSchema);

    const original: MigrationFile = {
      name: '0001_namelist.sql',
      body: `CREATE TABLE namelist_demo (id INT);`,
    };
    const edited: MigrationFile = {
      name: '0001_namelist.sql',
      body: `CREATE TABLE namelist_demo (id INT); -- edited!`,
    };

    const client = scopedClient(testSchema);
    try {
      await runMigrations(client, { files: [original] });
      // Allowlist contains BOTH the target name and an unrelated sibling — drift
      // must still be tolerated for the listed file.
      await expect(
        runMigrations(client, {
          files: [edited],
          allowChecksumDrift: '0001_namelist.sql,0099_other.sql',
        }),
      ).resolves.toBeUndefined();
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it('rejects drift when MIGRATE_ALLOW_CHECKSUM_DRIFT lists a DIFFERENT file', async () => {
    if (!sql) return;
    const testSchema = `${schema}_checksum_namelist_miss`;
    await resetSchema(testSchema);

    const original: MigrationFile = {
      name: '0001_namelist_miss.sql',
      body: `CREATE TABLE namelist_miss_demo (id INT);`,
    };
    const edited: MigrationFile = {
      name: '0001_namelist_miss.sql',
      body: `CREATE TABLE namelist_miss_demo (id INT); -- edited!`,
    };

    const client = scopedClient(testSchema);
    try {
      await runMigrations(client, { files: [original] });
      // The allowlist names another file — drift on 0001_namelist_miss.sql is
      // NOT covered, so the runner must still throw.
      await expect(
        runMigrations(client, {
          files: [edited],
          allowChecksumDrift: '0099_other.sql',
        }),
      ).rejects.toThrow(/checksum mismatch/);
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it('allows drift when MIGRATE_ALLOW_CHECKSUM_DRIFT=*', async () => {
    if (!sql) return;
    const testSchema = `${schema}_checksum_star`;
    await resetSchema(testSchema);

    const original: MigrationFile = {
      name: '0001_star.sql',
      body: `CREATE TABLE star_demo (id INT);`,
    };
    const edited: MigrationFile = {
      name: '0001_star.sql',
      body: `CREATE TABLE star_demo (id INT); -- edited!`,
    };

    const client = scopedClient(testSchema);
    try {
      await runMigrations(client, { files: [original] });
      await expect(
        runMigrations(client, { files: [edited], allowChecksumDrift: '*' }),
      ).resolves.toBeUndefined();
    } finally {
      await client.end({ timeout: 5 });
    }
  });

  it('allows drift when allowChecksumDrift=true (backward-compat programmatic override)', async () => {
    if (!sql) return;
    const testSchema = `${schema}_checksum_boolcompat`;
    await resetSchema(testSchema);

    const original: MigrationFile = {
      name: '0001_boolcompat.sql',
      body: `CREATE TABLE boolcompat_demo (id INT);`,
    };
    const edited: MigrationFile = {
      name: '0001_boolcompat.sql',
      body: `CREATE TABLE boolcompat_demo (id INT); -- edited!`,
    };

    const client = scopedClient(testSchema);
    try {
      await runMigrations(client, { files: [original] });
      await expect(
        runMigrations(client, { files: [edited], allowChecksumDrift: true }),
      ).resolves.toBeUndefined();
    } finally {
      await client.end({ timeout: 5 });
    }
  });
});
