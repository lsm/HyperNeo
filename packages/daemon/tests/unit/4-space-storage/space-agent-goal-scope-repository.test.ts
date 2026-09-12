import { beforeEach, describe, expect, test } from 'bun:test';
import { SpaceAgentGoalScopeRepository } from '../../../src/storage/repositories/space-agent-goal-scope-repository';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository';
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

function seedGoal(db: BunDatabase, id: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO space_goals (id, space_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, spaceId, id, Date.now(), Date.now());
}

function seedScope(db: BunDatabase, id: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO evolution_scopes (id, space_id, kind, name, objective, created_at, updated_at)
     VALUES (?, ?, 'project', ?, 'objective', ?, ?)`
  ).run(id, spaceId, id, Date.now(), Date.now());
}

describe('SpaceAgentGoalScopeRepository', () => {
  let db: BunDatabase;
  let repo: SpaceAgentGoalScopeRepository;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createSpaceTables(db);
    seedSpace(db, 'space-1');
    seedSpace(db, 'space-2');
    seedAgent(db, 'agent-1', 'space-1', 'researcher');
    seedAgent(db, 'agent-1b', 'space-1', 'writer');
    seedAgent(db, 'agent-2', 'space-2', 'reviewer');
    seedGoal(db, 'goal-1', 'space-1');
    seedGoal(db, 'goal-2', 'space-2');
    seedScope(db, 'scope-1', 'space-1');
    seedScope(db, 'scope-2', 'space-2');
    repo = new SpaceAgentGoalScopeRepository(db, new SpaceAgentRepository(db));
  });

  describe('assignGoal', () => {
    test('links an agent to a goal in its own space', () => {
      repo.assignGoal('agent-1', 'goal-1');

      expect(repo.listGoals('agent-1')).toEqual([
        {
          agentId: 'agent-1',
          goalId: 'goal-1',
          relationship: 'owner',
          createdAt: expect.any(Number),
          updatedAt: expect.any(Number),
        },
      ]);
    });

    test('an owner assignment displaces the previous owner', () => {
      repo.assignGoal('agent-1', 'goal-1');
      repo.assignGoal('agent-1b', 'goal-1');

      expect(repo.listGoalAssignments('goal-1').map((a) => a.agentId)).toEqual(['agent-1b']);
    });

    test('a non-owner assignment leaves the owner in place', () => {
      repo.assignGoal('agent-1', 'goal-1');
      repo.assignGoal('agent-1b', 'goal-1', 'watcher');

      expect(
        repo
          .listGoalAssignments('goal-1')
          .map((a) => a.agentId)
          .sort()
      ).toEqual(['agent-1', 'agent-1b']);
    });

    test('rejects an unknown agent', () => {
      expect(() => repo.assignGoal('missing', 'goal-1')).toThrow(
        'Long-horizon agent not found: missing'
      );
    });

    test('rejects a goal from another space', () => {
      expect(() => repo.assignGoal('agent-1', 'goal-2')).toThrow(
        'Goal goal-2 does not belong to space space-1'
      );
    });

    test('rejects an unknown goal', () => {
      expect(() => repo.assignGoal('agent-1', 'nope')).toThrow('Goal not found: nope');
    });
  });

  test('listGoals is scoped to one agent', () => {
    repo.assignGoal('agent-1', 'goal-1');
    repo.assignGoal('agent-1b', 'goal-1', 'watcher');

    expect(repo.listGoals('agent-1').map((g) => g.goalId)).toEqual(['goal-1']);
    expect(repo.listGoals('agent-1b').map((g) => g.relationship)).toEqual(['watcher']);
  });

  describe('deleting goal assignments', () => {
    test('deleteGoalAssignment removes every relationship for the pair', () => {
      repo.assignGoal('agent-1', 'goal-1');
      repo.assignGoal('agent-1', 'goal-1', 'watcher');

      repo.deleteGoalAssignment('agent-1', 'goal-1');

      expect(repo.listGoals('agent-1')).toEqual([]);
    });

    test('deleteGoalAssignmentByRelationship removes only the named one', () => {
      repo.assignGoal('agent-1', 'goal-1');
      repo.assignGoal('agent-1', 'goal-1', 'watcher');

      repo.deleteGoalAssignmentByRelationship('agent-1', 'goal-1', 'watcher');

      expect(repo.listGoals('agent-1').map((g) => g.relationship)).toEqual(['owner']);
    });
  });

  describe('getPrimaryGoalOwner', () => {
    test('resolves an active owner in the space', () => {
      repo.assignGoal('agent-1', 'goal-1');

      expect(repo.getPrimaryGoalOwner('goal-1', 'space-1')).toMatchObject({
        action: 'resolved',
        owner: { agentId: 'agent-1', relationship: 'owner' },
        conflicts: [],
      });
    });

    test('degrades an owner that belongs to another space to missing', () => {
      db.prepare(
        `INSERT INTO space_long_horizon_agent_goals
           (agent_id, goal_id, relationship, created_at, updated_at)
         VALUES ('agent-2', 'goal-1', 'owner', ?, ?)`
      ).run(Date.now(), Date.now());

      expect(repo.getPrimaryGoalOwner('goal-1', 'space-1')).toMatchObject({
        action: 'degraded',
        reason: 'missing',
        owner: { agentId: 'agent-2' },
      });
    });

    test('falls back to the space manager when there is no owner', () => {
      seedAgent(db, 'agent-mgr', 'space-1', 'space-manager');

      expect(repo.getPrimaryGoalOwner('goal-1', 'space-1')).toEqual({
        action: 'coordinator_fallback',
        coordinatorAgentId: 'agent-mgr',
      });
    });

    test('falls back to a legacy coordinator handle when no space-manager exists', () => {
      seedAgent(db, 'agent-coord', 'space-1', 'coordinator');

      expect(repo.getPrimaryGoalOwner('goal-1', 'space-1')).toEqual({
        action: 'coordinator_fallback',
        coordinatorAgentId: 'agent-coord',
      });
    });

    test('prefers the space-manager handle over the legacy coordinator handle', () => {
      seedAgent(db, 'agent-coord', 'space-1', 'coordinator');
      seedAgent(db, 'agent-mgr', 'space-1', 'space-manager');

      expect(repo.getPrimaryGoalOwner('goal-1', 'space-1')).toEqual({
        action: 'coordinator_fallback',
        coordinatorAgentId: 'agent-mgr',
      });
    });

    test('reports no recipient when there is neither an owner nor a coordinator', () => {
      expect(repo.getPrimaryGoalOwner('goal-1', 'space-1')).toEqual({ action: 'no_recipient' });
    });
  });

  describe('assignForgeScope', () => {
    test('links an agent to a scope in its own space', () => {
      repo.assignForgeScope('agent-1', 'scope-1');

      expect(repo.listForgeScopes('agent-1').map((s) => s.scopeId)).toEqual(['scope-1']);
    });

    test('is idempotent for the same relationship', () => {
      repo.assignForgeScope('agent-1', 'scope-1');
      repo.assignForgeScope('agent-1', 'scope-1');

      expect(repo.listForgeScopes('agent-1')).toHaveLength(1);
    });

    test('rejects an unknown agent', () => {
      expect(() => repo.assignForgeScope('missing', 'scope-1')).toThrow(
        'Long-horizon agent not found: missing'
      );
    });

    test('rejects a scope from another space', () => {
      expect(() => repo.assignForgeScope('agent-1', 'scope-2')).toThrow(
        'Forge scope scope-2 does not belong to space space-1'
      );
    });
  });

  test('deleteForgeScopeAssignment removes the link', () => {
    repo.assignForgeScope('agent-1', 'scope-1');

    repo.deleteForgeScopeAssignment('agent-1', 'scope-1');

    expect(repo.listForgeScopes('agent-1')).toEqual([]);
  });
});
