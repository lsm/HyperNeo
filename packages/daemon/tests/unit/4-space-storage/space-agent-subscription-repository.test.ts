import { beforeEach, describe, expect, test } from 'bun:test';
import type { CreateSpaceLongHorizonAgentSubscriptionParams } from '@hyperneo/shared';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository';
import { SpaceAgentSubscriptionRepository } from '../../../src/storage/repositories/space-agent-subscription-repository';
import { Database as BunDatabase } from '../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../helpers/space-test-db';

function seedSpace(db: BunDatabase, id: string): void {
  db.prepare(
    `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, id, `/tmp/${id}`, id, Date.now(), Date.now());
}

function seedAgent(db: BunDatabase, id: string, spaceId: string, handle: string): void {
  db.prepare(
    `INSERT INTO space_long_horizon_agents
       (id, space_id, handle, display_name, status, autonomy_level, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', 2, ?, ?)`
  ).run(id, spaceId, handle, handle, Date.now(), Date.now());
}

function subParams(
  overrides: Partial<CreateSpaceLongHorizonAgentSubscriptionParams> = {}
): CreateSpaceLongHorizonAgentSubscriptionParams {
  return {
    spaceId: 'space-1',
    agentId: 'agent-1',
    source: 'github',
    topic: 'pull_request.*',
    ...overrides,
  };
}

describe('SpaceAgentSubscriptionRepository', () => {
  let db: BunDatabase;
  let repo: SpaceAgentSubscriptionRepository;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createSpaceTables(db);
    seedSpace(db, 'space-1');
    seedSpace(db, 'space-2');
    seedAgent(db, 'agent-1', 'space-1', 'researcher');
    seedAgent(db, 'agent-1b', 'space-1', 'writer');
    seedAgent(db, 'agent-2', 'space-2', 'reviewer');
    repo = new SpaceAgentSubscriptionRepository(db, new SpaceAgentRepository(db));
  });

  describe('createSubscription', () => {
    test('round-trips every field', () => {
      const created = repo.createSubscription(
        subParams({ filter: { label: 'urgent' }, status: 'paused' })
      );

      expect(created.spaceId).toBe('space-1');
      expect(created.agentId).toBe('agent-1');
      expect(created.source).toBe('github');
      expect(created.topic).toBe('pull_request.*');
      expect(created.filter).toEqual({ label: 'urgent' });
      expect(created.status).toBe('paused');
      expect(repo.getSubscription(created.id)).toEqual(created);
    });

    test('defaults filter to an empty object and status to active', () => {
      const created = repo.createSubscription(subParams());

      expect(created.filter).toEqual({});
      expect(created.status).toBe('active');
    });

    test('rejects an unknown agent', () => {
      expect(() => repo.createSubscription(subParams({ agentId: 'missing' }))).toThrow(
        'Long-horizon agent not found: missing'
      );
    });

    test('rejects an agent that belongs to a different space', () => {
      expect(() => repo.createSubscription(subParams({ agentId: 'agent-2' }))).toThrow(
        'Long-horizon agent agent-2 does not belong to space space-1'
      );
    });
  });

  test('getSubscription returns null for an unknown id', () => {
    expect(repo.getSubscription('nope')).toBeNull();
  });

  test('getSubscriptionByRoute matches on space, agent, source and topic', () => {
    const created = repo.createSubscription(subParams());
    repo.createSubscription(subParams({ agentId: 'agent-1b' }));

    expect(repo.getSubscriptionByRoute('space-1', 'agent-1', 'github', 'pull_request.*')?.id).toBe(
      created.id
    );
    expect(repo.getSubscriptionByRoute('space-1', 'agent-1', 'github', 'issues.*')).toBeNull();
  });

  describe('upsertSubscription', () => {
    test('inserts when the route is new', () => {
      const created = repo.upsertSubscription(subParams());

      expect(repo.listSubscriptions('agent-1').map((s) => s.id)).toEqual([created.id]);
    });

    test('updates in place when the route already exists', () => {
      const first = repo.upsertSubscription(subParams({ filter: { label: 'a' } }));
      const second = repo.upsertSubscription(
        subParams({ filter: { label: 'b' }, status: 'paused' })
      );

      expect(second.id).toBe(first.id);
      expect(second.filter).toEqual({ label: 'b' });
      expect(second.status).toBe('paused');
      expect(repo.listSubscriptions('agent-1')).toHaveLength(1);
    });

    test('rejects an agent that belongs to a different space', () => {
      expect(() => repo.upsertSubscription(subParams({ agentId: 'agent-2' }))).toThrow(
        'Long-horizon agent agent-2 does not belong to space space-1'
      );
    });
  });

  test('listSubscriptions is scoped to one agent', () => {
    const first = repo.createSubscription(subParams());
    const second = repo.createSubscription(subParams({ topic: 'issues.*' }));
    repo.createSubscription(subParams({ agentId: 'agent-1b' }));

    expect(repo.listSubscriptions('agent-1').map((s) => s.id)).toEqual([first.id, second.id]);
  });

  describe('updateSubscription', () => {
    test('patches only the provided fields', () => {
      const created = repo.createSubscription(subParams({ filter: { label: 'a' } }));

      const updated = repo.updateSubscription(created.id, { status: 'disabled' });

      expect(updated?.status).toBe('disabled');
      expect(updated?.source).toBe('github');
      expect(updated?.topic).toBe('pull_request.*');
      expect(updated?.filter).toEqual({ label: 'a' });
    });

    test('returns null for an unknown id', () => {
      expect(repo.updateSubscription('nope', { status: 'paused' })).toBeNull();
    });
  });

  test('deleteSubscription removes the row', () => {
    const created = repo.createSubscription(subParams());

    repo.deleteSubscription(created.id);

    expect(repo.getSubscription(created.id)).toBeNull();
  });

  test('listActiveSubscriptionsBySpace returns only active rows in the space', () => {
    const active = repo.createSubscription(subParams());
    repo.createSubscription(subParams({ topic: 'issues.*', status: 'paused' }));
    repo.createSubscription(subParams({ spaceId: 'space-2', agentId: 'agent-2' }));

    expect(repo.listActiveSubscriptionsBySpace('space-1').map((s) => s.id)).toEqual([active.id]);
  });

  test('deleteSubscriptionByRoute removes only the matching route', () => {
    repo.createSubscription(subParams());
    const kept = repo.createSubscription(subParams({ topic: 'issues.*' }));

    repo.deleteSubscriptionByRoute('space-1', 'agent-1', 'github', 'pull_request.*');

    expect(repo.listSubscriptions('agent-1').map((s) => s.id)).toEqual([kept.id]);
  });

  test('a malformed filter_json reads back as an empty object', () => {
    const created = repo.createSubscription(subParams());
    db.prepare(
      `UPDATE space_long_horizon_agent_event_subscriptions SET filter_json = ? WHERE id = ?`
    ).run('{not json', created.id);

    expect(repo.getSubscription(created.id)?.filter).toEqual({});
  });
});
