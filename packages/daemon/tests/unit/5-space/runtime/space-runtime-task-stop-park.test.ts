import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { NodeExecutionStatus, SpaceTask, SpaceWorkflow } from '@hyperneo/shared';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';
import { ExternalEventService } from '../../../../src/lib/external-events/external-event-service';
import { ExternalEventStore } from '../../../../src/lib/external-events/external-event-store';
import type { ExternalEvent } from '../../../../src/lib/external-events/types';
import { createInternalCommandBus } from '../../../../src/lib/internal-command-bus';

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

function seedSpaceRow(db: BunDatabase, spaceId: string, workspacePath: string): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, max_concurrent_tasks, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', 2, ?, ?)`
  ).run(spaceId, workspacePath, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, `Agent ${agentId}`, Date.now(), Date.now());
}

interface ParkTam {
  isSessionAlive: (sessionId: string) => boolean;
  isSessionInMemory: (sessionId: string) => boolean;
  isSpawning: (taskId: string) => boolean;
  isExecutionSpawning: (executionId: string) => boolean;
  isTaskAgentAlive: (taskId: string) => boolean;
  getSubSessionIdsForTasks: (taskIds: string[]) => string[];
  getLiveSubSessionIdsForTasks: (taskIds: string[]) => string[];
  stopSessionsVerified: (
    sessionIds: string[]
  ) => Promise<Array<{ sessionId: string; stopped: boolean }>>;
  cleanup: (taskId: string, reason: string) => Promise<void>;
  spawnWorkflowNodeAgentForExecution: (
    task: unknown,
    space: unknown,
    workflow: unknown,
    run: unknown,
    execution: unknown,
    options?: unknown
  ) => Promise<string>;
  getAgentSessionById: (sessionId: string) => unknown;
  interruptBySessionId: (sessionId: string) => Promise<void>;
  cancelBySessionId: (sessionId: string) => void;
  injectRuntimeRecoveryMessage: (sessionId: string, message: string) => Promise<string>;
  restartStuckSubSession: (sessionId: string) => Promise<void>;
  injectIntoTaskAgent: () => Promise<{ injected: boolean; reason: string }>;
  rehydrate: () => Promise<void>;
  activateTargetSessionsForMessage: (
    taskId: string,
    workflowRunId: string,
    agentName: string,
    options?: unknown
  ) => Promise<Array<{ agentName: string; sessionId: string }>>;
}

function makeParkTam(
  nodeExecutionRepo: NodeExecutionRepository,
  opts: {
    liveSessionIds?: string[];
    subSessionsByTask?: Record<string, string[]>;
    verifiedStopOutcome?: 'ok' | 'partial' | 'reject';
    cleanupRejects?: boolean;
  } = {}
): ParkTam & {
  _spawned: Array<{ taskId: string; executionId: string; options: unknown }>;
  _verifiedStopCalls: string[][];
  _cleanupCalls: Array<{ taskId: string; reason: string }>;
  _injectCalls: string[];
  _restartCalls: string[];
  _activateCalls: Array<{ taskId: string; agentName: string }>;
} {
  const live = new Set(opts.liveSessionIds ?? []);
  const spawned: Array<{ taskId: string; executionId: string; options: unknown }> = [];
  const verifiedStopCalls: string[][] = [];
  const cleanupCalls: Array<{ taskId: string; reason: string }> = [];
  const injectCalls: string[] = [];
  const restartCalls: string[] = [];
  const activateCalls: Array<{ taskId: string; agentName: string }> = [];
  return {
    isSessionAlive: (sessionId) => live.has(sessionId),
    isSessionInMemory: (sessionId) => live.has(sessionId),
    isSpawning: () => false,
    isExecutionSpawning: () => false,
    isTaskAgentAlive: () => false,
    getSubSessionIdsForTasks: (taskIds) =>
      taskIds.flatMap((taskId) => opts.subSessionsByTask?.[taskId] ?? []),
    getLiveSubSessionIdsForTasks: (taskIds) =>
      taskIds.flatMap((taskId) => opts.subSessionsByTask?.[taskId] ?? []),
    stopSessionsVerified: async (sessionIds) => {
      verifiedStopCalls.push([...sessionIds]);
      if (opts.verifiedStopOutcome === 'reject') {
        throw new Error('verified stop exploded');
      }
      for (const sessionId of sessionIds) live.delete(sessionId);
      if (opts.verifiedStopOutcome === 'partial') {
        return sessionIds.map((sessionId, index) =>
          index === 0
            ? { sessionId, stopped: true }
            : { sessionId, stopped: false, detail: 'still alive: processing state' }
        );
      }
      return sessionIds.map((sessionId) => ({ sessionId, stopped: true }));
    },
    cleanup: async (taskId, reason) => {
      cleanupCalls.push({ taskId, reason });
      if (opts.cleanupRejects) {
        throw new Error('cleanup exploded');
      }
    },
    spawnWorkflowNodeAgentForExecution: async (
      task,
      _space,
      _workflow,
      _run,
      execution,
      options
    ) => {
      const t = task as { id: string };
      const e = execution as { id: string };
      const sessionId = `session:exec:${e.id}`;
      live.add(sessionId);
      spawned.push({ taskId: t.id, executionId: e.id, options });
      nodeExecutionRepo.update(e.id, {
        status: 'in_progress',
        agentSessionId: sessionId,
        startedAt: Date.now(),
        completedAt: null,
      });
      return sessionId;
    },
    getAgentSessionById: () => null,
    interruptBySessionId: async () => {},
    cancelBySessionId: () => {},
    injectRuntimeRecoveryMessage: async (sessionId) => {
      injectCalls.push(sessionId);
      return `runtime-nag:${sessionId}`;
    },
    restartStuckSubSession: async (sessionId) => {
      restartCalls.push(sessionId);
    },
    injectIntoTaskAgent: async () => ({ injected: false, reason: 'no-session' }),
    rehydrate: async () => {},
    activateTargetSessionsForMessage: async (taskId, _workflowRunId, agentName) => {
      activateCalls.push({ taskId, agentName });
      return [];
    },
    _spawned: spawned,
    _verifiedStopCalls: verifiedStopCalls,
    _cleanupCalls: cleanupCalls,
    _injectCalls: injectCalls,
    _restartCalls: restartCalls,
    _activateCalls: activateCalls,
  };
}

describe('SpaceRuntime — task-level stop parks the run', () => {
  let db: BunDatabase;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let agentManager: SpaceAgentManager;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;
  let nodeExecutionRepo: NodeExecutionRepository;
  let sdkMessageRepo: SDKMessageRepository;
  let bus: InternalEventBus<DaemonInternalEventMap>;
  let notifications: Array<{ eventName: string; payload: Record<string, unknown> }>;

  const SPACE_ID = 'space-task-stop';
  const AGENT = 'agent-task-stop';

  function buildRuntime(
    tam?: ReturnType<typeof makeParkTam>,
    overrides: Partial<SpaceRuntimeConfig> = {}
  ): SpaceRuntime {
    const config: SpaceRuntimeConfig = {
      db,
      spaceManager,
      spaceAgentManager: agentManager,
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      sdkMessageRepo,
      internalEventBus: bus,
      ...(tam ? { taskAgentManager: tam as never } : {}),
      ...overrides,
    };
    return new SpaceRuntime(config);
  }

  function buildWorkflow(spaceId: string, agentId: string = AGENT) {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const nodes = [
      { id: `step-a-${token}`, name: 'Step A', agentId },
      { id: `step-b-${token}`, name: 'Step B', agentId },
      { id: `step-c-${token}`, name: 'Step C', agentId },
      { id: `step-d-${token}`, name: 'Step D', agentId },
    ];
    const workflow: SpaceWorkflow = workflowManager.createWorkflow({
      spaceId,
      name: `Workflow-${token}`,
      description: 'Test',
      nodes,
      transitions: nodes.slice(0, -1).map((step, i) => ({
        from: step.id,
        to: nodes[i + 1].id,
        condition: { type: 'always' as const },
        order: 0,
      })),
      channels: nodes.slice(0, -1).map((step, i) => ({
        id: `${step.id}-to-${nodes[i + 1].id}`,
        from: step.name,
        to: nodes[i + 1].name,
      })),
      startNodeId: nodes[0].id,
      endNodeId: nodes.at(-1)?.id,
      rules: [],
      tags: [],
      completionAutonomyLevel: 3,
    });
    return {
      workflow,
      stepA: nodes[0].id,
      stepB: nodes[1].id,
      stepC: nodes[2].id,
      stepD: nodes[3].id,
    };
  }

  function createRun(spaceId: string, workflowId: string, title: string) {
    const run = workflowRunRepo.createRun({ spaceId, workflowId, title });
    workflowRunRepo.transitionStatus(run.id, 'in_progress');
    return run;
  }

  function seedExec(
    runId: string,
    nodeId: string,
    agentName: string,
    status: NodeExecutionStatus,
    opts: { agentSessionId?: string | null; result?: string | null } = {}
  ) {
    const created = nodeExecutionRepo.createOrIgnore({
      workflowRunId: runId,
      workflowNodeId: nodeId,
      agentName,
      agentId: AGENT,
      status: 'pending',
    });
    nodeExecutionRepo.update(created.id, {
      status,
      agentSessionId: opts.agentSessionId ?? null,
      result: opts.result ?? null,
      ...(status === 'in_progress' ? { startedAt: Date.now() } : {}),
    });
    return created;
  }

  function seedTask(
    runId: string,
    opts: {
      status?: string;
      taskAgentSessionId?: string | null;
      result?: string | null;
      reportedSummary?: string | null;
    } = {}
  ) {
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Task to stop',
      description: '',
      workflowRunId: runId,
      status: opts.status ?? 'in_progress',
      taskAgentSessionId: opts.taskAgentSessionId ?? null,
    });
    if (opts.result !== undefined || opts.reportedSummary !== undefined) {
      return taskRepo.updateTask(task.id, {
        result: opts.result ?? null,
        reportedSummary: opts.reportedSummary ?? null,
      })!;
    }
    return task;
  }

  beforeEach(() => {
    db = makeDb();
    seedSpaceRow(db, SPACE_ID, '/tmp/ws-task-stop');
    seedAgentRow(db, AGENT, SPACE_ID);

    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    taskRepo = new SpaceTaskRepository(db);
    nodeExecutionRepo = new NodeExecutionRepository(db);
    sdkMessageRepo = new SDKMessageRepository(db);
    const agentRepo = new SpaceAgentRepository(db);
    agentManager = new SpaceAgentManager(agentRepo);
    const workflowRepo = new SpaceWorkflowRepository(db);
    workflowManager = new SpaceWorkflowManager(workflowRepo);
    spaceManager = new SpaceManager(db);
    bus = new InternalEventBus<DaemonInternalEventMap>();
    notifications = [];
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  describe('parkStoppedWorkflowTask()', () => {
    test('verified-interrupts the task live sessions, parks in-flight executions, preserves the run', async () => {
      const { workflow, stepA, stepB, stepC, stepD } = buildWorkflow(SPACE_ID);
      const run = createRun(SPACE_ID, workflow.id, 'Stop Run');
      const task = seedTask(run.id, {
        taskAgentSessionId: 'session-task-agent',
        result: 'partial result so far',
        reportedSummary: 'partial summary so far',
      });
      const execInFlight = seedExec(run.id, stepA, 'Step A', 'in_progress', {
        agentSessionId: 'session-in-flight',
      });
      const execRebind = seedExec(run.id, stepB, 'Step B', 'waiting_rebind', {
        agentSessionId: 'session-rebind',
        result: 'waiting for orphaned tool_result recovery',
      });
      const execIdle = seedExec(run.id, stepC, 'Step C', 'idle', {
        agentSessionId: 'session-idle',
        result: 'finished work',
      });
      seedExec(run.id, stepD, 'Step D', 'cancelled', {
        agentSessionId: 'session-dead',
      });
      const baseTam = makeParkTam(nodeExecutionRepo, {
        liveSessionIds: [
          'session-in-flight',
          'session-rebind',
          'session-idle',
          'session-task-agent',
          'session-sub-extra',
        ],
        subSessionsByTask: { [task.id]: ['session-sub-extra'] },
      });
      const taskStatusAtVerifiedStop: Array<string | null> = [];
      const tam = {
        ...baseTam,
        stopSessionsVerified: async (sessionIds: string[]) => {
          taskStatusAtVerifiedStop.push(taskRepo.getTask(task.id)?.status ?? null);
          return baseTam.stopSessionsVerified(sessionIds);
        },
      };

      const updated = await buildRuntime(tam).parkStoppedWorkflowTask(SPACE_ID, task.id);

      expect(taskStatusAtVerifiedStop).toEqual(['stopped']);

      expect(tam._verifiedStopCalls).toHaveLength(1);
      expect([...tam._verifiedStopCalls[0]].sort()).toEqual(
        [
          'session-in-flight',
          'session-rebind',
          'session-idle',
          'session-task-agent',
          'session-sub-extra',
        ].sort()
      );
      expect(tam._cleanupCalls).toEqual([{ taskId: task.id, reason: 'stopped' }]);

      const parked = nodeExecutionRepo.getById(execInFlight.id)!;
      expect(parked.status).toBe('pending');
      expect(parked.result).toBeNull();
      expect(parked.agentSessionId).toBeNull();

      const rebind = nodeExecutionRepo.getById(execRebind.id)!;
      expect(rebind.status).toBe('waiting_rebind');
      expect(rebind.agentSessionId).toBe('session-rebind');
      expect(rebind.result).toBe('waiting for orphaned tool_result recovery');

      const idle = nodeExecutionRepo.getById(execIdle.id)!;
      expect(idle.status).toBe('idle');
      expect(idle.agentSessionId).toBe('session-idle');

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(updated?.status).toBe('stopped');
      expect(updated?.result).toBe('partial result so far');
      expect(updated?.reportedSummary).toBe('partial summary so far');
      expect(taskRepo.getTask(task.id)?.status).toBe('stopped');
    });

    test('covers the idle review submitter and live siblings when stopping a review-status task', async () => {
      const { workflow, stepA, stepB } = buildWorkflow(SPACE_ID);
      const run = createRun(SPACE_ID, workflow.id, 'Review Run');
      const task = seedTask(run.id, { status: 'review' });
      seedExec(run.id, stepA, 'Step A', 'idle', {
        agentSessionId: 'session-submitter',
        result: 'submitted for review',
      });
      seedExec(run.id, stepB, 'Step B', 'in_progress', {
        agentSessionId: 'session-sibling',
      });
      const tam = makeParkTam(nodeExecutionRepo, {
        liveSessionIds: ['session-submitter', 'session-sibling', 'session-sibling-sub'],
        subSessionsByTask: { [task.id]: ['session-sibling-sub'] },
      });

      const updated = await buildRuntime(tam).parkStoppedWorkflowTask(SPACE_ID, task.id);

      expect(tam._verifiedStopCalls).toHaveLength(1);
      expect([...tam._verifiedStopCalls[0]].sort()).toEqual(
        ['session-submitter', 'session-sibling', 'session-sibling-sub'].sort()
      );
      expect(updated?.status).toBe('stopped');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(tam._cleanupCalls).toEqual([{ taskId: task.id, reason: 'stopped' }]);
    });

    test('rejects an invalid transition before interrupting or parking anything', async () => {
      const { workflow, stepA } = buildWorkflow(SPACE_ID);
      const run = createRun(SPACE_ID, workflow.id, 'Open Run');
      const task = seedTask(run.id, { status: 'open' });
      const exec = seedExec(run.id, stepA, 'Step A', 'in_progress', {
        agentSessionId: 'session-in-flight',
      });
      const tam = makeParkTam(nodeExecutionRepo, {
        liveSessionIds: ['session-in-flight'],
      });

      await expect(buildRuntime(tam).parkStoppedWorkflowTask(SPACE_ID, task.id)).rejects.toThrow(
        "Invalid status transition from 'open' to 'stopped'."
      );

      expect(tam._verifiedStopCalls).toHaveLength(0);
      expect(tam._cleanupCalls).toHaveLength(0);
      expect(nodeExecutionRepo.getById(exec.id)?.status).toBe('in_progress');
      expect(taskRepo.getTask(task.id)?.status).toBe('open');
    });

    test('parks and writes stopped even without a task agent manager', async () => {
      const { workflow, stepA } = buildWorkflow(SPACE_ID);
      const run = createRun(SPACE_ID, workflow.id, 'No Tam Run');
      const task = seedTask(run.id);
      const exec = seedExec(run.id, stepA, 'Step A', 'in_progress', {
        agentSessionId: 'session-in-flight',
      });

      const updated = await buildRuntime().parkStoppedWorkflowTask(SPACE_ID, task.id);

      expect(updated?.status).toBe('stopped');
      expect(nodeExecutionRepo.getById(exec.id)?.status).toBe('pending');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
    });
  });

  describe('interrupt fail-open outcomes', () => {
    async function seedStoppableTask() {
      const { workflow, stepA } = buildWorkflow(SPACE_ID);
      const run = createRun(SPACE_ID, workflow.id, 'Fail-Open Run');
      const task = seedTask(run.id, { taskAgentSessionId: 'session-task-agent' });
      const exec = seedExec(run.id, stepA, 'Step A', 'in_progress', {
        agentSessionId: 'session-in-flight',
      });
      return { run, task, exec };
    }

    test('a partially-verified stop still parks executions and writes stopped', async () => {
      const { run, task, exec } = await seedStoppableTask();
      const tam = makeParkTam(nodeExecutionRepo, {
        liveSessionIds: ['session-in-flight', 'session-task-agent'],
        verifiedStopOutcome: 'partial',
      });

      const updated = await buildRuntime(tam).parkStoppedWorkflowTask(SPACE_ID, task.id);

      expect(updated?.status).toBe('stopped');
      expect(tam._verifiedStopCalls).toHaveLength(1);
      const parked = nodeExecutionRepo.getById(exec.id)!;
      expect(parked.status).toBe('pending');
      expect(parked.agentSessionId).toBeNull();
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
    });

    test('stopSessionsVerified rejecting still parks executions and writes stopped', async () => {
      const { run, task, exec } = await seedStoppableTask();
      const tam = makeParkTam(nodeExecutionRepo, {
        liveSessionIds: ['session-in-flight', 'session-task-agent'],
        verifiedStopOutcome: 'reject',
      });

      const updated = await buildRuntime(tam).parkStoppedWorkflowTask(SPACE_ID, task.id);

      expect(updated?.status).toBe('stopped');
      expect(nodeExecutionRepo.getById(exec.id)?.status).toBe('pending');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
    });

    test('cleanup rejecting still parks executions and writes stopped', async () => {
      const { run, task, exec } = await seedStoppableTask();
      const tam = makeParkTam(nodeExecutionRepo, {
        liveSessionIds: ['session-in-flight'],
        cleanupRejects: true,
      });

      const updated = await buildRuntime(tam).parkStoppedWorkflowTask(SPACE_ID, task.id);

      expect(updated?.status).toBe('stopped');
      expect(tam._cleanupCalls).toHaveLength(1);
      expect(nodeExecutionRepo.getById(exec.id)?.status).toBe('pending');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
    });
  });

  describe('leaving the stopped state', () => {
    test('cancelling a stopped task tears down its run so it does not stay stranded', async () => {
      const { workflow, stepA } = buildWorkflow(SPACE_ID);
      const run = createRun(SPACE_ID, workflow.id, 'Cancel After Stop Run');
      const task = seedTask(run.id, { taskAgentSessionId: 'session-task-agent' });
      seedExec(run.id, stepA, 'Step A', 'in_progress', {
        agentSessionId: 'session-in-flight',
      });
      const rt = buildRuntime(
        makeParkTam(nodeExecutionRepo, {
          liveSessionIds: ['session-in-flight', 'session-task-agent'],
        })
      );
      await rt.parkStoppedWorkflowTask(SPACE_ID, task.id);
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');

      const cancelled = await rt.stopWorkflowBackedTaskForStatus(SPACE_ID, task.id, {
        status: 'cancelled',
      });

      expect(cancelled?.status).toBe('cancelled');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('cancelled');
    });

    test('a stopped review task on a done run does not break the tick', async () => {
      const { workflow, stepA } = buildWorkflow(SPACE_ID);
      const run = createRun(SPACE_ID, workflow.id, 'Review Park Run');
      const task = seedTask(run.id);
      taskRepo.updateTask(task.id, { status: 'review' });
      seedExec(run.id, stepA, 'Step A', 'idle', {
        agentSessionId: 'session-submitter',
        result: 'work finished',
      });
      workflowRunRepo.transitionStatus(run.id, 'done');

      const rt = buildRuntime(
        makeParkTam(nodeExecutionRepo, { liveSessionIds: ['session-submitter'] })
      );
      await rt.parkStoppedWorkflowTask(SPACE_ID, task.id);

      await expect(rt.executeTick()).resolves.toBeUndefined();

      expect(taskRepo.getTask(task.id)?.status).toBe('stopped');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
    });

    test('a stopped task on a done run that is reopened does not break the tick', async () => {
      const { workflow, stepA } = buildWorkflow(SPACE_ID);
      const run = createRun(SPACE_ID, workflow.id, 'Reopen Done Run');
      const task = seedTask(run.id);
      taskRepo.updateTask(task.id, { status: 'review' });
      seedExec(run.id, stepA, 'Step A', 'idle', {
        agentSessionId: 'session-submitter',
        result: 'work finished',
      });
      workflowRunRepo.transitionStatus(run.id, 'done');

      const rt = buildRuntime(
        makeParkTam(nodeExecutionRepo, { liveSessionIds: ['session-submitter'] })
      );
      await rt.parkStoppedWorkflowTask(SPACE_ID, task.id);
      const reopened = await rt.stopWorkflowBackedTaskForStatus(SPACE_ID, task.id, {
        status: 'open',
      });
      expect(reopened?.status).toBe('open');

      await expect(rt.executeTick()).resolves.toBeUndefined();
      await expect(rt.executeTick()).resolves.toBeUndefined();

      expect(taskRepo.getTask(task.id)?.status).toBe('open');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('done');
    });

    test('submitting a parked task for approval does not respawn parked agents', async () => {
      const tam = makeParkTam(nodeExecutionRepo);
      const rt = buildRuntime(tam);
      const { workflow } = buildWorkflow(SPACE_ID);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Park Submit Run');
      const task = tasks[0];
      await rt.executeTick();
      expect(tam._spawned).toHaveLength(1);
      await rt.parkStoppedWorkflowTask(SPACE_ID, task.id);

      const taskManager = (
        rt as unknown as {
          getOrCreateTaskManager: (spaceId: string) => {
            submitTaskForReview: (
              taskId: string,
              opts: { submittedByNodeId: string | null; reason: string | null }
            ) => Promise<SpaceTask>;
          };
        }
      ).getOrCreateTaskManager(SPACE_ID);
      const submitted = await taskManager.submitTaskForReview(task.id, {
        submittedByNodeId: null,
        reason: 'work complete while parked',
      });
      expect(submitted.status).toBe('review');

      await rt.executeTick();

      expect(tam._spawned).toHaveLength(1);
      expect(taskRepo.getTask(task.id)?.status).toBe('review');
      const execs = nodeExecutionRepo.listByWorkflowRun(run.id);
      expect(
        execs
          .filter((e) => e.status === 'pending')
          .every((e) => !e.agentSessionId && e.startedAt !== null)
      ).toBe(true);
    });

    test('an approved parked task does not respawn parked agents', async () => {
      const tam = makeParkTam(nodeExecutionRepo);
      const rt = buildRuntime(tam);
      const { workflow } = buildWorkflow(SPACE_ID);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Approved Park Run');
      const task = tasks[0];
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'pending',
        agentSessionId: null,
        startedAt: Date.now(),
      });
      taskRepo.updateTask(task.id, { status: 'approved' });

      await rt.executeTick();

      expect(tam._spawned).toHaveLength(0);
      expect(taskRepo.getTask(task.id)?.status).toBe('approved');
      const parked = nodeExecutionRepo.getById(execution.id)!;
      expect(parked.status).toBe('pending');
      expect(parked.startedAt).not.toBeNull();
      expect(parked.agentSessionId).toBeNull();
    });

    test('a review task with fresh pending work still spawns after a restart', async () => {
      const tam = makeParkTam(nodeExecutionRepo);
      const rt = buildRuntime(tam);
      const { workflow } = buildWorkflow(SPACE_ID);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Review Fresh Run');
      const task = tasks[0];
      expect(
        nodeExecutionRepo
          .listByWorkflowRun(run.id)
          .every((e) => e.status !== 'in_progress' && e.startedAt === null)
      ).toBe(true);

      const taskManager = (
        rt as unknown as {
          getOrCreateTaskManager: (spaceId: string) => {
            submitTaskForReview: (
              taskId: string,
              opts: { submittedByNodeId: string | null; reason: string | null }
            ) => Promise<SpaceTask>;
          };
        }
      ).getOrCreateTaskManager(SPACE_ID);
      const submitted = await taskManager.submitTaskForReview(task.id, {
        submittedByNodeId: null,
        reason: 'submitted before any spawn',
      });
      expect(submitted.status).toBe('review');

      await rt.executeTick();

      expect(tam._spawned).toHaveLength(1);
    });

    test('resume clears a stale completion stamp left while parked', async () => {
      const tam = makeParkTam(nodeExecutionRepo);
      const rt = buildRuntime(tam);
      const { workflow } = buildWorkflow(SPACE_ID);
      const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Stale Stamp Run');
      const task = tasks[0];
      await rt.executeTick();
      await rt.parkStoppedWorkflowTask(SPACE_ID, task.id);
      taskRepo.updateTask(task.id, {
        reportedStatus: 'done',
        reportedSummary: 'stale completion',
        pendingCompletionReason: 'end_node',
      });

      const recovered = await rt.recoverWorkflowBackedTask(SPACE_ID, task.id, 'in_progress');

      expect(recovered.task.status).toBe('in_progress');
      const after = taskRepo.getTask(task.id);
      expect(after?.reportedStatus).toBeNull();
      expect(after?.reportedSummary).toBeNull();
      expect(after?.pendingCompletionReason).toBeNull();
    });
  });

  describe('stopped-task guards', () => {
    function saveAssistantMessage(
      sessionId: string,
      opts: { minutesAgo: number; terminal?: boolean }
    ): void {
      const content = [{ type: 'text', text: 'work update' }];
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
    }

    test('attemptBlockedRunRecovery does not auto-retry a stopped task run', async () => {
      const tam = makeParkTam(nodeExecutionRepo);
      const rt = buildRuntime(tam);

      const { workflow } = buildWorkflow(SPACE_ID);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Blocked Run');
      const task = tasks[0];
      await rt.executeTick();
      const exec = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(exec.id, { status: 'blocked', result: 'agent blocked' });
      workflowRunRepo.transitionStatus(run.id, 'blocked');

      await rt.parkStoppedWorkflowTask(SPACE_ID, task.id);
      await rt.executeTick();

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
      expect(nodeExecutionRepo.getById(exec.id)?.status).toBe('blocked');
      expect(taskRepo.getTask(task.id)?.status).toBe('stopped');
      const internals = rt as unknown as { blockedRetryCounts: Map<string, number> };
      expect(internals.blockedRetryCounts.has(run.id)).toBe(false);
    });

    test('recoverStalledRunsForSpace leaves an all-idle stopped run untouched', async () => {
      const tam = makeParkTam(nodeExecutionRepo);
      const rt = buildRuntime(tam);

      const { workflow } = buildWorkflow(SPACE_ID);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Idle Stop Run');
      const task = tasks[0];
      await rt.executeTick();
      const exec = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      saveAssistantMessage(exec.agentSessionId!, { minutesAgo: 30, terminal: true });
      nodeExecutionRepo.update(exec.id, { status: 'idle', completedAt: Date.now() });

      await rt.parkStoppedWorkflowTask(SPACE_ID, task.id);
      const idsBefore = nodeExecutionRepo.listByWorkflowRun(run.id).map((e) => e.id);

      await rt.recoverStalledRunsForSpace(SPACE_ID);

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(taskRepo.getTask(task.id)?.status).toBe('stopped');
      const after = nodeExecutionRepo.listByWorkflowRun(run.id);
      expect(after.map((e) => e.id)).toEqual(idsBefore);
      expect(after[0]?.status).toBe('idle');
    });

    test('handleNonTerminalIdleExecutions returns none for a stopped task without nudging', async () => {
      const { workflow, stepA } = buildWorkflow(SPACE_ID);
      const run = createRun(SPACE_ID, workflow.id, 'Nudge Run');
      const task = seedTask(run.id);
      seedExec(run.id, stepA, 'Step A', 'idle', { agentSessionId: 'session-idle' });
      saveAssistantMessage('session-idle', { minutesAgo: 1 });
      const tam = makeParkTam(nodeExecutionRepo, { liveSessionIds: ['session-idle'] });
      const rt = buildRuntime(tam);
      const internals = rt as unknown as {
        handleNonTerminalIdleExecutions: (
          runId: string,
          spaceId: string,
          canonicalTask: SpaceTask,
          workflow?: unknown,
          tam?: unknown,
          space?: unknown
        ) => Promise<string>;
      };

      const stoppedTask = { ...taskRepo.getTask(task.id)!, status: 'stopped' as const };
      await expect(
        internals.handleNonTerminalIdleExecutions(
          run.id,
          SPACE_ID,
          stoppedTask,
          undefined,
          tam,
          null
        )
      ).resolves.toBe('none');
      expect(tam._injectCalls).toHaveLength(0);
      expect(tam._restartCalls).toHaveLength(0);

      await expect(
        internals.handleNonTerminalIdleExecutions(
          run.id,
          SPACE_ID,
          taskRepo.getTask(task.id)!,
          undefined,
          tam,
          null
        )
      ).resolves.toBe('preserved');
    });

    test('prepareExternalEventTask holds deliveries for a stopped task', async () => {
      const { workflow, stepA } = buildWorkflow(SPACE_ID);
      const run = createRun(SPACE_ID, workflow.id, 'Event Run');
      const task = seedTask(run.id);
      seedExec(run.id, stepA, 'Step A', 'in_progress', { agentSessionId: 'session-a' });
      await buildRuntime().parkStoppedWorkflowTask(SPACE_ID, task.id);

      const rt = buildRuntime();
      const internals = rt as unknown as {
        prepareExternalEventTask: (target: unknown, event: unknown) => { action: string };
      };
      const decision = internals.prepareExternalEventTask(
        { workflowRunId: run.id, taskId: task.id, nodeId: stepA, agentName: 'Step A' },
        { spaceId: SPACE_ID, eventId: 'event-1' }
      );

      expect(decision).toEqual({ action: 'hold' });
    });

    test('activateSubscribedTargetForExternalEvent defers stopped tasks without activating', async () => {
      const { workflow, stepA } = buildWorkflow(SPACE_ID);
      const run = createRun(SPACE_ID, workflow.id, 'Subscribe Run');
      const task = seedTask(run.id);
      seedExec(run.id, stepA, 'Step A', 'in_progress', { agentSessionId: 'session-a' });
      const tam = makeParkTam(nodeExecutionRepo, { liveSessionIds: ['session-a'] });
      const rt = buildRuntime(tam);
      await rt.parkStoppedWorkflowTask(SPACE_ID, task.id);

      const internals = rt as unknown as {
        activateSubscribedTargetForExternalEvent: (target: unknown) => Promise<unknown>;
      };
      const target = {
        workflowRunId: run.id,
        taskId: task.id,
        nodeId: stepA,
        agentName: 'Step A',
      };
      const activated = await internals.activateSubscribedTargetForExternalEvent(target);

      expect(activated).toEqual(target);
      expect(tam._activateCalls).toHaveLength(0);
    });

    test('held external-event deliveries are stamped, requeued on resume, and delivered after respawn', async () => {
      const eventStore = new ExternalEventStore(db);
      const eventService = new ExternalEventService(eventStore, bus);
      const injected: Array<{ sessionId: string; message: string }> = [];
      const commandBus = createInternalCommandBus();
      commandBus.register('agent.message.inject', async (command) => {
        injected.push({ sessionId: command.sessionId, message: command.message });
        return { ok: true };
      });
      const tam = makeParkTam(nodeExecutionRepo);
      const rt = buildRuntime(tam, {
        externalEventStore: eventStore,
        commandBus,
      });

      const { workflow, stepA, stepD } = buildWorkflow(SPACE_ID);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Held Event Run');
      const task = tasks[0];
      rt.registerSubscription(
        run.id,
        task.id,
        stepA,
        'Step A',
        'github/*/*/pull_request/*.review_*'
      );
      rt.registerSubscription(
        run.id,
        task.id,
        stepD,
        'Step D',
        'github/*/*/pull_request/*.check_*'
      );
      await rt.executeTick();
      expect(tam._spawned).toHaveLength(1);
      await rt.parkStoppedWorkflowTask(SPACE_ID, task.id);
      expect(taskRepo.getTask(task.id)?.status).toBe('stopped');

      const event: ExternalEvent = {
        id: `evt-${Math.random().toString(36).slice(2)}`,
        spaceId: SPACE_ID,
        source: 'github',
        topic: 'github/lsm/neokai/pull_request/42.review_submitted',
        occurredAt: Date.now(),
        ingestedAt: Date.now(),
        dedupeKey: `dedupe-${Math.random().toString(36).slice(2)}`,
        summary: 'PR review submitted',
        payload: { action: 'review_submitted', prNumber: 42 },
      };
      await eventService.publish(event);
      const offPathEvent: ExternalEvent = {
        id: `evt-${Math.random().toString(36).slice(2)}`,
        spaceId: SPACE_ID,
        source: 'github',
        topic: 'github/lsm/neokai/pull_request/42.check_completed',
        occurredAt: Date.now(),
        ingestedAt: Date.now(),
        dedupeKey: `dedupe-${Math.random().toString(36).slice(2)}`,
        summary: 'CI check completed',
        payload: { action: 'check_completed', prNumber: 42 },
      };
      await eventService.publish(offPathEvent);

      const heldDeliveries = eventStore.listPendingDeliveries(run.id);
      expect(heldDeliveries).toHaveLength(2);
      expect(
        heldDeliveries.every((d) => d.failureReason === 'deliveryMode:defer; task_stopped')
      ).toBe(true);
      expect(injected).toHaveLength(0);
      const heldDelivery = heldDeliveries.find((d) => d.nodeId === stepA)!;
      const offPathDelivery = heldDeliveries.find((d) => d.nodeId === stepD)!;

      const recovered = await rt.recoverWorkflowBackedTask(SPACE_ID, task.id, 'in_progress');
      expect(recovered.task.status).toBe('in_progress');

      const queues = (
        rt as unknown as {
          pendingExternalEventQueue: Map<string, Array<{ deliveryKey: string }>>;
        }
      ).pendingExternalEventQueue;
      const queuedKeys = [...queues.values()].flat().map((item) => item.deliveryKey);
      expect(queuedKeys).toContain(heldDelivery.deliveryKey);
      expect(queuedKeys).toContain(offPathDelivery.deliveryKey);
      const retryTimers = (rt as unknown as { externalEventRetryTimers: Set<string> })
        .externalEventRetryTimers;
      expect(retryTimers.has(offPathDelivery.deliveryKey)).toBe(true);

      await rt.executeTick();
      expect(tam._spawned).toHaveLength(2);
      expect(injected).toHaveLength(1);
      expect(injected[0]?.message).toContain(event.id);
      expect(
        eventStore
          .listPendingDeliveries(run.id)
          .some((d) => d.deliveryKey === heldDelivery.deliveryKey)
      ).toBe(false);
    });

    test('held external-event deliveries are requeued when a stopped task is reopened', async () => {
      const eventStore = new ExternalEventStore(db);
      const eventService = new ExternalEventService(eventStore, bus);
      const injected: Array<{ sessionId: string; message: string }> = [];
      const commandBus = createInternalCommandBus();
      commandBus.register('agent.message.inject', async (command) => {
        injected.push({ sessionId: command.sessionId, message: command.message });
        return { ok: true };
      });
      const tam = makeParkTam(nodeExecutionRepo);
      const rt = buildRuntime(tam, {
        externalEventStore: eventStore,
        commandBus,
      });

      const { workflow, stepA } = buildWorkflow(SPACE_ID);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Reopen Held Run');
      const task = tasks[0];
      rt.registerSubscription(
        run.id,
        task.id,
        stepA,
        'Step A',
        'github/*/*/pull_request/*.review_*'
      );
      await rt.executeTick();
      expect(tam._spawned).toHaveLength(1);
      await rt.parkStoppedWorkflowTask(SPACE_ID, task.id);

      const event: ExternalEvent = {
        id: `evt-${Math.random().toString(36).slice(2)}`,
        spaceId: SPACE_ID,
        source: 'github',
        topic: 'github/lsm/neokai/pull_request/43.review_submitted',
        occurredAt: Date.now(),
        ingestedAt: Date.now(),
        dedupeKey: `dedupe-${Math.random().toString(36).slice(2)}`,
        summary: 'PR review submitted',
        payload: { action: 'review_submitted', prNumber: 43 },
      };
      await eventService.publish(event);
      const [held] = eventStore.listPendingDeliveries(run.id);
      expect(held?.failureReason).toBe('deliveryMode:defer; task_stopped');

      const reopened = await rt.stopWorkflowBackedTaskForStatus(SPACE_ID, task.id, {
        status: 'open',
      });
      expect(reopened?.status).toBe('open');

      const queues = (
        rt as unknown as {
          pendingExternalEventQueue: Map<string, Array<{ deliveryKey: string }>>;
        }
      ).pendingExternalEventQueue;
      const queuedKeys = [...queues.values()].flat().map((item) => item.deliveryKey);
      expect(queuedKeys).toContain(held!.deliveryKey);
      const retryTimers = (rt as unknown as { externalEventRetryTimers: Set<string> })
        .externalEventRetryTimers;
      expect(retryTimers.has(held!.deliveryKey)).toBe(true);

      await rt.executeTick();
      expect(tam._spawned).toHaveLength(2);
      expect(injected).toHaveLength(1);
      expect(injected[0]?.message).toContain(event.id);
      expect(
        eventStore.listPendingDeliveries(run.id).some((d) => d.deliveryKey === held!.deliveryKey)
      ).toBe(false);
    });

    test('held external-event deliveries are left inert when a stopped task is cancelled', async () => {
      const eventStore = new ExternalEventStore(db);
      const eventService = new ExternalEventService(eventStore, bus);
      const commandBus = createInternalCommandBus();
      const tam = makeParkTam(nodeExecutionRepo);
      const rt = buildRuntime(tam, {
        externalEventStore: eventStore,
        commandBus,
      });

      const { workflow, stepA } = buildWorkflow(SPACE_ID);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Cancel Held Run');
      const task = tasks[0];
      rt.registerSubscription(
        run.id,
        task.id,
        stepA,
        'Step A',
        'github/*/*/pull_request/*.review_*'
      );
      await rt.executeTick();
      await rt.parkStoppedWorkflowTask(SPACE_ID, task.id);

      const event: ExternalEvent = {
        id: `evt-${Math.random().toString(36).slice(2)}`,
        spaceId: SPACE_ID,
        source: 'github',
        topic: 'github/lsm/neokai/pull_request/44.review_submitted',
        occurredAt: Date.now(),
        ingestedAt: Date.now(),
        dedupeKey: `dedupe-${Math.random().toString(36).slice(2)}`,
        summary: 'PR review submitted',
        payload: { action: 'review_submitted', prNumber: 44 },
      };
      await eventService.publish(event);
      expect(eventStore.listPendingDeliveries(run.id)).toHaveLength(1);

      const cancelled = await rt.stopWorkflowBackedTaskForStatus(SPACE_ID, task.id, {
        status: 'cancelled',
      });
      expect(cancelled?.status).toBe('cancelled');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('cancelled');

      const queues = (
        rt as unknown as {
          pendingExternalEventQueue: Map<string, Array<{ deliveryKey: string }>>;
        }
      ).pendingExternalEventQueue;
      expect([...queues.values()].flat()).toHaveLength(0);
      const retryTimers = (rt as unknown as { externalEventRetryTimers: Set<string> })
        .externalEventRetryTimers;
      expect([...retryTimers]).toHaveLength(0);
      expect(tam._injectCalls).toHaveLength(0);
      expect(eventStore.listPendingDeliveries(run.id)).toHaveLength(1);
    });
  });

  describe('supervision and resume', () => {
    test('skips spawn, nag, and restart supervision for a stopped task across ticks, then resume re-drives with fresh budgets', async () => {
      const tam = makeParkTam(nodeExecutionRepo);
      const rt = buildRuntime(tam);

      const { workflow } = buildWorkflow(SPACE_ID);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Stop/Resume Run');
      const task = tasks[0];

      await rt.executeTick();
      expect(tam._spawned).toHaveLength(1);
      expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');

      const executionsBeforeStop = nodeExecutionRepo.listByWorkflowRun(run.id);
      const liveSessionId = executionsBeforeStop.find(
        (e) => e.status === 'in_progress'
      )?.agentSessionId;
      expect(liveSessionId).toBeTruthy();
      tam._verifiedStopCalls.length = 0;

      const internals = rt as unknown as {
        blockedRetryCounts: Map<string, number>;
        taskCrashCounts: Map<string, number>;
      };
      internals.taskCrashCounts.set(`${run.id}:${executionsBeforeStop[0].id}`, 1);
      internals.blockedRetryCounts.set(run.id, 2);

      const stopped = await rt.parkStoppedWorkflowTask(SPACE_ID, task.id);
      expect(stopped?.status).toBe('stopped');
      expect(tam._verifiedStopCalls).toHaveLength(1);
      expect(internals.taskCrashCounts.has(`${run.id}:${executionsBeforeStop[0].id}`)).toBe(false);
      expect(internals.blockedRetryCounts.has(run.id)).toBe(false);

      for (let i = 0; i < 3; i += 1) {
        await rt.executeTick();
      }

      expect(tam._spawned).toHaveLength(1);
      expect(tam._verifiedStopCalls).toHaveLength(1);
      expect(tam._injectCalls).toHaveLength(0);
      expect(tam._restartCalls).toHaveLength(0);
      const parkedExecution = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .find((e) => e.id === executionsBeforeStop[0].id)!;
      expect(parkedExecution.status).toBe('pending');
      expect(parkedExecution.agentSessionId).toBeNull();
      expect(taskRepo.getTask(task.id)?.status).toBe('stopped');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');

      const recovered = await rt.recoverWorkflowBackedTask(SPACE_ID, task.id, 'in_progress');
      expect(recovered.task.status).toBe('in_progress');
      expect(internals.blockedRetryCounts.has(run.id)).toBe(false);

      await rt.executeTick();

      expect(tam._spawned).toHaveLength(2);
      expect(tam._spawned[1]?.options).toEqual({ kickoff: true });
      const respawned = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .find((e) => e.id === executionsBeforeStop[0].id)!;
      expect(respawned.status).toBe('in_progress');
      expect(respawned.agentSessionId).toBeTruthy();
      expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');
    });
  });
});
