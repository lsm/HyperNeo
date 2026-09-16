import { describe, expect, test } from 'bun:test';
import type { Session, SpaceGoal } from '@hyperneo/shared';
import { createGoalOperations } from '../../../../src/lib/goals/operations.ts';
import { SpaceGoalService } from '../../../../src/lib/goals/service.ts';
import { ScheduleService } from '../../../../src/lib/schedule/schedule-service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { SpaceGoalEventRepository } from '../../../../src/storage/repositories/space-goal-event-repository.ts';
import { SpaceGoalRepository } from '../../../../src/storage/repositories/space-goal-repository.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { TaskScheduleRepository } from '../../../../src/storage/repositories/task-schedule-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const SPACE_ID = 'space-goal-reads';
const OTHER_SPACE_ID = 'space-goal-reads-other';

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
      longHorizonAgentRepo: { getById: () => null },
      getSession: (): Session | null => null,
    })
  );
  const seed = (spaceId: string, title: string): SpaceGoal =>
    goalService.createGoal({ spaceId, title });
  return { db, registry, goalService, seed };
}

async function invoke(
  ctx: ReturnType<typeof makeCtx>,
  name: string,
  input: unknown,
  caller: OperationCaller
) {
  const outcome = await invokeOperation(ctx.registry, name, input, caller);
  if (outcome.kind !== 'completed') throw new Error(`${name} failed: ${outcome.message}`);
  return outcome.value as {
    accepted: boolean;
    reason?: string;
    goal?: SpaceGoal;
    goals?: unknown[];
  };
}

const HUMAN: OperationCaller = { source: 'rpc' };

function agent(role: OperationCaller['role'], spaceId = SPACE_ID): OperationCaller {
  return { source: 'mcp', sessionId: 'session-1', spaceId, role, agentName: 'planner' };
}

describe('goal.list through the operations door', () => {
  test('returns the goals of the Space a human caller names', async () => {
    const ctx = makeCtx();
    try {
      ctx.seed(SPACE_ID, 'Ship the door');
      ctx.seed(OTHER_SPACE_ID, 'Someone else goal');
      const result = await invoke(ctx, 'goal.list', { spaceId: SPACE_ID }, HUMAN);
      expect(result.accepted).toBe(true);
      expect(result.goals).toHaveLength(1);
      expect((result.goals as SpaceGoal[])[0].title).toBe('Ship the door');
    } finally {
      ctx.db.close();
    }
  });

  test('rejects a human caller that names no Space', async () => {
    const ctx = makeCtx();
    try {
      const result = await invoke(ctx, 'goal.list', {}, HUMAN);
      expect(result).toEqual({
        accepted: false,
        reason: 'space_unresolved',
        message: 'spaceId is required for this caller.',
      });
    } finally {
      ctx.db.close();
    }
  });

  test('scopes an agent caller to its own Space and filters by status', async () => {
    const ctx = makeCtx();
    try {
      const active = ctx.seed(SPACE_ID, 'Active goal');
      ctx.goalService.pauseGoal(ctx.seed(SPACE_ID, 'Paused goal').id);
      const all = await invoke(ctx, 'goal.list', {}, agent('ad_hoc_member'));
      expect(all.goals).toHaveLength(2);
      const onlyActive = await invoke(
        ctx,
        'goal.list',
        { status: 'active' },
        agent('long_term_agent')
      );
      expect((onlyActive.goals as SpaceGoal[]).map((goal) => goal.id)).toEqual([active.id]);
    } finally {
      ctx.db.close();
    }
  });

  test('admits universal_read but stops workflow_worker at the door policy', async () => {
    const ctx = makeCtx();
    try {
      ctx.seed(SPACE_ID, 'Readable');
      const read = await invoke(ctx, 'goal.list', {}, agent('universal_read'));
      expect(read.accepted).toBe(true);
      const worker = await invokeOperation(ctx.registry, 'goal.list', {}, agent('workflow_worker'));
      expect(worker.kind).toBe('failed');
      expect(worker.kind === 'failed' && worker.code).toBe('forbidden');
    } finally {
      ctx.db.close();
    }
  });

  test('denies workflow_worker inside the operation even when the door lets it through', async () => {
    const ctx = makeCtx();
    try {
      ctx.seed(SPACE_ID, 'Readable');
      const operation = ctx.registry.get('goal.list');
      if (!operation) throw new Error('goal.list is not registered');
      const result = (await operation.execute({}, agent('workflow_worker'))) as {
        accepted: boolean;
        reason?: string;
      };
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('role_denied');
    } finally {
      ctx.db.close();
    }
  });

  test('rejects an agent caller that names a different Space in its input', async () => {
    const ctx = makeCtx();
    try {
      ctx.seed(OTHER_SPACE_ID, 'Not yours');
      const result = await invoke(
        ctx,
        'goal.list',
        { spaceId: OTHER_SPACE_ID },
        agent('long_term_agent')
      );
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('space_mismatch');
    } finally {
      ctx.db.close();
    }
  });

  test('rejects an agent caller whose session carries no Space', async () => {
    const ctx = makeCtx();
    try {
      const result = await invoke(
        ctx,
        'goal.list',
        {},
        {
          source: 'mcp',
          sessionId: 'session-1',
          role: 'long_term_agent',
        }
      );
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('space_unresolved');
    } finally {
      ctx.db.close();
    }
  });
});

describe('goal.get through the operations door', () => {
  test('returns the goal record for a caller inside the owning Space', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.seed(SPACE_ID, 'Readable goal');
      const result = await invoke(ctx, 'goal.get', { goalId: goal.id }, agent('ad_hoc_member'));
      expect(result.accepted).toBe(true);
      expect(result.goal?.id).toBe(goal.id);
      expect(result.goal?.revision).toBe(goal.revision);
    } finally {
      ctx.db.close();
    }
  });

  test('hides a goal owned by another Space behind goal_not_found', async () => {
    const ctx = makeCtx();
    try {
      const foreign = ctx.seed(OTHER_SPACE_ID, 'Foreign goal');
      const result = await invoke(
        ctx,
        'goal.get',
        { goalId: foreign.id },
        agent('long_term_agent')
      );
      expect(result).toEqual({
        accepted: false,
        reason: 'goal_not_found',
        message: `Goal not found: ${foreign.id}`,
      });
      expect(ctx.goalService.getGoal(foreign.id)?.spaceId).toBe(OTHER_SPACE_ID);
    } finally {
      ctx.db.close();
    }
  });

  test('lets a human caller read a goal without naming its Space', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.seed(OTHER_SPACE_ID, 'Human readable');
      const result = await invoke(ctx, 'goal.get', { goalId: goal.id }, HUMAN);
      expect(result.accepted).toBe(true);
      expect(result.goal?.spaceId).toBe(OTHER_SPACE_ID);
    } finally {
      ctx.db.close();
    }
  });

  test('denies a workflow_worker caller', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.seed(SPACE_ID, 'Worker denied');
      const outcome = await invokeOperation(
        ctx.registry,
        'goal.get',
        { goalId: goal.id },
        agent('workflow_worker')
      );
      expect(outcome.kind).toBe('failed');
      expect(outcome.kind === 'failed' && outcome.code).toBe('forbidden');
    } finally {
      ctx.db.close();
    }
  });

  test('rejects caller identity smuggled through the input schema', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.seed(SPACE_ID, 'Strict input');
      const outcome = await invokeOperation(
        ctx.registry,
        'goal.get',
        { goalId: goal.id, role: 'long_term_agent', agentId: 'agent-x' },
        agent('workflow_worker')
      );
      expect(outcome.kind).toBe('failed');
      expect(outcome.kind === 'failed' && outcome.code).toBe('invalid_input');
    } finally {
      ctx.db.close();
    }
  });
});
