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
import { McpAuditLogRepository } from '../../../../src/storage/repositories/mcp-audit-log-repository.ts';
import { SpaceAgentGoalScopeRepository } from '../../../../src/storage/repositories/space-agent-goal-scope-repository.ts';
import { SpaceGoalEventRepository } from '../../../../src/storage/repositories/space-goal-event-repository.ts';
import { SpaceGoalRepository } from '../../../../src/storage/repositories/space-goal-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { TaskScheduleRepository } from '../../../../src/storage/repositories/task-schedule-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const SPACE_ID = 'space-goal-create';
const OTHER_SPACE_ID = 'space-goal-create-other';
const SESSION_ID = 'session-goal-creator';

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
  const longHorizonAgentRepo = new SpaceLongHorizonAgentRepository(db);
  const goalScopeRepo = new SpaceAgentGoalScopeRepository(db, longHorizonAgentRepo);
  const auditLogRepo = new McpAuditLogRepository(db);
  const goalService = new SpaceGoalService({
    goalRepo: new SpaceGoalRepository(db),
    goalEventRepo: new SpaceGoalEventRepository(db),
    taskRepo,
    spaceRepo,
    goalScopeRepo,
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
  const seedAgent = (spaceId: string, handle: string, status: 'active' | 'paused' = 'active') =>
    longHorizonAgentRepo.create({
      spaceId,
      handle,
      displayName: handle,
      instructions: '',
      status,
    });
  const auditRows = () =>
    db.prepare(`SELECT tool_name, params_summary FROM mcp_audit_log`).all() as Array<{
      tool_name: string;
      params_summary: string;
    }>;
  return { db, registry, goalService, goalScopeRepo, seedAgent, auditRows };
}

type CreateResult = { accepted: boolean; reason?: string; goal?: SpaceGoal };

async function invoke(
  ctx: ReturnType<typeof makeCtx>,
  input: unknown,
  caller: OperationCaller
): Promise<CreateResult> {
  const outcome = await invokeOperation(ctx.registry, 'goal.create', input, caller);
  if (outcome.kind !== 'completed') throw new Error(`goal.create failed: ${outcome.message}`);
  return outcome.value as CreateResult;
}

const HUMAN: OperationCaller = { source: 'rpc' };

function agent(role: OperationCaller['role'], agentId?: string): OperationCaller {
  return { source: 'mcp', sessionId: SESSION_ID, spaceId: SPACE_ID, role, agentId };
}

describe('goal.create through the operations door', () => {
  test('creates a goal in the Space a human caller names', async () => {
    const ctx = makeCtx();
    try {
      const result = await invoke(ctx, { spaceId: SPACE_ID, title: 'Human goal' }, HUMAN);
      expect(result.accepted).toBe(true);
      expect(result.goal?.spaceId).toBe(SPACE_ID);
      expect(ctx.goalService.getGoal(result.goal?.id as string)?.title).toBe('Human goal');
    } finally {
      ctx.db.close();
    }
  });

  test('accepts a null checkInCronExpression, as the create dialog sends when the cron is blank', async () => {
    const ctx = makeCtx();
    try {
      const result = await invoke(
        ctx,
        { spaceId: SPACE_ID, title: 'No schedule', checkInCronExpression: null },
        HUMAN
      );
      expect(result.accepted).toBe(true);
      expect(ctx.goalService.getGoal(result.goal?.id as string)?.taskScheduleId).toBe(null);
    } finally {
      ctx.db.close();
    }
  });

  test('rejects a human caller that names no Space', async () => {
    const ctx = makeCtx();
    try {
      const result = await invoke(ctx, { title: 'Nowhere' }, HUMAN);
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('space_unresolved');
    } finally {
      ctx.db.close();
    }
  });

  test('self-claims ownership for the calling agent and audits the creation', async () => {
    const ctx = makeCtx();
    try {
      const self = ctx.seedAgent(SPACE_ID, 'planner');
      const result = await invoke(
        ctx,
        { title: 'Owned goal', priority: 'high' },
        agent('long_term_agent', self.id)
      );
      expect(result.accepted).toBe(true);
      expect(
        ctx.goalScopeRepo
          .listGoalAssignments(result.goal?.id as string)
          .map((link) => [link.agentId, link.relationship])
      ).toEqual([[self.id, 'owner']]);
      expect(JSON.parse(ctx.auditRows()[0].params_summary)).toEqual({
        title: 'Owned goal',
        priority: 'high',
      });
      expect(ctx.auditRows()[0].tool_name).toBe('goal.create');
    } finally {
      ctx.db.close();
    }
  });

  test('refuses an owner that belongs to another Space', async () => {
    const ctx = makeCtx();
    try {
      const self = ctx.seedAgent(SPACE_ID, 'planner');
      const foreign = ctx.seedAgent(OTHER_SPACE_ID, 'outsider');
      const result = await invoke(
        ctx,
        { title: 'Wrong owner', ownerAgentId: foreign.id },
        agent('long_term_agent', self.id)
      );
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('owner_not_found');
      expect(ctx.goalService.listGoals({ spaceId: SPACE_ID })).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });

  test('refuses an ad_hoc_member naming an owner other than itself', async () => {
    const ctx = makeCtx();
    try {
      const other = ctx.seedAgent(SPACE_ID, 'someone-else');
      const result = await invoke(
        ctx,
        { title: 'Delegated', ownerAgentId: other.id },
        agent('ad_hoc_member')
      );
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('owner_denied');
      expect(ctx.goalService.listGoals({ spaceId: SPACE_ID })).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });

  test('refuses a Space-authority caller whose own agent identity is not active', async () => {
    const ctx = makeCtx();
    try {
      const self = ctx.seedAgent(SPACE_ID, 'planner', 'paused');
      const other = ctx.seedAgent(SPACE_ID, 'someone-else');
      const result = await invoke(
        ctx,
        { title: 'Stale identity', ownerAgentId: other.id },
        agent('long_term_agent', self.id)
      );
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('owner_denied');
      expect(ctx.goalService.listGoals({ spaceId: SPACE_ID })).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });

  test('refuses an agent whose session is archived and writes nothing', async () => {
    const ctx = makeCtx('archived');
    try {
      const result = await invoke(ctx, { title: 'Guarded' }, agent('long_term_agent'));
      expect(result.accepted).toBe(false);
      expect(result.reason).toBe('session_not_admitted');
      expect(ctx.goalService.listGoals({ spaceId: SPACE_ID })).toEqual([]);
      expect(ctx.auditRows()).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });

  test('stops universal_read via admitGoalRole inside the operation', async () => {
    const ctx = makeCtx();
    try {
      const outcome = await invokeOperation(
        ctx.registry,
        'goal.create',
        { title: 'Read only' },
        agent('universal_read')
      );
      expect(outcome).toMatchObject({
        kind: 'completed',
        value: { accepted: false, reason: 'role_denied' },
      });
      expect(ctx.goalService.listGoals({ spaceId: SPACE_ID })).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });

  test('rejects caller identity smuggled through the input schema', async () => {
    const ctx = makeCtx();
    try {
      const outcome = await invokeOperation(
        ctx.registry,
        'goal.create',
        { title: 'Forged', agentId: 'agent-x' },
        agent('long_term_agent')
      );
      expect(outcome.kind).toBe('failed');
      expect(outcome.kind === 'failed' && outcome.code).toBe('invalid_input');
      expect(ctx.goalService.listGoals({ spaceId: SPACE_ID })).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });
});
