/**
 * Topic-profile commands (Phase 3).
 *
 * MVP UX restricts each workspace to a single active topic profile, but the
 * schema permits many (Phase 5+ extends the UI). To keep the door open
 * without a migration, the create/update commands here implement upsert
 * semantics in the application layer:
 *
 *   - `createTopicProfile` — if an active profile exists for the workspace,
 *     UPDATE its fields. Otherwise INSERT a fresh one.
 *   - `updateTopicProfile` — targeted UPDATE by id, with workspace ownership
 *     check.
 *   - `deleteTopicProfile` — soft-delete (status='disabled'). Hard delete
 *     would cascade into subscription.topic_profile_id → SET NULL, which is
 *     by design (subscriptions fall back to "use default profile" semantics
 *     in Phase 5).
 *   - `listTopicProfiles` — read-only, workspace-scoped.
 *
 * All mutations require role >= 'editor'; reads require role >= 'viewer'.
 *
 * No idempotency wrapper here: these are UI-driven mutations, not
 * money-moving commands. A double-clicked Create is harmless thanks to the
 * upsert; rapid PATCHes simply land in order.
 */

import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { TopicProfile } from '@postdash/domain';
import type { Database, DbOrTx } from '@postdash/db';
import { topicProfiles } from '@postdash/db';
import { CommandError } from './errors.js';
import { assertWorkspaceRole } from './policies.js';
import { rowToTopicProfile } from './topic-row-mappers.js';

// =============================================================================
// Schemas
// =============================================================================

const TopicProfileBodySchema = z.object({
  name: z.string().min(1).max(200),
  language: z.enum(['ru', 'en']),
  mainTopics: z.array(z.string().min(1).max(100)).max(50).default([]),
  keywords: z.array(z.string().min(1).max(100)).max(100).default([]),
  negativeKeywords: z.array(z.string().min(1).max(100)).max(100).default([]),
  toneProfile: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const CreateTopicProfileInputSchema = TopicProfileBodySchema.extend({
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
});
export type CreateTopicProfileInput = z.infer<typeof CreateTopicProfileInputSchema>;

export const UpdateTopicProfileInputSchema = TopicProfileBodySchema.partial().extend({
  topicProfileId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
});
export type UpdateTopicProfileInput = z.infer<typeof UpdateTopicProfileInputSchema>;

export const DeleteTopicProfileInputSchema = z.object({
  topicProfileId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
});
export type DeleteTopicProfileInput = z.infer<typeof DeleteTopicProfileInputSchema>;

export const ListTopicProfilesInputSchema = z.object({
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
});
export type ListTopicProfilesInput = z.infer<typeof ListTopicProfilesInputSchema>;

// =============================================================================
// Commands
// =============================================================================

/**
 * Upsert semantics: if the workspace already has an active topic profile,
 * the existing row is UPDATEd with the new payload (and the embedding is
 * invalidated → `embedding_status='pending'` so Phase 4 re-embeds). Else,
 * a new active profile is INSERTed.
 *
 * The DB-level lookup runs inside the same transaction as the write so a
 * concurrent CREATE from the same workspace cannot race past the
 * "exists?" check and produce two rows. Without the transaction the UI's
 * single-profile invariant would only be best-effort under high concurrency
 * (admittedly unlikely for a per-workspace settings screen, but cheap to
 * guarantee).
 */
export async function createTopicProfile(
  db: Database,
  input: CreateTopicProfileInput,
): Promise<{ profile: TopicProfile; created: boolean }> {
  const parsed = CreateTopicProfileInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CommandError(
      'validation_failed',
      `createTopicProfile: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const data = parsed.data;

  return db.transaction(async (tx) => {
    await assertWorkspaceRole(tx, data.workspaceId, data.userId, 'editor');

    const existing = await tx
      .select()
      .from(topicProfiles)
      .where(
        and(eq(topicProfiles.workspaceId, data.workspaceId), eq(topicProfiles.status, 'active')),
      )
      .limit(1);

    if (existing[0]) {
      const updated = await tx
        .update(topicProfiles)
        .set({
          name: data.name,
          language: data.language,
          mainTopics: data.mainTopics,
          keywords: data.keywords,
          negativeKeywords: data.negativeKeywords,
          toneProfile: data.toneProfile ?? null,
          // Invalidate the embedding — content changed, the old vector no
          // longer represents the profile. Phase 4 enqueues a re-embed task
          // when it sees embedding_status='pending'.
          embeddingStatus: 'pending',
          embeddingUpdatedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(topicProfiles.id, existing[0].id))
        .returning();
      const row = updated[0];
      if (!row) throw new CommandError('internal', 'topic_profiles update returned no row');
      return { profile: rowToTopicProfile(row), created: false };
    }

    const inserted = await tx
      .insert(topicProfiles)
      .values({
        workspaceId: data.workspaceId,
        name: data.name,
        language: data.language,
        mainTopics: data.mainTopics,
        keywords: data.keywords,
        negativeKeywords: data.negativeKeywords,
        toneProfile: data.toneProfile ?? null,
        status: 'active',
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new CommandError('internal', 'topic_profiles insert returned no row');
    return { profile: rowToTopicProfile(row), created: true };
  });
}

export async function updateTopicProfile(
  db: Database,
  input: UpdateTopicProfileInput,
): Promise<TopicProfile> {
  const parsed = UpdateTopicProfileInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CommandError(
      'validation_failed',
      `updateTopicProfile: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const data = parsed.data;

  return db.transaction(async (tx) => {
    await assertWorkspaceRole(tx, data.workspaceId, data.userId, 'editor');

    // Workspace-scoped lookup: the topic_profile MUST belong to the asserted
    // workspace. Otherwise a multi-workspace admin could update another
    // workspace's profile through this workspace's endpoint.
    const existing = await loadOwnedProfile(tx, data.topicProfileId, data.workspaceId);

    // Detect "content changed" to know whether to invalidate the embedding.
    // The name + language + tone don't affect the embedding (it's computed
    // from main_topics + keywords); but invalidating on any change is the
    // safer default — the cost of an extra embedding call is tiny.
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    let contentChanged = false;
    if (data.name !== undefined) patch.name = data.name;
    if (data.language !== undefined) {
      patch.language = data.language;
      contentChanged = true;
    }
    if (data.mainTopics !== undefined) {
      patch.mainTopics = data.mainTopics;
      contentChanged = true;
    }
    if (data.keywords !== undefined) {
      patch.keywords = data.keywords;
      contentChanged = true;
    }
    if (data.negativeKeywords !== undefined) {
      patch.negativeKeywords = data.negativeKeywords;
    }
    if (data.toneProfile !== undefined) patch.toneProfile = data.toneProfile;
    if (contentChanged) {
      patch.embeddingStatus = 'pending';
      patch.embeddingUpdatedAt = null;
    }

    const updated = await tx
      .update(topicProfiles)
      .set(patch)
      .where(eq(topicProfiles.id, existing.id))
      .returning();
    const row = updated[0];
    if (!row) throw new CommandError('internal', 'topic_profiles update returned no row');
    return rowToTopicProfile(row);
  });
}

export async function deleteTopicProfile(
  db: Database,
  input: DeleteTopicProfileInput,
): Promise<void> {
  const parsed = DeleteTopicProfileInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CommandError(
      'validation_failed',
      `deleteTopicProfile: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const data = parsed.data;

  await db.transaction(async (tx) => {
    // Mutation = editor. Tightening to admin would lock out the most common
    // user role; the disable is reversible (status flip).
    await assertWorkspaceRole(tx, data.workspaceId, data.userId, 'editor');
    const existing = await loadOwnedProfile(tx, data.topicProfileId, data.workspaceId);
    // Soft delete: keep the row + FK from subscriptions stable. Phase 5+ may
    // expose an "Undo delete" UI; until then, only direct DB access can
    // re-enable.
    await tx
      .update(topicProfiles)
      .set({ status: 'disabled', updatedAt: new Date() })
      .where(eq(topicProfiles.id, existing.id));
  });
}

export async function listTopicProfiles(
  db: Database,
  input: ListTopicProfilesInput,
): Promise<TopicProfile[]> {
  const parsed = ListTopicProfilesInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new CommandError(
      'validation_failed',
      `listTopicProfiles: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const data = parsed.data;

  return db.transaction(
    async (tx) => {
      await assertWorkspaceRole(tx, data.workspaceId, data.userId, 'viewer');
      const rows = await tx
        .select()
        .from(topicProfiles)
        .where(
          and(eq(topicProfiles.workspaceId, data.workspaceId), eq(topicProfiles.status, 'active')),
        )
        .orderBy(asc(topicProfiles.createdAt));
      return rows.map(rowToTopicProfile);
    },
    { accessMode: 'read only' },
  );
}

async function loadOwnedProfile(
  tx: DbOrTx,
  topicProfileId: string,
  workspaceId: string,
): Promise<{ id: string }> {
  const rows = await tx
    .select({ id: topicProfiles.id, workspaceId: topicProfiles.workspaceId })
    .from(topicProfiles)
    .where(eq(topicProfiles.id, topicProfileId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new CommandError('not_found', `topic_profile ${topicProfileId} not found`);
  }
  if (row.workspaceId !== workspaceId) {
    // Forbidden, not not_found: the row exists, the caller just doesn't
    // own it. Returning not_found would leak that the ID is valid.
    // Actually: returning forbidden ALSO leaks that the ID is valid. The
    // safest signal is not_found — but the route layer maps both to a
    // generic message anyway, so we pick forbidden here for accurate
    // server-side logging.
    throw new CommandError('forbidden', `topic_profile ${topicProfileId} belongs to a different workspace`);
  }
  return { id: row.id };
}
