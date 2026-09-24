import { describe, expect, test } from 'bun:test';
import type { Session } from '@hyperneo/shared';
import type {
  EvolutionAuditEntry,
  EvolutionAuditWriter,
} from '../../../../src/lib/evolution/admission.ts';
import { EvolutionEpisodeService } from '../../../../src/lib/evolution/episode-service.ts';
import { createEvolutionOperations } from '../../../../src/lib/evolution/operations.ts';
import { EvolutionScopeService } from '../../../../src/lib/evolution/scope-service.ts';
import { SpaceGoalService } from '../../../../src/lib/goals/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
  type OperationDefinition,
} from '../../../../src/lib/operations/registry.ts';
import { ScheduleService } from '../../../../src/lib/schedule/schedule-service.ts';
import { EvolutionRepository } from '../../../../src/storage/repositories/evolution-repository.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceGoalEventRepository } from '../../../../src/storage/repositories/space-goal-event-repository.ts';
import { SpaceGoalRepository } from '../../../../src/storage/repositories/space-goal-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { TaskScheduleRepository } from '../../../../src/storage/repositories/task-schedule-repository.ts';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const SPACE_ID = 'space-forge-scope-get';
const OTHER_SPACE_ID = 'space-forge-scope-get-other';

function insertSpace(db: BunDatabase, id: string): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(id, `/tmp/workspace-${id}`, id, id, Date.now(), Date.now());
}

function makeSession(id: string, spaceId: string): Session {
  return {
    id,
    title: id,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: 'active',
    config: { tools: {} },
    metadata: { promptProvenance: { source: 'test', hash: 'h', agentId: `agent-${id}` } },
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
  const episodeService = new EvolutionEpisodeService({
    evolutionRepo,
    taskRepo,
    workflowRunRepo,
    artifactRepo: new WorkflowRunArtifactRepository(db),
    goalService,
    db,
  });

  const sessions = new Map<string, Session>([
    ['session-member', makeSession('session-member', SPACE_ID)],
  ]);
  const sessionOwners = new SpaceLongHorizonAgentRepository(db);
  for (const owned of sessions.values()) {
    sessionOwners.create({
      id: `agent-${owned.id}`,
      spaceId: owned.context?.spaceId as string,
      handle: owned.id,
      sessionId: owned.id,
    });
  }
  const audited: EvolutionAuditEntry[] = [];
  const audit: EvolutionAuditWriter = (entry) => {
    audited.push(entry);
  };

  const longHorizonAgentRepo = new SpaceLongHorizonAgentRepository(db);
  const operations = createEvolutionOperations({
    getSession: (sessionId) => sessions.get(sessionId) ?? null,
    longHorizonAgentRepo,
    nodeExecutionRepo: new NodeExecutionRepository(db),
    taskRepo,
    workflowRunRepo,
    scopeService,
    episodeService,
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
    evolutionRepo,
    scopeService,
    longHorizonAgentRepo,
    audited,
    registry,
    op,
  };
}

type Ctx = ReturnType<typeof makeCtx>;

const memberCaller: OperationCaller = {
  source: 'mcp',
  sessionId: 'session-member',
  spaceId: SPACE_ID,
  role: 'long_term_agent',
  agentName: 'alice',
};
const readerCaller: OperationCaller = {
  source: 'mcp',
  sessionId: 'session-member',
  spaceId: SPACE_ID,
  role: 'universal_read',
};
const spacelessCaller: OperationCaller = {
  source: 'mcp',
  sessionId: 'session-member',
  role: 'long_term_agent',
};

function seedScope(ctx: Ctx, spaceId = SPACE_ID, goalId: string | null = null) {
  return ctx.scopeService.createScope({
    spaceId,
    spaceGoalId: goalId,
    kind: 'project',
    name: 'Reliability',
    objective: 'Reduce flakes',
  });
}

function seedParts(ctx: Ctx, scopeId: string) {
  ctx.scopeService.addManualNoteEvidence({ scopeId, summary: 'Flakes down 20%' });
  ctx.scopeService.addMetricSnapshotEvidence({
    scopeId,
    values: { flakeRate: 0.02 },
    source: 'ci',
  });
  ctx.evolutionRepo.createEpisode({ scopeId, title: 'Week one' });
  ctx.evolutionRepo.createLesson({
    scopeId,
    status: 'active',
    rule: 'Keep evidence scoped',
    why: 'Reduces drift',
  });
  ctx.evolutionRepo.createLesson({
    scopeId,
    status: 'candidate',
    rule: 'Retry flaky suites once',
    why: 'Cheap signal',
  });
  ctx.evolutionRepo.createTaskProposal({
    scopeId,
    title: 'Quarantine the flaky suite',
    description: '',
    reason: 'Evidence says so',
  });
  ctx.evolutionRepo.createTaskProposal({
    scopeId,
    title: 'Already dismissed',
    description: '',
    reason: 'Superseded',
    status: 'dismissed',
  });
}

async function read(ctx: Ctx, input: Record<string, unknown>, caller = readerCaller) {
  return (await ctx.op('evolution.scope.get').execute(input, caller)) as Record<string, unknown>;
}

describe('evolution.scope.get', () => {
  test('defaults to the scope row alone and reads no list', async () => {
    const ctx = makeCtx();
    try {
      const scope = seedScope(ctx);
      seedParts(ctx, scope.id);
      const result = await read(ctx, { scopeId: scope.id });
      expect(result).toEqual({
        accepted: true,
        scope: ctx.scopeService.getScope(scope.id) ?? undefined,
      });
      expect(Object.keys(result).sort()).toEqual(['accepted', 'scope']);
    } finally {
      ctx.db.close();
    }
  });

  test('reads back the agents a scope is routed to', async () => {
    const ctx = makeCtx();
    try {
      const scope = seedScope(ctx);
      const agent = ctx.longHorizonAgentRepo.create({
        spaceId: SPACE_ID,
        handle: 'steward',
        instructions: 'steward',
      });
      ctx.longHorizonAgentRepo.assignEvolutionScope(agent.id, scope.id);

      const result = await read(ctx, { scopeId: scope.id, include: ['agents'] });

      expect(result.agents).toEqual([
        { agentId: agent.id, relationship: 'owner', createdAt: expect.any(Number) },
      ]);
      expect(Object.keys(result).sort()).toEqual(['accepted', 'agents']);
    } finally {
      ctx.db.close();
    }
  });

  test('reports no agents for a scope nothing is routed to', async () => {
    const ctx = makeCtx();
    try {
      const scope = seedScope(ctx);
      const result = await read(ctx, { scopeId: scope.id, include: ['agents'] });
      expect(result.agents).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });

  test('returns the scope with its evidence and metric snapshots', async () => {
    const ctx = makeCtx();
    try {
      const scope = seedScope(ctx);
      seedParts(ctx, scope.id);
      const result = await read(ctx, {
        scopeId: scope.id,
        include: ['scope', 'evidence', 'metrics'],
      });
      expect((result.scope as { id: string }).id).toBe(scope.id);
      expect(result.evidence).toEqual(ctx.scopeService.listEvidence(scope.id).evidence);
      expect(result.metricSnapshots).toEqual(ctx.scopeService.listMetricSnapshots(scope.id));
    } finally {
      ctx.db.close();
    }
  });

  test('returns the episodes, lessons, and proposals without the scope row', async () => {
    const ctx = makeCtx();
    try {
      const scope = seedScope(ctx);
      seedParts(ctx, scope.id);
      const result = await read(ctx, {
        scopeId: scope.id,
        include: ['episodes', 'lessons', 'proposals'],
      });
      expect((result.episodes as Array<{ title: string }>).map((entry) => entry.title)).toEqual([
        'Week one',
      ]);
      expect((result.lessons as unknown[]).length).toBe(2);
      expect((result.proposals as unknown[]).length).toBe(2);
      expect(result.scope).toBeUndefined();
    } finally {
      ctx.db.close();
    }
  });

  test('filters the lesson and proposal parts by status', async () => {
    const ctx = makeCtx();
    try {
      const scope = seedScope(ctx);
      seedParts(ctx, scope.id);
      const result = await read(ctx, {
        scopeId: scope.id,
        include: ['lessons', 'proposals'],
        lessonStatus: 'active',
        proposalStatus: 'proposed',
      });
      expect((result.lessons as Array<{ rule: string }>).map((lesson) => lesson.rule)).toEqual([
        'Keep evidence scoped',
      ]);
      expect(
        (result.proposals as Array<{ title: string }>).map((proposal) => proposal.title)
      ).toEqual(['Quarantine the flaky suite']);
    } finally {
      ctx.db.close();
    }
  });

  test('addresses the scope by goal and by task, and demands an address', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.goalRepo.create({
        spaceId: SPACE_ID,
        title: 'Linked goal',
        description: '',
        type: 'recurring',
      });
      const scope = seedScope(ctx, SPACE_ID, goal.id);
      const task = ctx.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Scoped task',
        description: '',
        evolutionScopeId: scope.id,
      });
      const byGoal = await read(ctx, { goalId: goal.id });
      const byTask = await read(ctx, { taskId: task.id });
      expect((byGoal.scope as { id: string }).id).toBe(scope.id);
      expect((byTask.scope as { id: string }).id).toBe(scope.id);
      expect(await read(ctx, {})).toMatchObject({
        accepted: false,
        reason: 'resolve_target_required',
      });
    } finally {
      ctx.db.close();
    }
  });

  test('refuses a scope, goal, or task that belongs to another Space', async () => {
    const ctx = makeCtx();
    try {
      const foreignScope = seedScope(ctx, OTHER_SPACE_ID);
      const foreignGoal = ctx.goalRepo.create({
        spaceId: OTHER_SPACE_ID,
        title: 'Foreign goal',
        description: '',
        type: 'recurring',
      });
      const foreignTask = ctx.taskRepo.createTask({
        spaceId: OTHER_SPACE_ID,
        title: 'Foreign task',
        description: '',
        evolutionScopeId: foreignScope.id,
      });
      expect(await read(ctx, { scopeId: foreignScope.id })).toMatchObject({
        accepted: false,
        reason: 'scope_not_found',
      });
      expect(await read(ctx, { goalId: foreignGoal.id })).toMatchObject({
        accepted: false,
        reason: 'goal_not_found',
      });
      expect(await read(ctx, { taskId: foreignTask.id })).toMatchObject({
        accepted: false,
        reason: 'task_not_found',
      });
    } finally {
      ctx.db.close();
    }
  });

  test('audits a resolved address and a lesson or proposal read, and nothing else', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.goalRepo.create({
        spaceId: SPACE_ID,
        title: 'Linked goal',
        description: '',
        type: 'recurring',
      });
      const scope = seedScope(ctx, SPACE_ID, goal.id);
      seedParts(ctx, scope.id);
      await read(ctx, { scopeId: scope.id, include: ['scope', 'evidence', 'metrics', 'episodes'] });
      expect(ctx.audited).toEqual([]);
      await read(ctx, { scopeId: scope.id, include: ['lessons'] }, memberCaller);
      await read(ctx, { goalId: goal.id }, memberCaller);
      expect(ctx.audited.map((entry) => entry.toolName)).toEqual([
        'evolution.scope.get',
        'evolution.scope.get',
      ]);
      expect(ctx.audited[0]?.paramsSummary).toMatchObject({
        scopeId: scope.id,
        include: ['lessons'],
      });
      expect(ctx.audited[1]?.paramsSummary).toMatchObject({ goalId: goal.id, scopeId: scope.id });
    } finally {
      ctx.db.close();
    }
  });

  test('validates its result against the declared schema and denies a Space-less caller', async () => {
    const ctx = makeCtx();
    try {
      const scope = seedScope(ctx);
      seedParts(ctx, scope.id);
      expect(
        await invokeOperation(
          ctx.registry,
          'evolution.scope.get',
          {
            scopeId: scope.id,
            include: ['scope', 'evidence', 'metrics', 'episodes', 'lessons', 'proposals'],
          },
          memberCaller
        )
      ).toMatchObject({ kind: 'completed', value: { accepted: true, scope: { id: scope.id } } });
      expect(
        await invokeOperation(
          ctx.registry,
          'evolution.scope.get',
          { scopeId: scope.id },
          spacelessCaller
        )
      ).toMatchObject({ kind: 'completed', value: { accepted: false, reason: 'space_required' } });
      expect(
        await invokeOperation(
          ctx.registry,
          'evolution.scope.get',
          { scopeId: scope.id, include: ['unknown'] },
          memberCaller
        )
      ).toMatchObject({ kind: 'failed', code: 'invalid_input' });
    } finally {
      ctx.db.close();
    }
  });
});
