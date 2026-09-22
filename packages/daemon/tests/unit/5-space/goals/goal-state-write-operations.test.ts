import { describe, expect, test } from 'bun:test';
import type { Session, SpaceGoal, SpaceTask } from '@hyperneo/shared';
import { createGoalOperations } from '../../../../src/lib/goals/operations.ts';
import { SpaceGoalService } from '../../../../src/lib/goals/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { ScheduleService } from '../../../../src/lib/schedule/schedule-service.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { McpAuditLogRepository } from '../../../../src/storage/repositories/mcp-audit-log-repository.ts';
import { SpaceGoalEventRepository } from '../../../../src/storage/repositories/space-goal-event-repository.ts';
import { SpaceGoalRepository } from '../../../../src/storage/repositories/space-goal-repository.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { TaskScheduleRepository } from '../../../../src/storage/repositories/task-schedule-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const SPACE_ID = 'space-goal-writes';
const OTHER_SPACE_ID = 'space-goal-writes-other';
const SESSION_ID = 'session-goal-writer';

function insertSpace(db: BunDatabase, spaceId: string): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, `/tmp/workspace/${spaceId}`, spaceId, spaceId, Date.now(), Date.now());
}

function session(status: string, spaceId = SPACE_ID): Session {
  return {
    id: SESSION_ID,
    type: 'space',
    status,
    context: { spaceId },
    metadata: {},
  } as unknown as Session;
}

function makeCtx(sessionStatus = 'active') {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  createTables(db);
  insertSpace(db, SPACE_ID);
  insertSpace(db, OTHER_SPACE_ID);
  const spaceRepo = new SpaceRepository(db);
  const taskRepo = new SpaceTaskRepository(db);
  const auditLogRepo = new McpAuditLogRepository(db);
  const scheduleService = new ScheduleService({
    db,
    scheduleRepo: new TaskScheduleRepository(db),
    jobQueue: new JobQueueRepository(db),
    spaceRepo,
  });
  const goalService = new SpaceGoalService({
    goalRepo: new SpaceGoalRepository(db),
    goalEventRepo: new SpaceGoalEventRepository(db),
    taskRepo,
    spaceRepo,
    scheduleService,
    resolveWorkspacePath: async (_spaceId: string, rawPath: string) => rawPath,
    db,
  });
  const registry = createOperationRegistry(
    createGoalOperations({
      goalService,
      taskRepo,
      longHorizonAgentRepo: { getById: () => null },
      goalScopeRepo: { getPrimaryGoalOwner: () => ({ action: 'no_recipient' }) },
      getSession: (id) => (id === SESSION_ID ? session(sessionStatus) : null),
      auditLogRepo,
    })
  );
  const seed = (spaceId: string, title: string): SpaceGoal =>
    goalService.createGoal({ spaceId, title, autoTriggerNext: true });
  const auditRows = () =>
    db.prepare(`SELECT tool_name, params_summary, task_id FROM mcp_audit_log`).all() as Array<{
      tool_name: string;
      params_summary: string;
      task_id: string | null;
    }>;
  const seedScheduled = (spaceId: string, title: string): SpaceGoal =>
    goalService.createGoal({ spaceId, title, checkInCronExpression: '0 9 * * 1' });
  return { db, registry, goalService, scheduleService, auditRows, seed, seedScheduled };
}

type WriteResult = {
  accepted: boolean;
  reason?: string;
  goal?: SpaceGoal;
  task?: SpaceTask | null;
  queued?: boolean;
};

async function invoke(
  ctx: ReturnType<typeof makeCtx>,
  name: string,
  input: unknown,
  caller: OperationCaller
): Promise<WriteResult> {
  const outcome = await invokeOperation(ctx.registry, name, input, caller);
  if (outcome.kind !== 'completed') throw new Error(`${name} failed: ${outcome.message}`);
  return outcome.value as WriteResult;
}

const HUMAN: OperationCaller = { source: 'rpc' };

function agent(role: OperationCaller['role'], spaceId = SPACE_ID): OperationCaller {
  return { source: 'mcp', sessionId: SESSION_ID, spaceId, role, agentName: 'planner' };
}

describe('goal.task.trigger through the operations door', () => {
  test('creates an immediate goal task and audits it against that task', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.seed(SPACE_ID, 'Triggerable');
      const result = await invoke(
        ctx,
        'goal.task.trigger',
        { goalId: goal.id },
        agent('long_term_agent')
      );
      expect(result.accepted).toBe(true);
      expect(result.queued).toBe(false);
      expect(result.task?.goalId).toBe(goal.id);
      expect(ctx.auditRows()).toEqual([
        {
          tool_name: 'goal.task.trigger',
          params_summary: JSON.stringify({ goalId: goal.id }),
          task_id: result.task?.id ?? null,
        },
      ]);
    } finally {
      ctx.db.close();
    }
  });
});

describe('goal.update through the operations door', () => {
  test('writes rolling state and records the field names it touched', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.seed(SPACE_ID, 'Updatable');
      const result = await invoke(
        ctx,
        'goal.update',
        { goalId: goal.id, summary: 'Halfway', nextSteps: ['ship it'], progress: 50 },
        agent('ad_hoc_member')
      );
      expect(result.accepted).toBe(true);
      expect(result.goal?.summary).toBe('Halfway');
      expect(result.goal?.nextSteps).toEqual(['ship it']);
      expect(result.goal?.progress).toBe(50);
      expect(JSON.parse(ctx.auditRows()[0].params_summary)).toEqual({
        goalId: goal.id,
        fields: ['summary', 'progress', 'nextSteps'],
      });
    } finally {
      ctx.db.close();
    }
  });

  test('pauses the goal and its linked check-in schedule through the status field', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.seedScheduled(SPACE_ID, 'Weekly check-in');
      const scheduleId = goal.taskScheduleId as string;
      const result = await invoke(
        ctx,
        'goal.update',
        { goalId: goal.id, status: 'paused' },
        agent('ad_hoc_member')
      );
      expect(result.accepted).toBe(true);
      expect(result.goal?.status).toBe('paused');
      expect(result.goal?.nextCheckInAt).toBeNull();
      expect(ctx.scheduleService.getSchedule(scheduleId)?.status).toBe('paused');
      expect(ctx.goalService.listGoalEvents(goal.id)[0]?.eventType).toBe('status_changed');
    } finally {
      ctx.db.close();
    }
  });

  test('resumes a paused goal and restores its next check-in through the status field', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.seedScheduled(SPACE_ID, 'Weekly check-in');
      const scheduleId = goal.taskScheduleId as string;
      ctx.goalService.updateGoal(goal.id, { status: 'paused' });
      const result = await invoke(ctx, 'goal.update', { goalId: goal.id, status: 'active' }, HUMAN);
      expect(result.accepted).toBe(true);
      expect(result.goal?.status).toBe('active');
      expect(result.goal?.nextCheckInAt).not.toBeNull();
      expect(ctx.scheduleService.getSchedule(scheduleId)?.status).toBe('active');
      expect(ctx.goalService.listGoalEvents(goal.id)[0]?.eventType).toBe('status_changed');
    } finally {
      ctx.db.close();
    }
  });

  test('records workspacePath among the audited fields when a repin is requested', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.seed(SPACE_ID, 'Repinnable');
      const result = await invoke(
        ctx,
        'goal.update',
        { goalId: goal.id, summary: 'Moved', workspacePath: '/tmp/workspace/other-repo' },
        agent('ad_hoc_member')
      );
      expect(result.accepted).toBe(true);
      expect(result.goal?.workspacePath).toBe('/tmp/workspace/other-repo');
      expect(JSON.parse(ctx.auditRows()[0].params_summary).fields).toEqual([
        'summary',
        'workspacePath',
      ]);
    } finally {
      ctx.db.close();
    }
  });

  test('hides a goal owned by another Space behind goal_not_found', async () => {
    const ctx = makeCtx();
    try {
      const foreign = ctx.seed(OTHER_SPACE_ID, 'Foreign');
      const result = await invoke(
        ctx,
        'goal.update',
        { goalId: foreign.id, summary: 'Not yours' },
        agent('long_term_agent')
      );
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('goal_not_found');
      expect(ctx.goalService.getGoal(foreign.id)?.summary).toBe('');
    } finally {
      ctx.db.close();
    }
  });

  test('rejects internal goal pointers offered through the input schema', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.seed(SPACE_ID, 'Strict input');
      const outcome = await invokeOperation(
        ctx.registry,
        'goal.update',
        { goalId: goal.id, activeTaskId: 'task-forged' },
        agent('long_term_agent')
      );
      expect(outcome.kind).toBe('failed');
      expect(outcome.kind === 'failed' && outcome.code).toBe('invalid_input');
      expect(ctx.goalService.getGoal(goal.id)?.activeTaskId).toBeNull();
    } finally {
      ctx.db.close();
    }
  });
});
