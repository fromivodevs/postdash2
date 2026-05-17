/**
 * Handler: fetch_source.
 *
 * Pulls an RSS feed for a single source. Steps (per architecture/global-ingestion.md
 * §How it works):
 *
 *   1. SELECT source row (canonical_url, max_items_per_fetch).
 *   2. fetchRssSource() → ParsedItem[].
 *   3. For each item: canonicalize url + contentHash → UPSERT global_news_items.
 *   4. Enqueue extract_news_item for newly-inserted OR was_updated items.
 *   5. UPDATE sources.last_fetched_at + last_fetch_status.
 *
 * Volume cap: rss-parser already trims to `maxItems`, but we record the
 * pre-cap count for observability (no tasks row for the skipped items; the
 * convention is "next tick picks up the rest if source has high churn").
 *
 * Retry kind: 5xx / timeout / network → 'transient'; 4xx → 'permanent'
 * (per task queue retry policy).
 */

import { sql, eq } from 'drizzle-orm';
import {
  canonicalize,
  contentHash,
  fetchRssSource,
  resolveRedirect,
  type ParsedItem,
} from '@postdash/sources';
import { globalNewsItems, sources } from '@postdash/db';
import type { TaskHandler } from '../dispatcher.js';

export const fetchSourceHandler: TaskHandler = async (task, ctx) => {
  const sourceId = task.sourceId;
  if (!sourceId) {
    throw permanent(`fetch_source task ${task.id} has no source_id`);
  }

  const rows = await ctx.db
    .select({
      id: sources.id,
      url: sources.url,
      canonicalUrl: sources.canonicalUrl,
      type: sources.type,
      maxItemsPerFetch: sources.maxItemsPerFetch,
      status: sources.status,
    })
    .from(sources)
    .where(eq(sources.id, sourceId))
    .limit(1);
  const source = rows[0];
  if (!source) throw permanent(`source ${sourceId} not found`);
  if (source.status === 'disabled') {
    ctx.logger.info({ sourceId }, 'source disabled, skipping fetch');
    return;
  }
  if (source.type !== 'rss') {
    // Phase 4 only ships the RSS adapter. Other types are accepted in the
    // DB CHECK but have no fetch implementation yet — treat as permanent
    // failure so the task doesn't loop.
    throw permanent(`source ${sourceId} type=${source.type} has no fetcher in Phase 4`);
  }

  // SSRF re-check at fetch time. The full SSRF gate (DNS allowlist + rebinding
  // stability) ran at source creation, but DNS can flip later — a domain that
  // pointed to a public CDN yesterday may today resolve to a private IP. Re-
  // running `resolveRedirect` here is cheaper than introducing a connect-time
  // IP-pinning Agent in the fetcher (Phase 4+ hardening, tracked in
  // architecture/global-ingestion.md). Block-on-failure marks the source as
  // permanently failed for this attempt so the operator notices.
  //
  // We hand `guard.finalUrl` to the actual fetcher instead of re-feeding
  // `source.canonicalUrl` so that fetchRssSource doesn't walk a SECOND,
  // independent redirect chain (which an attacker who flips DNS between
  // guard and fetch could weaponize). This is detective-only — fetch's own
  // TCP connect still does its own DNS lookup, so there is a residual
  // TOCTOU window. Full connect-time IP pinning via a custom https.Agent
  // is tracked in architecture/global-ingestion.md "Known follow-ups".
  const guard = await resolveRedirect(source.canonicalUrl, {});
  if (guard.status === 'blocked_private_ip') {
    await ctx.db
      .update(sources)
      .set({
        lastFetchedAt: new Date(),
        // CHECK accepts ('ok' | '4xx' | '5xx' | 'parse_error' | 'timeout');
        // '4xx' is the closest match for "we refused to fetch this".
        lastFetchStatus: '4xx',
        lastFetchError: shortError(guard.error ?? 'blocked_private_ip'),
        status: 'error',
        updatedAt: new Date(),
      })
      .where(eq(sources.id, sourceId));
    throw permanent(`ssrf re-check blocked: ${guard.error ?? 'private ip'}`);
  }

  // Any non-success guard status (timeout, network_error, too_many_hops,
  // invalid_input) leaves `guard.finalUrl` pointing at the LAST URL we were
  // walking — which may be an unverified intermediate redirect hop (the SSRF
  // walk aborted mid-chain). Refusing to fetch that URL is the only safe move:
  // a partial walk + downstream fetch is functionally identical to having no
  // SSRF guard at all for that request. Park the source with the precise
  // upstream reason; timeout is retryable (transient), everything else is
  // treated as permanent until DNS / network conditions change and the
  // operator re-enables the source.
  if (guard.status !== 'resolved' && guard.status !== 'no_redirect') {
    const mappedStatus: 'timeout' | '4xx' = guard.status === 'timeout' ? 'timeout' : '4xx';
    await ctx.db
      .update(sources)
      .set({
        lastFetchedAt: new Date(),
        lastFetchStatus: mappedStatus,
        lastFetchError: shortError(`ssrf_guard_${guard.status}: ${guard.error ?? 'no detail'}`),
        updatedAt: new Date(),
      })
      .where(eq(sources.id, sourceId));
    if (guard.status === 'timeout') throw transient(`ssrf_guard_timeout`);
    throw permanent(`ssrf_guard_${guard.status}`);
  }

  // On 'resolved' / 'no_redirect' the guard already verified each hop's IP;
  // hand that terminus to the fetcher.
  const fetchUrl = guard.finalUrl;
  const result = await fetchRssSource(fetchUrl, {
    maxItems: source.maxItemsPerFetch,
  });

  if (result.status !== 'ok') {
    // Flip sources.status='error' when the failure is permanent (4xx) or this
    // attempt is about to exhaust the retry budget — the source is consistently
    // unreachable and operator attention is needed. A subsequent successful
    // fetch resets it back to 'active' (see the ok branch at the bottom).
    const finalAttempt = task.attempts >= task.maxAttempts;
    const isPermanent = result.status === '4xx';
    const markSourceError = isPermanent || finalAttempt;
    await ctx.db
      .update(sources)
      .set({
        lastFetchedAt: new Date(),
        lastFetchStatus: mapFetchStatus(result.status),
        // CHECK ≤ 200 chars; fetchRssSource already truncates.
        lastFetchError: result.error ?? `fetch ${result.status}`,
        ...(markSourceError ? { status: 'error' as const } : {}),
        updatedAt: new Date(),
      })
      .where(eq(sources.id, sourceId));
    // 4xx → permanent; 5xx/timeout/network/parse_error → transient (worth
    // retrying once or twice — feed could be temporarily down).
    if (isPermanent) {
      throw permanent(`feed ${result.status}: ${result.error ?? 'no detail'}`);
    }
    throw transient(`feed ${result.status}: ${result.error ?? 'no detail'}`);
  }

  // Per-item upsert into global_news_items. Done outside a single transaction
  // intentionally — each item's upsert is independent, and a transaction
  // around the whole loop would hold a write lock for the full processing
  // time of one source. Worst case: a crash mid-loop leaves some items
  // inserted, the next tick picks up the rest (idempotent via UNIQUE).
  const upserted: Array<{ id: string; isNew: boolean; wasUpdated: boolean }> = [];
  for (const item of result.items) {
    const upsertResult = await upsertItem(ctx.db, sourceId, item);
    if (upsertResult) upserted.push(upsertResult);
  }

  // Enqueue extract for new / updated items only. (Existing-and-unchanged
  // skips: the embedding was already generated previously.)
  for (const u of upserted) {
    if (u.isNew || u.wasUpdated) {
      await ctx.enqueue({
        type: 'extract_news_item',
        payload: { news_item_id: u.id },
      });
    }
  }

  const priorStatus = source.status;
  await ctx.db
    .update(sources)
    .set({
      lastFetchedAt: new Date(),
      lastFetchStatus: 'ok',
      lastFetchError: null,
      // If the source was previously parked in 'error' (permanent / exhausted
      // failure), a successful fetch un-parks it. We deliberately do NOT touch
      // 'disabled' here — operator-disabled sources stay disabled even when
      // we accidentally enqueue a fetch for them (the earlier guard at top of
      // the handler already short-circuits that case).
      ...(priorStatus === 'error' ? { status: 'active' as const } : {}),
      updatedAt: new Date(),
    })
    .where(eq(sources.id, sourceId));

  if (priorStatus === 'error') {
    // Notable transition — operator's log aggregator surfaces warns, so a
    // recovered source is visible without grep'ing every fetch_source line.
    // Phase 4's observability story is log-based (no metrics pipeline yet);
    // warn-level keeps recoveries discoverable against the info-level noise.
    ctx.logger.warn({ sourceId, status: 'active' }, 'source recovered from error to active');
  }

  ctx.logger.info(
    {
      sourceId,
      rawCount: result.rawCount,
      kept: result.items.length,
      newItems: upserted.filter((u) => u.isNew).length,
      updatedItems: upserted.filter((u) => u.wasUpdated).length,
    },
    'fetch_source completed',
  );
};

interface UpsertOutcome {
  id: string;
  isNew: boolean;
  wasUpdated: boolean;
}

async function upsertItem(
  db: Parameters<TaskHandler>[1]['db'],
  sourceId: string,
  item: ParsedItem,
): Promise<UpsertOutcome | null> {
  const canon = canonicalize(item.link);
  if (!canon.canonical) {
    // Item URL is unparseable. Skip — never block a whole fetch on one bad
    // item. Log redacted URL.
    return null;
  }
  const hash = contentHash({
    title: item.title,
    summary: item.summary,
    publishedAt: item.publishedAt,
  });

  // xmax-via-RETURNING for insert-vs-update detection (same pattern as
  // createSource in packages/commands/src/sources.ts). DO UPDATE branch
  // also returns the OLD content_hash via a stored expression so we can
  // detect the "feed updated existing item" case in JS.
  //
  // We need both:
  //   - inserted vs not (xmax=0)
  //   - if not inserted: was content_hash different? (was_updated path)
  //
  // Drizzle insert builder can return arbitrary SQL fragments via the
  // returning() object — including the OLD column value via `excluded`
  // and the existing row via the table alias.
  const rows = await db
    .insert(globalNewsItems)
    .values({
      sourceId,
      title: item.title,
      url: item.link,
      canonicalUrl: canon.canonical,
      contentHash: hash,
      summary: item.summary ?? null,
      publishedAt: item.publishedAt ?? null,
      language: item.language ?? null,
      status: 'new',
    })
    .onConflictDoUpdate({
      target: [globalNewsItems.sourceId, globalNewsItems.canonicalUrl],
      // Set only the fields that should change on update. content_hash is
      // updated unconditionally so the next fetch sees the new state.
      set: {
        title: sql`EXCLUDED.title`,
        summary: sql`EXCLUDED.summary`,
        publishedAt: sql`EXCLUDED.published_at`,
        language: sql`EXCLUDED.language`,
        contentHash: sql`EXCLUDED.content_hash`,
        // was_updated = TRUE when the new hash differs from the prior one.
        wasUpdated: sql`global_news_items.content_hash IS DISTINCT FROM EXCLUDED.content_hash`,
        lastUpdatedInSourceAt: sql`
          CASE WHEN global_news_items.content_hash IS DISTINCT FROM EXCLUDED.content_hash
               THEN now() ELSE global_news_items.last_updated_in_source_at END
        `,
        // When content changes, force re-embed. Otherwise keep the existing
        // embedding_status so we don't redundantly re-embed unchanged items.
        embeddingStatus: sql`
          CASE WHEN global_news_items.content_hash IS DISTINCT FROM EXCLUDED.content_hash
               THEN 'pending' ELSE global_news_items.embedding_status END
        `,
        updatedAt: new Date(),
      },
    })
    .returning({
      id: globalNewsItems.id,
      inserted: sql<boolean>`xmax = 0`,
      wasUpdated: globalNewsItems.wasUpdated,
    });
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    isNew: row.inserted === true,
    wasUpdated: row.inserted === false && row.wasUpdated === true,
  };
}

function mapFetchStatus(s: string): 'ok' | '4xx' | '5xx' | 'parse_error' | 'timeout' {
  // sources.last_fetch_status CHECK accepts exactly:
  //   ('ok' | '4xx' | '5xx' | 'parse_error' | 'timeout').
  // FetchStatus from rss-parser additionally has 'network_error' (DNS fail,
  // ECONNREFUSED, etc.) which has no DB slot — we intentionally collapse it
  // (and any unknown status) into 'timeout'. The precise upstream reason is
  // preserved verbatim in sources.last_fetch_error, so observability is not
  // lost; only the categorical bucket is widened. This is by design — adding
  // a 'network_error' enum value would require a CHECK migration with low
  // operator value (the error text already disambiguates).
  if (s === 'ok' || s === '4xx' || s === '5xx' || s === 'parse_error' || s === 'timeout') {
    return s;
  }
  return 'timeout';
}

function permanent(message: string): Error {
  const e: Error & { kind?: string } = new Error(message);
  e.kind = 'permanent';
  return e;
}
function transient(message: string): Error {
  const e: Error & { kind?: string } = new Error(message);
  e.kind = 'transient';
  return e;
}

/** Hard cap to match sources.last_fetch_error CHECK (≤200 chars). */
function shortError(msg: string): string {
  return msg.length > 200 ? msg.slice(0, 200) : msg;
}
