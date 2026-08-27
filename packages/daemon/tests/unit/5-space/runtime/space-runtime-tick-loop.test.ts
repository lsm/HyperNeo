import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { ToolContinuationRecoveryRepository } from '../../../../src/storage/repositories/tool-continuation-recovery-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { MAX_BLOCKED_RUN_RETRIES } from '../../../../src/lib/space/runtime/constants.ts';
import { SpawnSupersededError } from '../../../../src/lib/space/runtime/workflow-node-execution-validation.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceWorkflow } from '@hyperneo/shared';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});
  db.exec(`
		CREATE TABLE IF NOT EXISTS sdk_messages (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			message_type TEXT NOT NULL,
			message_subtype TEXT,
			sdk_message TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			send_status TEXT,
			origin TEXT,
			is_renderable INTEGER NOT NULL DEFAULT 1,
			is_terminal INTEGER NOT NULL DEFAULT 0,
			conversation_turn_index INTEGER,
			parent_tool_use_id TEXT,
			task_id TEXT,
			sdk_uuid TEXT,
			replacement_metadata_normalized INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS sdk_message_replacements (
			source_message_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			task_id TEXT,
			target_uuid TEXT NOT NULL,
			kind TEXT NOT NULL CHECK(kind IN ('superseded', 'retracted')),
			PRIMARY KEY (source_message_id, target_uuid, kind)
		);
		CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_id ON sdk_messages(task_id);
	`);
  return db;
}

function seedSpaceRow(
  db: BunDatabase,
  spaceId: string,
  workspacePath = '/tmp/workspace',
  maxConcurrentTasks = 1
): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, max_concurrent_tasks, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?, ?)`
  ).run(
    spaceId,
    workspacePath,
    `Space ${spaceId}`,
    spaceId,
    maxConcurrentTasks,
    Date.now(),
    Date.now()
  );
}

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string, name: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, name, Date.now(), Date.now());
}

function buildLinearWorkflow(
  spaceId: string,
  workflowManager: SpaceWorkflowManager,
  nodes: Array<{ id: string; name: string; agentId: string; instructions?: string }>,
  conditions: Array<{ type: 'always' | 'human'; description?: string }> = []
): SpaceWorkflow {
  const transitions = nodes.slice(0, -1).map((step, i) => ({
    from: step.id,
    to: nodes[i + 1].id,
    condition: conditions[i] ?? { type: 'always' as const },
    order: 0,
  }));

  return workflowManager.createWorkflow({
    spaceId,
    name: `Test Workflow ${Date.now()}-${Math.random()}`,
    description: 'Test',
    nodes,
    transitions,
    startNodeId: nodes[0].id,
    rules: [],
    tags: [],
    completionAutonomyLevel: 3,
  });
}

function makeMockTaskAgentManager(
  taskRepo: SpaceTaskRepository,
  nodeExecutionRepo: NodeExecutionRepository,
  overrides: {
    isSpawning?: (taskId: string) => boolean;
    isTaskAgentAlive?: (taskId: string) => boolean;
    spawnWorkflowNodeAgent?: (task: unknown) => Promise<string>;
    isExecutionSpawning?: (executionId: string) => boolean;
    isSessionAlive?: (sessionId: string) => boolean;
    isSessionInMemory?: (sessionId: string) => boolean;
    spawnWorkflowNodeAgentForExecution?: (
      task: unknown,
      space: unknown,
      workflow: unknown,
      run: unknown,
      execution: unknown
    ) => Promise<string>;
    rehydrate?: () => Promise<void>;
    cancelBySessionId?: (sessionId: string) => void;
    interruptBySessionId?: (sessionId: string) => Promise<void>;
    restartStuckSubSession?: (sessionId: string) => Promise<void>;
    injectRuntimeRecoveryMessage?: (sessionId: string, message: string) => Promise<string>;
    getAgentSessionById?: (sessionId: string) => unknown;
  } = {}
) {
  const spawned: string[] = [];
  const sessionToTask = new Map<string, string>();
  const spawnExecutionImpl =
    overrides.spawnWorkflowNodeAgentForExecution ??
    (async (
      task: unknown,
      _space: unknown,
      _workflow: unknown,
      _run: unknown,
      execution: unknown
    ) => {
      if (overrides.spawnWorkflowNodeAgent) {
        const legacySessionId = await overrides.spawnWorkflowNodeAgent(task);
        const t = task as { id?: string };
        const e = execution as { id?: string };
        if (t.id && legacySessionId) sessionToTask.set(legacySessionId, t.id);
        if (t.id) spawned.push(t.id);
        if (e.id) {
          nodeExecutionRepo.update(e.id, {
            status: 'in_progress',
            agentSessionId: legacySessionId,
            startedAt: Date.now(),
            completedAt: null,
          });
        }
        return legacySessionId;
      }
      const e = execution as { id?: string };
      const t = task as { id?: string };
      const executionId = e.id ?? t.id ?? `exec-${Math.random().toString(36).slice(2)}`;
      const taskId = t.id ?? executionId;
      const sessionId = `session:${executionId}`;
      sessionToTask.set(sessionId, taskId);
      spawned.push(taskId);
      if (e.id) {
        nodeExecutionRepo.update(e.id, {
          status: 'in_progress',
          agentSessionId: sessionId,
          startedAt: Date.now(),
          completedAt: null,
        });
      }
      return sessionId;
    });
  const spawnImpl =
    overrides.spawnWorkflowNodeAgent ??
    (async (task: unknown) => {
      const t = task as { id: string };
      spawned.push(t.id);
      taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
      sessionToTask.set(`session:${t.id}`, t.id);
      return `session:${t.id}`;
    });
  const aliveByTaskAgent =
    overrides.isSessionAlive ??
    ((sessionId: string) => {
      if (!overrides.isTaskAgentAlive) return false;
      const taskId = sessionToTask.get(sessionId);
      return taskId ? overrides.isTaskAgentAlive(taskId) : false;
    });
  return {
    isSpawning: overrides.isSpawning ?? (() => false),
    isTaskAgentAlive: overrides.isTaskAgentAlive ?? (() => false),
    spawnWorkflowNodeAgent: spawnImpl,
    isExecutionSpawning: overrides.isExecutionSpawning ?? (() => false),
    isSessionAlive: aliveByTaskAgent,
    isSessionInMemory: overrides.isSessionInMemory ?? aliveByTaskAgent,
    spawnWorkflowNodeAgentForExecution: spawnExecutionImpl,
    rehydrate: overrides.rehydrate ?? (async () => {}),
    cancelBySessionId: overrides.cancelBySessionId ?? (() => {}),
    interruptBySessionId: overrides.interruptBySessionId ?? (async () => {}),
    restartStuckSubSession: overrides.restartStuckSubSession ?? (async () => {}),
    injectRuntimeRecoveryMessage:
      overrides.injectRuntimeRecoveryMessage ??
      (async (sessionId: string) => `runtime-nag:${sessionId}`),
    getAgentSessionById: overrides.getAgentSessionById ?? (() => null),
    injectIntoTaskAgent: async () => ({ injected: false, reason: 'no-session' }),
    _spawned: spawned,
  };
}

describe('SpaceRuntime — tick loop correctness', () => {
  let db: BunDatabase;

  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let agentManager: SpaceAgentManager;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;
  let nodeExecutionRepo: NodeExecutionRepository;
  let sdkMessageRepo: SDKMessageRepository;
  let internalEventBus: InternalEventBus<DaemonInternalEventMap>;

  const SPACE_ID = 'space-tick-1';
  const SPACE_ID_2 = 'space-tick-2';
  const WORKSPACE = '/tmp/tick-ws';

  const AGENT_PLANNER = 'agent-planner';
  const AGENT_CODER = 'agent-coder';

  const STEP_A = 'step-a';
  const STEP_B = 'step-b';

  function saveAssistantMessage(
    sessionId: string,
    opts: { minutesAgo: number; terminal?: boolean; toolUse?: boolean }
  ): string {
    const content = opts.toolUse
      ? [{ type: 'tool_use', id: `tool-${sessionId}`, name: 'bash', input: {} }]
      : [{ type: 'text', text: 'done' }];
    const message = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content,
        stop_reason: opts.terminal ? 'end_turn' : null,
      },
    };
    sdkMessageRepo.saveSDKMessage(sessionId, message as never);
    const timestamp = new Date(Date.now() - opts.minutesAgo * 60_000).toISOString();
    db.prepare(`UPDATE sdk_messages SET timestamp = ? WHERE session_id = ?`).run(
      timestamp,
      sessionId
    );
    const row = db
      .prepare(
        `SELECT id FROM sdk_messages WHERE session_id = ? ORDER BY timestamp DESC, rowid DESC LIMIT 1`
      )
      .get(sessionId) as { id: string };
    return row.id;
  }

  function processingState(status: string) {
    return { getProcessingState: () => ({ status }) };
  }

  function saveRuntimeNagMessage(sessionId: string, messageId: string, minutesAgo = 20): void {
    const message = {
      type: 'user',
      uuid: messageId,
      message: {
        role: 'user',
        content: [{ type: 'text', text: '[Runtime recovery notice]' }],
      },
    };
    db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, origin, is_renderable, is_terminal) VALUES (?, ?, 'user', ?, ?, 'consumed', 'system', 1, 0)`
    ).run(
      messageId,
      sessionId,
      JSON.stringify(message),
      new Date(Date.now() - minutesAgo * 60_000).toISOString()
    );
  }

  beforeEach(() => {
    db = makeDb();

    seedSpaceRow(db, SPACE_ID, WORKSPACE);
    seedSpaceRow(db, SPACE_ID_2, '/tmp/tick-ws-2');
    seedAgentRow(db, AGENT_PLANNER, SPACE_ID, 'Planner');
    seedAgentRow(db, AGENT_CODER, SPACE_ID, 'Coder');
    seedAgentRow(db, `${AGENT_PLANNER}-s2`, SPACE_ID_2, 'Planner');
    seedAgentRow(db, `${AGENT_CODER}-s2`, SPACE_ID_2, 'Coder');

    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    taskRepo = new SpaceTaskRepository(db);
    nodeExecutionRepo = new NodeExecutionRepository(db);
    sdkMessageRepo = new SDKMessageRepository(db);

    const agentRepo = new SpaceAgentRepository(db);
    agentManager = new SpaceAgentManager(agentRepo);

    const workflowRepo = new SpaceWorkflowRepository(db);
    workflowManager = new SpaceWorkflowManager(workflowRepo);

    spaceManager = new SpaceManager(db);
    internalEventBus = new InternalEventBus<DaemonInternalEventMap>();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
    } catch {}
  });

  function buildConfig(
    tam?: ReturnType<typeof makeMockTaskAgentManager>,
    overrides: Partial<SpaceRuntimeConfig> = {}
  ): SpaceRuntimeConfig {
    return {
      db,
      spaceManager,
      spaceAgentManager: agentManager,
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      sdkMessageRepo,
      internalEventBus,
      taskAgentManager: tam as never,
      ...overrides,
    };
  }

  describe('tick picks up new tasks from workflow runs', () => {
    test('tick spawns agent for task created by startWorkflowRun before first tick', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo);
      const rt = new SpaceRuntime(buildConfig(tam));

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      expect(tasks[0].status).toBe('open');

      await rt.executeTick();

      expect(tam._spawned).toContain(tasks[0].id);
      const updated = taskRepo.getTask(tasks[0].id)!;
      expect(updated.status).toBe('in_progress');
    });

    test('tick picks up workflow run created between ticks', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isTaskAgentAlive: (taskId: string) => {
          const task = taskRepo.getTask(taskId);
          return !!task?.taskAgentSessionId;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam));

      await rt.executeTick();
      expect(tam._spawned).toHaveLength(0);

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Late Run');

      await rt.executeTick();

      expect(tam._spawned).toContain(tasks[0].id);
      expect(taskRepo.getTask(tasks[0].id)!.status).toBe('in_progress');
    });

    test('tick picks up tasks added to an existing run between ticks', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isTaskAgentAlive: (taskId: string) => {
          const task = taskRepo.getTask(taskId);
          return !!task?.taskAgentSessionId;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam));

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
        { id: STEP_B, name: 'Code', agentId: AGENT_CODER },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      await rt.executeTick();
      expect(tam._spawned).toContain(tasks[0].id);
      const firstSpawnCount = tam._spawned.length;

      const newTask = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Code',
        description: '',
        workflowRunId: run.id,
        status: 'open',
      });
      nodeExecutionRepo.createOrIgnore({
        workflowRunId: run.id,
        workflowNodeId: STEP_B,
        agentName: newTask.title,
        agentId: AGENT_CODER,
        status: 'pending',
      });

      await rt.executeTick();
      expect(tam._spawned.length).toBeGreaterThan(firstSpawnCount);
      expect(taskRepo.getTask(tasks[0].id)!.status).toBe('in_progress');
      expect(taskRepo.getTask(newTask.id)!.status).toBe('archived');
    });
  });

  describe('multiple ticks do not duplicate executors', () => {
    test('executor count stays 1 after multiple ticks for the same active run', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isTaskAgentAlive: () => true,
      });
      const rt = new SpaceRuntime(buildConfig(tam));

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      await rt.executeTick();
      expect(rt.executorCount).toBe(1);

      await rt.executeTick();
      expect(rt.executorCount).toBe(1);

      await rt.executeTick();
      expect(rt.executorCount).toBe(1);
    });

    test('two different runs produce exactly two executors across multiple ticks', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isTaskAgentAlive: () => true,
      });
      const rt = new SpaceRuntime(buildConfig(tam));

      const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const wf2 = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_B, name: 'Code', agentId: AGENT_CODER },
      ]);

      const { run: run1 } = await rt.startWorkflowRun(SPACE_ID, wf1.id, 'Run 1');
      const { run: run2 } = await rt.startWorkflowRun(SPACE_ID, wf2.id, 'Run 2');

      await rt.executeTick();
      expect(rt.executorCount).toBe(2);
      expect(rt.getExecutor(run1.id)).toBeDefined();
      expect(rt.getExecutor(run2.id)).toBeDefined();

      await rt.executeTick();
      expect(rt.executorCount).toBe(2);
    });
  });

  describe('tick skips already-running tasks', () => {
    test('in_progress task with alive agent is not re-spawned', async () => {
      let spawnCount = 0;
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isTaskAgentAlive: () => true,
        spawnWorkflowNodeAgent: async (task: unknown) => {
          const t = task as { id: string };
          spawnCount++;
          taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
          return `session:${t.id}`;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam));

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      await rt.executeTick();
      expect(spawnCount).toBe(1);

      await rt.executeTick();
      await rt.executeTick();
      await rt.executeTick();
      expect(spawnCount).toBe(1);
    });
  });

  describe('processCompletedTasks error isolation', () => {
    test('error in one run does not prevent processing the other run', async () => {
      const spawned: string[] = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isTaskAgentAlive: (taskId: string) => {
          const task = taskRepo.getTask(taskId);
          return !!task?.taskAgentSessionId;
        },
        spawnWorkflowNodeAgent: async (task: unknown) => {
          const t = task as { id: string };
          spawned.push(t.id);
          taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
          return `session:${t.id}`;
        },
      });

      const realRt = new SpaceRuntime(buildConfig(tam));
      const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const wf2 = buildLinearWorkflow(SPACE_ID_2, workflowManager, [
        { id: STEP_B, name: 'Code', agentId: `${AGENT_CODER}-s2` },
      ]);
      await realRt.startWorkflowRun(SPACE_ID, wf1.id, 'Failing Run');
      const { tasks: tasks2 } = await realRt.startWorkflowRun(SPACE_ID_2, wf2.id, 'Good Run');

      const faultySpaceManager = {
        getSpace: async (id: string) => {
          if (id === SPACE_ID) {
            throw new Error('Simulated DB corruption for space-tick-1');
          }
          return spaceManager.getSpace(id);
        },
        listSpaces: async () => spaceManager.listSpaces(false),
      };
      const faultyRt = new SpaceRuntime({
        ...buildConfig(tam),
        spaceManager: faultySpaceManager as never,
      });

      await expect(faultyRt.executeTick()).rejects.toThrow('Simulated DB corruption');

      expect(spawned).toContain(tasks2[0].id);
      expect(taskRepo.getTask(tasks2[0].id)!.status).toBe('in_progress');
    });

    test('first error is re-thrown after all runs are processed', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo);
      const realRt = new SpaceRuntime(buildConfig(tam));

      const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const wf2 = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_B, name: 'Code', agentId: AGENT_CODER },
      ]);
      await realRt.startWorkflowRun(SPACE_ID, wf1.id, 'Run 1');
      await realRt.startWorkflowRun(SPACE_ID, wf2.id, 'Run 2');

      const faultySpaceManager = {
        getSpace: async () => {
          throw new Error('getSpace always fails');
        },
        listSpaces: async () => spaceManager.listSpaces(false),
      };
      const faultyRt = new SpaceRuntime({
        ...buildConfig(tam),
        spaceManager: faultySpaceManager as never,
      });

      await expect(faultyRt.executeTick()).rejects.toThrow('getSpace always fails');

      expect(faultyRt.executorCount).toBe(2);
    });
  });

  describe('rehydration graceful failure handling', () => {
    test('rehydration skips run whose workflow was deleted (no throw)', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Orphan Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      new SpaceWorkflowRepository(db).deleteWorkflow(workflow.id);

      const freshRt = new SpaceRuntime(buildConfig());
      await expect(freshRt.executeTick()).resolves.toBeUndefined();
      expect(freshRt.executorCount).toBe(0);
    });

    test('rehydration does not duplicate executors on second tick', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Rehydrate Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Plan',
        description: '',
        workflowRunId: run.id,
        status: 'open',
      });

      const freshRt = new SpaceRuntime(buildConfig());

      await freshRt.executeTick();
      expect(freshRt.executorCount).toBe(1);

      await freshRt.executeTick();
      expect(freshRt.executorCount).toBe(1);
    });

    test('rehydration loads runs from multiple spaces', async () => {
      const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const wf2 = buildLinearWorkflow(SPACE_ID_2, workflowManager, [
        { id: STEP_B, name: 'Code', agentId: `${AGENT_CODER}-s2` },
      ]);

      const run1 = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: wf1.id,
        title: 'Run S1',
      });
      workflowRunRepo.transitionStatus(run1.id, 'in_progress');

      const run2 = workflowRunRepo.createRun({
        spaceId: SPACE_ID_2,
        workflowId: wf2.id,
        title: 'Run S2',
      });
      workflowRunRepo.transitionStatus(run2.id, 'in_progress');

      const freshRt = new SpaceRuntime(buildConfig());
      await freshRt.executeTick();

      expect(freshRt.executorCount).toBe(2);
      expect(freshRt.getExecutor(run1.id)).toBeDefined();
      expect(freshRt.getExecutor(run2.id)).toBeDefined();
    });
  });

  describe('Layer 1 runtime anti-stuck recovery', () => {
    test('nags only the stale agent in a multi-agent node', async () => {
      const nags: Array<{ sessionId: string; message: string }> = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => true,
        getAgentSessionById: () => processingState('processing'),
        injectRuntimeRecoveryMessage: async (sessionId, message) => {
          nags.push({ sessionId, message });
          return `runtime-nag:${sessionId}`;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam, { agentNoProgressThresholdMs: 60_000 }));
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Multi-agent ${Date.now()}`,
        description: 'Test',
        nodes: [
          {
            id: STEP_A,
            name: 'Build',
            agents: [
              { agentId: AGENT_PLANNER, name: 'Planner' },
              { agentId: AGENT_CODER, name: 'Coder' },
            ],
          },
          {
            id: STEP_B,
            name: 'Done',
            agents: [{ agentId: AGENT_PLANNER, name: 'Finisher' }],
          },
        ],
        transitions: [{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, order: 0 }],
        startNodeId: STEP_A,
        endNodeId: STEP_B,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      for (const execution of nodeExecutionRepo.listByWorkflowRun(run.id)) {
        const sessionId = `session:${execution.agentName}`;
        nodeExecutionRepo.update(execution.id, {
          status: 'in_progress',
          agentSessionId: sessionId,
          startedAt: Date.now() - 20 * 60_000,
        });
        saveAssistantMessage(sessionId, {
          minutesAgo: execution.agentName === 'Planner' ? 20 : 0,
          toolUse: execution.agentName === 'Planner',
        });
      }

      await rt.executeTick();

      expect(nags).toHaveLength(1);
      expect(nags[0].sessionId).toBe('session:Planner');
      expect(nags[0].message).toContain('[Runtime recovery notice]');
      expect(
        nodeExecutionRepo.listByWorkflowRun(run.id).filter((e) => e.status === 'in_progress')
      ).toHaveLength(2);
    });

    test('does not nag a DB-fallback-alive ghost session and resets it for spawn retry (#3109)', async () => {
      const nags: Array<{ sessionId: string; message: string }> = [];
      const spawned: string[] = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => true,
        isSessionInMemory: () => false,
        getAgentSessionById: () => null,
        injectRuntimeRecoveryMessage: async (sessionId, message) => {
          nags.push({ sessionId, message });
          return `runtime-nag:${sessionId}`;
        },
        spawnWorkflowNodeAgentForExecution: async (_task, _space, _workflow, _run, execution) => {
          const exec = execution as { id: string; agentName: string };
          spawned.push(exec.id);
          const sessionId = `session:${exec.agentName}:respawn`;
          nodeExecutionRepo.update(exec.id, {
            status: 'in_progress',
            agentSessionId: sessionId,
            startedAt: Date.now(),
            completedAt: null,
          });
          return sessionId;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam, { agentNoProgressThresholdMs: 60_000 }));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Build', agentId: AGENT_CODER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session:ghost-db',
        startedAt: Date.now() - 20 * 60_000,
      });
      saveAssistantMessage('session:ghost-db', { minutesAgo: 20, toolUse: true });

      await rt.executeTick();

      expect(nags).toHaveLength(0);
      expect(spawned).toEqual([execution.id]);
      const updated = nodeExecutionRepo.getById(execution.id)!;
      expect(updated.agentSessionId).toBe(`session:${execution.agentName}:respawn`);
      expect(updated.status).toBe('in_progress');
    });

    test('restarts only the nagged stale agent when no progress follows', async () => {
      const restarted: string[] = [];
      const injected: Array<{ sessionId: string; message: string }> = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: (sessionId) => sessionId !== 'session:Planner:new',
        getAgentSessionById: () => processingState('processing'),
        injectRuntimeRecoveryMessage: async (sessionId, message) => {
          injected.push({ sessionId, message });
          return `runtime-nag:${sessionId}:${injected.length}`;
        },
        restartStuckSubSession: async (sessionId) => {
          restarted.push(sessionId);
        },
        spawnWorkflowNodeAgentForExecution: async (_task, _space, _workflow, _run, execution) => {
          const exec = execution as { id: string; agentName: string };
          const sessionId = `session:${exec.agentName}:new`;
          nodeExecutionRepo.update(exec.id, {
            status: 'in_progress',
            agentSessionId: sessionId,
            startedAt: Date.now(),
            completedAt: null,
          });
          return sessionId;
        },
      });
      const rt = new SpaceRuntime(
        buildConfig(tam, { agentNoProgressThresholdMs: 60_000, agentStuckNagGraceMs: 0 })
      );
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Multi-agent restart ${Date.now()}`,
        description: 'Test',
        nodes: [
          {
            id: STEP_A,
            name: 'Build',
            agents: [
              { agentId: AGENT_PLANNER, name: 'Planner' },
              { agentId: AGENT_CODER, name: 'Coder' },
            ],
          },
          {
            id: STEP_B,
            name: 'Done',
            agents: [{ agentId: AGENT_PLANNER, name: 'Finisher' }],
          },
        ],
        transitions: [{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, order: 0 }],
        startNodeId: STEP_A,
        endNodeId: STEP_B,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      for (const execution of nodeExecutionRepo.listByWorkflowRun(run.id)) {
        const sessionId = `session:${execution.agentName}`;
        nodeExecutionRepo.update(execution.id, {
          status: 'in_progress',
          agentSessionId: sessionId,
          startedAt: Date.now() - 20 * 60_000,
        });
        saveAssistantMessage(sessionId, {
          minutesAgo: execution.agentName === 'Planner' ? 20 : 0,
          toolUse: execution.agentName === 'Planner',
        });
      }

      await rt.executeTick();
      await rt.executeTick();
      await rt.executeTick();

      expect(restarted).toEqual(['session:Planner']);
      const executions = nodeExecutionRepo.listByWorkflowRun(run.id);
      expect(executions.find((e) => e.agentName === 'Planner')?.agentSessionId).toBe(
        'session:Planner:new'
      );
      expect(executions.find((e) => e.agentName === 'Coder')?.agentSessionId).toBe('session:Coder');
      expect(injected.some((entry) => entry.message.includes('[Runtime session recovery]'))).toBe(
        true
      );
    });

    test('does not treat restart notice injection failure as spawn failure', async () => {
      const injected: Array<{ sessionId: string; message: string }> = [];
      const cancelled: string[] = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: (sessionId) => sessionId !== 'session:restart-notice-failed:new',
        getAgentSessionById: () => processingState('processing'),
        injectRuntimeRecoveryMessage: async (sessionId, message) => {
          injected.push({ sessionId, message });
          if (message.includes('[Runtime session recovery]')) {
            throw new Error('notice write failed');
          }
          return `runtime-nag:${sessionId}:${injected.length}`;
        },
        restartStuckSubSession: async () => {},
        cancelBySessionId: (sessionId) => {
          cancelled.push(sessionId);
        },
        spawnWorkflowNodeAgentForExecution: async (_task, _space, _workflow, _run, execution) => {
          const exec = execution as { id: string };
          const sessionId = 'session:restart-notice-failed:new';
          nodeExecutionRepo.update(exec.id, {
            status: 'in_progress',
            agentSessionId: sessionId,
            startedAt: Date.now(),
            completedAt: null,
          });
          return sessionId;
        },
      });
      const rt = new SpaceRuntime(
        buildConfig(tam, { agentNoProgressThresholdMs: 60_000, agentStuckNagGraceMs: 0 })
      );
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session:restart-notice-failed',
        startedAt: Date.now() - 20 * 60_000,
      });
      saveAssistantMessage('session:restart-notice-failed', { minutesAgo: 20, toolUse: true });

      await rt.executeTick();
      await rt.executeTick();
      await rt.executeTick();
      await Promise.resolve();

      expect(cancelled).toEqual([]);
      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('in_progress');
      expect(nodeExecutionRepo.getById(execution.id)?.agentSessionId).toBe(
        'session:restart-notice-failed:new'
      );
      expect(injected.some((entry) => entry.message.includes('[Runtime session recovery]'))).toBe(
        true
      );
    });

    test('waits for nag grace before restarting a still-stale live session', async () => {
      const restarted: string[] = [];
      const injected: Array<{ sessionId: string; message: string }> = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => true,
        getAgentSessionById: () => processingState('processing'),
        injectRuntimeRecoveryMessage: async (sessionId, message) => {
          injected.push({ sessionId, message });
          return `runtime-nag:${sessionId}:${injected.length}`;
        },
        restartStuckSubSession: async (sessionId) => {
          restarted.push(sessionId);
        },
      });
      const rt = new SpaceRuntime(
        buildConfig(tam, { agentNoProgressThresholdMs: 60_000, agentStuckNagGraceMs: 60_000 })
      );
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session:queued-nag',
        startedAt: Date.now() - 20 * 60_000,
      });
      saveAssistantMessage('session:queued-nag', { minutesAgo: 20, toolUse: true });

      await rt.executeTick();
      await rt.executeTick();

      expect(injected).toHaveLength(1);
      expect(injected[0].message).toContain('[Runtime recovery notice]');
      expect(restarted).toEqual([]);
      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('in_progress');
      expect(nodeExecutionRepo.getById(execution.id)?.agentSessionId).toBe('session:queued-nag');
    });

    test('ignores consumed runtime nag when deciding whether progress occurred', async () => {
      const restarted: string[] = [];
      const injected: Array<{ sessionId: string; message: string }> = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => true,
        getAgentSessionById: () => processingState('processing'),
        injectRuntimeRecoveryMessage: async (sessionId, message) => {
          injected.push({ sessionId, message });
          return `runtime-nag:${sessionId}:${injected.length}`;
        },
        restartStuckSubSession: async (sessionId) => {
          restarted.push(sessionId);
        },
        spawnWorkflowNodeAgentForExecution: async (_task, _space, _workflow, _run, execution) => {
          const exec = execution as { id: string; agentName: string };
          const sessionId = `session:${exec.agentName}:after-nag`;
          nodeExecutionRepo.update(exec.id, {
            status: 'in_progress',
            agentSessionId: sessionId,
            startedAt: Date.now(),
            completedAt: null,
          });
          return sessionId;
        },
      });
      const rt = new SpaceRuntime(
        buildConfig(tam, { agentNoProgressThresholdMs: 60_000, agentStuckNagGraceMs: 0 })
      );
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session:runtime-nag-progress',
        startedAt: Date.now() - 20 * 60_000,
      });
      saveAssistantMessage('session:runtime-nag-progress', { minutesAgo: 20, toolUse: true });

      await rt.executeTick();
      saveRuntimeNagMessage(
        'session:runtime-nag-progress',
        'runtime-nag:session:runtime-nag-progress:1'
      );
      await rt.executeTick();
      await rt.executeTick();

      expect(
        injected.filter((entry) => entry.message.includes('[Runtime recovery notice]'))
      ).toHaveLength(1);
      expect(restarted).toEqual(['session:runtime-nag-progress']);
      expect(nodeExecutionRepo.getById(execution.id)?.agentSessionId).toBe(
        'session:Plan:after-nag'
      );
    });

    test('nags alive sessions with no SDK messages after the threshold', async () => {
      const nags: Array<{ sessionId: string; message: string }> = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => true,
        getAgentSessionById: () => processingState('processing'),
        injectRuntimeRecoveryMessage: async (sessionId, message) => {
          nags.push({ sessionId, message });
          return `runtime-nag:${sessionId}`;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam, { agentNoProgressThresholdMs: 60_000 }));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session:no-sdk-output',
        startedAt: Date.now() - 20 * 60_000,
      });

      await rt.executeTick();

      expect(nags).toHaveLength(1);
      expect(nags[0].sessionId).toBe('session:no-sdk-output');
      expect(nags[0].message).toContain('no SDK messages were recorded');
    });

    test('uses per-slot timeout as the no-progress threshold when configured', async () => {
      const nags: string[] = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => true,
        getAgentSessionById: () => processingState('processing'),
        injectRuntimeRecoveryMessage: async (sessionId) => {
          nags.push(sessionId);
          return `runtime-nag:${sessionId}`;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam, { agentNoProgressThresholdMs: 60_000 }));
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Per-slot threshold ${Date.now()}`,
        description: 'Test',
        nodes: [
          {
            id: STEP_A,
            name: 'Build',
            agents: [{ agentId: AGENT_PLANNER, name: 'Planner', timeoutMs: 30_000 }],
          },
        ],
        transitions: [],
        startNodeId: STEP_A,
        endNodeId: STEP_A,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session:slot-timeout',
        startedAt: Date.now() - 20 * 60_000,
      });
      saveAssistantMessage('session:slot-timeout', { minutesAgo: 1, toolUse: true });

      await rt.executeTick();

      expect(nags).toEqual(['session:slot-timeout']);
    });

    test('allows per-slot timeout to extend the no-progress threshold', async () => {
      const nags: string[] = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => true,
        getAgentSessionById: () => processingState('processing'),
        injectRuntimeRecoveryMessage: async (sessionId) => {
          nags.push(sessionId);
          return `runtime-nag:${sessionId}`;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam, { agentNoProgressThresholdMs: 60_000 }));
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Extended per-slot threshold ${Date.now()}`,
        description: 'Test',
        nodes: [
          {
            id: STEP_A,
            name: 'Build',
            agents: [{ agentId: AGENT_PLANNER, name: 'Planner', timeoutMs: 10 * 60_000 }],
          },
        ],
        transitions: [],
        startNodeId: STEP_A,
        endNodeId: STEP_A,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session:slot-timeout-extended',
        startedAt: Date.now() - 20 * 60_000,
      });
      saveAssistantMessage('session:slot-timeout-extended', { minutesAgo: 2, toolUse: true });

      await rt.executeTick();

      expect(nags).toEqual([]);
      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('in_progress');
    });

    test('records SDK tool_use events for production active-tool recovery guard', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => true,
        getAgentSessionById: () => processingState('processing'),
      });
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Run',
      });
      workflowRunRepo.updateStatusUnchecked(run.id, 'in_progress');
      const execution = nodeExecutionRepo.create({
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        agentName: 'Plan',
        agentId: AGENT_PLANNER,
        status: 'in_progress',
        agentSessionId: 'session:production-tool',
      });

      await internalEventBus.publish('sdk.toolUse.created', {
        sessionId: 'session:production-tool',
        toolUseId: 'tool-production-path',
        toolName: 'Bash',
        timestamp: Date.now(),
      });

      const repo = new ToolContinuationRecoveryRepository(db);
      expect(repo.hasActiveToolUseForExecution(execution.id)).toBe(true);

      await internalEventBus.publish('sdk.toolUse.consumed', {
        sessionId: 'session:production-tool',
        toolUseId: 'tool-production-path',
        timestamp: Date.now(),
      });

      expect(repo.hasActiveToolUseForExecution(execution.id)).toBe(false);

      await rt.stop();
      await internalEventBus.publish('sdk.toolUse.created', {
        sessionId: 'session:production-tool',
        toolUseId: 'tool-after-stop',
        toolName: 'Bash',
        timestamp: Date.now(),
      });

      expect(repo.hasActiveToolUseForExecution(execution.id)).toBe(false);

      rt.start();
      await rt.stop();
      await internalEventBus.publish('sdk.toolUse.created', {
        sessionId: 'session:production-tool',
        toolUseId: 'tool-after-restart',
        toolName: 'Bash',
        timestamp: Date.now(),
      });
      expect(repo.hasActiveToolUseForExecution(execution.id)).toBe(false);
    });

    test('does not restart while the execution still has an active tool call', async () => {
      const restarted: string[] = [];
      const nags: string[] = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => true,
        getAgentSessionById: () => processingState('processing'),
        injectRuntimeRecoveryMessage: async (sessionId) => {
          nags.push(sessionId);
          return `runtime-nag:${sessionId}`;
        },
        restartStuckSubSession: async (sessionId) => {
          restarted.push(sessionId);
        },
      });
      const rt = new SpaceRuntime(
        buildConfig(tam, { agentNoProgressThresholdMs: 60_000, agentStuckNagGraceMs: 0 })
      );
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session:active-tool',
        startedAt: Date.now() - 20 * 60_000,
      });
      saveAssistantMessage('session:active-tool', { minutesAgo: 20, toolUse: true });
      new ToolContinuationRecoveryRepository(db).recordToolUse({
        toolUseId: 'tool-active-tool',
        sessionId: 'session:active-tool',
        ttlMs: 60_000,
        owner: { executionId: execution.id, workflowRunId: run.id },
      });

      await rt.executeTick();
      await rt.executeTick();

      expect(nags).toEqual([]);
      expect(restarted).toEqual([]);
      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('in_progress');
      expect(nodeExecutionRepo.getById(execution.id)?.agentSessionId).toBe('session:active-tool');
    });

    test('does not consume restart budget when stopping the stuck session fails', async () => {
      const restarted: string[] = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => true,
        getAgentSessionById: () => processingState('processing'),
        injectRuntimeRecoveryMessage: async (sessionId) => `runtime-nag:${sessionId}`,
        restartStuckSubSession: async (sessionId) => {
          restarted.push(sessionId);
          if (restarted.length === 1) throw new Error('stop failed');
        },
      });
      const rt = new SpaceRuntime(
        buildConfig(tam, { agentNoProgressThresholdMs: 60_000, agentStuckNagGraceMs: 0 })
      );
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session:restart-fails-once',
        startedAt: Date.now() - 20 * 60_000,
      });
      saveAssistantMessage('session:restart-fails-once', { minutesAgo: 20, toolUse: true });

      await rt.executeTick();
      await expect(rt.executeTick()).rejects.toThrow('stop failed');
      await rt.executeTick();

      expect(restarted).toEqual(['session:restart-fails-once', 'session:restart-fails-once']);
      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('pending');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
    });

    test('does not nag terminal or waiting-for-input sessions', async () => {
      const nags: string[] = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => true,
        getAgentSessionById: (sessionId) =>
          processingState(sessionId === 'session:waiting' ? 'waiting_for_input' : 'processing'),
        injectRuntimeRecoveryMessage: async (sessionId) => {
          nags.push(sessionId);
          return `runtime-nag:${sessionId}`;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam, { agentNoProgressThresholdMs: 60_000 }));
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `No nag ${Date.now()}`,
        description: 'Test',
        nodes: [
          {
            id: STEP_A,
            name: 'Build',
            agents: [
              { agentId: AGENT_PLANNER, name: 'Terminal' },
              { agentId: AGENT_CODER, name: 'Waiting' },
            ],
          },
          {
            id: STEP_B,
            name: 'Done',
            agents: [{ agentId: AGENT_PLANNER, name: 'Finisher' }],
          },
        ],
        transitions: [{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, order: 0 }],
        startNodeId: STEP_A,
        endNodeId: STEP_B,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      for (const execution of nodeExecutionRepo.listByWorkflowRun(run.id)) {
        const sessionId =
          execution.agentName === 'Terminal' ? 'session:terminal' : 'session:waiting';
        nodeExecutionRepo.update(execution.id, {
          status: 'in_progress',
          agentSessionId: sessionId,
          startedAt: Date.now() - 20 * 60_000,
        });
        saveAssistantMessage(sessionId, {
          minutesAgo: 20,
          terminal: execution.agentName === 'Terminal',
          toolUse: execution.agentName !== 'Terminal',
        });
      }

      await rt.executeTick();

      expect(nags).toEqual([]);
    });

    test('nudges naturally idle incomplete executions after threshold', async () => {
      const nudges: string[] = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => false,
        injectRuntimeRecoveryMessage: async (sessionId) => {
          nudges.push(sessionId);
          return `nudge:${sessionId}`;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'idle',
        agentSessionId: 'session:idle',
      });
      saveAssistantMessage('session:idle', { minutesAgo: 20, toolUse: true });

      await rt.executeTick();

      const updated = nodeExecutionRepo.getById(execution.id);
      expect(updated?.status).toBe('idle');
      expect(updated?.agentSessionId).toBe('session:idle');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(nudges).toEqual(['session:idle']);
      const state = (
        rt as unknown as { nonTerminalIdleStates: Map<string, { nudgeCount: number }> }
      ).nonTerminalIdleStates.get(`${run.id}:${execution.id}`);
      expect(state?.nudgeCount).toBe(1);
    });

    test('does not nudge idle incomplete executions while space is paused', async () => {
      const nudges: string[] = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => false,
        injectRuntimeRecoveryMessage: async (sessionId) => {
          nudges.push(sessionId);
          return `nudge:${sessionId}`;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;
      db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'idle',
        agentSessionId: 'session:paused-idle',
      });
      saveAssistantMessage('session:paused-idle', { minutesAgo: 20, toolUse: true });

      await rt.executeTick();

      const updated = nodeExecutionRepo.getById(execution.id);
      expect(updated?.status).toBe('idle');
      expect(updated?.agentSessionId).toBe('session:paused-idle');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(nudges).toEqual([]);
    });

    test('backs off then retries failed idle nudge attempts', async () => {
      let attempts = 0;
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => false,
        injectRuntimeRecoveryMessage: async (sessionId) => {
          attempts += 1;
          if (attempts === 1) throw new Error('session gone');
          return `nudge:${sessionId}`;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'idle',
        agentSessionId: 'session:failed-idle-nudge',
      });
      saveAssistantMessage('session:failed-idle-nudge', { minutesAgo: 20, toolUse: true });

      await rt.executeTick();
      await rt.executeTick();

      type IdleStateForTest = {
        nudgeCount: number;
        failedNudgeCount: number;
        lastNudgeAt: number;
      };
      const states = (rt as unknown as { nonTerminalIdleStates: Map<string, IdleStateForTest> })
        .nonTerminalIdleStates;
      const state = states.get(`${run.id}:${execution.id}`)!;
      expect(attempts).toBe(1);
      expect(state.nudgeCount).toBe(1);
      expect(state.failedNudgeCount).toBe(1);

      state.lastNudgeAt = Date.now() - 61_000;
      await rt.executeTick();

      expect(attempts).toBe(2);
      expect(state.nudgeCount).toBe(2);
      expect(state.failedNudgeCount).toBe(0);
    });

    test('does NOT nag an actively-working agent whose lastActivityAt is fresh', async () => {
      const nags: Array<{ sessionId: string; message: string }> = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => true,
        getAgentSessionById: () => processingState('processing'),
        injectRuntimeRecoveryMessage: async (sessionId, message) => {
          nags.push({ sessionId, message });
          return `runtime-nag:${sessionId}`;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam, { agentNoProgressThresholdMs: 60_000 }));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session:actively-working',
        startedAt: Date.now() - 20 * 60_000,
      });
      saveAssistantMessage('session:actively-working', { minutesAgo: 20, toolUse: true });
      nodeExecutionRepo.touchLastActivity(execution.id, Date.now());

      await rt.executeTick();

      expect(nags).toEqual([]);
      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('in_progress');
    });

    test('nags a genuinely-stuck agent whose lastActivityAt is stale', async () => {
      const nags: Array<{ sessionId: string; message: string }> = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => true,
        getAgentSessionById: () => processingState('processing'),
        injectRuntimeRecoveryMessage: async (sessionId, message) => {
          nags.push({ sessionId, message });
          return `runtime-nag:${sessionId}`;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam, { agentNoProgressThresholdMs: 60_000 }));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session:stuck',
        startedAt: Date.now() - 20 * 60_000,
      });
      saveAssistantMessage('session:stuck', { minutesAgo: 20, toolUse: true });
      nodeExecutionRepo.touchLastActivity(execution.id, Date.now() - 20 * 60_000);

      await rt.executeTick();

      expect(nags).toHaveLength(1);
      expect(nags[0].sessionId).toBe('session:stuck');
      expect(nags[0].message).toContain('[Runtime recovery notice]');
    });

    test('does NOT nag when a recent SDK message is newer than a stale lastActivityAt', async () => {
      const nags: Array<{ sessionId: string; message: string }> = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => true,
        getAgentSessionById: () => processingState('processing'),
        injectRuntimeRecoveryMessage: async (sessionId, message) => {
          nags.push({ sessionId, message });
          return `runtime-nag:${sessionId}`;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam, { agentNoProgressThresholdMs: 60_000 }));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session:recent-sdk',
        startedAt: Date.now() - 20 * 60_000,
      });
      nodeExecutionRepo.touchLastActivity(execution.id, Date.now() - 20 * 60_000);
      saveAssistantMessage('session:recent-sdk', { minutesAgo: 0, toolUse: true });

      await rt.executeTick();

      expect(nags).toEqual([]);
      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('in_progress');
    });
  });

  describe('paused/stopped spaces stay quiet under supervision', () => {
    test('paused space emits no nags or restarts for a stale live session across ticks', async () => {
      const nags: string[] = [];
      const restarted: string[] = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => true,
        getAgentSessionById: () => processingState('processing'),
        injectRuntimeRecoveryMessage: async (sessionId) => {
          nags.push(sessionId);
          return `runtime-nag:${sessionId}`;
        },
        restartStuckSubSession: async (sessionId) => {
          restarted.push(sessionId);
        },
      });
      const rt = new SpaceRuntime(
        buildConfig(tam, { agentNoProgressThresholdMs: 60_000, agentStuckNagGraceMs: 0 })
      );
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;
      db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session:paused-stuck',
        startedAt: Date.now() - 20 * 60_000,
      });
      saveAssistantMessage('session:paused-stuck', { minutesAgo: 20, toolUse: true });

      for (let i = 0; i < 5; i++) {
        await rt.executeTick();
      }

      expect(nags).toEqual([]);
      expect(restarted).toEqual([]);
      const updated = nodeExecutionRepo.getById(execution.id);
      expect(updated?.status).toBe('in_progress');
      expect(updated?.agentSessionId).toBe('session:paused-stuck');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
    });

    test('active space control: stale live session is still nagged and restarted', async () => {
      const nags: string[] = [];
      const restarted: string[] = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => true,
        getAgentSessionById: () => processingState('processing'),
        injectRuntimeRecoveryMessage: async (sessionId) => {
          nags.push(sessionId);
          return `runtime-nag:${sessionId}`;
        },
        restartStuckSubSession: async (sessionId) => {
          restarted.push(sessionId);
        },
      });
      const rt = new SpaceRuntime(
        buildConfig(tam, { agentNoProgressThresholdMs: 60_000, agentStuckNagGraceMs: 0 })
      );
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session:active-stuck',
        startedAt: Date.now() - 20 * 60_000,
      });
      saveAssistantMessage('session:active-stuck', { minutesAgo: 20, toolUse: true });

      await rt.executeTick();
      await rt.executeTick();

      expect(nags).toEqual(['session:active-stuck']);
      expect(restarted).toEqual(['session:active-stuck']);
    });

    test('stopped space does not auto-retry a blocked run across ticks', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo);
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'blocked',
        result: 'Agent session crashed',
      });
      taskRepo.updateTask(tasks[0].id, { status: 'blocked' });
      workflowRunRepo.transitionStatus(run.id, 'blocked');
      db.prepare(`UPDATE spaces SET stopped = 1 WHERE id = ?`).run(SPACE_ID);

      for (let i = 0; i < 3; i++) {
        await rt.executeTick();
      }

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('blocked');
      expect(nodeExecutionRepo.getById(execution.id)?.result).toBe('Agent session crashed');
      expect(taskRepo.getTask(tasks[0].id)?.status).toBe('blocked');
    });

    test('active space control: blocked run is auto-retried back to in_progress', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo);
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'blocked',
        result: 'Agent session crashed',
      });
      taskRepo.updateTask(tasks[0].id, { status: 'blocked' });
      workflowRunRepo.transitionStatus(run.id, 'blocked');

      await rt.executeTick();

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('pending');
      expect(nodeExecutionRepo.getById(execution.id)?.result).toBeNull();
      expect(taskRepo.getTask(tasks[0].id)?.status).toBe('in_progress');
    });

    test('stopped space emits no needs_attention once blocked-run retries are exhausted', async () => {
      const notifications: Array<{ runId?: string }> = [];
      internalEventBus.subscribe(
        'space.workflowRun.needsAttention',
        (payload) => {
          notifications.push({ runId: payload.runId });
        },
        { subscriberName: 'test-quiet-supervision:stopped' }
      );
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo);
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'blocked',
        result: 'Agent session crashed',
      });
      taskRepo.updateTask(tasks[0].id, { status: 'blocked' });
      workflowRunRepo.transitionStatus(run.id, 'blocked');
      (rt as unknown as { blockedRetryCounts: Map<string, number> }).blockedRetryCounts.set(
        run.id,
        MAX_BLOCKED_RUN_RETRIES
      );
      db.prepare(`UPDATE spaces SET stopped = 1 WHERE id = ?`).run(SPACE_ID);

      for (let i = 0; i < 3; i++) {
        await rt.executeTick();
      }

      expect(notifications).toEqual([]);
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('blocked');
      expect(taskRepo.getTask(tasks[0].id)?.status).toBe('blocked');
    });

    test('active space control: exhausted blocked-run retries still emit needs_attention', async () => {
      const notifications: Array<{ runId?: string }> = [];
      internalEventBus.subscribe(
        'space.workflowRun.needsAttention',
        (payload) => {
          notifications.push({ runId: payload.runId });
        },
        { subscriberName: 'test-quiet-supervision:active' }
      );
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo);
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'blocked',
        result: 'Agent session crashed',
      });
      taskRepo.updateTask(tasks[0].id, { status: 'blocked' });
      workflowRunRepo.transitionStatus(run.id, 'blocked');
      (rt as unknown as { blockedRetryCounts: Map<string, number> }).blockedRetryCounts.set(
        run.id,
        MAX_BLOCKED_RUN_RETRIES
      );

      await rt.executeTick();

      expect(notifications.filter((n) => n.runId === run.id).length).toBeGreaterThanOrEqual(1);
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('blocked');
    });

    test('human-reopened task repairs blocked executions even after retries are exhausted', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo);
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'blocked',
        result: '[MCP invariant] Workflow sub-session still missing required MCP servers',
        agentSessionId: 'session:ghost-after-restart',
        completedAt: Date.now(),
      });
      taskRepo.updateTask(tasks[0].id, {
        status: 'blocked',
        blockReason: 'execution_failed',
        result: 'Workflow run stalled across daemon restart',
      });
      workflowRunRepo.transitionStatus(run.id, 'blocked');
      (rt as unknown as { blockedRetryCounts: Map<string, number> }).blockedRetryCounts.set(
        run.id,
        MAX_BLOCKED_RUN_RETRIES
      );

      taskRepo.updateTask(tasks[0].id, {
        status: 'in_progress',
        blockReason: null,
        result: null,
      });

      await rt.executeTick();
      await rt.executeTick();

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      const repaired = nodeExecutionRepo.getById(execution.id);
      expect(repaired?.status).toBe('in_progress');
      expect(repaired?.agentSessionId).not.toBe('session:ghost-after-restart');
      expect(taskRepo.getTask(tasks[0].id)?.status).toBe('in_progress');
      expect(tam._spawned.length).toBeGreaterThanOrEqual(1);
    });

    test('human-reopened task drops bindings whose indexed session ended in an execution error', async () => {
      const erroredSession = 'session:errored-worker';
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionInMemory: (sessionId) => sessionId === erroredSession,
      });
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'blocked',
        result: 'Agent session failed',
        agentSessionId: erroredSession,
        completedAt: Date.now(),
      });
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin, is_renderable, is_terminal)
         VALUES (?, ?, 'result', 'error_during_execution', ?, ?, 'consumed', 'system', 1, 1)`
      ).run(
        'msg-errored-worker',
        erroredSession,
        JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
        }),
        new Date().toISOString()
      );
      taskRepo.updateTask(tasks[0].id, {
        status: 'blocked',
        blockReason: 'execution_failed',
        result: 'Agent session failed',
      });
      workflowRunRepo.transitionStatus(run.id, 'blocked');
      (rt as unknown as { blockedRetryCounts: Map<string, number> }).blockedRetryCounts.set(
        run.id,
        MAX_BLOCKED_RUN_RETRIES
      );

      taskRepo.updateTask(tasks[0].id, {
        status: 'in_progress',
        blockReason: null,
        result: null,
      });

      await rt.executeTick();
      await rt.executeTick();

      const repaired = nodeExecutionRepo.getById(execution.id);
      expect(repaired?.agentSessionId).not.toBe(erroredSession);
      expect(repaired?.status).toBe('in_progress');
      expect(tam._spawned.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('space stop parks work — stopped spaces stay parked and resume cleanly', () => {
    test('stopped space with parked executions: ticks spawn nothing, nag nothing, and change no statuses', async () => {
      const nags: string[] = [];
      const restarted: string[] = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        injectRuntimeRecoveryMessage: async (sessionId) => {
          nags.push(sessionId);
          return `runtime-nag:${sessionId}`;
        },
        restartStuckSubSession: async (sessionId) => {
          restarted.push(sessionId);
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session:before-stop',
        startedAt: Date.now(),
      });
      taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });

      rt.parkInFlightExecutionsForSpace(SPACE_ID);
      db.prepare(`UPDATE spaces SET stopped = 1 WHERE id = ?`).run(SPACE_ID);

      for (let i = 0; i < 4; i++) {
        await rt.executeTick();
      }

      expect(tam._spawned).toEqual([]);
      expect(nags).toEqual([]);
      expect(restarted).toEqual([]);
      const parked = nodeExecutionRepo.getById(execution.id)!;
      expect(parked.status).toBe('pending');
      expect(parked.agentSessionId).toBeNull();
      expect(taskRepo.getTask(tasks[0].id)?.status).toBe('in_progress');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      const crashCounts = (rt as unknown as { taskCrashCounts: Map<string, number> })
        .taskCrashCounts;
      expect(crashCounts.size).toBe(0);
    });

    test('stopped space: dead in-flight session triggers no crash accounting (stop-interrupt window)', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => false,
      });
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session:interrupted-by-stop',
        startedAt: Date.now(),
      });
      taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
      db.prepare(`UPDATE spaces SET stopped = 1 WHERE id = ?`).run(SPACE_ID);

      for (let i = 0; i < 3; i++) {
        await rt.executeTick();
      }

      const unchanged = nodeExecutionRepo.getById(execution.id)!;
      expect(unchanged.status).toBe('in_progress');
      expect(unchanged.agentSessionId).toBe('session:interrupted-by-stop');
      expect(taskRepo.getTask(tasks[0].id)?.status).toBe('in_progress');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      const crashCounts = (rt as unknown as { taskCrashCounts: Map<string, number> })
        .taskCrashCounts;
      expect(crashCounts.size).toBe(0);
    });

    test('start after stop re-drives the parked execution via kickoff spawn without crash accounting', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo);
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session:before-stop',
        startedAt: Date.now(),
      });
      taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
      rt.parkInFlightExecutionsForSpace(SPACE_ID);
      db.prepare(`UPDATE spaces SET stopped = 1 WHERE id = ?`).run(SPACE_ID);

      await rt.executeTick();
      expect(tam._spawned).toEqual([]);

      db.prepare(`UPDATE spaces SET stopped = 0 WHERE id = ?`).run(SPACE_ID);
      await rt.executeTick();

      expect(tam._spawned).toEqual([tasks[0].id]);
      const executionAfter = nodeExecutionRepo.getById(execution.id)!;
      expect(executionAfter.status).toBe('in_progress');
      expect(executionAfter.agentSessionId).toBe(`session:${execution.id}`);
      expect(taskRepo.getTask(tasks[0].id)?.status).toBe('in_progress');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      const crashCounts = (rt as unknown as { taskCrashCounts: Map<string, number> })
        .taskCrashCounts;
      expect(crashCounts.size).toBe(0);
    });

    test('review task with mid-turn submitter and spawned sibling: parked rows stay parked across ticks while stopped', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo);
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
        { id: STEP_B, name: 'Code', agentId: AGENT_CODER },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;
      const submitter = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(submitter.id, {
        status: 'in_progress',
        agentSessionId: `space:${SPACE_ID}:task:${tasks[0].id}:exec:${submitter.id}`,
        startedAt: Date.now(),
      });
      const sibling = nodeExecutionRepo.createOrIgnore({
        workflowRunId: run.id,
        workflowNodeId: STEP_B,
        agentName: 'Code',
        agentId: AGENT_CODER,
        status: 'pending',
      });
      nodeExecutionRepo.update(sibling.id, {
        status: 'in_progress',
        agentSessionId: `space:${SPACE_ID}:task:${tasks[0].id}:exec:${sibling.id}`,
        startedAt: Date.now(),
      });
      taskRepo.updateTask(tasks[0].id, { status: 'review' });

      rt.parkInFlightExecutionsForSpace(SPACE_ID);
      db.prepare(`UPDATE spaces SET stopped = 1 WHERE id = ?`).run(SPACE_ID);

      for (let i = 0; i < 3; i++) {
        await rt.executeTick();
      }

      expect(tam._spawned).toEqual([]);
      for (const exec of [submitter, sibling]) {
        const parked = nodeExecutionRepo.getById(exec.id)!;
        expect(parked.status).toBe('pending');
        expect(parked.agentSessionId).toBeNull();
      }
      expect(taskRepo.getTask(tasks[0].id)?.status).toBe('review');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      const crashCounts = (rt as unknown as { taskCrashCounts: Map<string, number> })
        .taskCrashCounts;
      expect(crashCounts.size).toBe(0);
    });

    test('review task parked at stop: reject then space.start re-drives the submitter via kickoff spawn', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo);
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;
      const submitter = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(submitter.id, {
        status: 'in_progress',
        agentSessionId: `space:${SPACE_ID}:task:${tasks[0].id}:exec:${submitter.id}`,
        startedAt: Date.now(),
      });
      taskRepo.updateTask(tasks[0].id, { status: 'review' });
      rt.parkInFlightExecutionsForSpace(SPACE_ID);
      db.prepare(`UPDATE spaces SET stopped = 1 WHERE id = ?`).run(SPACE_ID);

      await rt.executeTick();
      expect(tam._spawned).toEqual([]);

      const taskManager = new SpaceTaskManager(db, SPACE_ID);
      const rejected = await taskManager.setTaskStatus(tasks[0].id, 'in_progress');
      expect(rejected.status).toBe('in_progress');
      expect(rejected.pendingCheckpointType).toBeNull();

      db.prepare(`UPDATE spaces SET stopped = 0 WHERE id = ?`).run(SPACE_ID);
      await rt.executeTick();

      expect(tam._spawned).toEqual([tasks[0].id]);
      const executionAfter = nodeExecutionRepo.getById(submitter.id)!;
      expect(executionAfter.status).toBe('in_progress');
      expect(executionAfter.agentSessionId).toBe(`session:${submitter.id}`);
      expect(taskRepo.getTask(tasks[0].id)?.status).toBe('in_progress');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      const crashCounts = (rt as unknown as { taskCrashCounts: Map<string, number> })
        .taskCrashCounts;
      expect(crashCounts.size).toBe(0);
    });

    test('stopped space defers run-completion reconciliation and post-approval dispatch until start', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo);
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'idle',
        result: 'work finished just before stop',
        agentSessionId: 'session:finished',
        completedAt: Date.now(),
      });
      taskRepo.updateTask(tasks[0].id, { status: 'in_progress', reportedStatus: 'done' });
      db.prepare(`UPDATE spaces SET stopped = 1 WHERE id = ?`).run(SPACE_ID);

      await rt.executeTick();

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(taskRepo.getTask(tasks[0].id)?.status).toBe('in_progress');
      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('idle');
      expect(tam._spawned).toEqual([]);

      db.prepare(`UPDATE spaces SET stopped = 0 WHERE id = ?`).run(SPACE_ID);
      await rt.executeTick();

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
    });

    test('blocked-only run with exhausted retry budget: stop then start retries instead of escalating', async () => {
      const notifications: Array<{ kind: string; runId?: string }> = [];
      internalEventBus.subscribe(
        'space.workflowRun.needsAttention',
        (payload) => {
          notifications.push({ kind: 'needs_attention', runId: payload.runId });
        },
        { subscriberName: 'test-stop-park:blocked-budget-attention' }
      );
      internalEventBus.subscribe(
        'space.workflowRun.retry',
        (payload) => {
          notifications.push({ kind: 'task_retry', runId: payload.runId });
        },
        { subscriberName: 'test-stop-park:blocked-budget-retry' }
      );
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo);
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'blocked',
        result: 'Agent session crashed',
      });
      taskRepo.updateTask(tasks[0].id, { status: 'blocked' });
      workflowRunRepo.transitionStatus(run.id, 'blocked');
      (rt as unknown as { blockedRetryCounts: Map<string, number> }).blockedRetryCounts.set(
        run.id,
        MAX_BLOCKED_RUN_RETRIES
      );

      rt.parkInFlightExecutionsForSpace(SPACE_ID);
      db.prepare(`UPDATE spaces SET stopped = 1 WHERE id = ?`).run(SPACE_ID);

      await rt.executeTick();
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');

      db.prepare(`UPDATE spaces SET stopped = 0 WHERE id = ?`).run(SPACE_ID);
      await rt.executeTick();

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('pending');
      expect(taskRepo.getTask(tasks[0].id)?.status).toBe('in_progress');
      expect(notifications.filter((n) => n.kind === 'needs_attention')).toEqual([]);
      expect(notifications.some((n) => n.kind === 'task_retry' && n.runId === run.id)).toBe(true);
    });
  });

  describe('cleanupTerminalExecutors', () => {
    test('removes executor for done run', async () => {
      const rt = new SpaceRuntime(buildConfig());

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      expect(rt.executorCount).toBe(1);

      workflowRunRepo.transitionStatus(run.id, 'done');

      await rt.executeTick();

      expect(rt.getExecutor(run.id)).toBeUndefined();
      expect(rt.executorCount).toBe(0);
    });

    test('clears alive-stuck recovery state when removing done run executor', async () => {
      const nags: string[] = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => true,
        getAgentSessionById: () => processingState('processing'),
        injectRuntimeRecoveryMessage: async (sessionId) => {
          nags.push(sessionId);
          return `nag:${sessionId}`;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam, { agentNoProgressThresholdMs: 60_000 }));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session:terminal-stuck-state',
        startedAt: Date.now() - 10 * 60_000,
      });
      saveAssistantMessage('session:terminal-stuck-state', { minutesAgo: 10, toolUse: true });

      await rt.executeTick();
      expect(nags).toEqual(['session:terminal-stuck-state']);

      for (const task of taskRepo.listByWorkflowRun(run.id)) {
        taskRepo.updateTask(task.id, { status: 'done' });
      }
      workflowRunRepo.transitionStatus(run.id, 'done');
      await rt.executeTick();

      expect(rt.getExecutor(run.id)).toBeUndefined();
      expect(
        (rt as unknown as { agentStuckRecovery: Map<string, unknown> }).agentStuckRecovery.size
      ).toBe(0);
    });

    test('clears preserved idle state when removing done run executor', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => false,
      });
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'idle',
        agentSessionId: 'session:terminal-idle-state',
        startedAt: Date.now() - 10 * 60_000,
      });
      saveAssistantMessage('session:terminal-idle-state', { minutesAgo: 10, toolUse: true });

      await rt.executeTick();
      expect(
        (rt as unknown as { nonTerminalIdleStates: Map<string, unknown> }).nonTerminalIdleStates
          .size
      ).toBe(1);

      for (const task of taskRepo.listByWorkflowRun(run.id)) {
        taskRepo.updateTask(task.id, { status: 'done' });
      }
      workflowRunRepo.transitionStatus(run.id, 'done');
      await rt.executeTick();

      expect(rt.getExecutor(run.id)).toBeUndefined();
      expect(
        (rt as unknown as { nonTerminalIdleStates: Map<string, unknown> }).nonTerminalIdleStates
          .size
      ).toBe(0);
    });

    test('removes executor for cancelled run', async () => {
      const rt = new SpaceRuntime(buildConfig());

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      expect(rt.executorCount).toBe(1);

      workflowRunRepo.transitionStatus(run.id, 'cancelled');

      await rt.executeTick();

      expect(rt.getExecutor(run.id)).toBeUndefined();
      expect(rt.executorCount).toBe(0);
    });

    test('removes executor when run record is deleted from DB', async () => {
      const rt = new SpaceRuntime(buildConfig());

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      expect(rt.executorCount).toBe(1);
      for (const task of taskRepo.listByWorkflowRun(run.id)) {
        taskRepo.updateTask(task.id, { status: 'done' });
      }

      db.prepare('DELETE FROM space_workflow_runs WHERE id = ?').run(run.id);

      await rt.executeTick();

      expect(rt.getExecutor(run.id)).toBeUndefined();
      expect(rt.executorCount).toBe(0);
    });

    test('active executor with no run tasks is a safe no-op', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo);
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      taskRepo.updateTask(tasks[0].id, { workflowRunId: null });

      await rt.executeTick();

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(taskRepo.listByWorkflowRun(run.id)).toHaveLength(0);
      expect(rt.getExecutor(run.id)).toBeDefined();
      expect(nodeExecutionRepo.listByWorkflowRun(run.id)[0]?.status).toBe('pending');
    });

    test('active executor with no metadata is a safe no-op', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo);
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      (rt as unknown as { executorMeta: Map<string, unknown> }).executorMeta.delete(run.id);

      await rt.executeTick();

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(taskRepo.getTask(tasks[0].id)?.status).toBe('open');
      expect(rt.getExecutor(run.id)).toBeDefined();
      expect(nodeExecutionRepo.listByWorkflowRun(run.id)[0]?.status).toBe('pending');
    });

    test('active executor with no node executions is a safe no-op', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo);
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      db.prepare('DELETE FROM node_executions WHERE workflow_run_id = ?').run(run.id);

      await rt.executeTick();

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(taskRepo.getTask(tasks[0].id)?.status).toBe('open');
      expect(rt.getExecutor(run.id)).toBeDefined();
      expect(nodeExecutionRepo.listByWorkflowRun(run.id)).toHaveLength(0);
    });

    test('cleanupTerminalExecutors leaves in_progress runs alone', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isTaskAgentAlive: () => true,
      });
      const rt = new SpaceRuntime(buildConfig(tam));

      const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const wf2 = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_B, name: 'Code', agentId: AGENT_CODER },
      ]);

      const { run: run1 } = await rt.startWorkflowRun(SPACE_ID, wf1.id, 'Run 1');
      const { run: run2 } = await rt.startWorkflowRun(SPACE_ID, wf2.id, 'Run 2');

      workflowRunRepo.transitionStatus(run1.id, 'cancelled');

      await rt.executeTick();

      expect(rt.getExecutor(run1.id)).toBeUndefined();
      expect(rt.getExecutor(run2.id)).toBeDefined();
      expect(rt.executorCount).toBe(1);
    });
  });

  describe('approval-gate and success-result nag suppression', () => {
    test('does not nag when task is pending task_completion approval', async () => {
      const nags: string[] = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => true,
        getAgentSessionById: () => processingState('processing'),
        injectRuntimeRecoveryMessage: async (sessionId) => {
          nags.push(sessionId);
          return `nag:${sessionId}`;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam, { agentNoProgressThresholdMs: 60_000 }));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session:awaiting-approval',
        startedAt: Date.now() - 20 * 60_000,
      });
      taskRepo.updateTask(tasks[0].id, {
        status: 'review',
        pendingCheckpointType: 'task_completion',
      });

      await rt.executeTick();

      expect(nags).toHaveLength(0);
    });

    test('does not nag when execution has a result and task is in review', async () => {
      const nags: string[] = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => true,
        getAgentSessionById: () => processingState('processing'),
        injectRuntimeRecoveryMessage: async (sessionId) => {
          nags.push(sessionId);
          return `nag:${sessionId}`;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam, { agentNoProgressThresholdMs: 60_000 }));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session:has-result',
        startedAt: Date.now() - 20 * 60_000,
        result: 'PR #42 opened at https://github.com/example/repo/pull/42',
      });
      taskRepo.updateTask(tasks[0].id, {
        status: 'review',
      });

      await rt.executeTick();

      expect(nags).toHaveLength(0);
    });
  });

  describe('multiple independent workflow runs in same tick', () => {
    test('tick spawns agents for tasks across multiple runs', async () => {
      db.prepare(`UPDATE spaces SET max_concurrent_tasks = ? WHERE id = ?`).run(2, SPACE_ID);

      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isTaskAgentAlive: (taskId: string) => {
          const task = taskRepo.getTask(taskId);
          return !!task?.taskAgentSessionId;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam));

      const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const wf2 = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_B, name: 'Code', agentId: AGENT_CODER },
      ]);

      const { tasks: tasks1 } = await rt.startWorkflowRun(SPACE_ID, wf1.id, 'Run 1');
      const { tasks: tasks2 } = await rt.startWorkflowRun(SPACE_ID, wf2.id, 'Run 2');

      await rt.executeTick();

      expect(tam._spawned).toContain(tasks1[0].id);
      expect(tam._spawned).toContain(tasks2[0].id);

      expect(taskRepo.getTask(tasks1[0].id)!.status).toBe('in_progress');
      expect(taskRepo.getTask(tasks2[0].id)!.status).toBe('in_progress');
    });

    test('one run completing does not affect sibling run processing', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isTaskAgentAlive: () => true,
      });
      const rt = new SpaceRuntime(buildConfig(tam));

      const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const wf2 = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_B, name: 'Code', agentId: AGENT_CODER },
      ]);

      const { run: run1 } = await rt.startWorkflowRun(SPACE_ID, wf1.id, 'Run 1');
      const { run: run2 } = await rt.startWorkflowRun(SPACE_ID, wf2.id, 'Run 2');

      await rt.executeTick();
      expect(rt.executorCount).toBe(2);

      workflowRunRepo.transitionStatus(run1.id, 'done');

      await rt.executeTick();

      expect(rt.getExecutor(run1.id)).toBeUndefined();
      expect(rt.getExecutor(run2.id)).toBeDefined();
      expect(rt.executorCount).toBe(1);
    });
  });

  describe('start() / stop() lifecycle', () => {
    test('start() is idempotent — calling twice does not create duplicate timers', async () => {
      const origSetInterval = globalThis.setInterval;
      let intervalCount = 0;
      globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
        intervalCount++;
        return origSetInterval(...args);
      }) as typeof setInterval;

      try {
        const rt = new SpaceRuntime(buildConfig());
        rt.start();
        rt.start();

        expect(intervalCount).toBe(1);
        await rt.stop();
      } finally {
        globalThis.setInterval = origSetInterval;
      }
    });

    test('stop() clears the timer — clearInterval is called', async () => {
      const origClearInterval = globalThis.clearInterval;
      let clearCalled = false;
      globalThis.clearInterval = ((...args: Parameters<typeof clearInterval>) => {
        clearCalled = true;
        return origClearInterval(...args);
      }) as typeof clearInterval;

      try {
        const rt = new SpaceRuntime(buildConfig());
        rt.start();
        expect(clearCalled).toBe(false);

        await rt.stop();
        expect(clearCalled).toBe(true);
      } finally {
        globalThis.clearInterval = origClearInterval;
      }
    });

    test('stop() when not started is a no-op', async () => {
      const rt = new SpaceRuntime(buildConfig());

      await expect(rt.stop()).resolves.toBeUndefined();
    });

    test('start() can be called again after stop() — creates a new timer', async () => {
      const origSetInterval = globalThis.setInterval;
      let intervalCount = 0;
      globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
        intervalCount++;
        return origSetInterval(...args);
      }) as typeof setInterval;

      try {
        const rt = new SpaceRuntime(buildConfig());

        rt.start();
        expect(intervalCount).toBe(1);

        await rt.stop();

        rt.start();
        expect(intervalCount).toBe(2);

        await rt.stop();
      } finally {
        globalThis.setInterval = origSetInterval;
      }
    });
  });

  describe('tick handles spawn failure gracefully', () => {
    test('spawn failure for one task does not prevent spawning another task', async () => {
      db.prepare(`UPDATE spaces SET max_concurrent_tasks = ? WHERE id = ?`).run(2, SPACE_ID);

      let callCount = 0;
      const spawned: string[] = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isTaskAgentAlive: (taskId: string) => {
          const task = taskRepo.getTask(taskId);
          return !!task?.taskAgentSessionId;
        },
        spawnWorkflowNodeAgent: async (task: unknown) => {
          const t = task as { id: string };
          callCount++;
          if (callCount === 1) {
            throw new Error('Simulated spawn failure');
          }
          spawned.push(t.id);
          taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
          return `session:${t.id}`;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam));

      const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const wf2 = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_B, name: 'Code', agentId: AGENT_CODER },
      ]);

      const { tasks: tasks1 } = await rt.startWorkflowRun(SPACE_ID, wf1.id, 'Run 1');
      const { tasks: tasks2 } = await rt.startWorkflowRun(SPACE_ID, wf2.id, 'Run 2');

      await rt.executeTick();

      expect(callCount).toBe(2);
      expect(taskRepo.getTask(tasks1[0].id)!.status).toBe('in_progress');
      expect(spawned).toContain(tasks2[0].id);
      expect(taskRepo.getTask(tasks2[0].id)!.status).toBe('in_progress');
    });

    test('spawn failure keeps task in open status for retry on next tick', async () => {
      let failOnce = true;
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isTaskAgentAlive: (taskId: string) => {
          const task = taskRepo.getTask(taskId);
          return !!task?.taskAgentSessionId;
        },
        spawnWorkflowNodeAgent: async (task: unknown) => {
          const t = task as { id: string };
          if (failOnce) {
            failOnce = false;
            throw new Error('Transient failure');
          }
          taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
          return `session:${t.id}`;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam));

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      await rt.executeTick();
      const tasks = taskRepo.listByWorkflowRun(workflowRunRepo.listBySpace(SPACE_ID)[0].id);
      expect(tasks[0].status).toBe('in_progress');
      const runExecsAfterFail = nodeExecutionRepo.listByWorkflowRun(tasks[0].workflowRunId!);
      expect(runExecsAfterFail.some((exec) => exec.status === 'pending')).toBe(true);

      await rt.executeTick();
      const updated = taskRepo.getTask(tasks[0].id)!;
      expect(updated.status).toBe('in_progress');
      expect(updated.taskAgentSessionId).toBeTruthy();
    });

    test('a superseded spawn skips for this tick without cancelling, blocking, or retrying (superpipe P5)', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        spawnWorkflowNodeAgentForExecution: async (_task, _space, _workflow, _run, execution) => {
          const exec = execution as { id: string; agentName: string };
          if (exec.agentName === 'Planner') {
            throw new SpawnSupersededError(exec.id, 'reserve-task-spawn');
          }
          const sessionId = `session:${exec.agentName}:new`;
          nodeExecutionRepo.update(exec.id, {
            status: 'in_progress',
            agentSessionId: sessionId,
            startedAt: Date.now(),
            completedAt: null,
          });
          return sessionId;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam));

      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Superseded spawn ${Date.now()}`,
        description: 'Test',
        nodes: [
          {
            id: STEP_A,
            name: 'Build',
            agents: [
              { agentId: AGENT_PLANNER, name: 'Planner' },
              { agentId: AGENT_CODER, name: 'Coder' },
            ],
          },
          {
            id: STEP_B,
            name: 'Done',
            agents: [{ agentId: AGENT_PLANNER, name: 'Finisher' }],
          },
        ],
        transitions: [{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, order: 0 }],
        startNodeId: STEP_A,
        endNodeId: STEP_B,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });
      const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      await rt.executeTick();

      const executions = nodeExecutionRepo.listByWorkflowRun(tasks[0].workflowRunId!);
      const planner = executions.find((exec) => exec.agentName === 'Planner');
      const coder = executions.find((exec) => exec.agentName === 'Coder');
      expect(planner?.status).toBe('pending');
      expect(planner?.agentSessionId).toBeNull();
      expect(coder?.status).toBe('in_progress');
      expect(coder?.agentSessionId).toBe('session:Coder:new');

      const run = workflowRunRepo.getRun(tasks[0].workflowRunId!);
      expect(run?.status).toBe('in_progress');
      expect(taskRepo.getTask(tasks[0].id)!.status).toBe('in_progress');
    });

    test('a park landing mid-spawn-pass is not undone by the trailing open→in_progress update (PR #2770 review)', async () => {
      let parked = false;
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        spawnWorkflowNodeAgentForExecution: async (_task, _space, _workflow, _run, execution) => {
          const exec = execution as { id: string; agentName: string };
          if (!parked) {
            parked = true;
            taskRepo.updateTask(
              taskRepo.listByWorkflowRun(workflowRunRepo.listBySpace(SPACE_ID)[0].id)[0].id,
              { status: 'stopped' }
            );
          }
          throw new SpawnSupersededError(exec.id, 'reserve-task-spawn');
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam));

      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Park mid-spawn ${Date.now()}`,
        description: 'Test',
        nodes: [
          {
            id: STEP_A,
            name: 'Build',
            agents: [
              { agentId: AGENT_PLANNER, name: 'Planner' },
              { agentId: AGENT_CODER, name: 'Coder' },
            ],
          },
          {
            id: STEP_B,
            name: 'Done',
            agents: [{ agentId: AGENT_PLANNER, name: 'Finisher' }],
          },
        ],
        transitions: [{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, order: 0 }],
        startNodeId: STEP_A,
        endNodeId: STEP_B,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });
      const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      await rt.executeTick();

      expect(taskRepo.getTask(tasks[0].id)!.status).toBe('stopped');
      const executions = nodeExecutionRepo.listByWorkflowRun(tasks[0].workflowRunId!);
      expect(executions.every((exec) => exec.status === 'pending')).toBe(true);
    });

    test('persistent worktree creation failure fails closed with bounded retry then blocked task', async () => {
      const WORKTREE_ERROR =
        'Task worktree creation failed for workflow task; refusing to spawn a node agent in the shared space workspace: git worktree add failed';
      let spawnAttempts = 0;
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        spawnWorkflowNodeAgentForExecution: async () => {
          spawnAttempts++;
          throw new Error(WORKTREE_ERROR);
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam));

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const runId = tasks[0].workflowRunId!;

      await rt.executeTick();
      await rt.executeTick();
      let execution = nodeExecutionRepo.listByWorkflowRun(runId)[0];
      expect(execution.status).toBe('pending');
      expect(execution.agentSessionId).toBeNull();

      await rt.executeTick();
      execution = nodeExecutionRepo.listByWorkflowRun(runId)[0];
      expect(execution.status).toBe('blocked');
      expect(execution.result).toContain('worktree');
      expect(execution.result).toContain('3 times');

      const task = taskRepo.getTask(tasks[0].id)!;
      expect(task.status).toBe('blocked');
      expect(task.result).toContain('worktree');
      expect(task.blockReason).toBe('agent_crashed');

      expect(spawnAttempts).toBe(3);
    });
  });

  describe('rehydration does not duplicate executors from startWorkflowRun', () => {
    test('startWorkflowRun before first tick — rehydration skips already-registered executor', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isTaskAgentAlive: () => true,
      });
      const rt = new SpaceRuntime(buildConfig(tam));

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      expect(rt.executorCount).toBe(1);

      await rt.executeTick();
      expect(rt.executorCount).toBe(1);
      expect(rt.getExecutor(run.id)).toBeDefined();
    });
  });

  describe('rehydration happens exactly once', () => {
    test('rehydrate is called exactly once across multiple ticks', async () => {
      let rehydrateCount = 0;
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        rehydrate: async () => {
          rehydrateCount++;
        },
        isTaskAgentAlive: () => true,
      });
      const rt = new SpaceRuntime(buildConfig(tam));

      await rt.executeTick();
      await rt.executeTick();
      await rt.executeTick();

      expect(rehydrateCount).toBe(1);
    });
  });

  describe('auto-resume of rate/usage-limited tasks', () => {
    test('restores a paused task whose resetAt has passed (cross-restart backstop)', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo);
      const rt = new SpaceRuntime(buildConfig(tam));

      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'capped',
        description: '',
      });
      taskRepo.updateTask(task.id, { status: 'usage_limited' });
      taskRepo.updateTask(task.id, {
        status: 'usage_limited',
        restrictions: {
          type: 'usage_limit',
          limit: 'parsed-reset',
          resetAt: Date.now() - 60_000,
          sessionRole: 'worker',
        },
      });

      await rt.executeTick();

      const restored = taskRepo.getTask(task.id)!;
      expect(restored.status).toBe('in_progress');
      expect(restored.restrictions).toBeNull();
    });

    test('leaves a paused task whose resetAt is still in the future', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo);
      const rt = new SpaceRuntime(buildConfig(tam));

      const task = taskRepo.createTask({ spaceId: SPACE_ID, title: 'capped', description: '' });
      const futureReset = Date.now() + 60 * 60 * 1000;
      taskRepo.updateTask(task.id, {
        status: 'rate_limited',
        restrictions: {
          type: 'rate_limit',
          limit: 'backoff-ladder',
          resetAt: futureReset,
          sessionRole: 'worker',
        },
      });

      await rt.executeTick();

      const still = taskRepo.getTask(task.id)!;
      expect(still.status).toBe('rate_limited');
      expect(still.restrictions?.resetAt).toBe(futureReset);
    });
  });

  describe('KNOWN-BUG phase-0: park-during-spawn (task #1190, stagedRun ADR 0004)', () => {
    test('KNOWN-BUG phase-0: task parked stopped between spawn-loop iterations still spawns the next agent', async () => {
      const events: string[] = [];
      const liveSessions = new Set<string>();
      let releaseFirstSpawn!: () => void;
      let signalFirstSpawnStarted!: () => void;
      const firstSpawnStarted = new Promise<void>((resolve) => {
        signalFirstSpawnStarted = resolve;
      });
      const firstSpawnGate = new Promise<void>((resolve) => {
        releaseFirstSpawn = resolve;
      });
      const tam = {
        rehydrate: async () => {},
        isExecutionSpawning: () => false,
        isSessionAlive: (sessionId: string) => liveSessions.has(sessionId),
        getAgentSessionById: () => null,
        restartStuckSubSession: async () => {},
        injectRuntimeRecoveryMessage: async (sessionId: string) => `runtime-nag:${sessionId}`,
        cancelBySessionId: () => {},
        interruptBySessionId: async () => {},
        getSubSessionIdsForTasks: () => [],
        stopSessionsVerified: async (sessionIds: string[]) => {
          for (const sessionId of sessionIds) liveSessions.delete(sessionId);
          return sessionIds.map((sessionId) => ({ sessionId, stopped: true }));
        },
        cleanup: async () => {},
        spawnWorkflowNodeAgentForExecution: async (
          _task: unknown,
          _space: unknown,
          _workflow: unknown,
          _run: unknown,
          execution: unknown
        ) => {
          const exec = execution as { id: string };
          events.push(`spawn:${exec.id}`);
          const sessionId = `session:${exec.id}`;
          liveSessions.add(sessionId);
          nodeExecutionRepo.update(exec.id, {
            status: 'in_progress',
            agentSessionId: sessionId,
            startedAt: Date.now(),
            completedAt: null,
          });
          if (events.length === 1) {
            signalFirstSpawnStarted();
            await firstSpawnGate;
          }
          return sessionId;
        },
      };

      const rt = new SpaceRuntime({
        ...buildConfig(),
        taskAgentManager: tam as never,
      });
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Park During Spawn ${Date.now()}-${Math.random()}`,
        description: 'Test',
        nodes: [
          {
            id: STEP_A,
            name: 'Build',
            agents: [
              { agentId: AGENT_PLANNER, name: 'Planner' },
              { agentId: AGENT_CODER, name: 'Coder' },
            ],
          },
          {
            id: STEP_B,
            name: 'Finish',
            agents: [{ agentId: AGENT_PLANNER, name: 'Finisher' }],
          },
        ],
        transitions: [{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, order: 0 }],
        startNodeId: STEP_A,
        endNodeId: STEP_B,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'in_progress' });
      expect(nodeExecutionRepo.listByWorkflowRun(run.id)).toHaveLength(2);

      const tickPromise = rt.executeTick();
      await firstSpawnStarted;
      const parked = await rt.parkStoppedWorkflowTask(SPACE_ID, task.id);
      expect(parked?.status).toBe('stopped');
      events.push('park');
      releaseFirstSpawn();
      await tickPromise;

      expect(events).toHaveLength(3);
      expect(events[1]).toBe('park');
      const firstSpawnedExecutionId = events[0]!.slice('spawn:'.length);
      const secondSpawnedExecutionId = events[2]!.slice('spawn:'.length);
      expect(secondSpawnedExecutionId).not.toBe(firstSpawnedExecutionId);

      expect(taskRepo.getTask(task.id)?.status).toBe('stopped');
      const parkedExecution = nodeExecutionRepo.getById(firstSpawnedExecutionId)!;
      expect(parkedExecution.status).toBe('pending');
      expect(parkedExecution.agentSessionId).toBeNull();
      const spawnedDespitePark = nodeExecutionRepo.getById(secondSpawnedExecutionId)!;
      expect(spawnedDespitePark.status).toBe('in_progress');
      expect(spawnedDespitePark.agentSessionId).toBe(`session:${secondSpawnedExecutionId}`);
    });
  });
});
