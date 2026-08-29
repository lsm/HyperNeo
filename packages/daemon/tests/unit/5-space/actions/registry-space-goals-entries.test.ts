import { describe, expect, test } from 'bun:test';
import { createActionRegistry } from '../../../../src/lib/space/actions/registry.ts';
import { createSpaceRegistryEntries } from '../../../../src/lib/space/actions/registry-space.ts';
import { SpaceGoalService } from '../../../../src/lib/space/goals/goal-service.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { ScheduleService } from '../../../../src/lib/space/schedule/schedule-service.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import {
  ReviewGoalOutcomeSchema,
  SPACE_GOAL_TOOL_SCHEMAS,
} from '../../../../src/lib/space/tools/space-agent-tool-schemas.ts';
import type { SpaceAgentToolsConfig } from '../../../../src/lib/space/tools/space-agent-tools.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
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
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const SPACE_ID = 'space-registry-goals-test';

const stubTaskAgentManager = {
  injectSubSessionMessage: async () => 'sdk-message-stub',
} as unknown as TaskAgentManager;

interface GoalsCtx {
  db: BunDatabase;
  config: SpaceAgentToolsConfig;
}

function makeCtx(overrides: Partial<SpaceAgentToolsConfig> = {}): GoalsCtx {
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
    callerRole: 'coordinator',
    ...overrides,
  };
  return { db, config };
}

const GOAL_ENTRIES: ReadonlyArray<readonly [string, string, string]> = [
  ['list_goals', 'goals', 'read'],
  ['get_goal', 'goals', 'read'],
  ['create_goal', 'goals', 'mutate'],
  ['update_goal', 'goals', 'mutate'],
  ['pause_goal', 'goals', 'mutate'],
  ['resume_goal', 'goals', 'mutate'],
  ['trigger_goal_task', 'goals', 'mutate'],
  ['list_goal_tasks', 'goals', 'read'],
  ['list_goal_events', 'goals', 'read'],
  ['review_goal_outcome', 'goals', 'mutate'],
];

describe('createSpaceRegistryEntries — goals composition', () => {
  test('builds the authored goals-family entries in typed-surface order after the base families', () => {
    const ctx = makeCtx();
    try {
      const entries = createSpaceRegistryEntries(ctx.config);
      expect(
        entries
          .filter((entry) => entry.family === 'goals')
          .map((entry) => [entry.name, entry.family, entry.safetyClass])
      ).toEqual(GOAL_ENTRIES);
      expect(entries.slice(-GOAL_ENTRIES.length).map((entry) => entry.name)).toEqual(
        GOAL_ENTRIES.map(([name]) => name)
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
        (entry) => entry.family === 'goals'
      );
      expect(entries).toHaveLength(GOAL_ENTRIES.length);
      for (const entry of entries) {
        const expected =
          SPACE_GOAL_TOOL_SCHEMAS[entry.name as keyof typeof SPACE_GOAL_TOOL_SCHEMAS] ??
          (entry.name === 'review_goal_outcome' ? ReviewGoalOutcomeSchema : undefined);
        expect(expected).toBeDefined();
        expect(entry.paramsSchema).toBe(expected);
      }
    } finally {
      ctx.db.close();
    }
  });

  test('composes into a valid action registry', () => {
    const ctx = makeCtx();
    try {
      const registry = createActionRegistry(createSpaceRegistryEntries(ctx.config));
      expect(registry.get('list_goals')?.family).toBe('goals');
      expect(registry.get('review_goal_outcome')?.safetyClass).toBe('mutate');
      expect(registry.get('archive_goal' as string)).toBeUndefined();
    } finally {
      ctx.db.close();
    }
  });
});

describe('createSpaceRegistryEntries — goals conditional entries', () => {
  test('omits the nine goal entries when goalService is absent; review_goal_outcome follows only the caller role', () => {
    const ctx = makeCtx({ goalService: undefined });
    try {
      const entries = createSpaceRegistryEntries(ctx.config);
      expect(
        entries.filter((entry) => entry.name !== 'review_goal_outcome' && entry.family === 'goals')
      ).toEqual([]);
      expect(entries.some((entry) => entry.name === 'review_goal_outcome')).toBe(true);
      expect(entries.filter((entry) => entry.family === 'goals')).toHaveLength(1);
    } finally {
      ctx.db.close();
    }
  });

  test('review_goal_outcome reports goal management unavailable at call time when goalService is absent', async () => {
    const ctx = makeCtx({ goalService: undefined });
    try {
      const entry = createSpaceRegistryEntries(ctx.config).find(
        (candidate) => candidate.name === 'review_goal_outcome'
      );
      if (!entry) throw new Error('review_goal_outcome entry missing');
      const result = (await entry.handler(ReviewGoalOutcomeSchema.parse({}))) as {
        content: Array<{ text: string }>;
      };
      const payload = JSON.parse(result.content[0].text) as {
        success: boolean;
        error: string;
      };
      expect(payload.success).toBe(false);
      expect(payload.error).toBe('Goal management not available');
    } finally {
      ctx.db.close();
    }
  });

  test('keeps the nine goal entries but drops review_goal_outcome for non-owning caller roles', () => {
    for (const callerRole of ['ad_hoc_member', 'workflow_worker', undefined] as const) {
      const ctx = makeCtx({ callerRole });
      try {
        const entries = createSpaceRegistryEntries(ctx.config);
        expect(entries.some((entry) => entry.name === 'review_goal_outcome')).toBe(false);
        expect(entries.filter((entry) => entry.family === 'goals')).toHaveLength(9);
      } finally {
        ctx.db.close();
      }
    }
  });

  test('includes review_goal_outcome for long_term_agent callers', () => {
    const ctx = makeCtx({ callerRole: 'long_term_agent' });
    try {
      const entries = createSpaceRegistryEntries(ctx.config);
      expect(entries.some((entry) => entry.name === 'review_goal_outcome')).toBe(true);
      expect(entries.filter((entry) => entry.family === 'goals')).toHaveLength(10);
    } finally {
      ctx.db.close();
    }
  });
});

describe('createSpaceRegistryEntries — goals handler wiring', () => {
  test('round-trips every goals-family entry through its underlying handler', async () => {
    const ctx = makeCtx();
    try {
      const byName = new Map(
        createSpaceRegistryEntries(ctx.config).map((entry) => [entry.name, entry])
      );

      const createGoal = byName.get('create_goal');
      if (!createGoal) throw new Error('create_goal entry missing');
      const created = (await createGoal.handler(
        createGoal.paramsSchema.parse({ title: 'Fixture goal', description: 'registry fixture' })
      )) as { content: Array<{ text: string }> };
      const createdPayload = JSON.parse(created.content[0].text) as {
        success: boolean;
        goal: { id: string };
      };
      expect(createdPayload.success).toBe(true);
      const goalId = createdPayload.goal.id;

      const cases: Array<{ name: string; params: Record<string, unknown>; success: boolean }> = [
        { name: 'list_goals', params: {}, success: true },
        { name: 'get_goal', params: { goal_id: goalId }, success: true },
        {
          name: 'update_goal',
          params: { goal_id: goalId, summary: 'Updated via the registry' },
          success: true,
        },
        { name: 'pause_goal', params: { goal_id: goalId }, success: true },
        { name: 'resume_goal', params: { goal_id: goalId }, success: true },
        { name: 'trigger_goal_task', params: { goal_id: goalId }, success: true },
        { name: 'list_goal_tasks', params: { goal_id: goalId }, success: true },
        { name: 'list_goal_events', params: { goal_id: goalId }, success: true },
        { name: 'review_goal_outcome', params: {}, success: true },
      ];

      for (const { name, params, success } of cases) {
        const entry = byName.get(name);
        if (!entry) throw new Error(`entry missing: ${name}`);
        const result = (await entry.handler(entry.paramsSchema.parse(params))) as {
          content: Array<{ text: string }>;
        };
        const payload = JSON.parse(result.content[0].text) as { success: boolean };
        expect(payload.success).toBe(success);
      }
    } finally {
      ctx.db.close();
    }
  });
});
