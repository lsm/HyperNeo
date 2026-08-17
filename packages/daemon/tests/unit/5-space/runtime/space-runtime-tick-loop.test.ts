/**
 * SpaceRuntime — Tick Loop Correctness Tests
 *
 * Covers tick loop behaviors NOT covered by the main space-runtime.test.ts:
 * - Tick picks up tasks from new workflow runs created between ticks
 * - Multiple ticks do not duplicate executors for the same run
 * - Tick processes multiple independent workflow runs in the same tick
 * - processCompletedTasks error isolation (one bad run doesn't starve others)
 * - Executor creation failure during rehydration is handled gracefully
 * - cleanupTerminalExecutors removes 'done' runs (not just cancelled)
 * - start()/stop() lifecycle: timer management, idempotent start, stop clears timer
 * - Tick spawns agents for tasks added to an existing run between ticks
 */

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
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceWorkflow } from '@hyperneo/shared';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
  // Use in-memory SQLite — faster than file-based DB and avoids filesystem
  // I/O contention that caused beforeEach hook timeouts in CI.
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

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Mock TaskAgentManager factory
// ---------------------------------------------------------------------------

function makeMockTaskAgentManager(
  taskRepo: SpaceTaskRepository,
  nodeExecutionRepo: NodeExecutionRepository,
  overrides: {
    isSpawning?: (taskId: string) => boolean;
    isTaskAgentAlive?: (taskId: string) => boolean;
    spawnWorkflowNodeAgent?: (task: unknown) => Promise<string>;
    isExecutionSpawning?: (executionId: string) => boolean;
    isSessionAlive?: (sessionId: string) => boolean;
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
  return {
    isSpawning: overrides.isSpawning ?? (() => false),
    isTaskAgentAlive: overrides.isTaskAgentAlive ?? (() => false),
    spawnWorkflowNodeAgent: spawnImpl,
    isExecutionSpawning: overrides.isExecutionSpawning ?? (() => false),
    isSessionAlive:
      overrides.isSessionAlive ??
      ((sessionId: string) => {
        if (!overrides.isTaskAgentAlive) return false;
        const taskId = sessionToTask.get(sessionId);
        return taskId ? overrides.isTaskAgentAlive(taskId) : false;
      }),
    spawnWorkflowNodeAgentForExecution: spawnExecutionImpl,
    rehydrate: overrides.rehydrate ?? (async () => {}),
    cancelBySessionId: overrides.cancelBySessionId ?? (() => {}),
    interruptBySessionId: overrides.interruptBySessionId ?? (async () => {}),
    restartStuckSubSession: overrides.restartStuckSubSession ?? (async () => {}),
    injectRuntimeRecoveryMessage:
      overrides.injectRuntimeRecoveryMessage ??
      (async (sessionId: string) => `runtime-nag:${sessionId}`),
    getAgentSessionById: overrides.getAgentSessionById ?? (() => null),
    // PR 3/5 added a post-approval awareness injection via
    // `injectIntoTaskAgent`. The tick-loop mock is not exercising delivery,
    // so return a trivial "not injected" result — production treats this as
    // best-effort anyway.
    injectIntoTaskAgent: async () => ({ injected: false, reason: 'no-session' }),
    _spawned: spawned,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SpaceRuntime — tick loop correctness', () => {
  // Covers the per-tick scheduling/dispatch loop and approval → router
  // hand-off. The legacy approval→done dispatch path was removed in PR 4/5;
  // `dispatchPostApproval` is the only route now.

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
    // Seed agents in second space too
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
    } catch {
      /* ignore */
    }
    try {
    } catch {
      /* ignore */
    }
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

  // -------------------------------------------------------------------------
  // Tick picks up new tasks with workflow runs
  // -------------------------------------------------------------------------

  describe('tick picks up new tasks from workflow runs', () => {
    test('tick spawns agent for task created by startWorkflowRun before first tick', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo);
      const rt = new SpaceRuntime(buildConfig(tam));

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      expect(tasks[0].status).toBe('open');

      // First tick picks up the pending task and spawns agent
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

      // First tick — no runs yet
      await rt.executeTick();
      expect(tam._spawned).toHaveLength(0);

      // Create a workflow run between ticks
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Late Run');

      // Second tick picks up the new run's task
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

      // First tick spawns agent for first task
      await rt.executeTick();
      expect(tam._spawned).toContain(tasks[0].id);
      const firstSpawnCount = tam._spawned.length;

      // Simulate a new task being added to the same run (e.g., by channel activation)
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

      // Second tick picks up the new task
      await rt.executeTick();
      expect(tam._spawned.length).toBeGreaterThan(firstSpawnCount);
      expect(taskRepo.getTask(tasks[0].id)!.status).toBe('in_progress');
      expect(taskRepo.getTask(newTask.id)!.status).toBe('archived');
    });
  });

  // -------------------------------------------------------------------------
  // Multiple ticks do not duplicate executors
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Tick skips already-running tasks
  // -------------------------------------------------------------------------

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

      // First tick spawns
      await rt.executeTick();
      expect(spawnCount).toBe(1);

      // Subsequent ticks skip alive agent
      await rt.executeTick();
      await rt.executeTick();
      await rt.executeTick();
      expect(spawnCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // processCompletedTasks error isolation
  // -------------------------------------------------------------------------

  describe('processCompletedTasks error isolation', () => {
    test('error in one run does not prevent processing the other run', async () => {
      // Strategy: create two runs with the real spaceManager, then build a
      // fresh runtime with a faulty spaceManager that throws for SPACE_ID.
      // The fresh runtime rehydrates both runs on first tick, then
      // processRunTick throws for run1 but succeeds for run2.
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

      // Create runs with real spaceManager so startWorkflowRun succeeds
      const realRt = new SpaceRuntime(buildConfig(tam));
      const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const wf2 = buildLinearWorkflow(SPACE_ID_2, workflowManager, [
        { id: STEP_B, name: 'Code', agentId: `${AGENT_CODER}-s2` },
      ]);
      await realRt.startWorkflowRun(SPACE_ID, wf1.id, 'Failing Run');
      const { tasks: tasks2 } = await realRt.startWorkflowRun(SPACE_ID_2, wf2.id, 'Good Run');

      // Now build a fresh runtime with a faulty spaceManager
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

      // executeTick rehydrates both runs, then processRunTick throws for run1
      // but continues to process run2. Re-throws the first error at the end.
      await expect(faultyRt.executeTick()).rejects.toThrow('Simulated DB corruption');

      // The good run's task was spawned successfully despite the sibling error
      expect(spawned).toContain(tasks2[0].id);
      expect(taskRepo.getTask(tasks2[0].id)!.status).toBe('in_progress');
    });

    test('first error is re-thrown after all runs are processed', async () => {
      // Create two runs with real spaceManager first
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

      // Build fresh runtime with getSpace that always throws
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

      // Both runs error, but executeTick re-throws (first error only)
      // after processing all runs — it doesn't bail on the first error.
      await expect(faultyRt.executeTick()).rejects.toThrow('getSpace always fails');

      // Both executors are still in the map (error doesn't remove them)
      expect(faultyRt.executorCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Executor creation failure during rehydration
  // -------------------------------------------------------------------------

  describe('rehydration graceful failure handling', () => {
    test('rehydration skips run whose workflow was deleted (no throw)', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      // Create a run directly via repo
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Orphan Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Delete the workflow — rehydration should skip this run
      // Simulate a workflow deleted out from under an active run — a legacy
      // orphan the deletion guard (RFC §4 #3) now prevents in normal operation,
      // but which rehydration must still tolerate. Bypass the manager guard by
      // deleting at the repo level (no active-run check).
      new SpaceWorkflowRepository(db).deleteWorkflow(workflow.id);

      const freshRt = new SpaceRuntime(buildConfig());
      await expect(freshRt.executeTick()).resolves.toBeUndefined();
      expect(freshRt.executorCount).toBe(0);
    });

    test('rehydration does not duplicate executors on second tick', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      // Create a run that will be rehydrated
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Rehydrate Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      // Also create a task for it
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Plan',
        description: '',
        workflowRunId: run.id,
        status: 'open',
      });

      const freshRt = new SpaceRuntime(buildConfig());

      // First tick triggers rehydration
      await freshRt.executeTick();
      expect(freshRt.executorCount).toBe(1);

      // Second tick does NOT re-rehydrate
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

  // -------------------------------------------------------------------------
  // Layer 1 runtime anti-stuck recovery
  // -------------------------------------------------------------------------

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

    // -------------------------------------------------------------------------
    // lastActivityAt-driven detection (task #943)
    // -------------------------------------------------------------------------

    test('does NOT nag an actively-working agent whose lastActivityAt is fresh', async () => {
      // Reproduces the observed false-stall: an in_progress node whose
      // startedAt and last SDK message are 20min stale (the OLD signals), but
      // whose lastActivityAt is fresh because the agent is pushing commits /
      // making tool calls / exchanging messages. The stall detector must key
      // off lastActivityAt and NOT nag an agent that is plainly working.
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
      // Old SDK message — under the pre-lastActivityAt logic this alone would nag.
      saveAssistantMessage('session:actively-working', { minutesAgo: 20, toolUse: true });
      // Fresh activity signal — agent just tooled/pushed/messaged.
      nodeExecutionRepo.touchLastActivity(execution.id, Date.now());

      await rt.executeTick();

      expect(nags).toEqual([]);
      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('in_progress');
    });

    test('nags a genuinely-stuck agent whose lastActivityAt is stale', async () => {
      // Counterpoint: when lastActivityAt IS stale (no tool calls, no messages,
      // no commits for 20min) the detector must still fire — lastActivityAt is
      // authoritative precisely because it is the real-activity signal.
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
      // Stale activity — last genuine work was 20min ago.
      nodeExecutionRepo.touchLastActivity(execution.id, Date.now() - 20 * 60_000);

      await rt.executeTick();

      expect(nags).toHaveLength(1);
      expect(nags[0].sessionId).toBe('session:stuck');
      expect(nags[0].message).toContain('[Runtime recovery notice]');
    });

    test('does NOT nag when a recent SDK message is newer than a stale lastActivityAt', async () => {
      // lastActivityAt is stale (an old tool call 20min ago) but a fresh SDK
      // message shows the agent just made progress. The detector must take the
      // NEWEST applicable timestamp — a stale lastActivityAt must not shadow a
      // newer SDK message, or the agent gets nagged/restarted despite just
      // having produced output. (Regression guard for the ??-chain ordering bug.)
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
      // Stale activity, fresh SDK message.
      nodeExecutionRepo.touchLastActivity(execution.id, Date.now() - 20 * 60_000);
      saveAssistantMessage('session:recent-sdk', { minutesAgo: 0, toolUse: true });

      await rt.executeTick();

      expect(nags).toEqual([]);
      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('in_progress');
    });
  });

  // -------------------------------------------------------------------------
  // cleanupTerminalExecutors for 'done' runs
  // -------------------------------------------------------------------------

  describe('cleanupTerminalExecutors', () => {
    test('removes executor for done run', async () => {
      const rt = new SpaceRuntime(buildConfig());

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      expect(rt.executorCount).toBe(1);

      // Mark run as done externally
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

      // Delete the run record entirely
      db.prepare('DELETE FROM space_workflow_runs WHERE id = ?').run(run.id);

      await rt.executeTick();

      expect(rt.getExecutor(run.id)).toBeUndefined();
      expect(rt.executorCount).toBe(0);
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

      // Cancel run1, leave run2 in_progress
      workflowRunRepo.transitionStatus(run1.id, 'cancelled');

      await rt.executeTick();

      expect(rt.getExecutor(run1.id)).toBeUndefined();
      expect(rt.getExecutor(run2.id)).toBeDefined();
      expect(rt.executorCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Approval-gate and success-result nag suppression
  // -------------------------------------------------------------------------

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
      // Mark task as awaiting approval
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

  // -------------------------------------------------------------------------
  // Multiple independent workflow runs processed in same tick
  // -------------------------------------------------------------------------

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

      // Single tick spawns agents for both runs
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

      // Tick to spawn both
      await rt.executeTick();
      expect(rt.executorCount).toBe(2);

      // Complete run1 externally
      workflowRunRepo.transitionStatus(run1.id, 'done');

      // Next tick cleans up run1, keeps run2
      await rt.executeTick();

      expect(rt.getExecutor(run1.id)).toBeUndefined();
      expect(rt.getExecutor(run2.id)).toBeDefined();
      expect(rt.executorCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // start() / stop() lifecycle
  // -------------------------------------------------------------------------

  describe('start() / stop() lifecycle', () => {
    test('start() is idempotent — calling twice does not create duplicate timers', async () => {
      // Intercept setInterval to count how many timers are created
      const origSetInterval = globalThis.setInterval;
      let intervalCount = 0;
      globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
        intervalCount++;
        return origSetInterval(...args);
      }) as typeof setInterval;

      try {
        const rt = new SpaceRuntime(buildConfig());
        rt.start();
        rt.start(); // second call should be no-op

        // Only one interval should have been created
        expect(intervalCount).toBe(1);
        await rt.stop();
      } finally {
        globalThis.setInterval = origSetInterval;
      }
    });

    test('stop() clears the timer — clearInterval is called', async () => {
      // Use a deterministic approach: intercept clearInterval to verify it's called
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

      // Should not throw
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

        // Restart — should create a new interval
        rt.start();
        expect(intervalCount).toBe(2);

        await rt.stop();
      } finally {
        globalThis.setInterval = origSetInterval;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Spawn failure handling
  // -------------------------------------------------------------------------

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

      // Create two separate workflow runs so tasks are processed in order
      const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const wf2 = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_B, name: 'Code', agentId: AGENT_CODER },
      ]);

      const { tasks: tasks1 } = await rt.startWorkflowRun(SPACE_ID, wf1.id, 'Run 1');
      const { tasks: tasks2 } = await rt.startWorkflowRun(SPACE_ID, wf2.id, 'Run 2');

      // Tick — first spawn fails, second should succeed
      await rt.executeTick();

      expect(callCount).toBe(2);
      // First task failed to spawn — run task remains in_progress while execution retries stay pending
      expect(taskRepo.getTask(tasks1[0].id)!.status).toBe('in_progress');
      // Second task should have been spawned successfully
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

      // First tick — spawn fails, task stays open
      await rt.executeTick();
      const tasks = taskRepo.listByWorkflowRun(workflowRunRepo.listBySpace(SPACE_ID)[0].id);
      expect(tasks[0].status).toBe('in_progress');
      const runExecsAfterFail = nodeExecutionRepo.listByWorkflowRun(tasks[0].workflowRunId!);
      expect(runExecsAfterFail.some((exec) => exec.status === 'pending')).toBe(true);

      // Second tick — spawn succeeds (failOnce is now false)
      await rt.executeTick();
      const updated = taskRepo.getTask(tasks[0].id)!;
      expect(updated.status).toBe('in_progress');
      expect(updated.taskAgentSessionId).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Race condition: rehydration + fresh executor from startWorkflowRun
  // -------------------------------------------------------------------------

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

      // startWorkflowRun already registered the executor.
      // First executeTick triggers rehydration — should NOT duplicate.
      expect(rt.executorCount).toBe(1);

      await rt.executeTick();
      expect(rt.executorCount).toBe(1);
      expect(rt.getExecutor(run.id)).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // executeTick rehydration happens exactly once
  // -------------------------------------------------------------------------

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

      // TaskAgentManager.rehydrate() called exactly once (on the first tick)
      expect(rehydrateCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Auto-resume of rate/usage-limited tasks across daemon restarts
  // (recoverRateLimitedTasks). The in-memory watchdog cooldown does not survive
  // a restart; this tick sweep is driven off the persisted restrictions.resetAt.
  // -------------------------------------------------------------------------
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
          resetAt: Date.now() - 60_000, // reset already passed
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

  // -------------------------------------------------------------------------
  // Stopped space: pause + interrupt, never cancel.
  //
  // `space.stop` marks the space stopped (the registered onSpaceStopped
  // callback synchronously adds it to the runtime's pausedSpaceIds hold
  // cache) and parks in-flight node executions (pending + blank session
  // binding — the clean-recovery reset). While stopped the tick loop must
  // not spawn, nag, restart, or churn blocked-run recovery, and no status
  // may change; `space.start` re-drives the parked executions via the
  // normal spawn path with fresh kickoff sessions and no crash accounting.
  // -------------------------------------------------------------------------

  describe('stopped space pauses supervision without cancelling work', () => {
    test('stopped space with parked executions: no spawn, no nag, no crash accounting, statuses unchanged', async () => {
      const nags: string[] = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        injectRuntimeRecoveryMessage: async (sessionId) => {
          nags.push(sessionId);
          return `runtime-nag:${sessionId}`;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      // First tick while active: spawn drives the execution in_progress.
      await rt.executeTick();
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      expect(execution.status).toBe('in_progress');
      expect(execution.agentSessionId).toBeTruthy();
      const spawnCountAfterStart = tam._spawned.length;

      // Stop: space row flagged (delivery hold lands via the constructor-
      // registered onSpaceStopped callback) and in-flight executions parked —
      // exactly what stopActiveWork does in production.
      await spaceManager.stopSpace(SPACE_ID);
      rt.parkInFlightExecutionsForSpace(SPACE_ID);

      const parked = nodeExecutionRepo.getById(execution.id)!;
      expect(parked.status).toBe('pending');
      expect(parked.agentSessionId).toBeNull();

      for (let i = 0; i < 3; i++) {
        await rt.executeTick();
      }

      expect(tam._spawned).toHaveLength(spawnCountAfterStart);
      expect(nags).toEqual([]);
      const after = nodeExecutionRepo.getById(execution.id)!;
      expect(after.status).toBe('pending');
      expect(after.agentSessionId).toBeNull();
      // Nothing was cancelled — task and run keep their statuses.
      expect(taskRepo.getTask(tasks[0].id)!.status).toBe('in_progress');
      expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
      // No crash accounting was charged against the parked execution.
      expect((rt as unknown as { taskCrashCounts: Map<string, number> }).taskCrashCounts.size).toBe(
        0
      );
    });

    test('stopped space does not churn blocked-run recovery', async () => {
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo);
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_B, name: 'Code', agentId: AGENT_CODER },
      ]);

      // Seed a blocked run directly (no tick needed — the executor is
      // rehydrated on the first tick below, stopped or not).
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Blocked Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      workflowRunRepo.transitionStatus(run.id, 'blocked');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Code',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_B,
        status: 'blocked',
      });
      nodeExecutionRepo.createOrIgnore({
        workflowRunId: run.id,
        workflowNodeId: STEP_B,
        agentName: 'Code',
        agentId: AGENT_CODER,
        status: 'blocked',
      });

      // Stop the space, then tick: attemptBlockedRunRecovery must hold.
      await spaceManager.stopSpace(SPACE_ID);
      await rt.executeTick();
      await rt.executeTick();

      expect(workflowRunRepo.getRun(run.id)!.status).toBe('blocked');
      expect(taskRepo.getTask(task.id)!.status).toBe('blocked');
      expect(nodeExecutionRepo.listByWorkflowRun(run.id)[0]!.status).toBe('blocked');
      expect(tam._spawned).toHaveLength(0);
      expect(
        (rt as unknown as { blockedRetryCounts: Map<string, number> }).blockedRetryCounts.size
      ).toBe(0);
    });

    test('paused space does not nag a live idle-stuck session awake', async () => {
      // Alive-stuck nag/restart must not wake sessions while scheduling is
      // held. Same fixture as the genuinely-stuck nag test, but paused.
      const nags: string[] = [];
      const restarts: string[] = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => true,
        getAgentSessionById: () => processingState('processing'),
        injectRuntimeRecoveryMessage: async (sessionId) => {
          nags.push(sessionId);
          return `runtime-nag:${sessionId}`;
        },
        restartStuckSubSession: async (sessionId) => {
          restarts.push(sessionId);
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
        agentSessionId: 'session:paused-stuck',
        startedAt: Date.now() - 20 * 60_000,
      });
      saveAssistantMessage('session:paused-stuck', { minutesAgo: 20, toolUse: true });
      nodeExecutionRepo.touchLastActivity(execution.id, Date.now() - 20 * 60_000);

      await spaceManager.pauseSpace(SPACE_ID);
      await rt.executeTick();
      await rt.executeTick();

      expect(nags).toEqual([]);
      expect(restarts).toEqual([]);
      const after = nodeExecutionRepo.getById(execution.id)!;
      expect(after.status).toBe('in_progress');
      expect(after.agentSessionId).toBe('session:paused-stuck');
      expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
    });

    test('space.start after stop re-drives the parked execution with a fresh kickoff', async () => {
      let spawnCalls = 0;
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        // Unique session id per spawn so the resumed kickoff is visibly a
        // NEW session, not the pre-stop one re-derived from the execution id.
        spawnWorkflowNodeAgentForExecution: async (
          _task: unknown,
          _space: unknown,
          _workflow: unknown,
          _run: unknown,
          execution: unknown
        ) => {
          spawnCalls++;
          const e = execution as { id: string };
          const sessionId = `session:resume-${e.id}-${spawnCalls}`;
          nodeExecutionRepo.update(e.id, {
            status: 'in_progress',
            agentSessionId: sessionId,
            startedAt: Date.now(),
            completedAt: null,
          });
          return sessionId;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      // Spawn, stop, park — then verify the stop held for one tick.
      await rt.executeTick();
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      const preStopSessionId = execution.agentSessionId!;
      expect(preStopSessionId).toBeTruthy();

      await spaceManager.stopSpace(SPACE_ID);
      rt.parkInFlightExecutionsForSpace(SPACE_ID);
      await rt.executeTick();
      expect(nodeExecutionRepo.getById(execution.id)!.status).toBe('pending');

      // space.start: the resume hook clears the delivery hold and the spawn
      // loop re-drives the parked execution with a fresh kickoff session.
      await spaceManager.startSpace(SPACE_ID);
      await rt.executeTick();

      const resumed = nodeExecutionRepo.getById(execution.id)!;
      expect(spawnCalls).toBe(2); // initial kickoff + post-resume re-drive
      expect(resumed.status).toBe('in_progress');
      expect(resumed.agentSessionId).toBeTruthy();
      expect(resumed.agentSessionId).not.toBe(preStopSessionId);
      expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
      // Resume is a clean recovery — no crash retries charged.
      expect((rt as unknown as { taskCrashCounts: Map<string, number> }).taskCrashCounts.size).toBe(
        0
      );
    });

    test('stopped space (no park) does not nag or restart a live idle-stuck session', async () => {
      // The stopped half of the alive-stuck guard — the in-process face of a
      // spawn that raced the stop: a live session bound to an in_progress
      // execution inside a stopped space must not be woken by the runtime.
      const nags: string[] = [];
      const restarts: string[] = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => true,
        getAgentSessionById: () => processingState('processing'),
        injectRuntimeRecoveryMessage: async (sessionId) => {
          nags.push(sessionId);
          return `runtime-nag:${sessionId}`;
        },
        restartStuckSubSession: async (sessionId) => {
          restarts.push(sessionId);
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
        agentSessionId: 'session:stopped-stuck',
        startedAt: Date.now() - 20 * 60_000,
      });
      saveAssistantMessage('session:stopped-stuck', { minutesAgo: 20, toolUse: true });
      nodeExecutionRepo.touchLastActivity(execution.id, Date.now() - 20 * 60_000);

      // Stop WITHOUT parking — the session stays bound and live.
      await spaceManager.stopSpace(SPACE_ID);
      await rt.executeTick();
      await rt.executeTick();

      expect(nags).toEqual([]);
      expect(restarts).toEqual([]);
      const after = nodeExecutionRepo.getById(execution.id)!;
      expect(after.status).toBe('in_progress');
      expect(after.agentSessionId).toBe('session:stopped-stuck');
    });

    test('stopped space holds dead-session crash accounting (no retries, no blocked flip)', async () => {
      // A session-bearing row whose session is genuinely dead (e.g. left by a
      // stop racing a spawn) must not consume crash retries or flip the run
      // blocked while the space is stopped.
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
        status: 'in_progress',
        agentSessionId: 'session:dead-remnant',
        startedAt: Date.now() - 5 * 60_000,
      });

      await spaceManager.stopSpace(SPACE_ID);
      for (let i = 0; i < 3; i++) {
        await rt.executeTick();
      }

      // Row untouched, no crash accounting, run not blocked.
      const after = nodeExecutionRepo.getById(execution.id)!;
      expect(after.status).toBe('in_progress');
      expect(after.agentSessionId).toBe('session:dead-remnant');
      expect((rt as unknown as { taskCrashCounts: Map<string, number> }).taskCrashCounts.size).toBe(
        0
      );
      expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
    });

    test('stopped space holds waiting_rebind rows — no fail-and-block, no rebound spawn', async () => {
      // A waiting_rebind row that slipped past stop's park (e.g. raced) must
      // not be failed-and-blocked nor rebound into a fresh spawn while the
      // space is stopped.
      const spawns: string[] = [];
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => false,
        spawnWorkflowNodeAgentForExecution: async (
          _task: unknown,
          _space: unknown,
          _workflow: unknown,
          _run: unknown,
          execution: unknown
        ) => {
          const e = execution as { id: string };
          spawns.push(e.id);
          return `session:rebind-${e.id}`;
        },
      });
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'waiting_rebind',
        agentSessionId: 'session:rebind-dead',
      });

      await spaceManager.stopSpace(SPACE_ID);
      await rt.executeTick();
      await rt.executeTick();

      const after = nodeExecutionRepo.getById(execution.id)!;
      expect(after.status).toBe('waiting_rebind');
      expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
      // The task was never spawned (the row was flipped to waiting_rebind
      // before the first tick), so it stays open — the assertion is that the
      // hold did NOT fail-and-block it.
      expect(taskRepo.getTask(tasks[0].id)!.status).toBe('open');
      expect(spawns).toEqual([]);
    });

    test('park is a no-op after the space resumed (stop→start race)', async () => {
      // If space.start lands between the stop and the park call, the delivery
      // hold is already released and park must not strip live session
      // bindings of the resumed space.
      const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, {
        isSessionAlive: () => true,
      });
      const rt = new SpaceRuntime(buildConfig(tam));
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session:still-live',
        startedAt: Date.now(),
      });

      await spaceManager.stopSpace(SPACE_ID);
      // Resume BEFORE parking — onSpaceResumed releases the hold.
      await spaceManager.startSpace(SPACE_ID);
      rt.parkInFlightExecutionsForSpace(SPACE_ID);

      const after = nodeExecutionRepo.getById(execution.id)!;
      expect(after.status).toBe('in_progress');
      expect(after.agentSessionId).toBe('session:still-live');
    });

    test('spawn aborts when the space stops mid-spawn (fresh session interrupted, execution left pending)', async () => {
      // The live-window face of the stop/spawn race: the runtime's spawn gate
      // passed while the space was active, but the space row flipped to
      // stopped before the session registered. The real TaskAgentManager
      // spawn must re-check the row after registration and abort BEFORE
      // stamping the execution or injecting the kickoff.
      const cancelled: string[] = [];
      const realTam = new TaskAgentManager({
        db: { getDatabase: () => db, getSession: () => null },
        internalEventBus: { subscribe: () => () => {} },
        spaceManager,
        spaceAgentManager: agentManager,
        spaceWorkflowManager: workflowManager,
        taskRepo,
        workflowRunRepo,
        nodeExecutionRepo,
      } as unknown as ConstructorParameters<typeof TaskAgentManager>[0]);
      const fakeSession = { id: 'session:race-window' };
      (
        realTam as unknown as {
          createSubSession: (taskId: string, sessionId: string) => Promise<string>;
        }
      ).createSubSession = async (_taskId: string, sessionId: string) => sessionId;
      (realTam as unknown as { getSubSession: (sessionId: string) => unknown }).getSubSession =
        () => fakeSession;
      (realTam as unknown as { cancelBySessionId: (sessionId: string) => void }).cancelBySessionId =
        (sessionId: string) => {
          cancelled.push(sessionId);
        };

      const rt = new SpaceRuntime(buildConfig());
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      const task = taskRepo.getTask(tasks[0].id)!;
      const space = await spaceManager.getSpace(SPACE_ID);

      // Stop lands while the spawn is in flight (after the gate, before the
      // stamp): the spawn sees the fresh stopped row and self-aborts.
      await spaceManager.stopSpace(SPACE_ID);
      await expect(
        realTam.spawnWorkflowNodeAgentForExecution(task, space, workflow, run, execution, {
          kickoff: true,
        })
      ).rejects.toThrow(/stopped during spawn/);

      // The just-created session was torn down (DB-preserving cancel), and
      // the execution was never stamped — it stays parked-pending.
      expect(cancelled).toHaveLength(1);
      const after = nodeExecutionRepo.getById(execution.id)!;
      expect(after.status).toBe('pending');
      expect(after.agentSessionId).toBeNull();
    });
  });
});
