import { describe, expect, test } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { SESSION_WRITE_AUTONOMY_LEVEL } from '../../../../src/lib/space/tools/tool-admission-gates.ts';
import {
  ListTasksSchema,
  SPACE_AGENT_TOOL_SCHEMAS,
  type SpaceAgentToolName,
} from '../../../../src/lib/space/tools/space-agent-tool-schemas.ts';
import { createActionRegistry } from '../../../../src/lib/space/actions/registry.ts';
import { createSpaceRegistryEntries } from '../../../../src/lib/space/actions/registry-space.ts';
import type { SpaceAgentToolsConfig } from '../../../../src/lib/space/tools/space-agent-tools.ts';

const SPACE_ID = 'space-registry-test';

const stubTaskAgentManager = {
  injectSubSessionMessage: async () => 'sdk-message-stub',
} as unknown as TaskAgentManager;

interface RegistryCtx {
  db: BunDatabase;
  config: SpaceAgentToolsConfig;
  workflowManager: SpaceWorkflowManager;
  workflowRunRepo: SpaceWorkflowRunRepository;
  taskRepo: SpaceTaskRepository;
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
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES ('agent-coder-1', ?, 'Coder', '', null, '[]', '', ?, ?)`
  ).run(SPACE_ID, Date.now(), Date.now());

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
    ...overrides,
  };
  return { db, config, workflowManager, workflowRunRepo, taskRepo };
}

const EXPECTED_ENTRIES: ReadonlyArray<readonly [string, string, string]> = [
  ['list_sessions', 'sessions', 'read'],
  ['get_session_detail', 'sessions', 'read'],
  ['get_session_messages', 'sessions', 'read'],
  ['send_session_message', 'sessions', 'mutate'],
  ['update_session_state', 'sessions', 'mutate'],
  ['interrupt_session', 'sessions', 'mutate'],
  ['list_workflows', 'workflows', 'read'],
  ['get_workflow_run', 'workflows', 'read'],
  ['change_plan', 'workflows', 'mutate'],
  ['get_workflow_detail', 'workflows', 'read'],
  ['suggest_workflow', 'workflows', 'read'],
  ['list_tasks', 'tasks', 'read'],
  ['create_standalone_task', 'tasks', 'mutate'],
  ['get_task_detail', 'tasks', 'read'],
  ['update_task', 'tasks', 'mutate'],
  ['retry_task', 'tasks', 'mutate'],
  ['cancel_task', 'tasks', 'mutate'],
  ['reassign_task', 'tasks', 'mutate'],
  ['publish_task', 'tasks', 'mutate'],
  ['archive_task', 'tasks', 'destructive'],
  ['send_message_to_task', 'tasks', 'mutate'],
  ['list_task_members', 'tasks', 'read'],
  ['approve_task', 'tasks', 'mutate'],
  ['approve_pending_completion', 'tasks', 'human_only'],
];

function names(entries: ReadonlyArray<{ name: string }>): string[] {
  return entries.map((entry) => entry.name);
}

describe('createSpaceRegistryEntries — composition', () => {
  test('builds the authored sessions/workflows/tasks entries in typed-surface order', () => {
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

  test('shares the schema objects with the typed server — one parse path', () => {
    const ctx = makeCtx();
    try {
      const entries = createSpaceRegistryEntries(ctx.config);
      expect(entries).toHaveLength(Object.keys(SPACE_AGENT_TOOL_SCHEMAS).length);
      for (const entry of entries) {
        expect(entry.paramsSchema).toBe(SPACE_AGENT_TOOL_SCHEMAS[entry.name as SpaceAgentToolName]);
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
      expect(registry.get('list_tasks')?.family).toBe('tasks');
      expect(registry.get('send_message_to_task')?.safetyClass).toBe('mutate');
    } finally {
      ctx.db.close();
    }
  });
});

describe('createSpaceRegistryEntries — autonomy requirements', () => {
  test('session writes carry the session-write autonomy level; reads carry none', () => {
    const ctx = makeCtx();
    try {
      const entries = createSpaceRegistryEntries(ctx.config);
      const byName = new Map(entries.map((entry) => [entry.name, entry]));
      for (const name of [
        'send_session_message',
        'update_session_state',
        'interrupt_session',
      ] as const) {
        expect(byName.get(name)?.autonomyRequirement).toBe(SESSION_WRITE_AUTONOMY_LEVEL);
      }
      for (const [name] of EXPECTED_ENTRIES) {
        if (name === 'approve_task') continue;
        if (['send_session_message', 'update_session_state', 'interrupt_session'].includes(name))
          continue;
        expect(byName.get(name)?.autonomyRequirement).toBeUndefined();
      }
    } finally {
      ctx.db.close();
    }
  });

  test('approve_task resolves the workflow completionAutonomyLevel with default 5', async () => {
    const ctx = makeCtx();
    try {
      const workflow = ctx.workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: 'Completion 3',
        nodes: [{ name: 'Work', agents: [{ agentId: 'agent-coder-1', name: 'Coder' }] }],
        tags: [],
        completionAutonomyLevel: 3,
      });
      const run = ctx.workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Run',
      });
      const workflowTask = ctx.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Workflow task',
        description: '',
        workflowRunId: run.id,
      });
      const standaloneTask = ctx.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Standalone task',
        description: '',
      });

      const entries = createSpaceRegistryEntries(ctx.config);
      const resolve = entries.find((entry) => entry.name === 'approve_task')?.autonomyRequirement;
      expect(typeof resolve).toBe('function');
      if (typeof resolve === 'function') {
        expect(await resolve({ task_id: workflowTask.id })).toBe(3);
        expect(await resolve({ task_id: standaloneTask.id })).toBe(5);
        expect(await resolve({ task_id: 'missing-task' })).toBe(5);
      }
    } finally {
      ctx.db.close();
    }
  });
});

describe('createSpaceRegistryEntries — conditional entries', () => {
  test('omits every sessions entry when db is absent', () => {
    const ctx = makeCtx({ db: undefined });
    try {
      const entries = createSpaceRegistryEntries(ctx.config);
      expect(entries.filter((entry) => entry.family === 'sessions')).toEqual([]);
      expect(entries).toHaveLength(EXPECTED_ENTRIES.length - 6);
      expect(names(entries)).toContain('list_tasks');
    } finally {
      ctx.db.close();
    }
  });

  test('omits send_message_to_task when taskAgentManager is absent', () => {
    const ctx = makeCtx({ taskAgentManager: undefined });
    try {
      const entries = createSpaceRegistryEntries(ctx.config);
      expect(names(entries)).not.toContain('send_message_to_task');
      expect(entries).toHaveLength(EXPECTED_ENTRIES.length - 1);
      expect(names(entries)).toContain('list_sessions');
    } finally {
      ctx.db.close();
    }
  });
});

describe('createSpaceRegistryEntries — handler wiring', () => {
  test('dispatches through the underlying typed handlers', async () => {
    const ctx = makeCtx();
    try {
      const created = ctx.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Wired task',
        description: '',
      });
      const entries = createSpaceRegistryEntries(ctx.config);
      const listTasks = entries.find((entry) => entry.name === 'list_tasks');
      const listWorkflows = entries.find((entry) => entry.name === 'list_workflows');
      if (!listTasks || !listWorkflows) throw new Error('core entries missing');

      const taskResult = (await listTasks.handler(ListTasksSchema.parse({}))) as {
        content: Array<{ text: string }>;
      };
      const taskPayload = JSON.parse(taskResult.content[0].text) as {
        success: boolean;
        tasks: Array<{ id: string; title: string }>;
      };
      expect(taskPayload.success).toBe(true);
      expect(taskPayload.tasks.map((task) => task.id)).toContain(created.id);

      const workflowResult = (await listWorkflows.handler({})) as {
        content: Array<{ text: string }>;
      };
      const workflowPayload = JSON.parse(workflowResult.content[0].text) as {
        success: boolean;
        workflows: unknown[];
      };
      expect(workflowPayload.success).toBe(true);
      expect(workflowPayload.workflows).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });
});
