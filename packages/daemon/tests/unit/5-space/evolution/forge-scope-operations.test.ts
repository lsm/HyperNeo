import { describe, expect, test } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import { createForgeOperations } from '../../../../src/lib/evolution/operations.ts';
import type {
  ForgeAuditEntry,
  ForgeAuditWriter,
} from '../../../../src/lib/evolution/forge-admission.ts';
import { EvolutionScopeService } from '../../../../src/lib/evolution/scope-service.ts';
import { SpaceGoalService } from '../../../../src/lib/goals/service.ts';
import { ScheduleService } from '../../../../src/lib/schedule/schedule-service.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/workflows/workflow-manager.ts';
import {
  createOperationRegistry,
  type OperationCaller,
  type OperationDefinition,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { EvolutionRepository } from '../../../../src/storage/repositories/evolution-repository.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceGoalEventRepository } from '../../../../src/storage/repositories/space-goal-event-repository.ts';
import { SpaceGoalRepository } from '../../../../src/storage/repositories/space-goal-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { TaskScheduleRepository } from '../../../../src/storage/repositories/task-schedule-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const SPACE_ID = 'space-forge-operations';
const OTHER_SPACE_ID = 'space-forge-operations-other';

function insertSpace(db: BunDatabase, id: string): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(id, `/tmp/workspace-${id}`, id, id, Date.now(), Date.now());
}

function makeSession(id: string, spaceId: string, status: string): Session {
  return {
    id,
    title: id,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status,
    config: { tools: {} },
    metadata: {},
    type: 'space_chat',
    context: { spaceId },
  } as unknown as Session;
}

function makeCtx() {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  insertSpace(db, SPACE_ID);
  insertSpace(db, OTHER_SPACE_ID);

  const spaceRepo = new SpaceRepository(db);
  const goalRepo = new SpaceGoalRepository(db);
  const taskRepo = new SpaceTaskRepository(db);
  const workflowRunRepo = new SpaceWorkflowRunRepository(db);
  const evolutionRepo = new EvolutionRepository(db);
  const workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
  const scheduleService = new ScheduleService({
    db,
    scheduleRepo: new TaskScheduleRepository(db),
    jobQueue: new JobQueueRepository(db),
    spaceRepo,
  });
  const goalService = new SpaceGoalService({
    goalRepo,
    goalEventRepo: new SpaceGoalEventRepository(db),
    taskRepo,
    spaceRepo,
    scheduleService,
    db,
  });
  const scopeService = new EvolutionScopeService({
    evolutionRepo,
    spaceRepo,
    goalRepo,
    taskRepo,
    workflowRunRepo,
  });

  const sessions = new Map<string, Session>([
    ['session-member', makeSession('session-member', SPACE_ID, 'active')],
    ['session-archived', makeSession('session-archived', SPACE_ID, 'archived')],
    ['session-outsider', makeSession('session-outsider', OTHER_SPACE_ID, 'active')],
  ]);
  const audited: ForgeAuditEntry[] = [];
  const audit: ForgeAuditWriter = (entry) => {
    audited.push(entry);
  };

  const operations = createForgeOperations({
    getSession: (sessionId) => sessions.get(sessionId) ?? null,
    longHorizonAgentRepo: new SpaceLongHorizonAgentRepository(db),
    nodeExecutionRepo: new NodeExecutionRepository(db),
    taskRepo,
    workflowRunRepo,
    scopeService,
    getGoal: (goalId) => goalService.getGoal(goalId),
    db,
    goalRepo,
    scheduleService,
    audit,
  });
  const registry = createOperationRegistry(operations);
  const op = (name: string): OperationDefinition => {
    const found = registry.get(name);
    if (!found) throw new Error(`operation missing: ${name}`);
    return found;
  };
  return {
    db,
    goalRepo,
    taskRepo,
    workflowManager,
    workflowRunRepo,
    evolutionRepo,
    scopeService,
    operations,
    registry,
    op,
    audited,
  };
}

const memberCaller: OperationCaller = {
  source: 'mcp',
  sessionId: 'session-member',
  spaceId: SPACE_ID,
  role: 'ad_hoc_member',
  agentName: 'alice',
};
const readerCaller: OperationCaller = {
  source: 'mcp',
  sessionId: 'session-member',
  spaceId: SPACE_ID,
  role: 'universal_read',
};
const workerCaller: OperationCaller = {
  source: 'mcp',
  sessionId: 'session-member',
  spaceId: SPACE_ID,
  role: 'workflow_worker',
};
const archivedCaller: OperationCaller = {
  source: 'mcp',
  sessionId: 'session-archived',
  spaceId: SPACE_ID,
  role: 'ad_hoc_member',
};
const rpcCaller: OperationCaller = { source: 'rpc' };

const scopeInput = {
  kind: 'project' as const,
  name: 'Reliability',
  objective: 'Reduce flakes',
};

const SCOPE_OPERATION_NAMES = [
  'forge.evidence.attachTask',
  'forge.evidence.attachWorkflowRun',
  'forge.evidence.list',
  'forge.metric.add',
  'forge.metric.list',
  'forge.note.add',
  'forge.scope.create',
  'forge.scope.createFromGoal',
  'forge.scope.get',
  'forge.scope.list',
  'forge.scope.resolve',
  'forge.scope.update',
  'forge.timeline.get',
];

describe('Forge operation catalog', () => {
  test('registers every scope, timeline, evidence, and metric operation name', () => {
    const ctx = makeCtx();
    try {
      const registered = new Set(ctx.operations.map((entry) => entry.name));
      expect(SCOPE_OPERATION_NAMES.filter((name) => !registered.has(name))).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });
});

describe('forge.scope.create', () => {
  test('creates a scope in the caller Space and writes an audit entry', async () => {
    const ctx = makeCtx();
    try {
      const result = (await ctx.op('forge.scope.create').execute(scopeInput, memberCaller)) as {
        accepted: true;
        scope: { id: string; spaceId: string; name: string };
      };
      expect(result.accepted).toBe(true);
      expect(result.scope.spaceId).toBe(SPACE_ID);
      expect(ctx.evolutionRepo.getScope(result.scope.id)?.name).toBe('Reliability');
      expect(ctx.audited.map((entry) => entry.toolName)).toEqual(['forge.scope.create']);
    } finally {
      ctx.db.close();
    }
  });

  test('ignores a caller-supplied spaceId that matches and rejects one that differs', async () => {
    const ctx = makeCtx();
    try {
      const mismatch = (await ctx
        .op('forge.scope.create')
        .execute({ ...scopeInput, spaceId: OTHER_SPACE_ID }, memberCaller)) as {
        accepted: false;
        reason: string;
      };
      expect(mismatch).toMatchObject({ accepted: false, reason: 'space_mismatch' });
      expect(ctx.scopeService.listScopes({ spaceId: OTHER_SPACE_ID })).toHaveLength(0);
    } finally {
      ctx.db.close();
    }
  });

  test('denies a workflow_worker caller and leaves the Space without scopes', async () => {
    const ctx = makeCtx();
    try {
      const denied = (await ctx.op('forge.scope.create').execute(scopeInput, workerCaller)) as {
        accepted: false;
        reason: string;
      };
      expect(denied).toMatchObject({ accepted: false, reason: 'forge_denied' });
      expect(ctx.scopeService.listScopes({ spaceId: SPACE_ID })).toHaveLength(0);
    } finally {
      ctx.db.close();
    }
  });

  test('denies a universal_read caller because the operation mutates', async () => {
    const ctx = makeCtx();
    try {
      const denied = (await ctx.op('forge.scope.create').execute(scopeInput, readerCaller)) as {
        accepted: false;
        reason: string;
      };
      expect(denied).toMatchObject({ accepted: false, reason: 'forge_denied' });
      expect(ctx.scopeService.listScopes({ spaceId: SPACE_ID })).toHaveLength(0);
    } finally {
      ctx.db.close();
    }
  });

  test('denies an archived session in the owning Space and changes nothing', async () => {
    const ctx = makeCtx();
    try {
      const denied = (await ctx.op('forge.scope.create').execute(scopeInput, archivedCaller)) as {
        accepted: false;
        reason: string;
      };
      expect(denied).toMatchObject({ accepted: false, reason: 'forge_denied' });
      expect(ctx.scopeService.listScopes({ spaceId: SPACE_ID })).toHaveLength(0);
      expect(ctx.audited).toHaveLength(0);
    } finally {
      ctx.db.close();
    }
  });

  test('requires an explicit spaceId from an RPC caller', async () => {
    const ctx = makeCtx();
    try {
      const missing = (await ctx.op('forge.scope.create').execute(scopeInput, rpcCaller)) as {
        accepted: false;
        reason: string;
      };
      expect(missing).toMatchObject({ accepted: false, reason: 'space_required' });
      const created = (await ctx
        .op('forge.scope.create')
        .execute({ ...scopeInput, spaceId: SPACE_ID }, rpcCaller)) as {
        accepted: true;
        scope: { spaceId: string };
      };
      expect(created.scope.spaceId).toBe(SPACE_ID);
    } finally {
      ctx.db.close();
    }
  });

  test('rejects a goal outside the caller Space and an unparseable self-nag policy', async () => {
    const ctx = makeCtx();
    try {
      const foreignGoal = ctx.goalRepo.create({
        spaceId: OTHER_SPACE_ID,
        title: 'Foreign goal',
        description: '',
        type: 'recurring',
      });
      expect(
        await ctx
          .op('forge.scope.create')
          .execute({ ...scopeInput, goalId: foreignGoal.id }, memberCaller)
      ).toMatchObject({ accepted: false, reason: 'goal_not_found' });
      expect(
        await ctx.op('forge.scope.create').execute(
          {
            ...scopeInput,
            policy: { automation: { selfNagCronExpression: 'not a cron' } },
          },
          memberCaller
        )
      ).toMatchObject({ accepted: false, reason: 'invalid_policy' });
      expect(ctx.scopeService.listScopes({ spaceId: SPACE_ID })).toHaveLength(0);
    } finally {
      ctx.db.close();
    }
  });
});

describe('forge.scope.createFromGoal', () => {
  test('creates a mission scope defaulting its name from the goal', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.goalRepo.create({
        spaceId: SPACE_ID,
        title: 'Weekly review',
        description: 'recurring fixture',
        type: 'recurring',
      });
      const result = (await ctx
        .op('forge.scope.createFromGoal')
        .execute({ goalId: goal.id }, memberCaller)) as {
        accepted: true;
        scope: { kind: string; name: string; spaceGoalId: string | null };
      };
      expect(result.scope).toMatchObject({
        kind: 'mission',
        name: 'Weekly review',
        spaceGoalId: goal.id,
      });
    } finally {
      ctx.db.close();
    }
  });
});

describe('forge.scope.list', () => {
  test('lists scopes for a universal_read caller and rejects RPC callers without a Space', async () => {
    const ctx = makeCtx();
    try {
      await ctx.op('forge.scope.create').execute(scopeInput, memberCaller);
      const listed = (await ctx.op('forge.scope.list').execute({}, readerCaller)) as {
        accepted: true;
        scopes: Array<{ name: string }>;
      };
      expect(listed.scopes.map((scope) => scope.name)).toEqual(['Reliability']);
      expect(await ctx.op('forge.scope.list').execute({}, rpcCaller)).toMatchObject({
        accepted: false,
        reason: 'space_required',
      });
    } finally {
      ctx.db.close();
    }
  });
});

describe('forge.scope.get', () => {
  test('hides a scope owned by another Space behind scope_not_found', async () => {
    const ctx = makeCtx();
    try {
      const foreign = ctx.scopeService.createScope({
        spaceId: OTHER_SPACE_ID,
        kind: 'project',
        name: 'Foreign scope',
        objective: 'other space',
      });
      expect(
        await ctx.op('forge.scope.get').execute({ scopeId: foreign.id }, memberCaller)
      ).toMatchObject({ accepted: false, reason: 'scope_not_found' });
      const visible = (await ctx
        .op('forge.scope.get')
        .execute({ scopeId: foreign.id }, rpcCaller)) as { accepted: true; scope: { id: string } };
      expect(visible.scope.id).toBe(foreign.id);
    } finally {
      ctx.db.close();
    }
  });
});

describe('forge.scope.update', () => {
  test('deep-merges policyPatch and the judge model without clobbering the rest', async () => {
    const ctx = makeCtx();
    try {
      const created = (await ctx.op('forge.scope.create').execute(
        {
          ...scopeInput,
          policy: { episodeJudgeProvider: 'anthropic', automation: { completedTaskThreshold: 3 } },
        },
        memberCaller
      )) as { accepted: true; scope: { id: string } };
      const updated = (await ctx.op('forge.scope.update').execute(
        {
          scopeId: created.scope.id,
          policyPatch: { automation: { completedTaskThreshold: 5 } },
          episodeJudgeModel: 'claude-opus-4',
        },
        memberCaller
      )) as { accepted: true; scope: { policy: Record<string, unknown> } };
      expect(updated.scope.policy).toMatchObject({
        episodeJudgeProvider: 'anthropic',
        episodeJudgeModel: 'claude-opus-4',
        automation: { completedTaskThreshold: 5 },
      });
    } finally {
      ctx.db.close();
    }
  });

  test('rejects an unknown scope without touching the store', async () => {
    const ctx = makeCtx();
    try {
      expect(
        await ctx
          .op('forge.scope.update')
          .execute({ scopeId: 'missing-scope', name: 'x' }, memberCaller)
      ).toMatchObject({ accepted: false, reason: 'scope_not_found' });
      expect(ctx.scopeService.listScopes({ spaceId: SPACE_ID })).toHaveLength(0);
    } finally {
      ctx.db.close();
    }
  });
});

describe('forge scope input min-length parity', () => {
  test('forge.scope.create rejects a blank objective and a blank metric key or label', async () => {
    const ctx = makeCtx();
    try {
      expect(
        await invokeOperation(
          ctx.registry,
          'forge.scope.create',
          { ...scopeInput, objective: '' },
          memberCaller
        )
      ).toMatchObject({ kind: 'failed', code: 'invalid_input' });
      expect(
        await invokeOperation(
          ctx.registry,
          'forge.scope.create',
          {
            ...scopeInput,
            metricDefinitions: [{ key: '', label: 'Flake rate', direction: 'decrease' }],
          },
          memberCaller
        )
      ).toMatchObject({ kind: 'failed', code: 'invalid_input' });
      expect(
        await invokeOperation(
          ctx.registry,
          'forge.scope.create',
          {
            ...scopeInput,
            metricDefinitions: [{ key: 'flake_rate', label: '', direction: 'decrease' }],
          },
          memberCaller
        )
      ).toMatchObject({ kind: 'failed', code: 'invalid_input' });
      expect(ctx.scopeService.listScopes({ spaceId: SPACE_ID })).toHaveLength(0);
    } finally {
      ctx.db.close();
    }
  });

  test('forge.scope.update rejects a blank objective and leaves the stored scope intact', async () => {
    const ctx = makeCtx();
    try {
      const created = (await ctx.op('forge.scope.create').execute(scopeInput, memberCaller)) as {
        accepted: true;
        scope: { id: string };
      };
      expect(
        await invokeOperation(
          ctx.registry,
          'forge.scope.update',
          { scopeId: created.scope.id, objective: '' },
          memberCaller
        )
      ).toMatchObject({ kind: 'failed', code: 'invalid_input' });
      expect(ctx.evolutionRepo.getScope(created.scope.id)?.objective).toBe('Reduce flakes');
    } finally {
      ctx.db.close();
    }
  });

  test('forge.scope.createFromGoal rejects a blank name or objective override', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.goalRepo.create({
        spaceId: SPACE_ID,
        title: 'Ship reliability',
        description: 'Cut the flake rate',
        type: 'measurable',
      });
      expect(
        await invokeOperation(
          ctx.registry,
          'forge.scope.createFromGoal',
          { goalId: goal.id, objective: '' },
          memberCaller
        )
      ).toMatchObject({ kind: 'failed', code: 'invalid_input' });
      expect(
        await invokeOperation(
          ctx.registry,
          'forge.scope.createFromGoal',
          { goalId: goal.id, name: '' },
          memberCaller
        )
      ).toMatchObject({ kind: 'failed', code: 'invalid_input' });
      expect(ctx.scopeService.listScopes({ spaceId: SPACE_ID })).toHaveLength(0);
    } finally {
      ctx.db.close();
    }
  });
});

describe('forge.scope.resolve', () => {
  test('resolves the scope linked to a goal and demands a target otherwise', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.goalRepo.create({
        spaceId: SPACE_ID,
        title: 'Linked goal',
        description: '',
        type: 'recurring',
      });
      const created = (await ctx
        .op('forge.scope.createFromGoal')
        .execute({ goalId: goal.id }, memberCaller)) as { accepted: true; scope: { id: string } };
      const resolved = (await ctx
        .op('forge.scope.resolve')
        .execute({ goalId: goal.id }, memberCaller)) as { accepted: true; scope: { id: string } };
      expect(resolved.scope.id).toBe(created.scope.id);
      expect(await ctx.op('forge.scope.resolve').execute({}, memberCaller)).toMatchObject({
        accepted: false,
        reason: 'resolve_target_required',
      });
    } finally {
      ctx.db.close();
    }
  });
});

describe('forge.note.add', () => {
  test('attaches a manual note and surfaces it through forge.evidence.list', async () => {
    const ctx = makeCtx();
    try {
      const created = (await ctx.op('forge.scope.create').execute(scopeInput, memberCaller)) as {
        accepted: true;
        scope: { id: string };
      };
      const added = (await ctx
        .op('forge.note.add')
        .execute({ scopeId: created.scope.id, summary: 'Flakes down 20%' }, memberCaller)) as {
        accepted: true;
        evidence: { kind: string; summary: string };
      };
      expect(added.evidence).toMatchObject({ kind: 'manual_note', summary: 'Flakes down 20%' });
      const listed = (await ctx
        .op('forge.evidence.list')
        .execute({ scopeId: created.scope.id }, readerCaller)) as {
        accepted: true;
        evidence: Array<{ summary: string }>;
      };
      expect(listed.evidence.map((item) => item.summary)).toEqual(['Flakes down 20%']);
    } finally {
      ctx.db.close();
    }
  });

  test('denies an archived session and writes no evidence', async () => {
    const ctx = makeCtx();
    try {
      const created = (await ctx.op('forge.scope.create').execute(scopeInput, memberCaller)) as {
        accepted: true;
        scope: { id: string };
      };
      expect(
        await ctx
          .op('forge.note.add')
          .execute({ scopeId: created.scope.id, summary: 'should not land' }, archivedCaller)
      ).toMatchObject({ accepted: false, reason: 'forge_denied' });
      expect(ctx.scopeService.listEvidence(created.scope.id).evidence).toHaveLength(0);
    } finally {
      ctx.db.close();
    }
  });
});

describe('forge.evidence.attachTask', () => {
  test('attaches an in-Space task to an explicit scope and rejects a foreign task', async () => {
    const ctx = makeCtx();
    try {
      const created = (await ctx.op('forge.scope.create').execute(scopeInput, memberCaller)) as {
        accepted: true;
        scope: { id: string };
      };
      const task = ctx.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Evidence task',
        description: '',
      });
      const foreign = ctx.taskRepo.createTask({
        spaceId: OTHER_SPACE_ID,
        title: 'Foreign task',
        description: '',
      });
      const attached = (await ctx
        .op('forge.evidence.attachTask')
        .execute({ taskId: task.id, scopeId: created.scope.id }, memberCaller)) as {
        accepted: true;
        evidence: { kind: string; sourceId: string | null };
      };
      expect(attached.evidence).toMatchObject({ kind: 'task', sourceId: task.id });
      expect(
        await ctx
          .op('forge.evidence.attachTask')
          .execute({ taskId: foreign.id, scopeId: created.scope.id }, memberCaller)
      ).toMatchObject({ accepted: false, reason: 'task_not_found' });
    } finally {
      ctx.db.close();
    }
  });

  test('reports evidence_not_attached when no scope can be resolved for the task', async () => {
    const ctx = makeCtx();
    try {
      const task = ctx.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Unlinked task',
        description: '',
      });
      expect(
        await ctx.op('forge.evidence.attachTask').execute({ taskId: task.id }, memberCaller)
      ).toMatchObject({ accepted: false, reason: 'evidence_not_attached' });
    } finally {
      ctx.db.close();
    }
  });
});

describe('forge.evidence.attachWorkflowRun', () => {
  test('attaches a run to an explicit scope and rejects an unknown run', async () => {
    const ctx = makeCtx();
    try {
      const created = (await ctx.op('forge.scope.create').execute(scopeInput, memberCaller)) as {
        accepted: true;
        scope: { id: string };
      };
      const workflow = ctx.workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: 'Forge evidence run',
        nodes: [{ name: 'Work', agents: [{ agentId: 'agent-1', name: 'Coder' }] }],
        tags: [],
      });
      const run = ctx.workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Run',
      });
      const attached = (await ctx
        .op('forge.evidence.attachWorkflowRun')
        .execute({ workflowRunId: run.id, scopeId: created.scope.id }, memberCaller)) as {
        accepted: true;
        evidence: { kind: string; sourceId: string | null };
      };
      expect(attached.evidence).toMatchObject({ kind: 'workflow_run', sourceId: run.id });
      expect(
        await ctx
          .op('forge.evidence.attachWorkflowRun')
          .execute({ workflowRunId: 'missing-run', scopeId: created.scope.id }, memberCaller)
      ).toMatchObject({ accepted: false, reason: 'workflow_run_not_found' });
    } finally {
      ctx.db.close();
    }
  });
});

describe('forge.metric.add', () => {
  test('records a snapshot that forge.metric.list and forge.timeline.get both report', async () => {
    const ctx = makeCtx();
    try {
      const created = (await ctx.op('forge.scope.create').execute(scopeInput, memberCaller)) as {
        accepted: true;
        scope: { id: string };
      };
      const added = (await ctx.op('forge.metric.add').execute(
        {
          scopeId: created.scope.id,
          values: { flakeRate: 0.02 },
          source: 'ci',
          note: 'week 1',
        },
        memberCaller
      )) as { accepted: true; snapshot: { id: string }; evidence: { kind: string } };
      expect(added.evidence.kind).toBe('metric_snapshot');
      const listed = (await ctx
        .op('forge.metric.list')
        .execute({ scopeId: created.scope.id }, readerCaller)) as {
        accepted: true;
        snapshots: Array<{ id: string; source: string }>;
      };
      expect(listed.snapshots.map((snapshot) => snapshot.id)).toEqual([added.snapshot.id]);
      const timeline = (await ctx
        .op('forge.timeline.get')
        .execute({ scopeId: created.scope.id }, readerCaller)) as {
        accepted: true;
        scope: { id: string };
        metricSnapshots: Array<{ source: string }>;
      };
      expect(timeline.scope.id).toBe(created.scope.id);
      expect(timeline.metricSnapshots.map((snapshot) => snapshot.source)).toEqual(['ci']);
    } finally {
      ctx.db.close();
    }
  });
});

describe('invokeOperation', () => {
  test('validates the forge.timeline.get result against its declared schema', async () => {
    const ctx = makeCtx();
    try {
      const created = (await ctx.op('forge.scope.create').execute(scopeInput, memberCaller)) as {
        accepted: true;
        scope: { id: string };
      };
      await ctx
        .op('forge.note.add')
        .execute({ scopeId: created.scope.id, summary: 'note' }, memberCaller);
      const outcome = await invokeOperation(
        ctx.registry,
        'forge.timeline.get',
        { scopeId: created.scope.id },
        memberCaller
      );
      expect(outcome).toMatchObject({
        kind: 'completed',
        value: { accepted: true, scope: { id: created.scope.id } },
      });
      const denied = await invokeOperation(
        ctx.registry,
        'forge.timeline.get',
        { scopeId: created.scope.id },
        workerCaller
      );
      expect(denied).toMatchObject({ kind: 'failed', code: 'forbidden' });
      expect(
        await ctx.op('forge.timeline.get').execute({ scopeId: created.scope.id }, workerCaller)
      ).toMatchObject({ accepted: false, reason: 'forge_denied' });
    } finally {
      ctx.db.close();
    }
  });
});
