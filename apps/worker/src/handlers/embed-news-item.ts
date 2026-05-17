/**
 * Handler: embed_news_item.
 *
 * Calls `ai.embed()` for the item's title+extracted_text, validates the
 * vector dimension, persists into `global_news_items.embedding`, and
 * enqueues `cluster_news`.
 *
 * Failures:
 *   - Yandex 5xx / timeout / network → 'transient' (retried with backoff).
 *   - Yandex 4xx (parse_error from provider) / dim mismatch → 'permanent'.
 *     Item gets `embedding_status='failed'` so the matcher can skip it.
 *   - Token expiry → provider already retries-after-401 once internally.
 */

import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { AIProviderError } from '@postdash/ai';
import { globalNewsItems } from '@postdash/db';
import type { TaskHandler } from '../dispatcher.js';

const PayloadSchema = z.object({
  news_item_id: z.string().uuid(),
});

export const embedNewsItemHandler: TaskHandler = async (task, ctx) => {
  const payload = PayloadSchema.parse(task.payload);

  const rows = await ctx.db
    .select({
      id: globalNewsItems.id,
      title: globalNewsItems.title,
      extractedText: globalNewsItems.extractedText,
    })
    .from(globalNewsItems)
    .where(eq(globalNewsItems.id, payload.news_item_id))
    .limit(1);
  const item = rows[0];
  if (!item) throw permanent(`news_item ${payload.news_item_id} not found`);

  const text = item.extractedText ? `${item.title}\n\n${item.extractedText}` : item.title;

  let result: { vector: number[]; used_model: string };
  try {
    result = await ctx.ai.embed({ text, kind: 'doc' });
  } catch (err) {
    // Mark the row failed so Phase 5 matcher can skip it. Retry decision
    // (transient vs permanent) bubbles up via classifyFailure in dispatcher.
    await ctx.db
      .update(globalNewsItems)
      .set({
        embeddingStatus: 'failed',
        embeddingUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(globalNewsItems.id, payload.news_item_id));
    if (err instanceof AIProviderError) {
      // parse_error / not_implemented → permanent. server_error /
      // rate_limit / unknown → let it bubble as transient.
      if (err.code === 'parse_error' || err.code === 'not_implemented') {
        throw permanent(err.message);
      }
    }
    throw err;
  }

  // pgvector accepts a JSON-array literal cast to vector. Drizzle's vector
  // column type expects `number[]` directly when using the `vector` helper.
  await ctx.db
    .update(globalNewsItems)
    .set({
      embedding: result.vector,
      embeddingStatus: 'ok',
      embeddingUpdatedAt: new Date(),
      status: sql`CASE WHEN status IN ('new','extracted') THEN 'embedded' ELSE status END`,
      updatedAt: new Date(),
    })
    .where(eq(globalNewsItems.id, payload.news_item_id));

  await ctx.enqueue({
    type: 'cluster_news',
    payload: { news_item_id: payload.news_item_id },
  });
};

function permanent(message: string): Error {
  const e: Error & { kind?: string } = new Error(message);
  e.kind = 'permanent';
  return e;
}
