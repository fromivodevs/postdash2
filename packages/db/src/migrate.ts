/**
 * Простой SQL migrator для Phase 0.
 *
 * Применяет файлы из migrations/*.sql в алфавитном порядке.
 * Уже применённые отслеживает в таблице _migrations.
 *
 * С Phase 1+ можно переключиться на drizzle-kit-managed миграции
 * через `pnpm db:generate`. Этот скрипт совместим с обоими подходами:
 * читает любые *.sql файлы.
 *
 * Concurrency contract:
 *   Каждая попытка применить файл оборачивается в `client.begin(...)` и
 *   сразу берёт `pg_advisory_xact_lock(MIGRATION_LOCK_ID)`. Любые параллельные
 *   запуски `pnpm db:migrate` (CI + ручной, две реплики Render и т.п.)
 *   сериализуются на этом lock'е — гонка "оба прошли lookup, оба применяют
 *   тело, второй падает на PK INSERT после double-apply" исключена. После
 *   взятия лока мы ПОВТОРНО проверяем `_migrations`, потому что пока мы ждали
 *   лок, другой раннер мог успеть применить файл — тогда мы просто выходим.
 *
 *   Lock timeout: перед попыткой взять advisory lock мы выставляем
 *   `SET LOCAL lock_timeout = '30s'`. Без таймаута падение предыдущей миграции
 *   с зависшим TCP-соединением держит txn-scoped lock до TCP keepalive (~2h
 *   на Linux по умолчанию), и новый деплой повисает молча. С таймаутом мы
 *   падаем за 30s с friendly сообщением: оператор сразу видит `pg_locks`-
 *   ситуацию и может вмешаться (kill старого backend'а / снять stale connection).
 *
 * Checksum contract:
 *   При первом применении файла мы сохраняем sha256 его содержимого в
 *   `_migrations.checksum`. На повторных запусках, если файл уже применён,
 *   но его checksum на диске не совпадает с тем что в БД — это значит кто-то
 *   отредактировал уже применённую миграцию. Это всегда баг (схема на диске
 *   и в БД разъехались), кидаем явную ошибку.
 *
 *   Escape hatch: `MIGRATE_ALLOW_CHECKSUM_DRIFT` — НЕ булев флаг. Значения:
 *     - не задано / пустая строка → strict mode (default).
 *     - список filenames через запятую (e.g. `0001_phase1.sql,0003_other.sql`) →
 *       drift разрешён ТОЛЬКО для этих файлов. Любой другой файл с drift'ом всё
 *       равно падает. Это намеренно — оператор должен явно перечислить, какие
 *       миграции он "приземлил руками" (restore из бэкапа и т.п.), и забытая в
 *       deploy env переменная не маскирует будущие drift'ы.
 *     - `*` или `all` → global override (drift разрешён для всех файлов);
 *       печатает громкий warning `GLOBAL CHECKSUM DRIFT OVERRIDE ACTIVE — NOT FOR PRODUCTION`.
 *   Boolean-truthy значения (`true`/`yes`/`on`/`1`) НЕ распознаются — это
 *   сделано специально, чтобы вынудить оператора писать имя миграции и не
 *   оставлять "залипший" флаг в проде. Если переменная содержит ТОЛЬКО такие
 *   non-.sql / non-wildcard токены, runner печатает warning при старте, чтобы
 *   оператор сразу увидел в логах деплоя, что override — no-op.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { parseDbEnv } from './env.js';

// Constant int8 advisory lock id for the whole migrator. Picked once at random
// and pinned here — DO NOT change it, otherwise old + new runners stop
// serializing against each other. pg_advisory_xact_lock auto-releases at txn
// end, so no manual unlock path is needed.
export const MIGRATION_LOCK_ID = 1873492837492837n;

// PostgreSQL int8 = signed 64-bit, max = 2^63 - 1. pg_advisory_xact_lock($1::int8)
// rejects out-of-range values at runtime — far from the change site and only
// when migrations actually run. We assert at module load so a future maintainer
// who edits MIGRATION_LOCK_ID into something out-of-range fails immediately on
// import, with a clear message.
const POSTGRES_INT8_MAX = 9223372036854775807n;
if (MIGRATION_LOCK_ID <= 0n || MIGRATION_LOCK_ID > POSTGRES_INT8_MAX) {
  throw new Error('MIGRATION_LOCK_ID must fit in Postgres int8 (1..2^63 - 1)');
}

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultMigrationsDir = join(__dirname, '..', 'migrations');

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitForDb(sql: postgres.Sql, maxAttempts: number): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await sql`SELECT 1`;
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const waitMs = attempt * 5_000;
      console.warn(
        `db connection attempt ${attempt}/${maxAttempts} failed, retrying in ${waitMs}ms (managed Postgres cold start?)`,
      );
      await sleep(waitMs);
    }
  }
}

export interface MigrationFile {
  name: string;
  body: string;
}

export interface RunMigrationsOptions {
  /** Pre-loaded migration files. If omitted, files are read from `migrationsDir`. */
  files?: MigrationFile[];
  /** Directory to scan for *.sql files. Defaults to packages/db/migrations. */
  migrationsDir?: string;
  /**
   * Programmatic override of the checksum-drift policy.
   *   - `true`  → allow drift for ALL files (used by tests).
   *   - `false` → strict mode regardless of env (used by tests).
   *   - string  → same syntax as MIGRATE_ALLOW_CHECKSUM_DRIFT
   *               (comma-separated filenames, `*`, or `all`).
   *   - undefined → fall back to MIGRATE_ALLOW_CHECKSUM_DRIFT env var.
   */
  allowChecksumDrift?: boolean | string;
}

/**
 * Parse the env var / option string into a predicate `isDriftAllowed(name)`.
 * See header docstring for the contract.
 *
 * Exported for unit tests (no DB needed) — production callers go through
 * `runMigrations`.
 */
export function buildDriftPolicy(raw: string | undefined): {
  isAllowed: (name: string) => boolean;
  isGlobal: boolean;
} {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') {
    return { isAllowed: () => false, isGlobal: false };
  }
  const tokens = trimmed
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const global = tokens.some((t) => t === '*' || t.toLowerCase() === 'all');
  if (global) {
    return { isAllowed: () => true, isGlobal: true };
  }
  const allowedNames = new Set(tokens);
  // Operator-error guard: if the env var was filled with boolean-looking tokens
  // (`true`, `yes`, `1`) or any other non-filename, strict mode silently stays
  // on and the operator's intended override is a no-op. Warn loudly so the
  // mistake is visible in deploy logs instead of being discovered later when a
  // checksum-drift migration unexpectedly fails on production.
  if (allowedNames.size > 0 && [...allowedNames].every((t) => !t.endsWith('.sql'))) {
    console.warn(
      '[migrate] MIGRATE_ALLOW_CHECKSUM_DRIFT contains no .sql filenames and no * / all wildcard — strict mode active. Did you mean MIGRATE_ALLOW_CHECKSUM_DRIFT=<filename.sql> or =* ?',
    );
  }
  return {
    isAllowed: (name: string) => allowedNames.has(name),
    isGlobal: false,
  };
}

function loadMigrationFiles(migrationsDir: string): MigrationFile[] {
  // Forward migrations only. `*.down.sql` files are the documented rollback
  // artifacts (e.g. 0001_phase1.down.sql) — they are applied manually via
  // `psql`, never picked up by this forward runner. There is intentionally no
  // automated down-runner at this phase.
  //
  // Case-insensitive `.down.sql` check: a typoed rollback file like
  // `0001_phase1_DOWN.sql` or `0001_phase1.Down.SQL` must NOT be silently
  // applied as a forward migration on case-insensitive filesystems / sloppy
  // rename scripts. We reject any `*.down.sql` regardless of case.
  //
  // We also require the extension be exactly lowercase `.sql` for the forward
  // path. An uppercase `.SQL` (or mixed-case) is suspicious — almost always a
  // rename typo — and is logged with a warn so the operator notices instead of
  // having it silently picked up or silently dropped.
  const all = readdirSync(migrationsDir);
  const names: string[] = [];
  for (const f of all) {
    if (/\.down\.sql$/i.test(f)) continue; // rollback artifact, skip
    if (f.endsWith('.sql')) {
      names.push(f);
      continue;
    }
    if (/\.sql$/i.test(f)) {
      console.warn(
        `[migrate] ignoring ${f}: forward migrations must use lowercase '.sql' extension (got non-lowercase). Rename the file.`,
      );
    }
  }
  names.sort();
  return names.map((name) => ({
    name,
    body: readFileSync(join(migrationsDir, name), 'utf8'),
  }));
}

export async function runMigrations(
  sql: postgres.Sql,
  opts: RunMigrationsOptions = {},
): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now(),
      checksum text NOT NULL DEFAULT ''
    );
  `);
  // Backwards compat for DBs migrated by an older version of this runner
  // (the original bootstrap had no checksum column). Default '' marks rows
  // that pre-date checksum tracking; we treat empty stored-checksum as
  // "checksum unknown, skip the mismatch check" (see below).
  await sql.unsafe(
    `ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum text NOT NULL DEFAULT ''`,
  );

  const files =
    opts.files ?? loadMigrationFiles(opts.migrationsDir ?? defaultMigrationsDir);

  if (files.length === 0) {
    console.warn('No migration files found');
  }

  // Resolve drift policy. Programmatic boolean (used by tests) wins; string
  // (programmatic or env) goes through the parser; undefined → env var.
  const optOverride = opts.allowChecksumDrift;
  let driftPolicy: { isAllowed: (name: string) => boolean; isGlobal: boolean };
  if (optOverride === true) {
    driftPolicy = { isAllowed: () => true, isGlobal: true };
  } else if (optOverride === false) {
    driftPolicy = { isAllowed: () => false, isGlobal: false };
  } else if (typeof optOverride === 'string') {
    driftPolicy = buildDriftPolicy(optOverride);
  } else {
    driftPolicy = buildDriftPolicy(process.env['MIGRATE_ALLOW_CHECKSUM_DRIFT']);
  }

  if (driftPolicy.isGlobal && optOverride !== true) {
    // Loud warning only when the global override came from env / string, not
    // from the tests' programmatic `true`.
    console.warn(
      '[migrate] GLOBAL CHECKSUM DRIFT OVERRIDE ACTIVE — NOT FOR PRODUCTION',
    );
  }

  for (const file of files) {
    const fileChecksum = sha256Hex(file.body);

    const existing = await sql<
      { name: string; checksum: string }[]
    >`SELECT name, checksum FROM _migrations WHERE name = ${file.name}`;
    if (existing.length > 0) {
      const storedChecksum = existing[0]?.checksum ?? '';
      // Empty stored checksum = row inserted by a pre-checksum runner, no
      // mismatch check possible. We do NOT backfill on read because that would
      // mask a real drift if the file was edited before this upgrade rolled out.
      if (storedChecksum !== '' && storedChecksum !== fileChecksum) {
        const msg =
          `Migration ${file.name} has been altered after apply (checksum mismatch). ` +
          `Create a new migration file instead of editing.`;
        if (driftPolicy.isAllowed(file.name)) {
          console.warn(
            `[migrate] ${msg} (suppressed by MIGRATE_ALLOW_CHECKSUM_DRIFT policy for ${file.name})`,
          );
        } else {
          throw new Error(msg);
        }
      }
      console.warn(`skip ${file.name} (already applied)`);
      continue;
    }

    // Run the migration body AND its `_migrations` ledger row in ONE
    // transaction: a process kill anywhere in here rolls back BOTH, so the
    // schema is never left applied-but-unrecorded (which would re-run the file
    // on next boot). The migration .sql files therefore must NOT contain their
    // own BEGIN/COMMIT — this runner owns the transaction boundary.
    //
    // Inside the transaction we also take a transaction-scoped advisory lock
    // so concurrent runners (CI race, two replicas of a deploy job) serialize
    // here. After acquiring the lock we re-check whether the file was applied
    // while we were waiting — if so, another runner won the race and we skip.
    await sql.begin(async (tx) => {
      // Bound the wait for pg_advisory_xact_lock so a crashed previous
      // migration (whose txn-scoped lock is still held by a half-dead
      // backend) cannot hang a fresh deploy until TCP keepalive fires
      // (~2h on Linux default). SET LOCAL is scoped to this txn only.
      await tx.unsafe(`SET LOCAL lock_timeout = '30s'`);
      try {
        await tx.unsafe('SELECT pg_advisory_xact_lock($1::int8)', [
          MIGRATION_LOCK_ID.toString(),
        ]);
      } catch (err) {
        const lockErr = err as { code?: string; message?: string };
        // Postgres SQLSTATE 55P03 = lock_not_available (raised by lock_timeout).
        if (lockErr.code === '55P03' || /lock.*timeout|lock not available/i.test(lockErr.message ?? '')) {
          throw new Error(
            `Migration lock not available within 30s. Either (a) a previous run crashed and left a stale advisory lock, OR (b) a legitimate long migration is still running on another instance. Check pg_stat_activity + pg_locks before killing.`,
            { cause: err },
          );
        }
        throw err;
      }

      const recheck = await tx<
        { name: string }[]
      >`SELECT name FROM _migrations WHERE name = ${file.name}`;
      if (recheck.length > 0) {
        console.warn(`skip ${file.name} (applied by concurrent runner)`);
        return;
      }

      await tx.unsafe(file.body);
      await tx`INSERT INTO _migrations (name, checksum) VALUES (${file.name}, ${fileChecksum})`;
    });
    console.warn(`applied ${file.name}`);
  }
}

// CLI entrypoint: only run when this file is invoked as a script (tsx src/migrate.ts),
// not when imported by a test that wants to call runMigrations() against a
// throw-away client. Compare basenames as a defensive fallback for Windows /
// tsx path-normalization differences (`migrate.ts` always wins).
const isCliEntry = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    const self = fileURLToPath(import.meta.url);
    if (self === argv1) return true;
    // Normalize: same basename + parent dir suffix is also a match.
    return self.endsWith('migrate.ts') && argv1.endsWith('migrate.ts');
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  const env = parseDbEnv();
  const client = postgres(env.DATABASE_URL, { max: 1, connect_timeout: 30 });
  try {
    await waitForDb(client, 3);
    await runMigrations(client);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exitCode = 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}
