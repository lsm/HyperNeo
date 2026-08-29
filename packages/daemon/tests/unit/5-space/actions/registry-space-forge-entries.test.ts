import { describe, expect, test } from 'bun:test';
import { createActionRegistry } from '../../../../src/lib/space/actions/registry.ts';
import { createSpaceRegistryEntries } from '../../../../src/lib/space/actions/registry-space.ts';
import { EvolutionEpisodeService } from '../../../../src/lib/space/evolution-episode-service.ts';
import { EvolutionScopeService } from '../../../../src/lib/space/evolution-scope-service.ts';
import { SpaceGoalService } from '../../../../src/lib/space/goals/goal-service.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { ScheduleService } from '../../../../src/lib/space/schedule/schedule-service.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { SPACE_FORGE_TOOL_SCHEMAS } from '../../../../src/lib/space/tools/space-agent-tool-schemas.ts';
import type { SpaceAgentToolsConfig } from '../../../../src/lib/space/tools/space-agent-tools.ts';
import { SESSION_WRITE_AUTONOMY_LEVEL } from '../../../../src/lib/space/tools/tool-admission-gates.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { EvolutionRepository } from '../../../../src/storage/repositories/evolution-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceGoalEventRepository } from '../../../../src/storage/repositories/space-goal-event-repository.ts';
import { SpaceGoalRepository } from '../../../../src/storage/repositories/space-goal-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { TaskScheduleRepository } from '../../../../src/storage/repositories/task-schedule-repository.ts';
import { WorkflowRunArtifactRepository } from '../../../../src/storage/repositories/workflow-run-artifact-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const SPACE_ID = 'space-registry-forge-test';

const stubTaskAgentManager = {
  injectSubSessionMessage: async () => 'sdk-message-stub',
} as unknown as TaskAgentManager;

interface ForgeCtx {
  db: BunDatabase;
  config: SpaceAgentToolsConfig;
  workflowManager: SpaceWorkflowManager;
  workflowRunRepo: SpaceWorkflowRunRepository;
  taskRepo: SpaceTaskRepository;
  goalRepo: SpaceGoalRepository;
  evolutionRepo: EvolutionRepository;
}

function makeCtx(overrides: Partial<SpaceAgentToolsConfig> = {}): ForgeCtx {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, '/tmp/workspace', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(SPACE_ID, SPACE_ID, SPACE_ID, Date.now(), Date.now());

  const spaceRepo = new SpaceRepository(db);
  const spaceAgentManager = new SpaceAgentManager(new SpaceAgentRepository(db));
  const workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
  const workflowRunRepo = new SpaceWorkflowRunRepository(db);
  const nodeExecutionRepo = new NodeExecutionRepository(db);
  const taskRepo = new SpaceTaskRepository(db);
  const spaceManager = new SpaceManager(db);
  const longHorizonAgentRepo = new SpaceLongHorizonAgentRepository(db);
  const runtime = new SpaceRuntime({
    db,
    spaceManager,
    spaceAgentManager,
    spaceWorkflowManager: workflowManager,
    workflowRunRepo,
    taskRepo,
    nodeExecutionRepo,
    longHorizonAgentRepo,
  });
  const goalRepo = new SpaceGoalRepository(db);
  const goalService = new SpaceGoalService({
    goalRepo,
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
  const evolutionRepo = new EvolutionRepository(db);
  const evolutionScopeService = new EvolutionScopeService({
    evolutionRepo,
    spaceRepo,
    goalRepo,
    taskRepo,
    workflowRunRepo,
  });
  const evolutionEpisodeService = new EvolutionEpisodeService({
    evolutionRepo,
    taskRepo,
    workflowRunRepo,
    artifactRepo: new WorkflowRunArtifactRepository(db),
    goalService,
    judgeEpisode: async () => ({
      title: 'Registry dispatch episode',
      outcomeSummary: 'Evidence reviewed through the action registry',
      findings: [
        {
          domain: 'workflow',
          kind: 'optimization',
          impact: 'medium',
          confidence: 0.8,
          evidence: ['manual note'],
          proposedAction: 'Add follow-up task',
        },
      ],
      candidateLessons: [
        {
          appliesTo: ['workflow'],
          rule: 'Keep evidence scoped',
          why: 'Reduces drift',
          confidence: 0.9,
        },
      ],
      proposals: [
        {
          title: 'Improve Forge registry dogfood',
          description: 'Dispatch Forge tools through the registry',
          reason: 'Judge found next step',
          priority: 'high',
        },
      ],
    }),
  });
  const config: SpaceAgentToolsConfig = {
    spaceId: SPACE_ID,
    db,
    runtime,
    workflowManager,
    taskRepo,
    nodeExecutionRepo,
    workflowRunRepo,
    taskManager: new SpaceTaskManager(db, SPACE_ID),
    spaceAgentManager,
    taskAgentManager: stubTaskAgentManager,
    goalService,
    goalRepo,
    evolutionScopeService,
    evolutionEpisodeService,
    callerRole: 'coordinator',
    ...overrides,
  };
  return { db, config, workflowManager, workflowRunRepo, taskRepo, goalRepo, evolutionRepo };
}

const FORGE_ENTRIES: ReadonlyArray<readonly [string, string, string]> = [
  ['create_forge_scope', 'forge', 'mutate'],
  ['create_forge_scope_from_goal', 'forge', 'mutate'],
  ['list_forge_scopes', 'forge', 'read'],
  ['get_forge_scope', 'forge', 'read'],
  ['update_forge_scope', 'forge', 'mutate'],
  ['get_forge_timeline', 'forge', 'read'],
  ['add_forge_manual_note', 'forge', 'mutate'],
  ['attach_forge_task_evidence', 'forge', 'mutate'],
  ['attach_forge_workflow_run_evidence', 'forge', 'mutate'],
  ['add_forge_metric_snapshot', 'forge', 'mutate'],
  ['list_forge_evidence', 'forge', 'read'],
  ['list_forge_metric_snapshots', 'forge', 'read'],
  ['create_forge_episode', 'forge', 'mutate'],
  ['list_forge_review_bundle', 'forge', 'read'],
  ['list_forge_lessons', 'forge', 'read'],
  ['list_forge_proposals', 'forge', 'read'],
  ['resolve_forge_scope', 'forge', 'read'],
  ['update_forge_episode', 'forge', 'mutate'],
  ['update_forge_lesson', 'forge', 'mutate'],
  ['create_forge_task_proposal', 'forge', 'mutate'],
  ['update_forge_task_proposal', 'forge', 'mutate'],
  ['create_task_from_forge_proposal', 'forge', 'mutate'],
  ['apply_forge_rollup', 'forge', 'mutate'],
];

describe('createSpaceRegistryEntries — forge composition', () => {
  test('builds the authored forge-family entries in typed-surface order after the base families', () => {
    const ctx = makeCtx();
    try {
      const entries = createSpaceRegistryEntries(ctx.config);
      expect(
        entries
          .filter((entry) => entry.family === 'forge')
          .map((entry) => [entry.name, entry.family, entry.safetyClass])
      ).toEqual(FORGE_ENTRIES);
      const names = entries.map((entry) => entry.name);
      expect(names[names.length - 1]).toBe('review_goal_outcome');
      expect(names.indexOf('apply_forge_rollup')).toBe(names.length - 2);
      expect(names.indexOf('create_forge_scope')).toBeGreaterThan(
        names.indexOf('list_goal_events')
      );
      for (const entry of entries) {
        expect(entry.description.length).toBeGreaterThan(0);
        expect(entry.paramsDoc.length).toBeGreaterThan(0);
      }
    } finally {
      ctx.db.close();
    }
  });

  test('shares the schema objects with the typed surface — one parse path', () => {
    const ctx = makeCtx();
    try {
      const entries = createSpaceRegistryEntries(ctx.config).filter(
        (entry) => entry.family === 'forge'
      );
      expect(entries).toHaveLength(FORGE_ENTRIES.length);
      expect(FORGE_ENTRIES.length).toBe(Object.keys(SPACE_FORGE_TOOL_SCHEMAS).length);
      for (const entry of entries) {
        expect(entry.paramsSchema).toBe(
          SPACE_FORGE_TOOL_SCHEMAS[entry.name as keyof typeof SPACE_FORGE_TOOL_SCHEMAS]
        );
      }
    } finally {
      ctx.db.close();
    }
  });

  test('composes into a valid action registry', () => {
    const ctx = makeCtx();
    try {
      const registry = createActionRegistry(createSpaceRegistryEntries(ctx.config));
      expect(registry.get('create_forge_scope')?.family).toBe('forge');
      expect(registry.get('apply_forge_rollup')?.safetyClass).toBe('mutate');
      expect(registry.get('archive_forge_scope' as string)).toBeUndefined();
    } finally {
      ctx.db.close();
    }
  });
});

describe('createSpaceRegistryEntries — forge conditional entries', () => {
  test('omits every forge entry when either evolution service is absent', () => {
    for (const overrides of [
      { evolutionScopeService: undefined, evolutionEpisodeService: undefined },
      { evolutionScopeService: undefined },
      { evolutionEpisodeService: undefined },
    ] as Array<Partial<SpaceAgentToolsConfig>>) {
      const ctx = makeCtx(overrides);
      try {
        const entries = createSpaceRegistryEntries(ctx.config);
        expect(entries.filter((entry) => entry.family === 'forge')).toEqual([]);
        expect(entries.map((entry) => entry.name)).toContain('list_tasks');
      } finally {
        ctx.db.close();
      }
    }
  });
});

describe('createSpaceRegistryEntries — forge autonomy', () => {
  test('terminal status transitions require destructive clearance; edits and non-terminal statuses stay level 1', async () => {
    const ctx = makeCtx();
    try {
      const byName = new Map(
        createSpaceRegistryEntries(ctx.config).map((entry) => [entry.name, entry])
      );
      const episode = byName.get('update_forge_episode')?.autonomyRequirement;
      const lesson = byName.get('update_forge_lesson')?.autonomyRequirement;
      const proposal = byName.get('update_forge_task_proposal')?.autonomyRequirement;
      expect(typeof episode).toBe('function');
      expect(typeof lesson).toBe('function');
      expect(typeof proposal).toBe('function');
      if (
        typeof episode !== 'function' ||
        typeof lesson !== 'function' ||
        typeof proposal !== 'function'
      ) {
        throw new Error('forge autonomy resolvers missing');
      }
      expect(await episode({ episode_id: 'ep-1', status: 'accepted' })).toBe(
        SESSION_WRITE_AUTONOMY_LEVEL
      );
      expect(await episode({ episode_id: 'ep-1', status: 'dismissed' })).toBe(
        SESSION_WRITE_AUTONOMY_LEVEL
      );
      expect(await episode({ episode_id: 'ep-1', status: 'draft' })).toBe(1);
      expect(await episode({ episode_id: 'ep-1', title: 'Edited' })).toBe(1);
      expect(await lesson({ lesson_id: 'ls-1', status: 'dismissed' })).toBe(
        SESSION_WRITE_AUTONOMY_LEVEL
      );
      expect(await lesson({ lesson_id: 'ls-1', status: 'active' })).toBe(
        SESSION_WRITE_AUTONOMY_LEVEL
      );
      expect(await lesson({ lesson_id: 'ls-1', rule: 'Tightened' })).toBe(1);
      expect(await proposal({ proposal_id: 'pr-1', status: 'dismissed' })).toBe(
        SESSION_WRITE_AUTONOMY_LEVEL
      );
      expect(await proposal({ proposal_id: 'pr-1', status: 'accepted' })).toBe(
        SESSION_WRITE_AUTONOMY_LEVEL
      );
      expect(await proposal({ proposal_id: 'pr-1', title: 'Edited' })).toBe(1);

      ctx.db
        .prepare(
          `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
           allowed_models, session_ids, slug, status, created_at, updated_at)
           VALUES ('foreign-space', '/tmp/workspace-foreign', 'foreign-space', '', '', '', '[]', '[]', 'foreign-space', 'active', ?, ?)`
        )
        .run(Date.now(), Date.now());
      const foreignScope = ctx.evolutionRepo.createScope({
        spaceId: 'foreign-space',
        kind: 'project',
        name: 'Foreign scope',
        objective: 'foreign fixture',
      });
      const foreignActiveLesson = ctx.evolutionRepo.createLesson({
        scopeId: foreignScope.id,
        status: 'active',
        rule: 'Foreign rule',
        why: 'foreign fixture',
      });
      expect(await lesson({ lesson_id: foreignActiveLesson.id, rule: 'Cross-space probe' })).toBe(
        1
      );
      expect(await lesson({ lesson_id: 'missing-lesson', rule: 'Probe' })).toBe(1);

      expect(byName.get('apply_forge_rollup')?.autonomyRequirement).toBe(
        SESSION_WRITE_AUTONOMY_LEVEL
      );
      expect(byName.get('create_task_from_forge_proposal')?.autonomyRequirement).toBe(
        SESSION_WRITE_AUTONOMY_LEVEL
      );
      for (const entry of byName.values()) {
        if (entry.family !== 'forge') continue;
        if (
          ![
            'update_forge_episode',
            'update_forge_lesson',
            'update_forge_task_proposal',
            'create_task_from_forge_proposal',
            'apply_forge_rollup',
          ].includes(entry.name)
        ) {
          expect(entry.autonomyRequirement).toBeUndefined();
        }
      }
    } finally {
      ctx.db.close();
    }
  });
});

describe('createSpaceRegistryEntries — forge handler wiring', () => {
  test('round-trips every forge-family entry through its underlying handler', async () => {
    const ctx = makeCtx();
    try {
      const goal = ctx.goalRepo.create({
        spaceId: SPACE_ID,
        title: 'Fixture recurring goal',
        description: 'registry fixture',
        type: 'recurring',
      });
      const task = ctx.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Evidence task',
        description: '',
      });
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

      const byName = new Map(
        createSpaceRegistryEntries(ctx.config).map((entry) => [entry.name, entry])
      );
      const call = async (name: string, params: Record<string, unknown>) => {
        const entry = byName.get(name);
        if (!entry) throw new Error(`entry missing: ${name}`);
        const result = (await entry.handler(entry.paramsSchema.parse(params))) as {
          content: Array<{ text: string }>;
        };
        return JSON.parse(result.content[0].text) as Record<string, any>;
      };

      const goalScope = await call('create_forge_scope_from_goal', { goal_id: goal.id });
      expect(goalScope.success).toBe(true);
      const scopeId = (goalScope.scope as { id: string }).id;

      const noteEvidence = await call('add_forge_manual_note', {
        scope_id: scopeId,
        summary: 'Manual evidence via the registry',
      });
      expect(noteEvidence.success).toBe(true);
      const evidenceId = (noteEvidence.evidence as { id: string }).id;

      const episode = await call('create_forge_episode', {
        scope_id: scopeId,
        evidence_ids: [evidenceId],
        confirm_low_confidence: true,
      });
      expect(episode.success).toBe(true);
      const episodeId = (episode.episode as { id: string }).id;

      const lessons = await call('list_forge_lessons', { scope_id: scopeId });
      const lessonId = ((lessons.lessons as Array<{ id: string }>) ?? [])[0]?.id;

      const lessonResolver = byName.get('update_forge_lesson')?.autonomyRequirement;
      expect(typeof lessonResolver).toBe('function');
      if (typeof lessonResolver === 'function' && lessonId) {
        expect(await lessonResolver({ lesson_id: lessonId, rule: 'Candidate edit' })).toBe(1);
        expect(await lessonResolver({ lesson_id: lessonId, status: 'active' })).toBe(
          SESSION_WRITE_AUTONOMY_LEVEL
        );
        await call('update_forge_lesson', { lesson_id: lessonId, status: 'active' });
        expect(await lessonResolver({ lesson_id: lessonId, rule: 'Live-guidance edit' })).toBe(
          SESSION_WRITE_AUTONOMY_LEVEL
        );
      }

      const proposal = await call('create_forge_task_proposal', {
        scope_id: scopeId,
        title: 'Registry proposal',
        description: 'created via the registry',
        reason: 'round trip',
      });
      expect(proposal.success).toBe(true);
      const proposalId = (proposal.proposal as { id: string }).id;

      const cases: Array<{ name: string; params: Record<string, unknown>; success: boolean }> = [
        { name: 'list_forge_scopes', params: {}, success: true },
        {
          name: 'create_forge_scope',
          params: { kind: 'project', name: 'Standalone scope', objective: 'registry fixture' },
          success: true,
        },
        { name: 'create_forge_scope_from_goal', params: { goal_id: goal.id }, success: true },
        { name: 'get_forge_scope', params: { scope_id: scopeId }, success: true },
        {
          name: 'update_forge_scope',
          params: { scope_id: scopeId, name: 'Renamed scope' },
          success: true,
        },
        { name: 'get_forge_timeline', params: { scope_id: scopeId }, success: true },
        {
          name: 'add_forge_manual_note',
          params: { scope_id: scopeId, summary: 'Another note' },
          success: true,
        },
        {
          name: 'attach_forge_task_evidence',
          params: { task_id: task.id, scope_id: scopeId },
          success: true,
        },
        {
          name: 'attach_forge_workflow_run_evidence',
          params: { workflow_run_id: run.id, scope_id: scopeId },
          success: true,
        },
        {
          name: 'add_forge_metric_snapshot',
          params: { scope_id: scopeId, values: { coverage: 0.5 }, source: 'registry-test' },
          success: true,
        },
        { name: 'list_forge_evidence', params: { scope_id: scopeId }, success: true },
        { name: 'list_forge_metric_snapshots', params: { scope_id: scopeId }, success: true },
        {
          name: 'create_forge_episode',
          params: { scope_id: scopeId, evidence_ids: ['missing-evidence'] },
          success: false,
        },
        { name: 'list_forge_review_bundle', params: { scope_id: scopeId }, success: true },
        { name: 'list_forge_lessons', params: { scope_id: scopeId }, success: true },
        { name: 'list_forge_proposals', params: { scope_id: scopeId }, success: true },
        { name: 'resolve_forge_scope', params: { goal_id: goal.id }, success: true },
        {
          name: 'update_forge_episode',
          params: { episode_id: episodeId, title: 'Edited' },
          success: true,
        },
        {
          name: 'update_forge_lesson',
          params: { lesson_id: lessonId, status: 'active' },
          success: true,
        },
        {
          name: 'create_forge_task_proposal',
          params: {
            scope_id: scopeId,
            title: 'Second proposal',
            description: 'created via the registry',
            reason: 'round trip',
          },
          success: true,
        },
        {
          name: 'update_forge_task_proposal',
          params: { proposal_id: proposalId, title: 'Edited' },
          success: true,
        },
        {
          name: 'create_task_from_forge_proposal',
          params: { proposal_id: proposalId },
          success: true,
        },
        {
          name: 'apply_forge_rollup',
          params: { episode_id: episodeId, goal_update: { summary: 'Rolled up via the registry' } },
          success: true,
        },
      ];

      for (const { name, params, success } of cases) {
        const payload = await call(name, params);
        expect(payload.success).toBe(success);
      }
    } finally {
      ctx.db.close();
    }
  });
});
