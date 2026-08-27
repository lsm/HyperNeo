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
  SPACE_AGENT_TOOL_SCHEMAS,
  type SpaceAgentToolName,
  UpdateSessionStateSchema,
} from '../../../../src/lib/space/tools/space-agent-tool-schemas.ts';
import type { SpaceAgentToolsConfig } from '../../../../src/lib/space/tools/space-agent-tools.ts';
import { SESSION_WRITE_AUTONOMY_LEVEL } from '../../../../src/lib/space/tools/tool-admission-gates.ts';
import type { McpAuditLogRepository } from '../../../../src/storage/repositories/mcp-audit-log-repository.ts';
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
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    workspace_path TEXT,
    created_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    status TEXT NOT NULL,
    config TEXT NOT NULL,
    metadata TEXT NOT NULL,
    is_worktree INTEGER DEFAULT 0,
    worktree_path TEXT,
    main_repo_path TEXT,
    worktree_branch TEXT,
    git_branch TEXT,
    sdk_session_id TEXT,
    acp_session_id TEXT,
    sdk_origin_path TEXT,
    available_commands TEXT,
    processing_state TEXT,
    archived_at TEXT,
    parent_id TEXT,
    type TEXT DEFAULT 'worker',
    session_context TEXT,
    room_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.roomId') END) VIRTUAL,
    space_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.spaceId') END) VIRTUAL,
    task_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.taskId') END) VIRTUAL
  )`);
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
  ['interrupt_session', 'sessions', 'destructive'],
  ['list_workflows', 'workflows', 'read'],
  ['get_workflow_run', 'workflows', 'read'],
  ['change_plan', 'workflows', 'destructive'],
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
      expect(entries).toHaveLength(EXPECTED_ENTRIES.length);
      expect(EXPECTED_ENTRIES.length).toBe(Object.keys(SPACE_AGENT_TOOL_SCHEMAS).length);
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
      expect(registry.get('list_workflows')?.family).toBe('workflows');
      expect(registry.get('interrupt_session')?.safetyClass).toBe('destructive');
      expect(registry.get('list_tasks')?.family).toBe('tasks');
      expect(registry.get('archive_task')?.safetyClass).toBe('destructive');
      expect(registry.get('approve_pending_completion')?.safetyClass).toBe('human_only');
    } finally {
      ctx.db.close();
    }
  });

  test('destructive entries and human_only approval carry clearance; plain reads and writes gate in their handlers', () => {
    const ctx = makeCtx();
    try {
      const byName = new Map(
        createSpaceRegistryEntries(ctx.config).map((entry) => [entry.name, entry])
      );
      for (const name of [
        'update_session_state',
        'interrupt_session',
        'archive_task',
        'change_plan',
      ]) {
        expect(byName.get(name)?.autonomyRequirement).toBe(SESSION_WRITE_AUTONOMY_LEVEL);
      }
      expect(byName.get('approve_pending_completion')?.autonomyRequirement).toBe(5);
      expect(byName.get('send_session_message')?.autonomyRequirement).toBeUndefined();
      for (const [name] of EXPECTED_ENTRIES) {
        if (
          [
            'update_session_state',
            'interrupt_session',
            'archive_task',
            'change_plan',
            'update_task',
            'cancel_task',
            'approve_task',
            'approve_pending_completion',
          ].includes(name)
        )
          continue;
        expect(byName.get(name)?.autonomyRequirement).toBeUndefined();
      }
    } finally {
      ctx.db.close();
    }
  });

  test('update_task requires archive clearance only for the archived transition', async () => {
    const ctx = makeCtx();
    try {
      const entries = createSpaceRegistryEntries(ctx.config);
      const resolve = entries.find((entry) => entry.name === 'update_task')?.autonomyRequirement;
      expect(typeof resolve).toBe('function');
      if (typeof resolve === 'function') {
        expect(await resolve({ task_id: 'task-1', status: 'archived' })).toBe(
          SESSION_WRITE_AUTONOMY_LEVEL
        );
        expect(await resolve({ task_id: 'task-1', status: 'blocked' })).toBe(1);
        expect(await resolve({ task_id: 'task-1', title: 'Edited' })).toBe(1);
      }
    } finally {
      ctx.db.close();
    }
  });

  test('cancel_task requires workflow-run clearance only when cancel_workflow_run is set', async () => {
    const ctx = makeCtx();
    try {
      const entries = createSpaceRegistryEntries(ctx.config);
      const resolve = entries.find((entry) => entry.name === 'cancel_task')?.autonomyRequirement;
      expect(typeof resolve).toBe('function');
      if (typeof resolve === 'function') {
        expect(await resolve({ task_id: 'task-1', cancel_workflow_run: true })).toBe(
          SESSION_WRITE_AUTONOMY_LEVEL
        );
        expect(await resolve({ task_id: 'task-1' })).toBe(1);
        expect(await resolve({ task_id: 'task-1', cancel_workflow_run: false })).toBe(1);
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
      expect(entries.map((entry) => entry.name)).toContain('list_tasks');
    } finally {
      ctx.db.close();
    }
  });

  test('omits send_message_to_task when taskAgentManager is absent', () => {
    const ctx = makeCtx({ taskAgentManager: undefined });
    try {
      const entries = createSpaceRegistryEntries(ctx.config);
      expect(entries.map((entry) => entry.name)).not.toContain('send_message_to_task');
      expect(entries).toHaveLength(EXPECTED_ENTRIES.length - 1);
      expect(entries.map((entry) => entry.name)).toContain('list_sessions');
    } finally {
      ctx.db.close();
    }
  });
});

describe('createSpaceRegistryEntries — handler wiring', () => {
  test('registry-dispatched handlers write no legacy audit rows — audit belongs to the dispatcher choke point', async () => {
    const auditRows: Array<Record<string, unknown>> = [];
    const auditLogRepo = {
      createEntry: (entry: Record<string, unknown>) => {
        auditRows.push(entry);
      },
    } as unknown as McpAuditLogRepository;
    const ctx = makeCtx({ auditLogRepo, getSpaceAutonomyLevel: async () => 5 });
    try {
      const now = new Date().toISOString();
      ctx.db
        .prepare(
          `INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata, session_context)
           VALUES ('sess-1', 'Stuck', ?, ?, 'active', '{}', '{}', ?)`
        )
        .run(now, now, JSON.stringify({ spaceId: SPACE_ID }));

      const entries = createSpaceRegistryEntries(ctx.config);
      const updateSessionState = entries.find((entry) => entry.name === 'update_session_state');
      if (!updateSessionState) throw new Error('update_session_state entry missing');
      const result = (await updateSessionState.handler(
        UpdateSessionStateSchema.parse({ session_id: 'sess-1', processing_state: 'running' })
      )) as { content: Array<{ text: string }> };
      const payload = JSON.parse(result.content[0].text) as { success: boolean; updated: boolean };

      expect(payload.success).toBe(true);
      expect(payload.updated).toBe(true);
      expect(auditRows).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });

  test('dispatches through the underlying typed handlers', async () => {
    const ctx = makeCtx();
    try {
      const workflow = ctx.workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: 'Round trip',
        nodes: [{ name: 'Work', agents: [{ agentId: 'agent-coder-1', name: 'Coder' }] }],
        tags: [],
      });
      const entries = createSpaceRegistryEntries(ctx.config);
      const listWorkflows = entries.find((entry) => entry.name === 'list_workflows');
      const getWorkflowDetail = entries.find((entry) => entry.name === 'get_workflow_detail');
      if (!listWorkflows || !getWorkflowDetail) throw new Error('core entries missing');

      const listResult = (await listWorkflows.handler({})) as {
        content: Array<{ text: string }>;
      };
      const listPayload = JSON.parse(listResult.content[0].text) as {
        success: boolean;
        workflows: Array<{ id: string }>;
      };
      expect(listPayload.success).toBe(true);
      expect(listPayload.workflows.map((wf) => wf.id)).toContain(workflow.id);

      const detailResult = (await getWorkflowDetail.handler({ workflow_id: workflow.id })) as {
        content: Array<{ text: string }>;
      };
      const detailPayload = JSON.parse(detailResult.content[0].text) as {
        success: boolean;
        workflow: { id: string };
      };
      expect(detailPayload.success).toBe(true);
      expect(detailPayload.workflow.id).toBe(workflow.id);
    } finally {
      ctx.db.close();
    }
  });

  test('round-trips every tasks-family entry through its underlying handler', async () => {
    const ctx = makeCtx();
    try {
      const draftTask = ctx.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Draft',
        description: '',
        status: 'draft',
      });
      const openTask = ctx.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Open',
        description: 'Standalone open task',
      });
      const cancelTarget = ctx.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Cancel me',
        description: '',
      });
      const retryTarget = ctx.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Not retryable',
        description: '',
      });
      const reassignTarget = ctx.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Reassign me',
        description: '',
      });
      const archiveTarget = ctx.taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Archive me',
        description: '',
      });

      const entries = createSpaceRegistryEntries(ctx.config);
      const byName = new Map(entries.map((entry) => [entry.name, entry]));
      const cases: Array<{ name: string; params: Record<string, unknown>; success: boolean }> = [
        { name: 'list_tasks', params: {}, success: true },
        {
          name: 'create_standalone_task',
          params: { title: 'Round trip', description: 'created via the registry' },
          success: true,
        },
        { name: 'get_task_detail', params: { task_id: openTask.id }, success: true },
        {
          name: 'update_task',
          params: { task_id: openTask.id, title: 'Open (edited)' },
          success: true,
        },
        { name: 'retry_task', params: { task_id: retryTarget.id }, success: false },
        { name: 'cancel_task', params: { task_id: cancelTarget.id }, success: true },
        {
          name: 'reassign_task',
          params: { task_id: reassignTarget.id, custom_agent_id: 'agent-coder-1' },
          success: true,
        },
        { name: 'publish_task', params: { task_id: draftTask.id }, success: true },
        { name: 'archive_task', params: { task_id: archiveTarget.id }, success: true },
        {
          name: 'send_message_to_task',
          params: { task_id: openTask.id, message: 'ping', node_id: 'coder' },
          success: false,
        },
        { name: 'list_task_members', params: { task_id: openTask.id }, success: true },
        { name: 'approve_task', params: { task_id: openTask.id }, success: false },
        {
          name: 'approve_pending_completion',
          params: { task_id: openTask.id, approved: true },
          success: false,
        },
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
