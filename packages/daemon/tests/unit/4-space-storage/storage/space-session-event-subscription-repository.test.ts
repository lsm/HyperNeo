import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceSessionEventSubscriptionRepository } from '../../../../src/storage/repositories/space-session-event-subscription-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

describe('SpaceSessionEventSubscriptionRepository', () => {
  let db: Database;
  let repo: SpaceSessionEventSubscriptionRepository;
  let spaceId: string;
  let otherSpaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    const spaces = new SpaceRepository(db as never);
    spaceId = spaces.createSpace({ workspacePath: '/ws/a', slug: 'a', name: 'A' }).id;
    otherSpaceId = spaces.createSpace({ workspacePath: '/ws/b', slug: 'b', name: 'B' }).id;
    repo = new SpaceSessionEventSubscriptionRepository(db as never);
  });

  afterEach(() => db.close());

  test('upsert stores a subscription that get returns', () => {
    const stored = repo.upsert({
      spaceId,
      sessionId: 'session-1',
      topic: 'github/acme/widgets/pull_request/7.*',
      label: 'PR 7',
    });

    expect(repo.get(stored.id)).toEqual(stored);
    expect(stored).toMatchObject({
      spaceId,
      sessionId: 'session-1',
      topic: 'github/acme/widgets/pull_request/7.*',
      label: 'PR 7',
    });
  });

  test('upsert on the same session and topic updates the row instead of adding one', () => {
    const first = repo.upsert({ spaceId, sessionId: 'session-1', topic: 'github/a/b/*' });
    const second = repo.upsert({
      spaceId,
      sessionId: 'session-1',
      topic: 'github/a/b/*',
      label: 'relabelled',
    });

    expect(second.id).toBe(first.id);
    expect(second.label).toBe('relabelled');
    expect(repo.listBySpace(spaceId)).toHaveLength(1);
  });

  test('listBySpace returns only that Space subscriptions', () => {
    repo.upsert({ spaceId, sessionId: 'session-1', topic: 'github/a/b/*' });
    repo.upsert({ spaceId, sessionId: 'session-2', topic: 'github/a/c/*' });
    repo.upsert({ spaceId: otherSpaceId, sessionId: 'session-3', topic: 'github/a/b/*' });

    expect(repo.listBySpace(spaceId).map((subscription) => subscription.sessionId)).toEqual([
      'session-1',
      'session-2',
    ]);
    expect(repo.get('missing')).toBeNull();
  });
});
