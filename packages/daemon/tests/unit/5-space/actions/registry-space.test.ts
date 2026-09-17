import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createActionRegistry } from '../../../../src/lib/space/actions/registry.ts';
import { createSpaceRegistryEntries } from '../../../../src/lib/space/actions/registry-space.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/tasks/task-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/workflows/workflow-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import {
  ListAgentEventSubscriptionsSchema,
  SubscribeAgentEventSchema,
  UnsubscribeAgentEventSchema,
} from '../../../../src/lib/space/actions/space-agent-schemas.ts';
import type { SpaceAgentToolsConfig } from '../../../../src/lib/space/actions/space-handlers.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentReminderRepository } from '../../../../src/storage/repositories/space-agent-reminder-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentSubscriptionRepository } from '../../../../src/storage/repositories/space-agent-subscription-repository.ts';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { seedWorkerMirror } from '../../helpers/seed-worker-mirror';

const SPACE_ID = 'space-registry-test';

const stubTaskAgentManager = {
  injectSubSessionMessage: async () => 'sdk-message-stub',
  getLiveSubSessionIdsForTasks: () => [],
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
  seedWorkerMirror(db, { id: 'agent-coder-1', spaceId: SPACE_ID, name: 'Coder' });

  const workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
  const workflowRunRepo = new SpaceWorkflowRunRepository(db);
  const nodeExecutionRepo = new NodeExecutionRepository(db);
  const taskRepo = new SpaceTaskRepository(db);
  const spaceManager = new SpaceManager(db);
  const longHorizonAgentRepo = new SpaceLongHorizonAgentRepository(db);
  const subscriptionRepo = new SpaceAgentSubscriptionRepository(db, new SpaceAgentRepository(db));
  const reminderRepo = new SpaceAgentReminderRepository(db, new SpaceAgentRepository(db));
  const runtime = new SpaceRuntime({
    db,
    spaceManager,
    spaceWorkflowManager: workflowManager,
    workflowRunRepo,
    taskRepo,
    nodeExecutionRepo,
    longHorizonAgentRepo,
    subscriptionRepo,
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
    taskAgentManager: stubTaskAgentManager,
    longHorizonAgentRepo,
    subscriptionRepo,
    reminderRepo,
    ...overrides,
  };
  return { db, config, workflowManager, workflowRunRepo, taskRepo };
}

const EXPECTED_ENTRIES: ReadonlyArray<readonly [string, string, string]> = [
  ['subscribe_agent_event', 'agents', 'mutate'],
  ['unsubscribe_agent_event', 'agents', 'mutate'],
  ['list_agent_event_subscriptions', 'agents', 'read'],
];

const SCHEMA_BY_NAME: Record<string, z.ZodType<unknown>> = {
  subscribe_agent_event: SubscribeAgentEventSchema,
  unsubscribe_agent_event: UnsubscribeAgentEventSchema,
  list_agent_event_subscriptions: ListAgentEventSubscriptionsSchema,
};

describe('createSpaceRegistryEntries — composition', () => {
  test('builds the surviving subscription entries in authored order', () => {
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

  test('shares the schema objects with the authored surface — one parse path', () => {
    const ctx = makeCtx();
    try {
      const entries = createSpaceRegistryEntries(ctx.config);
      expect(entries).toHaveLength(EXPECTED_ENTRIES.length);
      for (const entry of entries) {
        expect(SCHEMA_BY_NAME[entry.name]).toBeDefined();
        expect(entry.paramsSchema).toBe(SCHEMA_BY_NAME[entry.name]);
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
      expect(registry.get('subscribe_agent_event')?.safetyClass).toBe('mutate');
      expect(registry.get('list_agent_event_subscriptions')?.family).toBe('agents');
      expect(registry.get('create_agent_template')).toBeUndefined();
      expect(registry.get('list_agent_templates')).toBeUndefined();
      expect(registry.get('delete_agent_template')).toBeUndefined();
      expect(registry.get('list_agents')).toBeUndefined();
      expect(registry.get('list_workflows')).toBeUndefined();
      expect(registry.get('approve_task')).toBeUndefined();
    } finally {
      ctx.db.close();
    }
  });

  test('no entry carries clearance; the survivors gate in their handlers', () => {
    const ctx = makeCtx();
    try {
      const byName = new Map(
        createSpaceRegistryEntries(ctx.config).map((entry) => [entry.name, entry])
      );
      for (const [name] of EXPECTED_ENTRIES) {
        expect(byName.get(name)?.autonomyRequirement).toBeUndefined();
      }
    } finally {
      ctx.db.close();
    }
  });
});

describe('createSpaceRegistryEntries — conditional entries', () => {
  test('omits every entry when db is absent', () => {
    const ctx = makeCtx({ db: undefined });
    try {
      expect(createSpaceRegistryEntries(ctx.config)).toEqual([]);
    } finally {
      ctx.db.close();
    }
  });
});

describe('createSpaceRegistryEntries — handler wiring', () => {
  test('round-trips the surviving entries through their underlying handlers', async () => {
    const ctx = makeCtx();
    try {
      const repo = ctx.config.longHorizonAgentRepo;
      if (!repo) throw new Error('longHorizonAgentRepo missing');
      const seeded = repo.create({
        spaceId: SPACE_ID,
        handle: '@registry-agent',
        displayName: 'Registry Agent',
      });

      const entries = createSpaceRegistryEntries(ctx.config);
      const byName = new Map(entries.map((entry) => [entry.name, entry]));
      const cases: Array<{ name: string; params: Record<string, unknown>; success: boolean }> = [
        {
          name: 'subscribe_agent_event',
          params: { agent_id: seeded.id, topic_pattern: 'github/*/*/pull_request/*' },
          success: true,
        },
        {
          name: 'list_agent_event_subscriptions',
          params: { agent_id: seeded.id },
          success: true,
        },
        {
          name: 'unsubscribe_agent_event',
          params: { agent_id: seeded.id, topic_pattern: 'github/*/*/pull_request/*' },
          success: true,
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
