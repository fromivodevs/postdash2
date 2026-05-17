/**
 * Handler: recompute_topic_embedding.
 *
 * Enqueued by createTopicProfile / updateTopicProfile (commands) when the
 * profile's content (main_topics / keywords / language) changes. Reads the
 * current row, builds a representative text from main_topics + keywords,
 * calls `ai.embed(kind='query')`, and persists into `topic_profiles.embedding`.
 *
 * The 'query' kind matches the topic_profile's role as a query against
 * news embeddings (computed with 'doc'). Yandex documents this asymmetry as
 * the recommended pattern for relevance retrieval.
 *
 * Failures:
 *   - Yandex 5xx / network → 'transient' (handler retries with backoff).
 *   - Yandex 4xx / dim mismatch → 'permanent' (row keeps embedding_status='pending'
 *     so the matcher knows to skip semantic pre-score for this topic).
 *
 * The partial UNIQUE `tasks_unique_active_recompute_per_topic` collapses
 * burst-PATCH enqueues to one in-flight recompute per topic.
 */

import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { AIProviderError } from '@postdash/ai';
import { topicProfiles } from '@postdash/db';
import type { TaskHandler } from '../dispatcher.js';

const PayloadSchema = z.object({
  topic_profile_id: z.string().uuid(),
});

export const recomputeTopicEmbeddingHandler: TaskHandler = async (task, ctx) => {
  const payload = PayloadSchema.parse(task.payload);

  const rows = await ctx.db
    .select({
      id: topicProfiles.id,
      mainTopics: topicProfiles.mainTopics,
      keywords: topicProfiles.keywords,
      status: topicProfiles.status,
    })
    .from(topicProfiles)
    .where(eq(topicProfiles.id, payload.topic_profile_id))
    .limit(1);
  const topic = rows[0];
  if (!topic) throw permanent(`topic_profile ${payload.topic_profile_id} not found`);
  if (topic.status !== 'active') {
    ctx.logger.info(
      { topicProfileId: payload.topic_profile_id, status: topic.status },
      'topic_profile not active, skipping embedding',
    );
    return;
  }

  // Representative text. Empty topic_profile (no topics + no keywords) is
  // common right after CREATE — embedding it would produce a meaningless
  // vector. Empty topic profiles cannot be embedded — flip to terminal
  // 'failed' state so scheduler.slowTick (which scans
  // `WHERE embedding_status='pending'`) stops re-enqueueing this row every
  // 5 minutes forever. The next user edit (updateTopicProfile) that adds
  // topics or keywords flips the status back to 'pending', which re-arms
  // the recompute. The matcher meanwhile falls back to LLM-only scoring
  // for any embedding_status != 'ok' (no cosine pre-filter).
  const text = buildTopicText(topic.mainTopics, topic.keywords);
  if (text.trim().length === 0) {
    await ctx.db
      .update(topicProfiles)
      .set({
        embeddingStatus: 'failed',
        embeddingUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(topicProfiles.id, payload.topic_profile_id));
    ctx.logger.info(
      { topicProfileId: payload.topic_profile_id },
      'topic_profile has no topics/keywords; marked embedding_status=failed (terminal)',
    );
    return;
  }

  try {
    const result = await ctx.ai.embed({ text, kind: 'query' });
    await ctx.db
      .update(topicProfiles)
      .set({
        embedding: result.vector,
        embeddingStatus: 'ok',
        embeddingUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(topicProfiles.id, payload.topic_profile_id));
    ctx.logger.info(
      { topicProfileId: payload.topic_profile_id, dim: result.vector.length },
      'topic_profile embedding refreshed',
    );
  } catch (err) {
    // Mark failed only on permanent errors — transient errors should leave
    // embedding_status='pending' so a retry can recover. parse_error /
    // not_implemented are permanent; everything else bubbles up as transient
    // via the dispatcher's classifyFailure.
    if (
      err instanceof AIProviderError &&
      (err.code === 'parse_error' || err.code === 'not_implemented')
    ) {
      await ctx.db
        .update(topicProfiles)
        .set({
          embeddingStatus: 'failed',
          embeddingUpdatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(topicProfiles.id, payload.topic_profile_id));
      throw permanent(err.message);
    }
    throw err;
  }
};

/**
 * Build the text that represents a topic profile for embedding. main_topics
 * are weighted by inclusion order (intent: "AI coding" first, then
 * "developer tools"). keywords are appended after a separator so the model
 * doesn't treat them as part of the headline topic.
 */
export function buildTopicText(mainTopics: string[], keywords: string[]): string {
  const topics = mainTopics.map((t) => t.trim()).filter((t) => t.length > 0);
  const kws = keywords.map((k) => k.trim()).filter((k) => k.length > 0);
  if (topics.length === 0 && kws.length === 0) return '';
  const parts: string[] = [];
  if (topics.length > 0) parts.push(`Topics: ${topics.join(', ')}`);
  if (kws.length > 0) parts.push(`Keywords: ${kws.join(', ')}`);
  return parts.join('. ');
}

function permanent(message: string): Error {
  const e: Error & { kind?: string } = new Error(message);
  e.kind = 'permanent';
  return e;
}
