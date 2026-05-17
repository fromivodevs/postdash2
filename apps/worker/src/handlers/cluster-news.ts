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
 *
 * ## ivfflat planner contract
 *
 * Postgres' query planner only picks the `global_news_items_embedding_ivfflat_idx`
 * when the distance operand is a CONSTANT literal — `$1::vector` is treated as
 * a runtime parameter, and the planner falls back to a sequential scan that
 * gets slower linearly in the corpus size. We therefore inline the embedding
 * as a `[v0,v1,...]::vector` literal string, and bracket the transaction with
 * `SET LOCAL ivfflat.probes = 10` (default 1, recall ~75%; 10 lifts recall to
 * ~95% on a 100-list index — see architecture/global-ingestion.md).
 *
 * ## Transactional scope
 *
 * The ENTIRE handler body runs inside a single `ctx.client.begin(...)`
 * transaction. Two reasons:
 *   - `SET LOCAL ivfflat.probes = 10` only applies for the lifetime of the
 *     surrounding tx; running the neighbour query in one tx and the writes
 *     outside it would silently revert to probes=1 for any future query
 *     that happens to land on the same pooled connection.
 *   - Two concurrent cluster_news tasks for different items but the same
 *     neighbour timeframe could both see "no cluster exists" and both
 *     INSERT into news_clusters, producing twin clusters. Wrapping
 *     neighbour-lookup + create + attach in one transaction narrows
 *     (does not eliminate) that window. The `news_cluster_items.UNIQUE
 *     (news_item_id)` index still prevents the second writer from attaching
 *     the same item twice, so we never get torn cluster membership — only
 *     an orphan extra cluster row. A fully atomic solution would need
 *     `SELECT ... FOR UPDATE` on the nearest neighbour's cluster row to
 *     serialize concurrent writers, which is overkill for MVP; the
 *     stranded-cluster reaper is tracked in
 *     architecture/global-ingestion.md "Known follow-ups".
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import type { TaskHandler } from '../dispatcher.js';

const PayloadSchema = z.object({
  news_item_id: z.string().uuid(),
});

/**
 * Format `number[]` as a pgvector literal: `[0.1,0.2,...]`. We inline this
 * directly into the unsafe-SQL string (NOT as a `$N` bind) so the planner
 * sees a real CONSTANT — that's the condition for picking the ivfflat index.
 * Inputs come from `ai.embed()` which already validates every element is a
 * finite number, so there is no SQL-injection surface.
 */
function vectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

export const clusterNewsHandler: TaskHandler = async (task, ctx) => {
  const payload = PayloadSchema.parse(task.payload);
  const windowHours = ctx.aiConfig.dedupeWindowHours;
  const threshold = ctx.aiConfig.dedupeCosineThreshold;

  await ctx.client.begin(async (tx) => {
    // SET LOCAL is scoped to this transaction only — once we COMMIT/ROLLBACK
    // the connection reverts to the cluster default (probes=1). Required for
    // the ivfflat planner contract documented in the file header.
    await tx.unsafe('SET LOCAL ivfflat.probes = 10');

    // Skip if item already clustered (idempotency on re-enqueue). Inside the
    // tx so a concurrent attach by another worker is visible (postgres
    // default read-committed sees committed inserts).
    const existing = (await tx`
      SELECT cluster_id FROM news_cluster_items WHERE news_item_id = ${payload.news_item_id}
    `) as Array<{ cluster_id: string }>;
    if (existing.length > 0) {
      ctx.logger.info({ newsItemId: payload.news_item_id }, 'item already clustered, skipping');
      return;
    }

    // Pull the item's embedding + published_at. Selecting as `number[]` (not
    // `::text`) lets us format the vector literal in JS without an intermediate
    // round-trip; pgvector returns `[a,b,...]` strings by default, so we ask
    // for the array shape explicitly via the driver.
    const itemRows = (await tx`
      SELECT embedding, published_at, title
      FROM global_news_items
      WHERE id = ${payload.news_item_id} AND embedding_status = 'ok'
      LIMIT 1
    `) as Array<{ embedding: number[] | string | null; published_at: Date | null; title: string }>;
    const item = itemRows[0];
    if (!item || item.embedding === null) {
      throw permanent(`news_item ${payload.news_item_id} has no usable embedding`);
    }
    const embeddingArray = parseEmbedding(item.embedding);

    // Nearest neighbour query. We compare against items in the 48h window
    // EXCLUDING ourselves. cluster_id may be NULL — we LEFT JOIN
    // news_cluster_items to find each candidate's cluster.
    //
    // The embedding is inlined as a `[...]::vector` literal so the planner can
    // pick the ivfflat index.
    const vecLit = vectorLiteral(embeddingArray);
    const neighbours = (await tx.unsafe(
      `
      SELECT g.id, nci.cluster_id, (g.embedding <=> '${vecLit}'::vector) AS distance
      FROM global_news_items g
      LEFT JOIN news_cluster_items nci ON nci.news_item_id = g.id
      WHERE g.embedding_status = 'ok'
        AND g.id != $1
        AND g.published_at IS NOT NULL
        AND g.published_at > now() - ($2::int * interval '1 hour')
      ORDER BY g.embedding <=> '${vecLit}'::vector
      LIMIT 5
      `,
      [payload.news_item_id, windowHours],
    )) as Array<{ id: string; cluster_id: string | null; distance: number }>;

    const nearest = neighbours[0];
    let clusterId: string | null = null;

    if (nearest && nearest.distance < threshold) {
      if (nearest.cluster_id) {
        clusterId = nearest.cluster_id;
      } else {
        // Neighbour exists but isn't clustered yet (race / out-of-order
        // processing). Create a cluster from the pair.
        const created = await createCluster(tx, item.title);
        clusterId = created;
        await attachToCluster(tx, clusterId, nearest.id);
      }
      await attachToCluster(tx, clusterId, payload.news_item_id);
      ctx.logger.info(
        { newsItemId: payload.news_item_id, clusterId, distance: nearest.distance },
        'attached item to existing cluster',
      );
    } else {
      clusterId = await createCluster(tx, item.title);
      await attachToCluster(tx, clusterId, payload.news_item_id);
      ctx.logger.info(
        { newsItemId: payload.news_item_id, clusterId, distance: nearest?.distance ?? null },
        'created new cluster',
      );
    }

    await recomputeCluster(tx, clusterId);

    await tx`
      UPDATE global_news_items
      SET status = 'clustered', updated_at = now()
      WHERE id = ${payload.news_item_id} AND status IN ('new', 'extracted', 'embedded')
    `;
  });
};

/**
 * `tx` parameter type — the callback argument of postgres.js `.begin()`.
 * postgres.js exposes this as `TransactionSql<...>`, which is intentionally
 * a *narrower* type than the connection-level `Sql<...>` (it removes
 * lifecycle methods like END/CLOSE that don't apply to a transaction).
 * Alias it directly so helpers accept exactly what `begin(async (tx) => ...)`
 * yields, without forcing callers to widen.
 */
type TxClient = postgres.TransactionSql;

async function createCluster(tx: TxClient, title: string): Promise<string> {
  const rows = (await tx`
    INSERT INTO news_clusters (canonical_title, first_seen_at, last_seen_at, sources_count)
    VALUES (${title}, now(), now(), 1)
    RETURNING id
  `) as Array<{ id: string }>;
  const id = rows[0]?.id;
  if (!id) throw permanent('news_clusters insert returned no id');
  return id;
}

async function attachToCluster(tx: TxClient, clusterId: string, newsItemId: string): Promise<void> {
  // UNIQUE (news_item_id) — second attach is a no-op via ON CONFLICT DO NOTHING.
  await tx`
    INSERT INTO news_cluster_items (cluster_id, news_item_id)
    VALUES (${clusterId}, ${newsItemId})
    ON CONFLICT (news_item_id) DO NOTHING
  `;
}

async function recomputeCluster(tx: TxClient, clusterId: string): Promise<void> {
  // centroid = avg of all embedded items in the cluster.
  // sources_count = distinct source_id across items.
  //
  // Single CTE so the news_cluster_items → global_news_items join scans once
  // and feeds both aggregates. The previous two correlated subqueries each
  // independently re-joined the tables, doubling index reads on every cluster
  // mutation. Postgres' planner can in principle collapse the two subqueries
  // into one pass, but the CTE form makes the intent explicit and removes any
  // dependency on planner heuristics. tx.unsafe is required because postgres.js
  // does not expose a tagged-template path for WITH ... UPDATE chains.
  await tx.unsafe(
    `
    WITH members AS (
      SELECT g.embedding, g.source_id, g.embedding_status
      FROM global_news_items g
      JOIN news_cluster_items ci ON ci.news_item_id = g.id
      WHERE ci.cluster_id = $1
    )
    UPDATE news_clusters SET
      centroid_embedding = (SELECT AVG(embedding) FROM members WHERE embedding_status = 'ok'),
      sources_count = (SELECT COUNT(DISTINCT source_id) FROM members),
      last_seen_at = now(),
      updated_at = now()
    WHERE id = $1
    `,
    [clusterId],
  );
}

/**
 * pgvector returns vectors as `[a,b,c]`-formatted strings via postgres.js by
 * default; only the configured-types driver path returns `number[]`. Accept
 * both so this helper survives a future driver upgrade or per-call type tag.
 */
function parseEmbedding(value: number[] | string): number[] {
  if (Array.isArray(value)) return value;
  const trimmed = value.trim();
  const inner = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  if (inner.length === 0) return [];
  return inner.split(',').map((s) => Number(s));
}

function permanent(message: string): Error {
  const e: Error & { kind?: string } = new Error(message);
  e.kind = 'permanent';
  return e;
}

void sql;
