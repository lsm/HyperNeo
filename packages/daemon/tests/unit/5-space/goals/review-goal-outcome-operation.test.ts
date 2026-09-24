import { describe, expect, test } from 'bun:test';
import type { Session, SpaceGoal, SpaceGoalOutcomeNotification } from '@hyperneo/shared';
import { createGoalOperations } from '../../../../src/lib/goals/operations.ts';
import { SpaceGoalService } from '../../../../src/lib/goals/service.ts';
import { ScheduleService } from '../../../../src/lib/schedule/schedule-service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { McpAuditLogRepository } from '../../../../src/storage/repositories/mcp-audit-log-repository.ts';
import { SpaceAgentGoalScopeRepository } from '../../../../src/storage/repositories/space-agent-goal-scope-repository.ts';
import { SpaceGoalEventRepository } from '../../../../src/storage/repositories/space-goal-event-repository.ts';
import { SpaceGoalOutcomeNotificationRepository } from '../../../../src/storage/repositories/space-goal-outcome-notification-repository.ts';
import { SpaceGoalRepository } from '../../../../src/storage/repositories/space-goal-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { TaskScheduleRepository } from '../../../../src/storage/repositories/task-schedule-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const SPACE_ID = 'space-goal-review';
const SESSION_ID = 'session-goal-owner';
const SESSION_OWNER_ID = 'agent-session-owner';

function insertSpace(db: BunDatabase, spaceId: string): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, `/tmp/workspace/${spaceId}`, spaceId, spaceId, Date.now(), Date.now());
}

function session(status: string): Session {
  return {
    id: SESSION_ID,
    type: 'space',
    status,
    context: { spaceId: SPACE_ID },
    metadata: { promptProvenance: { source: 'test', hash: 'h', agentId: SESSION_OWNER_ID } },
  } as unknown as Session;
}

function makeCtx(sessionStatus = 'active') {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  insertSpace(db, SPACE_ID);
  const spaceRepo = new SpaceRepository(db);
  const taskRepo = new SpaceTaskRepository(db);
  const goalRepo = new SpaceGoalRepository(db);
  const longHorizonAgentRepo = new SpaceLongHorizonAgentRepository(db);
  const goalScopeRepo = new SpaceAgentGoalScopeRepository(db, longHorizonAgentRepo);
  const outcomeNotificationRepo = new SpaceGoalOutcomeNotificationRepository(db);
  const auditLogRepo = new McpAuditLogRepository(db);
  const goalService = new SpaceGoalService({
    goalRepo,
    goalEventRepo: new SpaceGoalEventRepository(db),
    taskRepo,
    spaceRepo,
    goalScopeRepo,
    agentRepo: longHorizonAgentRepo,
    outcomeNotificationRepo,
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
      getSession: (id) => (id === SESSION_ID ? session(sessionStatus) : null),
      auditLogRepo,
    })
  );
  const owner = longHorizonAgentRepo.create({
    id: SESSION_OWNER_ID,
    sessionId: SESSION_ID,
    spaceId: SPACE_ID,
    handle: 'owner-agent',
    displayName: 'Owner',
    instructions: '',
  });
  const goal = goalService.createGoal({
    spaceId: SPACE_ID,
    title: 'Reviewed goal',
    primaryOwnerAgentId: owner.id,
  });
  const task = goalService.createImmediateTask(goal.id).task;
  const notify = (): SpaceGoalOutcomeNotification =>
    outcomeNotificationRepo.create({
      spaceId: SPACE_ID,
      goalId: goal.id,
      taskId: task?.id as string,
      terminalGeneration: 1,
      goalRevision: goalRepo.getById(goal.id)?.revision ?? 0,
      payload: {
        summary: 'done',
        taskStatus: 'done',
        taskTitle: task?.title ?? '',
        goalTitle: goal.title,
      },
    });
  const auditRows = () =>
    db.prepare(`SELECT tool_name, params_summary FROM mcp_audit_log`).all() as Array<{
      tool_name: string;
      params_summary: string;
    }>;
  return { db, registry, goalService, owner, goal, task, notify, auditRows };
}

type ReviewResult = {
  kind: string;
  accepted: boolean;
  reason?: string;
  message?: string;
  status?: string;
  notifications?: SpaceGoalOutcomeNotification[];
  goal?: SpaceGoal;
};

async function invoke(
  ctx: ReturnType<typeof makeCtx>,
  input: unknown,
  caller: OperationCaller,
  name = 'goal.outcome.resolve'
): Promise<ReviewResult> {
  const outcome = await invokeOperation(ctx.registry, name, input, caller);
  if (outcome.kind !== 'completed') throw new Error(`${name} failed: ${outcome.message}`);
  return outcome.value as ReviewResult;
}

function list(
  ctx: ReturnType<typeof makeCtx>,
  caller: OperationCaller,
  input: unknown = {}
): Promise<ReviewResult> {
  return invoke(ctx, input, caller, 'goal.outcome.list');
}

function ownerCaller(ctx: ReturnType<typeof makeCtx>): OperationCaller {
  return {
    source: 'mcp',
    sessionId: SESSION_ID,
    spaceId: SPACE_ID,
    role: 'long_term_agent',
    agentId: ctx.owner.id,
  };
}

describe('the goal outcome operations door', () => {
  test('goal.outcome.list accepts an omitted input from the MCP door', async () => {
    const ctx = makeCtx();
    try {
      const notification = ctx.notify();
      const outcome = await invokeOperation(
        ctx.registry,
        'goal.outcome.list',
        undefined,
        ownerCaller(ctx)
      );
      expect(outcome).toMatchObject({
        kind: 'completed',
        value: { accepted: true, notifications: [{ id: notification.id }] },
      });
    } finally {
      ctx.db.close();
    }
  });

  test('goal.outcome.list returns the notifications the calling agent owns', async () => {
    const ctx = makeCtx();
    try {
      const notification = ctx.notify();
      const result = await list(ctx, ownerCaller(ctx));
      expect(result.accepted).toBe(true);
      expect(result.notifications?.map((entry) => entry.id)).toEqual([notification.id]);
    } finally {
      ctx.db.close();
    }
  });

  test('resolves the reviewing actor from the caller, not from input', async () => {
    const ctx = makeCtx();
    try {
      ctx.notify();
      const result = await list(ctx, {
        source: 'mcp',
        sessionId: SESSION_ID,
        spaceId: SPACE_ID,
        role: 'long_term_agent',
      });
      expect(result.accepted).toBe(true);
      expect(result.notifications).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });

  test('acknowledges a notification and persists the goal-state update', async () => {
    const ctx = makeCtx();
    try {
      const notification = ctx.notify();
      const result = await invoke(
        ctx,
        {
          notificationId: notification.id,
          goalId: ctx.goal.id,
          taskId: ctx.task?.id,
          summary: 'Outcome reviewed',
          nextSteps: ['next slice'],
        },
        ownerCaller(ctx)
      );
      expect(result.accepted).toBe(true);
      expect(result.status).toBe('claimed');
      expect(ctx.goalService.getGoal(ctx.goal.id)?.summary).toBe('Outcome reviewed');
      expect(ctx.auditRows()[0].tool_name).toBe('goal.outcome.resolve');
    } finally {
      ctx.db.close();
    }
  });

  test('goal.outcome.resolve refuses a goal-state update that names no notification', async () => {
    const ctx = makeCtx();
    try {
      const outcome = await invokeOperation(
        ctx.registry,
        'goal.outcome.resolve',
        { summary: 'Sneaky' },
        ownerCaller(ctx)
      );
      expect(outcome.kind).toBe('failed');
      expect(outcome.kind === 'failed' && outcome.code).toBe('invalid_input');
      expect(ctx.goalService.getGoal(ctx.goal.id)?.summary).toBe('');
    } finally {
      ctx.db.close();
    }
  });

  test('refuses a goal-state update paired with a non-acknowledge disposition', async () => {
    const ctx = makeCtx();
    try {
      const notification = ctx.notify();
      const result = await invoke(
        ctx,
        {
          notificationId: notification.id,
          goalId: ctx.goal.id,
          taskId: ctx.task?.id,
          disposition: 'reject',
          summary: 'Sneaky',
        },
        ownerCaller(ctx)
      );
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('review_input_invalid');
      expect(ctx.goalService.getGoal(ctx.goal.id)?.summary).toBe('');
    } finally {
      ctx.db.close();
    }
  });

  test('reports an unknown notification as notification_not_found', async () => {
    const ctx = makeCtx();
    try {
      const result = await invoke(
        ctx,
        {
          notificationId: 'missing-notification',
          goalId: ctx.goal.id,
          taskId: ctx.task?.id,
          disposition: 'acknowledge',
        },
        ownerCaller(ctx)
      );
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('notification_not_found');
    } finally {
      ctx.db.close();
    }
  });

  test('denies a claim whose goal and task identity do not match the notification', async () => {
    const ctx = makeCtx();
    try {
      const notification = ctx.notify();
      const result = await invoke(
        ctx,
        {
          notificationId: notification.id,
          goalId: ctx.goal.id,
          taskId: 'some-other-task',
          disposition: 'acknowledge',
        },
        ownerCaller(ctx)
      );
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('review_denied');
      expect(result.message).toContain('identity_mismatch');
    } finally {
      ctx.db.close();
    }
  });

  test('refuses an owner whose session is archived and writes nothing', async () => {
    const ctx = makeCtx('archived');
    try {
      const notification = ctx.notify();
      const result = await invoke(
        ctx,
        {
          notificationId: notification.id,
          goalId: ctx.goal.id,
          taskId: ctx.task?.id,
          summary: 'Blocked',
        },
        ownerCaller(ctx)
      );
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('session_not_admitted');
      expect(ctx.goalService.getGoal(ctx.goal.id)?.summary).toBe('');
      expect(ctx.auditRows()).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });

  test('rejects caller identity smuggled through the input schema', async () => {
    const ctx = makeCtx();
    try {
      const outcome = await invokeOperation(
        ctx.registry,
        'goal.outcome.list',
        { actorAgentId: 'agent-x' },
        ownerCaller(ctx)
      );
      expect(outcome.kind).toBe('failed');
      expect(outcome.kind === 'failed' && outcome.code).toBe('invalid_input');
    } finally {
      ctx.db.close();
    }
  });
});
