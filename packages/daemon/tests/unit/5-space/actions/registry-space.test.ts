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
  return { db, config, workflowManager };
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
  ['change_plan', 'workflows', 'destructive'],
  ['get_workflow_detail', 'workflows', 'read'],
  ['suggest_workflow', 'workflows', 'read'],
];

describe('createSpaceRegistryEntries — composition', () => {
  test('builds the authored sessions/workflows entries in typed-surface order', () => {
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
      expect(registry.get('interrupt_session')?.safetyClass).toBe('mutate');
    } finally {
      ctx.db.close();
    }
  });

  test('state writes carry static level 4; send_session_message gates conditionally in its handler', () => {
    const ctx = makeCtx();
    try {
      const byName = new Map(
        createSpaceRegistryEntries(ctx.config).map((entry) => [entry.name, entry])
      );
      for (const name of ['update_session_state', 'interrupt_session']) {
        expect(byName.get(name)?.autonomyRequirement).toBe(SESSION_WRITE_AUTONOMY_LEVEL);
      }
      expect(byName.get('send_session_message')?.autonomyRequirement).toBeUndefined();
      for (const [name] of EXPECTED_ENTRIES) {
        if (['update_session_state', 'interrupt_session'].includes(name)) continue;
        expect(byName.get(name)?.autonomyRequirement).toBeUndefined();
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
      expect(entries.every((entry) => entry.family === 'workflows')).toBe(true);
    } finally {
      ctx.db.close();
    }
  });

  test('keeps every entry when taskAgentManager is absent — the gate targets task-family actions', () => {
    const ctx = makeCtx({ taskAgentManager: undefined });
    try {
      const entries = createSpaceRegistryEntries(ctx.config);
      expect(entries.map((entry) => entry.name)).toEqual(EXPECTED_ENTRIES.map(([name]) => name));
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
});
