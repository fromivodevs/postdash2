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
import { writeOperationLog } from './operation-log.js';
import { assertWorkspaceRole } from './policies.js';
import { rowToTopicProfile } from './topic-row-mappers.js';

/**
 * Postgres unique-violation SQLSTATE. Cast through `unknown` because Drizzle's
 * thrown error is typed as `Error` but carries the postgres-js `.code` field
 * at runtime.
 */
const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object' && (err as { code?: unknown }).code === PG_UNIQUE_VIOLATION,
  );
}

/**
 * Bounded depth for tone_profile jsonb. Mitigates a JSON-bomb attack
 * (deep-nested object fits in the 16KB body limit but blows up Postgres's
 * jsonb parser). Applied alongside Zod schema validation, BEFORE the DB write.
 */
const MAX_TONE_PROFILE_DEPTH = 8;
/**
 * Combined cap on object keys + array elements. The earlier version only
 * counted object keys, which let a flat array `{x: ["a","a",...]}` pack
 * ~6000 strings into a 16KB body without tripping the limit. Counting
 * arrays toward the same budget closes that bypass.
 */
const MAX_TONE_PROFILE_NODES = 200;
function validateToneProfileDepth(value: unknown, depth = 0, nodeCount = { n: 0 }): void {
  if (depth > MAX_TONE_PROFILE_DEPTH) {
    throw new CommandError('validation_failed', 'tone_profile JSON exceeds max depth', {
      code: 'tone_profile_too_deep',
    });
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) {
      nodeCount.n += 1;
      if (nodeCount.n > MAX_TONE_PROFILE_NODES) {
        throw new CommandError('validation_failed', 'tone_profile exceeds max node count', {
          code: 'tone_profile_too_many_nodes',
        });
      }
      validateToneProfileDepth(item, depth + 1, nodeCount);
    }
    return;
  }
  for (const [, v] of Object.entries(value as Record<string, unknown>)) {
    nodeCount.n += 1;
    if (nodeCount.n > MAX_TONE_PROFILE_NODES) {
      throw new CommandError('validation_failed', 'tone_profile exceeds max node count', {
        code: 'tone_profile_too_many_nodes',
      });
    }
    validateToneProfileDepth(v, depth + 1, nodeCount);
  }
}

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
  if (data.toneProfile) validateToneProfileDepth(data.toneProfile);

  // Race-safe upsert. Two concurrent callers from the same workspace can both
  // see no existing active profile. Without the partial UNIQUE index in
  // migration 0004 (`topic_profiles_one_active_per_workspace_uniq`), both
  // INSERTs succeed and the workspace ends up with two active profiles. With
  // the index, the loser's INSERT throws SQLSTATE 23505 — we catch, re-run
  // the SELECT (now the winner's row is visible), and UPDATE it. This is the
  // canonical Postgres "upsert via unique" pattern when ON CONFLICT can't
  // target a partial index from a NULL-aware comparison.
  return doCreateTopicProfileWithRetry(db, data, 0);
}

const MAX_UPSERT_RETRIES = 2;

async function doCreateTopicProfileWithRetry(
  db: Database,
  data: CreateTopicProfileInput,
  attempt: number,
): Promise<{ profile: TopicProfile; created: boolean }> {
  try {
    return await db.transaction(async (tx) => {
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
        await logTopicProfileAction(tx, data, row.id, 'update');
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
      await logTopicProfileAction(tx, data, row.id, 'create');
      return { profile: rowToTopicProfile(row), created: true };
    });
  } catch (err) {
    if (isUniqueViolation(err) && attempt < MAX_UPSERT_RETRIES) {
      // Another caller won the race and created the active profile. Retry
      // the whole transaction — the SELECT now sees the winner's row and
      // we land on the UPDATE branch.
      return doCreateTopicProfileWithRetry(db, data, attempt + 1);
    }
    throw err;
  }
}

async function logTopicProfileAction(
  tx: DbOrTx,
  data: { workspaceId: string; userId: string },
  topicId: string,
  action: 'create' | 'update' | 'delete',
): Promise<void> {
  // Per 02-ARCHITECTURE.md Rule 6, via the shared helper.
  await writeOperationLog(tx, {
    workspaceId: data.workspaceId,
    userId: data.userId,
    commandType:
      action === 'create'
        ? 'CreateTopicProfile'
        : action === 'update'
          ? 'UpdateTopicProfile'
          : 'DeleteTopicProfile',
    objectType: 'topic_profile',
    objectId: topicId,
    payloadSummary: { action },
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
  if (data.toneProfile) validateToneProfileDepth(data.toneProfile);

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
    await logTopicProfileAction(tx, data, row.id, 'update');
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
    await logTopicProfileAction(tx, data, existing.id, 'delete');
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
    throw new CommandError(
      'forbidden',
      `topic_profile ${topicProfileId} belongs to a different workspace`,
    );
  }
  return { id: row.id };
}
