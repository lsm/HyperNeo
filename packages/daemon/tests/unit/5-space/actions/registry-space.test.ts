import { describe, expect, test } from 'bun:test';
import { createActionRegistry } from '../../../../src/lib/space/actions/registry.ts';
import { createSpaceRegistryEntries } from '../../../../src/lib/space/actions/registry-space.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import {
  ReviewGoalOutcomeSchema,
  SPACE_AGENT_LIFECYCLE_TOOL_SCHEMAS,
  SPACE_FORGE_TOOL_SCHEMAS,
  SPACE_GOAL_TOOL_SCHEMAS,
} from '../../../../src/lib/space/tools/space-agent-tool-schemas.ts';
import type { SpaceAgentToolsConfig } from '../../../../src/lib/space/tools/space-agent-tools.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const SPACE_ID = 'space-registry-test';

const stubTaskAgentManager = {
  injectSubSessionMessage: async () => 'sdk-message-stub',
} as unknown as TaskAgentManager;

const stubGoalService = {} as unknown as SpaceAgentToolsConfig['goalService'];
const stubEvolutionScopeService = {} as unknown as SpaceAgentToolsConfig['evolutionScopeService'];
const stubEvolutionEpisodeService =
  {} as unknown as SpaceAgentToolsConfig['evolutionEpisodeService'];

interface RegistryCtx {
  db: BunDatabase;
  config: SpaceAgentToolsConfig;
}

function makeCtx(overrides: Partial<SpaceAgentToolsConfig> = {}): RegistryCtx {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, '/tmp/workspace', ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(SPACE_ID, SPACE_ID, SPACE_ID, Date.now(), Date.now());

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
    goalService: stubGoalService,
    evolutionScopeService: stubEvolutionScopeService,
    evolutionEpisodeService: stubEvolutionEpisodeService,
    callerRole: 'coordinator',
    ...overrides,
  };
  return { db, config };
}

const EXPECTED_ENTRIES: ReadonlyArray<readonly [string, string, string]> = [
  ['list_agents', 'agents', 'read'],
  ['get_agent', 'agents', 'read'],
  ['create_agent', 'agents', 'mutate'],
  ['create_agent_from_template', 'agents', 'mutate'],
  ['list_agent_templates', 'agents', 'read'],
  ['update_agent', 'agents', 'mutate'],
  ['pause_agent', 'agents', 'mutate'],
  ['archive_agent', 'agents', 'mutate'],
  ['assign_agent_to_goal', 'agents', 'mutate'],
  ['unassign_agent_from_goal', 'agents', 'mutate'],
  ['assign_agent_to_forge_scope', 'agents', 'mutate'],
  ['unassign_agent_from_forge_scope', 'agents', 'mutate'],
  ['create_agent_reminder', 'agents', 'mutate'],
  ['list_agent_reminders', 'agents', 'read'],
  ['subscribe_agent_event', 'agents', 'mutate'],
  ['unsubscribe_agent_event', 'agents', 'mutate'],
  ['list_agent_event_subscriptions', 'agents', 'read'],
  ['list_goals', 'goals', 'read'],
  ['get_goal', 'goals', 'read'],
  ['create_goal', 'goals', 'mutate'],
  ['update_goal', 'goals', 'mutate'],
  ['pause_goal', 'goals', 'mutate'],
  ['resume_goal', 'goals', 'mutate'],
  ['trigger_goal_task', 'goals', 'mutate'],
  ['list_goal_tasks', 'goals', 'read'],
  ['list_goal_events', 'goals', 'read'],
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
  ['review_goal_outcome', 'goals', 'mutate'],
];

describe('createSpaceRegistryEntries — composition', () => {
  test('builds the authored agents/goals/Forge entries in typed-surface order', () => {
    const ctx = makeCtx();
    try {
      const entries = createSpaceRegistryEntries(ctx.config);
      expect(entries.map((entry) => [entry.name, entry.family, entry.safetyClass])).toEqual(
        EXPECTED_ENTRIES
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
      const entries = createSpaceRegistryEntries(ctx.config);
      expect(entries).toHaveLength(EXPECTED_ENTRIES.length);
      for (const entry of entries) {
        const expected =
          SPACE_AGENT_LIFECYCLE_TOOL_SCHEMAS[
            entry.name as keyof typeof SPACE_AGENT_LIFECYCLE_TOOL_SCHEMAS
          ] ??
          SPACE_GOAL_TOOL_SCHEMAS[entry.name as keyof typeof SPACE_GOAL_TOOL_SCHEMAS] ??
          SPACE_FORGE_TOOL_SCHEMAS[entry.name as keyof typeof SPACE_FORGE_TOOL_SCHEMAS] ??
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
      expect(registry.entries).toHaveLength(EXPECTED_ENTRIES.length);
      expect(registry.get('list_agents')?.family).toBe('agents');
      expect(registry.get('archive_forge_scope' as string)).toBeUndefined();
    } finally {
      ctx.db.close();
    }
  });
});

describe('createSpaceRegistryEntries — conditional entries', () => {
  test('omits every agents entry when db is absent', () => {
    const ctx = makeCtx({ db: undefined });
    try {
      const entries = createSpaceRegistryEntries(ctx.config);
      expect(entries.filter((entry) => entry.family === 'agents')).toEqual([]);
      expect(entries).toHaveLength(EXPECTED_ENTRIES.length - 17);
    } finally {
      ctx.db.close();
    }
  });

  test('omits the nine goal entries when goalService is absent; review_goal_outcome follows only the caller role', () => {
    const ctx = makeCtx({ goalService: undefined });
    try {
      const entries = createSpaceRegistryEntries(ctx.config);
      expect(
        entries.filter((entry) => entry.name !== 'review_goal_outcome' && entry.family === 'goals')
      ).toEqual([]);
      expect(entries.some((entry) => entry.name === 'review_goal_outcome')).toBe(true);
      expect(entries).toHaveLength(EXPECTED_ENTRIES.length - 9);
    } finally {
      ctx.db.close();
    }
  });

  test('omits every forge entry when evolution services are absent', () => {
    const ctx = makeCtx({
      evolutionScopeService: undefined,
      evolutionEpisodeService: undefined,
    });
    try {
      const entries = createSpaceRegistryEntries(ctx.config);
      expect(entries.filter((entry) => entry.family === 'forge')).toEqual([]);
      expect(entries).toHaveLength(EXPECTED_ENTRIES.length - 23);
    } finally {
      ctx.db.close();
    }
  });

  test('keeps goals but drops review_goal_outcome for non-owning caller roles', () => {
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
    } finally {
      ctx.db.close();
    }
  });
});

describe('createSpaceRegistryEntries — handler wiring', () => {
  test('dispatches through the underlying typed handlers', async () => {
    const ctx = makeCtx();
    try {
      const entries = createSpaceRegistryEntries(ctx.config);
      const listAgentTemplates = entries.find((entry) => entry.name === 'list_agent_templates');
      if (!listAgentTemplates) throw new Error('core entry missing');

      const result = (await listAgentTemplates.handler({})) as {
        content: Array<{ text: string }>;
      };
      const payload = JSON.parse(result.content[0].text) as {
        success: boolean;
        presets: Array<{ template_name: string }>;
      };
      expect(payload.success).toBe(true);
      expect(payload.presets.length).toBeGreaterThan(0);
    } finally {
      ctx.db.close();
    }
  });
});
