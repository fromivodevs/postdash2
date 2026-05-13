/**
 * Простой SQL migrator для Phase 0.
 *
 * Применяет файлы из migrations/*.sql в алфавитном порядке.
 * Уже применённые отслеживает в таблице _migrations.
 *
 * С Phase 1+ можно переключиться на drizzle-kit-managed миграции
 * через `pnpm db:generate`. Этот скрипт совместим с обоими подходами:
 * читает любые *.sql файлы.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { parseDbEnv } from './env.js';

const env = parseDbEnv();
const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(__dirname, '..', 'migrations');

const client = postgres(env.DATABASE_URL, { max: 1 });

try {
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.warn('No migration files found in', migrationsDir);
  }

  for (const file of files) {
    const applied = await client`SELECT name FROM _migrations WHERE name = ${file}`;
    if (applied.length > 0) {
      console.warn(`skip ${file} (already applied)`);
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    await client.unsafe(sql);
    await client`INSERT INTO _migrations (name) VALUES (${file})`;
    console.warn(`applied ${file}`);
  }
} catch (err) {
  console.error('Migration failed:', err);
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
