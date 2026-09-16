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
import { runMigrations } from '../../../../src/storage/schema/index.ts';
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
  insertSpace(db, SPACE_ID);
  insertSpace(db, OTHER_SPACE_ID);
  const spaceRepo = new SpaceRepository(db);
  const taskRepo = new SpaceTaskRepository(db);
  const auditLogRepo = new McpAuditLogRepository(db);
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
    resolveWorkspacePath: async (_spaceId: string, rawPath: string) => rawPath,
    db,
  });
  const registry = createOperationRegistry(
    createGoalOperations({
      goalService,
      taskRepo,
      longHorizonAgentRepo: { getById: () => null },
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
  return { db, registry, goalService, auditRows, seed };
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

describe('goal.pause through the operations door', () => {
  test('pauses a goal for an agent whose session is active in the owning Space', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.seed(SPACE_ID, 'Pausable');
      const result = await invoke(ctx, 'goal.pause', { goalId: goal.id }, agent('ad_hoc_member'));
      expect(result.accepted).toBe(true);
      expect(result.goal?.status).toBe('paused');
      expect(ctx.goalService.getGoal(goal.id)?.status).toBe('paused');
      expect(ctx.auditRows().map((row) => row.tool_name)).toEqual(['goal.pause']);
    } finally {
      ctx.db.close();
    }
  });

  test('refuses an agent whose session is archived and leaves the goal untouched', async () => {
    const ctx = makeCtx('archived');
    try {
      const goal = ctx.seed(SPACE_ID, 'Guarded');
      const result = await invoke(ctx, 'goal.pause', { goalId: goal.id }, agent('long_term_agent'));
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('session_not_admitted');
      expect(ctx.goalService.getGoal(goal.id)?.status).toBe('active');
      expect(ctx.auditRows()).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });

  test('stops universal_read at the door policy and leaves the goal active', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.seed(SPACE_ID, 'Read only');
      const outcome = await invokeOperation(
        ctx.registry,
        'goal.pause',
        { goalId: goal.id },
        agent('universal_read')
      );
      expect(outcome.kind).toBe('failed');
      expect(outcome.kind === 'failed' && outcome.code).toBe('forbidden');
      expect(ctx.goalService.getGoal(goal.id)?.status).toBe('active');
    } finally {
      ctx.db.close();
    }
  });

  test('denies universal_read inside the operation as well', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.seed(SPACE_ID, 'Read only');
      const operation = ctx.registry.get('goal.pause');
      if (!operation) throw new Error('goal.pause is not registered');
      const result = (await operation.execute(
        { goalId: goal.id },
        agent('universal_read')
      )) as WriteResult;
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('role_denied');
      expect(ctx.goalService.getGoal(goal.id)?.status).toBe('active');
    } finally {
      ctx.db.close();
    }
  });
});

describe('goal.resume through the operations door', () => {
  test('resumes a paused goal for a human caller', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.seed(SPACE_ID, 'Resumable');
      ctx.goalService.pauseGoal(goal.id);
      const result = await invoke(ctx, 'goal.resume', { goalId: goal.id }, HUMAN);
      expect(result.accepted).toBe(true);
      expect(result.goal?.status).toBe('active');
    } finally {
      ctx.db.close();
    }
  });
});

describe('goal.triggerTask through the operations door', () => {
  test('creates an immediate goal task and audits it against that task', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.seed(SPACE_ID, 'Triggerable');
      const result = await invoke(
        ctx,
        'goal.triggerTask',
        { goalId: goal.id },
        agent('long_term_agent')
      );
      expect(result.accepted).toBe(true);
      expect(result.queued).toBe(false);
      expect(result.task?.goalId).toBe(goal.id);
      expect(ctx.auditRows()).toEqual([
        {
          tool_name: 'goal.triggerTask',
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
