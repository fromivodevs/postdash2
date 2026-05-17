/**
 * Handler: cluster_news.
 *
 * Semantic dedup. Given a freshly-embedded item:
 *   1. Find nearest neighbour within last AI_DEDUPE_WINDOW_HOURS (default 48h)
 *      using pgvector cosine distance.
 *   2. If neighbour's distance < AI_DEDUPE_COSINE_THRESHOLD (default 0.15) —
 *      attach to the neighbour's cluster (or create one from the pair).
 *      Else create a new cluster.
 *   3. Recompute centroid + sources_count + last_seen_at on the cluster.
 *
 * news_cluster_items.UNIQUE (news_item_id) enforces "one cluster per item" —
 * re-running this handler on the same item is a no-op (ON CONFLICT DO NOTHING).
 *
 * The cluster lookup is bounded by published_at > now() - 48h so the index
 * scan cost stays predictable as the corpus grows.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { parseAIEnv } from '@postdash/ai';
import type { TaskHandler } from '../dispatcher.js';

const PayloadSchema = z.object({
  news_item_id: z.string().uuid(),
});

const aiEnv = parseAIEnv();

export const clusterNewsHandler: TaskHandler = async (task, ctx) => {
  const payload = PayloadSchema.parse(task.payload);

  // Skip if item already clustered (idempotency on re-enqueue).
  const existing = (await ctx.client`
    SELECT cluster_id FROM news_cluster_items WHERE news_item_id = ${payload.news_item_id}
  `) as Array<{ cluster_id: string }>;
  if (existing.length > 0) {
    ctx.logger.info({ newsItemId: payload.news_item_id }, 'item already clustered, skipping');
    return;
  }

  // Pull the item's embedding + published_at.
  const itemRows = (await ctx.client`
    SELECT embedding::text AS embedding, published_at, title
    FROM global_news_items
    WHERE id = ${payload.news_item_id} AND embedding_status = 'ok'
    LIMIT 1
  `) as Array<{ embedding: string; published_at: Date | null; title: string }>;
  const item = itemRows[0];
  if (!item) throw permanent(`news_item ${payload.news_item_id} has no usable embedding`);

  // Nearest neighbour query. Cast the JSON-literal back to vector for the
  // distance op. We compare against items in the 48h window EXCLUDING
  // ourselves. cluster_id may be NULL — we LEFT JOIN news_cluster_items
  // to find each candidate's cluster.
  const windowHours = aiEnv.AI_DEDUPE_WINDOW_HOURS;
  const threshold = aiEnv.AI_DEDUPE_COSINE_THRESHOLD;
  const neighbours = (await ctx.client`
    SELECT g.id, nci.cluster_id, (g.embedding <=> ${item.embedding}::vector) AS distance
    FROM global_news_items g
    LEFT JOIN news_cluster_items nci ON nci.news_item_id = g.id
    WHERE g.embedding_status = 'ok'
      AND g.id != ${payload.news_item_id}
      AND g.published_at IS NOT NULL
      AND g.published_at > now() - (${windowHours}::int * interval '1 hour')
    ORDER BY g.embedding <=> ${item.embedding}::vector
    LIMIT 5
  `) as Array<{ id: string; cluster_id: string | null; distance: number }>;

  const nearest = neighbours[0];
  let clusterId: string | null = null;

  if (nearest && nearest.distance < threshold) {
    if (nearest.cluster_id) {
      clusterId = nearest.cluster_id;
    } else {
      // Neighbour exists but isn't clustered yet (race / out-of-order
      // processing). Create a cluster from the pair.
      const created = await createCluster(ctx, item.title);
      clusterId = created;
      await attachToCluster(ctx, clusterId, nearest.id);
    }
    await attachToCluster(ctx, clusterId, payload.news_item_id);
    ctx.logger.info(
      { newsItemId: payload.news_item_id, clusterId, distance: nearest.distance },
      'attached item to existing cluster',
    );
  } else {
    clusterId = await createCluster(ctx, item.title);
    await attachToCluster(ctx, clusterId, payload.news_item_id);
    ctx.logger.info(
      { newsItemId: payload.news_item_id, clusterId, distance: nearest?.distance ?? null },
      'created new cluster',
    );
  }

  await recomputeCluster(ctx, clusterId);

  await ctx.client`
    UPDATE global_news_items
    SET status = 'clustered', updated_at = now()
    WHERE id = ${payload.news_item_id} AND status IN ('new', 'extracted', 'embedded')
  `;
};

async function createCluster(ctx: Parameters<TaskHandler>[1], title: string): Promise<string> {
  const rows = (await ctx.client`
    INSERT INTO news_clusters (canonical_title, first_seen_at, last_seen_at, sources_count)
    VALUES (${title}, now(), now(), 1)
    RETURNING id
  `) as Array<{ id: string }>;
  const id = rows[0]?.id;
  if (!id) throw permanent('news_clusters insert returned no id');
  return id;
}

async function attachToCluster(
  ctx: Parameters<TaskHandler>[1],
  clusterId: string,
  newsItemId: string,
): Promise<void> {
  // UNIQUE (news_item_id) — second attach is a no-op via ON CONFLICT DO NOTHING.
  await ctx.client`
    INSERT INTO news_cluster_items (cluster_id, news_item_id)
    VALUES (${clusterId}, ${newsItemId})
    ON CONFLICT (news_item_id) DO NOTHING
  `;
}

async function recomputeCluster(ctx: Parameters<TaskHandler>[1], clusterId: string): Promise<void> {
  // centroid = avg of all embedded items in the cluster.
  // sources_count = distinct source_id across items.
  await ctx.client`
    UPDATE news_clusters SET
      centroid_embedding = (
        SELECT AVG(g.embedding) FROM global_news_items g
        JOIN news_cluster_items ci ON ci.news_item_id = g.id
        WHERE ci.cluster_id = ${clusterId} AND g.embedding_status = 'ok'
      ),
      sources_count = (
        SELECT COUNT(DISTINCT g.source_id) FROM global_news_items g
        JOIN news_cluster_items ci ON ci.news_item_id = g.id
        WHERE ci.cluster_id = ${clusterId}
      ),
      last_seen_at = now(),
      updated_at = now()
    WHERE id = ${clusterId}
  `;
}

function permanent(message: string): Error {
  const e: Error & { kind?: string } = new Error(message);
  e.kind = 'permanent';
  return e;
}

void sql;
