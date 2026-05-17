/**
 * Adapter that wires `system_state` into `IAMTokenStore` for the
 * `packages/ai` IAMTokenCache. Lives in `apps/worker` to keep
 * `packages/ai` free of any DB dependency (preserves the "ai is an adapter,
 * not core" rule — see `architecture/global-ingestion.md` dependency graph).
 */

import { sql } from 'drizzle-orm';
import type { Database } from '@postdash/db';
import type { IAMTokenStore } from '@postdash/ai';

const KEY = 'ya_iam_token';

interface StoredValue {
  token: string;
}

export function systemStateIamStore(db: Database): IAMTokenStore {
  return {
    async read() {
      const rows = (await db.execute(sql`
        SELECT value, expires_at
        FROM system_state
        WHERE key = ${KEY}
        LIMIT 1
      `)) as Array<{ value: unknown; expires_at: Date | null }>;
      const row = rows[0];
      if (!row || !row.expires_at) return null;
      const parsed = row.value as Partial<StoredValue> | null;
      if (!parsed || typeof parsed.token !== 'string') return null;
      return { token: parsed.token, expiresAt: row.expires_at };
    },
    async write(token: string, expiresAt: Date) {
      const value: StoredValue = { token };
      await db.execute(sql`
        INSERT INTO system_state (key, value, expires_at, updated_at)
        VALUES (${KEY}, ${JSON.stringify(value)}::jsonb, ${expiresAt}, now())
        ON CONFLICT (key) DO UPDATE SET
          value = EXCLUDED.value,
          expires_at = EXCLUDED.expires_at,
          updated_at = now()
      `);
    },
  };
}
