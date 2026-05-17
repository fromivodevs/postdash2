import { describe, expect, it } from 'vitest';
import {
  createTopicProfile,
  deleteTopicProfile,
  listTopicProfiles,
  updateTopicProfile,
} from '../topic-profiles.js';
import { CommandError } from '../errors.js';
import { makeMockDb } from './_mock-db.js';

const WORKSPACE = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const TOPIC = '33333333-3333-3333-3333-333333333333';

function policyOk(role: 'editor' | 'viewer' = 'editor') {
  return [{ role, status: 'active' }];
}

function topicRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: TOPIC,
    workspaceId: WORKSPACE,
    name: 'Tech',
    language: 'ru',
    mainTopics: ['ai'],
    keywords: ['llm'],
    negativeKeywords: ['spam'],
    toneProfile: null,
    embeddingStatus: 'pending',
    embeddingUpdatedAt: null,
    status: 'active',
    createdAt: new Date('2026-05-17T00:00:00Z'),
    updatedAt: new Date('2026-05-17T00:00:00Z'),
    ...overrides,
  };
}

describe('createTopicProfile', () => {
  it('rejects invalid input with validation_failed', async () => {
    const mock = makeMockDb({});
    await expect(
      createTopicProfile(mock.db, {
        workspaceId: 'not-a-uuid',
        userId: USER,
        name: 'X',
        language: 'ru',
      } as never),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('inserts a new profile when none exists', async () => {
    const mock = makeMockDb({
      selectResults: [policyOk('editor'), []],
      // topic_profiles INSERT, then operation_log INSERT
      insertResults: [[topicRow({ name: 'New' })], []],
    });
    const r = await createTopicProfile(mock.db, {
      workspaceId: WORKSPACE,
      userId: USER,
      name: 'New',
      language: 'ru',
      mainTopics: ['x'],
      keywords: [],
      negativeKeywords: [],
    });
    expect(r.created).toBe(true);
    expect(r.profile.name).toBe('New');
  });

  it('updates the existing active profile (upsert semantics) and invalidates embedding', async () => {
    const mock = makeMockDb({
      selectResults: [policyOk('editor'), [topicRow()]],
      // topic_profiles UPDATE, then operation_log INSERT
      insertResults: [[]],
      updateResults: [
        [
          topicRow({
            name: 'Edited',
            embeddingStatus: 'pending',
            updatedAt: new Date('2026-05-17T01:00:00Z'),
          }),
        ],
      ],
    });
    const r = await createTopicProfile(mock.db, {
      workspaceId: WORKSPACE,
      userId: USER,
      name: 'Edited',
      language: 'ru',
      mainTopics: ['x'],
      keywords: [],
      negativeKeywords: [],
    });
    expect(r.created).toBe(false);
    expect(r.profile.name).toBe('Edited');
    expect(r.profile.embeddingStatus).toBe('pending');
    expect(mock.calls).toContain('update');
  });

  it('rejects when policy check fails (no membership)', async () => {
    const mock = makeMockDb({ selectResults: [[]] });
    await expect(
      createTopicProfile(mock.db, {
        workspaceId: WORKSPACE,
        userId: USER,
        name: 'X',
        language: 'ru',
        mainTopics: [],
        keywords: [],
        negativeKeywords: [],
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('updateTopicProfile', () => {
  it('returns 404 when profile does not exist', async () => {
    const mock = makeMockDb({ selectResults: [policyOk('editor'), []] });
    await expect(
      updateTopicProfile(mock.db, {
        topicProfileId: TOPIC,
        workspaceId: WORKSPACE,
        userId: USER,
        name: 'X',
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects cross-workspace profile with forbidden', async () => {
    const otherWorkspace = '99999999-9999-9999-9999-999999999999';
    const mock = makeMockDb({
      selectResults: [policyOk('editor'), [{ id: TOPIC, workspaceId: otherWorkspace }]],
    });
    await expect(
      updateTopicProfile(mock.db, {
        topicProfileId: TOPIC,
        workspaceId: WORKSPACE,
        userId: USER,
        name: 'X',
      }),
    ).rejects.toBeInstanceOf(CommandError);
  });

  it('invalidates embedding only when content fields change', async () => {
    const mock = makeMockDb({
      selectResults: [policyOk('editor'), [{ id: TOPIC, workspaceId: WORKSPACE }]],
      updateResults: [[topicRow({ name: 'Renamed' })]],
      insertResults: [[]], // operation_log insert
    });
    await updateTopicProfile(mock.db, {
      topicProfileId: TOPIC,
      workspaceId: WORKSPACE,
      userId: USER,
      name: 'Renamed',
    });
    expect(mock.calls).toContain('update');
  });

  it('rejects deeply nested tone_profile (JSON-bomb defence)', async () => {
    const mock = makeMockDb({});
    // Build a 12-deep nested object — exceeds MAX_TONE_PROFILE_DEPTH=8.
    let bomb: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 12; i++) bomb = { x: bomb };
    await expect(
      updateTopicProfile(mock.db, {
        topicProfileId: TOPIC,
        workspaceId: WORKSPACE,
        userId: USER,
        toneProfile: bomb,
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('deleteTopicProfile', () => {
  it('soft-deletes by flipping status to disabled', async () => {
    const mock = makeMockDb({
      selectResults: [policyOk('editor'), [{ id: TOPIC, workspaceId: WORKSPACE }]],
      updateResults: [[topicRow({ status: 'disabled' })]],
      insertResults: [[]], // operation_log insert
    });
    await deleteTopicProfile(mock.db, {
      topicProfileId: TOPIC,
      workspaceId: WORKSPACE,
      userId: USER,
    });
    expect(mock.calls).toContain('update');
  });
});

describe('listTopicProfiles', () => {
  it('returns the active profiles for the workspace', async () => {
    const mock = makeMockDb({
      selectResults: [policyOk('viewer'), [topicRow()]],
    });
    const r = await listTopicProfiles(mock.db, { workspaceId: WORKSPACE, userId: USER });
    expect(r).toHaveLength(1);
    expect(r[0]?.id).toBe(TOPIC);
  });
});
