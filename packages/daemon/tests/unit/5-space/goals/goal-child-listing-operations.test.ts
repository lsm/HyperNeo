import { describe, expect, test } from 'bun:test';
import type { Session, SpaceGoal, SpaceGoalEvent, SpaceTaskCompact } from '@hyperneo/shared';
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

const SPACE_ID = 'space-goal-children';
const OTHER_SPACE_ID = 'space-goal-children-other';

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
      goalScopeRepo: { getPrimaryGoalOwner: () => ({ action: 'no_recipient' }) },
      getSession: (): Session | null => null,
    })
  );
  const seed = (spaceId: string, title: string): SpaceGoal =>
    goalService.createGoal({ spaceId, title, autoTriggerNext: true });
  return { db, registry, goalService, taskRepo, seed };
}

type ChildPage = {
  accepted: boolean;
  reason?: string;
  total?: number;
  hasMore?: boolean;
  tasks?: SpaceTaskCompact[];
  events?: SpaceGoalEvent[];
};

async function invoke(
  ctx: ReturnType<typeof makeCtx>,
  name: string,
  input: unknown,
  caller: OperationCaller
): Promise<ChildPage> {
  const outcome = await invokeOperation(ctx.registry, name, input, caller);
  if (outcome.kind !== 'completed') throw new Error(`${name} failed: ${outcome.message}`);
  return outcome.value as ChildPage;
}

function agent(role: OperationCaller['role'], spaceId = SPACE_ID): OperationCaller {
  return { source: 'mcp', sessionId: 'session-1', spaceId, role, agentName: 'planner' };
}

describe('goal.tasks.list through the operations door', () => {
  test('projects goal-linked tasks to compact summaries with a total', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.seed(SPACE_ID, 'Linked work');
      const triggered = ctx.goalService.createImmediateTask(goal.id);
      expect(triggered.task).not.toBeNull();
      const result = await invoke(
        ctx,
        'goal.tasks.list',
        { goalId: goal.id },
        agent('ad_hoc_member')
      );
      expect(result.accepted).toBe(true);
      expect(result.total).toBe(1);
      expect(result.hasMore).toBe(false);
      expect(result.tasks?.[0]).toEqual({
        id: triggered.task?.id as string,
        taskNumber: triggered.task?.taskNumber as number,
        title: triggered.task?.title as string,
        status: triggered.task?.status as SpaceTaskCompact['status'],
        priority: triggered.task?.priority as SpaceTaskCompact['priority'],
        createdAt: triggered.task?.createdAt as number,
        updatedAt: triggered.task?.updatedAt as number,
      });
    } finally {
      ctx.db.close();
    }
  });

  test('returns an empty page for a goal with no linked tasks', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.seed(SPACE_ID, 'Nothing linked');
      const result = await invoke(
        ctx,
        'goal.tasks.list',
        { goalId: goal.id },
        agent('universal_read')
      );
      expect(result).toEqual({ accepted: true, total: 0, hasMore: false, tasks: [] });
    } finally {
      ctx.db.close();
    }
  });

  test('hides a goal owned by another Space behind goal_not_found', async () => {
    const ctx = makeCtx();
    try {
      const foreign = ctx.seed(OTHER_SPACE_ID, 'Foreign');
      ctx.goalService.createImmediateTask(foreign.id);
      const result = await invoke(
        ctx,
        'goal.tasks.list',
        { goalId: foreign.id },
        agent('long_term_agent')
      );
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('goal_not_found');
      expect(ctx.taskRepo.listByGoal(OTHER_SPACE_ID, foreign.id, {}).total).toBe(1);
    } finally {
      ctx.db.close();
    }
  });

  test('stops a workflow_worker caller at the door policy', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.seed(SPACE_ID, 'Worker denied');
      const outcome = await invokeOperation(
        ctx.registry,
        'goal.tasks.list',
        { goalId: goal.id },
        agent('workflow_worker')
      );
      expect(outcome.kind).toBe('failed');
      expect(outcome.kind === 'failed' && outcome.code).toBe('forbidden');
    } finally {
      ctx.db.close();
    }
  });

  test('denies a workflow_worker caller inside the operation as well', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.seed(SPACE_ID, 'Worker denied');
      const operation = ctx.registry.get('goal.tasks.list');
      if (!operation) throw new Error('goal.tasks.list is not registered');
      const result = (await operation.execute(
        { goalId: goal.id },
        agent('workflow_worker')
      )) as ChildPage;
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('role_denied');
    } finally {
      ctx.db.close();
    }
  });
});

describe('goal.events.list through the operations door', () => {
  test('returns the append-only history of a goal newest-first', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.seed(SPACE_ID, 'Tracked goal');
      ctx.goalService.pauseGoal(goal.id);
      const result = await invoke(
        ctx,
        'goal.events.list',
        { goalId: goal.id },
        agent('ad_hoc_member')
      );
      expect(result.accepted).toBe(true);
      expect(result.total).toBe(result.events?.length);
      expect(result.events?.map((event) => event.eventType)).toEqual(['status_changed', 'created']);
      expect(result.events?.[0].goalId).toBe(goal.id);
    } finally {
      ctx.db.close();
    }
  });

  test('honours the limit cursor', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.seed(SPACE_ID, 'Busy goal');
      ctx.goalService.pauseGoal(goal.id);
      ctx.goalService.resumeGoal(goal.id);
      const result = await invoke(
        ctx,
        'goal.events.list',
        { goalId: goal.id, limit: 1 },
        agent('long_term_agent')
      );
      expect(result.events).toHaveLength(1);
      expect(result.total).toBe(1);
    } finally {
      ctx.db.close();
    }
  });

  test('rejects an unknown goal id', async () => {
    const ctx = makeCtx();
    try {
      const result = await invoke(
        ctx,
        'goal.events.list',
        { goalId: 'missing-goal' },
        agent('long_term_agent')
      );
      expect(result).toEqual({
        accepted: false,
        reason: 'goal_not_found',
        message: 'Goal not found: missing-goal',
      });
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
        'goal.events.list',
        { goalId: goal.id, sessionId: 'session-elsewhere' },
        agent('workflow_worker')
      );
      expect(outcome.kind).toBe('failed');
      expect(outcome.kind === 'failed' && outcome.code).toBe('invalid_input');
    } finally {
      ctx.db.close();
    }
  });
});
