/**
 * Handler: extract_news_item.
 *
 * Phase 4 MVP: copies RSS `summary` into `extracted_text` and enqueues
 * `embed_news_item`. Real HTML scraping (Readability / cheerio) is
 * deliberately deferred per architecture/global-ingestion.md "Decision:
 * HTML extraction отложена".
 *
 * Idempotent on re-run: if extracted_text is already populated and the
 * status is not 'new', we still enqueue embed. Embed has its own anti-dupe
 * partial UNIQUE index on `(payload->>'news_item_id')` for tasks in
 * pending/running states (added in `0006_phase4_hardening.sql`), so a
 * duplicate enqueue collapses to ON CONFLICT DO NOTHING in
 * `enqueueTask`. The dispatcher already guarantees that a single task only
 * fires one extract; the partial index makes a manual re-enqueue safe too.
 */

import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { globalNewsItems } from '@postdash/db';
import type { TaskHandler } from '../dispatcher.js';

const PayloadSchema = z.object({
  news_item_id: z.string().uuid(),
});

export const extractNewsItemHandler: TaskHandler = async (task, ctx) => {
  const payload = PayloadSchema.parse(task.payload);

  const rows = await ctx.db
    .select({
      id: globalNewsItems.id,
      summary: globalNewsItems.summary,
      extractedText: globalNewsItems.extractedText,
      status: globalNewsItems.status,
    })
    .from(globalNewsItems)
    .where(eq(globalNewsItems.id, payload.news_item_id))
    .limit(1);
  const item = rows[0];
  if (!item) throw permanent(`news_item ${payload.news_item_id} not found`);

  // MVP: extracted_text = summary. When summary is missing (some feeds give
  // only title), leave extracted_text NULL — the embed handler will still
  // run on title alone.
  const next = item.summary ?? item.extractedText ?? null;
  await ctx.db
    .update(globalNewsItems)
    .set({
      extractedText: next,
      status: 'extracted',
      updatedAt: new Date(),
    })
    .where(eq(globalNewsItems.id, payload.news_item_id));

  await ctx.enqueue({
    type: 'embed_news_item',
    payload: { news_item_id: payload.news_item_id },
  });
};

function permanent(message: string): Error {
  const e: Error & { kind?: string } = new Error(message);
  e.kind = 'permanent';
  return e;
}
