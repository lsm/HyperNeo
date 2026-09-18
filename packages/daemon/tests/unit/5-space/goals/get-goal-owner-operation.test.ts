import { describe, expect, test } from 'bun:test';
import type { Session, SpaceGoalOwnerResolution } from '@hyperneo/shared';
import { createGoalOperations } from '../../../../src/lib/goals/operations.ts';
import { SpaceGoalService } from '../../../../src/lib/goals/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { ScheduleService } from '../../../../src/lib/schedule/schedule-service.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { SpaceAgentGoalScopeRepository } from '../../../../src/storage/repositories/space-agent-goal-scope-repository.ts';
import { SpaceGoalEventRepository } from '../../../../src/storage/repositories/space-goal-event-repository.ts';
import { SpaceGoalRepository } from '../../../../src/storage/repositories/space-goal-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { TaskScheduleRepository } from '../../../../src/storage/repositories/task-schedule-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const SPACE_ID = 'space-goal-owner';
const OTHER_SPACE_ID = 'space-goal-owner-other';

function insertSpace(db: BunDatabase, spaceId: string): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, `/tmp/workspace/${spaceId}`, spaceId, spaceId, Date.now(), Date.now());
}

function makeCtx() {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  insertSpace(db, SPACE_ID);
  insertSpace(db, OTHER_SPACE_ID);
  const spaceRepo = new SpaceRepository(db);
  const taskRepo = new SpaceTaskRepository(db);
  const longHorizonAgentRepo = new SpaceLongHorizonAgentRepository(db);
  const goalScopeRepo = new SpaceAgentGoalScopeRepository(db, longHorizonAgentRepo);
  const goalService = new SpaceGoalService({
    goalRepo: new SpaceGoalRepository(db),
    goalEventRepo: new SpaceGoalEventRepository(db),
    taskRepo,
    spaceRepo,
    scheduleService: new ScheduleService({
      db,
      scheduleRepo: new TaskScheduleRepository(db),
      jobQueue: new JobQueueRepository(db),
      spaceRepo,
    }),
    db,
  });
  const registry = createOperationRegistry(
    createGoalOperations({
      goalService,
      taskRepo,
      longHorizonAgentRepo,
      goalScopeRepo,
      getSession: (): Session | null => null,
    })
  );
  const seedAgent = (spaceId: string, handle: string, status: 'active' | 'paused' = 'active') =>
    longHorizonAgentRepo.create({ spaceId, handle, displayName: handle, instructions: '', status });
  return { db, registry, goalService, goalScopeRepo, seedAgent };
}

async function invoke(ctx: ReturnType<typeof makeCtx>, input: unknown, caller: OperationCaller) {
  const outcome = await invokeOperation(ctx.registry, 'goal.owner.get', input, caller);
  if (outcome.kind !== 'completed') throw new Error(`goal.owner.get failed: ${outcome.message}`);
  return outcome.value as {
    accepted: boolean;
    reason?: string;
    owner?: SpaceGoalOwnerResolution;
  };
}

const rpcCaller: OperationCaller = { source: 'rpc' };

describe('goal.owner.get', () => {
  test('reads no_recipient for an unassigned goal', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.goalService.createGoal({ spaceId: SPACE_ID, title: 'Unowned' });
      const result = await invoke(ctx, { spaceId: SPACE_ID, goalId: goal.id }, rpcCaller);
      expect(result).toEqual({ accepted: true, owner: { action: 'no_recipient' } });
    } finally {
      ctx.db.close();
    }
  });

  test('resolves the primary owner of an assigned goal', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.goalService.createGoal({ spaceId: SPACE_ID, title: 'Owned' });
      const agent = ctx.seedAgent(SPACE_ID, 'planner');
      ctx.goalScopeRepo.assignGoal(agent.id, goal.id);
      const result = await invoke(ctx, { spaceId: SPACE_ID, goalId: goal.id }, rpcCaller);
      expect(result.accepted).toBe(true);
      const owner = result.owner as {
        action: string;
        owner: { agentId: string; relationship: string };
        conflicts: unknown[];
      };
      expect(owner.action).toBe('resolved');
      expect(owner.owner.agentId).toBe(agent.id);
      expect(owner.owner.relationship).toBe('owner');
      expect(owner.conflicts).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });

  test('degrades when the owning agent is not active', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.goalService.createGoal({ spaceId: SPACE_ID, title: 'Paused owner' });
      const agent = ctx.seedAgent(SPACE_ID, 'sleeper', 'paused');
      ctx.goalScopeRepo.assignGoal(agent.id, goal.id);
      const result = await invoke(ctx, { spaceId: SPACE_ID, goalId: goal.id }, rpcCaller);
      expect(result.owner).toMatchObject({ action: 'degraded', reason: 'paused' });
    } finally {
      ctx.db.close();
    }
  });

  test('rejects a goal outside the requested Space as goal_not_found', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.goalService.createGoal({ spaceId: OTHER_SPACE_ID, title: 'Elsewhere' });
      const result = await invoke(ctx, { spaceId: SPACE_ID, goalId: goal.id }, rpcCaller);
      expect(result).toMatchObject({ accepted: false, reason: 'goal_not_found' });
    } finally {
      ctx.db.close();
    }
  });

  test('scopes an mcp caller to its own Space', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.goalService.createGoal({ spaceId: OTHER_SPACE_ID, title: 'Elsewhere' });
      const caller: OperationCaller = { source: 'mcp', spaceId: SPACE_ID, role: 'universal_read' };
      const result = await invoke(ctx, { goalId: goal.id }, caller);
      expect(result).toMatchObject({ accepted: false, reason: 'goal_not_found' });
    } finally {
      ctx.db.close();
    }
  });
});
