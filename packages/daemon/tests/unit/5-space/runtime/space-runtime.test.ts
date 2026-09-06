import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SpaceWorkflow, SpaceWorkflowRun } from '@hyperneo/shared';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { TransientSpawnError } from '../../../../src/lib/space/runtime/workflow-node-execution-validation.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { seedUnifiedAgentMirror } from '../../helpers/seed-unified-agent';

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});

  db.exec(`CREATE TABLE IF NOT EXISTS sdk_messages (
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
	)`);

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
  seedUnifiedAgentMirror(db, { id: agentId, spaceId, name });
}

function buildLinearWorkflow(
  spaceId: string,
  workflowManager: SpaceWorkflowManager,
  nodes: Array<{ id: string; name: string; agentId: string; instructions?: string }>,
  conditions: Array<{ type: 'always' | 'human'; description?: string }> = [],
  opts: { channels?: SpaceWorkflow['channels']; gates?: SpaceWorkflow['gates'] } = {}
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
    channels: opts.channels,
    gates: opts.gates,
    startNodeId: nodes[0].id,
    rules: [],
    tags: [],
    completionAutonomyLevel: 3,
  });
}

const SYNTHETIC_END_NODE_ID = '__test_end__';

function appendSyntheticEnd<T extends { id: string; agents?: unknown[] }>(
  nodes: T[],
  endAgentId: string
): { nodes: Array<T | { id: string; name: string; agentId: string }>; endNodeId: string } {
  const last = nodes[nodes.length - 1];
  const lastIsMultiAgent = (last.agents?.length ?? 0) > 1;
  if (!lastIsMultiAgent) {
    return { nodes, endNodeId: last.id };
  }
  return {
    nodes: [...nodes, { id: SYNTHETIC_END_NODE_ID, name: 'Synthetic End', agentId: endAgentId }],
    endNodeId: SYNTHETIC_END_NODE_ID,
  };
}

describe('SpaceRuntime', () => {
  let db: BunDatabase;

  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let nodeExecutionRepo: NodeExecutionRepository;
  let longHorizonAgentRepo: SpaceLongHorizonAgentRepository;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;
  let runtime: SpaceRuntime;

  const SPACE_ID = 'space-rt-1';
  const WORKSPACE = '/tmp/runtime-ws';

  const AGENT_PLANNER = 'agent-planner';
  const AGENT_CODER = 'agent-coder';
  const AGENT_GENERAL = 'agent-general';
  const AGENT_CUSTOM = 'agent-custom';

  const STEP_A = 'step-a';
  const STEP_B = 'step-b';
  const STEP_C = 'step-c';

  beforeEach(() => {
    db = makeDb();

    seedSpaceRow(db, SPACE_ID, WORKSPACE);

    seedAgentRow(db, AGENT_PLANNER, SPACE_ID, 'Planner');
    seedAgentRow(db, AGENT_CODER, SPACE_ID, 'Coder');
    seedAgentRow(db, AGENT_GENERAL, SPACE_ID, 'General');
    seedAgentRow(db, AGENT_CUSTOM, SPACE_ID, 'Custom');

    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    taskRepo = new SpaceTaskRepository(db);
    nodeExecutionRepo = new NodeExecutionRepository(db);

    longHorizonAgentRepo = new SpaceLongHorizonAgentRepository(db);

    const workflowRepo = new SpaceWorkflowRepository(db);
    workflowManager = new SpaceWorkflowManager(workflowRepo);

    spaceManager = new SpaceManager(db);

    const config: SpaceRuntimeConfig = {
      db,
      spaceManager,
      longHorizonAgentRepo,
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
    };
    runtime = new SpaceRuntime(config);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
    } catch {}
  });

  describe('recoverWorkflowBackedTask()', () => {
    test('manual recovery clears alive-stuck restart budget for the run', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const sdkMessageRepo = new SDKMessageRepository(db);
      const restarted: string[] = [];
      const tam = {
        isExecutionSpawning: () => false,
        isSessionAlive: () => true,
        isSessionInMemory: () => true,
        getAgentSessionById: () => ({ getProcessingState: () => ({ status: 'processing' }) }),
        injectRuntimeRecoveryMessage: async (sessionId: string) => `runtime-nag:${sessionId}`,
        restartStuckSubSession: async (sessionId: string) => {
          restarted.push(sessionId);
        },
        spawnWorkflowNodeAgentForExecution: async () => 'session:new',
        prepareSubSessionForWorkflowResume: async () => true,
        rehydrate: async () => {},
      };
      const rt = new SpaceRuntime({
        db,
        spaceManager,
        longHorizonAgentRepo,
        spaceWorkflowManager: workflowManager,
        workflowRunRepo,
        taskRepo,
        nodeExecutionRepo,
        sdkMessageRepo,
        taskAgentManager: tam as never,
        agentNoProgressThresholdMs: 60_000,
        agentStuckNagGraceMs: 0,
      });
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Recover stuck');
      const task = tasks[0];
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'in_progress',
        agentSessionId: 'session:stuck-before-recover',
        startedAt: Date.now() - 20 * 60_000,
      });
      sdkMessageRepo.saveSDKMessage('session:stuck-before-recover', {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-before-recover', name: 'bash', input: {} }],
          stop_reason: null,
        },
      } as never);
      db.prepare(`UPDATE sdk_messages SET timestamp = ? WHERE session_id = ?`).run(
        new Date(Date.now() - 20 * 60_000).toISOString(),
        'session:stuck-before-recover'
      );

      await rt.executeTick();
      await rt.executeTick();
      expect(restarted).toEqual(['session:stuck-before-recover']);

      workflowRunRepo.transitionStatus(run.id, 'blocked');
      taskRepo.updateTask(task.id, { status: 'blocked', blockReason: 'execution_failed' });
      nodeExecutionRepo.update(execution.id, {
        status: 'blocked',
        agentSessionId: 'session:stuck-after-recover',
        startedAt: Date.now() - 20 * 60_000,
      });
      sdkMessageRepo.saveSDKMessage('session:stuck-after-recover', {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-after-recover', name: 'bash', input: {} }],
          stop_reason: null,
        },
      } as never);
      db.prepare(`UPDATE sdk_messages SET timestamp = ? WHERE session_id = ?`).run(
        new Date(Date.now() - 20 * 60_000).toISOString(),
        'session:stuck-after-recover'
      );

      await rt.recoverWorkflowBackedTask(SPACE_ID, task.id, 'in_progress');
      await rt.executeTick();
      await rt.executeTick();

      expect(restarted).toEqual(['session:stuck-before-recover', 'session:stuck-after-recover']);
    });

    test('resuming a cancelled workflow task keeps task and run active after a tick', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Recover me');
      const task = tasks[0];
      const completedAt = Date.now() - 10_000;

      workflowRunRepo.transitionStatus(run.id, 'cancelled');
      workflowRunRepo.updateRun(run.id, { completedAt });
      taskRepo.updateTask(task.id, { status: 'cancelled', completedAt });
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'cancelled',
        completedAt,
        result: 'stale result',
      });

      await runtime.recoverWorkflowBackedTask(SPACE_ID, task.id, 'in_progress');
      await runtime.executeTick();

      const recoveredTask = taskRepo.getTask(task.id)!;
      const recoveredRun = workflowRunRepo.getRun(run.id)!;
      expect(recoveredTask.status).toBe('in_progress');
      expect(recoveredTask.completedAt).toBeNull();
      expect(recoveredRun.status).toBe('in_progress');
      expect(recoveredRun.completedAt).toBeNull();
    });

    test('reopening a done workflow task clears completion timestamps and keeps run active', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Reopen me');
      const task = tasks[0];
      const completedAt = Date.now() - 10_000;

      workflowRunRepo.transitionStatus(run.id, 'done');
      workflowRunRepo.updateRun(run.id, { completedAt });
      taskRepo.updateTask(task.id, { status: 'done', completedAt, result: 'old result' });
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'cancelled',
        completedAt,
        result: 'stale result',
      });

      await runtime.recoverWorkflowBackedTask(SPACE_ID, task.id, 'in_progress');
      await runtime.executeTick();

      const recoveredTask = taskRepo.getTask(task.id)!;
      const recoveredRun = workflowRunRepo.getRun(run.id)!;
      expect(recoveredTask.status).toBe('in_progress');
      expect(recoveredTask.completedAt).toBeNull();
      expect(recoveredTask.result).toBeNull();
      expect(recoveredRun.status).toBe('in_progress');
      expect(recoveredRun.completedAt).toBeNull();
    });

    test('reopening a blocked workflow task leaves task open while run processes active', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Unblock me');
      const task = tasks[0];
      const completedAt = Date.now() - 10_000;

      workflowRunRepo.transitionStatus(run.id, 'blocked');
      workflowRunRepo.updateRun(run.id, { completedAt, failureReason: 'Needs input' });
      taskRepo.updateTask(task.id, {
        status: 'blocked',
        completedAt,
        blockReason: 'human_input_requested',
      });
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(execution.id, {
        status: 'blocked',
        completedAt,
        result: 'blocked result',
      });

      await runtime.recoverWorkflowBackedTask(SPACE_ID, task.id, 'open');
      await runtime.executeTick();

      const recoveredTask = taskRepo.getTask(task.id)!;
      const recoveredRun = workflowRunRepo.getRun(run.id)!;
      expect(recoveredTask.status).toBe('open');
      expect(recoveredTask.completedAt).toBeNull();
      expect(recoveredTask.blockReason).toBeNull();
      expect(recoveredRun.status).toBe('in_progress');
      expect(recoveredRun.completedAt).toBeNull();
      expect(recoveredRun.failureReason).toBeUndefined();
    });

    test('resuming a blocked workflow task moves task and run in progress', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await runtime.startWorkflowRun(
        SPACE_ID,
        workflow.id,
        'Resume blocked'
      );
      const task = tasks[0];
      const completedAt = Date.now() - 10_000;

      workflowRunRepo.transitionStatus(run.id, 'blocked');
      workflowRunRepo.updateRun(run.id, { completedAt, failureReason: 'Needs input' });
      taskRepo.updateTask(task.id, {
        status: 'blocked',
        completedAt,
        blockReason: 'human_input_requested',
      });

      await runtime.recoverWorkflowBackedTask(SPACE_ID, task.id, 'in_progress');

      const recoveredTask = taskRepo.getTask(task.id)!;
      const recoveredRun = workflowRunRepo.getRun(run.id)!;
      expect(recoveredTask.status).toBe('in_progress');
      expect(recoveredTask.completedAt).toBeNull();
      expect(recoveredTask.blockReason).toBeNull();
      expect(recoveredRun.status).toBe('in_progress');
      expect(recoveredRun.completedAt).toBeNull();
      expect(recoveredRun.failureReason).toBeUndefined();
    });

    test('recreates start node executions when recovery finds none', async () => {
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: 'Multi-agent start',
        description: 'Test',
        nodes: [
          {
            id: STEP_A,
            name: 'Plan',
            agents: [
              { name: 'Planner', agentId: AGENT_PLANNER },
              { name: 'Coder', agentId: AGENT_CODER },
            ],
          },
          { id: STEP_B, name: 'End', agentId: AGENT_GENERAL },
        ],
        transitions: [
          {
            from: STEP_A,
            to: STEP_B,
            condition: { type: 'always' },
            order: 0,
          },
        ],
        startNodeId: STEP_A,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Missing nodes');
      const task = tasks[0];

      workflowRunRepo.transitionStatus(run.id, 'cancelled');
      taskRepo.updateTask(task.id, { status: 'cancelled' });
      nodeExecutionRepo.deleteByWorkflowRun(run.id);

      await runtime.recoverWorkflowBackedTask(SPACE_ID, task.id, 'in_progress');

      const executions = nodeExecutionRepo.listByWorkflowRun(run.id);
      expect(executions).toHaveLength(2);
      expect(executions.map((execution) => execution.agentName).sort()).toEqual([
        'Coder',
        'Planner',
      ]);
      expect(executions.every((execution) => execution.workflowNodeId === STEP_A)).toBe(true);
      expect(executions.every((execution) => execution.status === 'pending')).toBe(true);
    });

    test('resets terminal node execution without live session to pending', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Reset node');
      const task = tasks[0];
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];

      workflowRunRepo.transitionStatus(run.id, 'cancelled');
      taskRepo.updateTask(task.id, { status: 'cancelled' });
      nodeExecutionRepo.update(execution.id, {
        status: 'cancelled',
        agentSessionId: 'stale-session',
        result: 'old',
        data: { stale: true },
        startedAt: Date.now() - 2_000,
        completedAt: Date.now() - 1_000,
      });

      await runtime.recoverWorkflowBackedTask(SPACE_ID, task.id, 'in_progress');

      const recoveredExecution = nodeExecutionRepo.getById(execution.id)!;
      expect(recoveredExecution.status).toBe('pending');
      expect(recoveredExecution.agentSessionId).toBe('stale-session');
      expect(recoveredExecution.result).toBeNull();
      expect(recoveredExecution.data).toBeNull();
      expect(recoveredExecution.startedAt).toBeNull();
      expect(recoveredExecution.completedAt).toBeNull();
    });

    test('reactivates terminal node execution with a live session', async () => {
      const preparedSessions: string[] = [];
      const liveTaskAgentManager = {
        isSessionAlive: (sessionId: string) => sessionId === 'live-session',
        isSessionInMemory: (sessionId: string) => sessionId === 'live-session',
        prepareSubSessionForWorkflowResume: async (sessionId: string) => {
          preparedSessions.push(sessionId);
          return true;
        },
      } as SpaceRuntimeConfig['taskAgentManager'];
      runtime = new SpaceRuntime({
        db,
        spaceManager,
        longHorizonAgentRepo,
        spaceWorkflowManager: workflowManager,
        workflowRunRepo,
        taskRepo,
        nodeExecutionRepo,
        taskAgentManager: liveTaskAgentManager,
      });

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Live node');
      const task = tasks[0];
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];

      workflowRunRepo.transitionStatus(run.id, 'cancelled');
      taskRepo.updateTask(task.id, { status: 'cancelled' });
      nodeExecutionRepo.update(execution.id, {
        status: 'cancelled',
        agentSessionId: 'live-session',
        completedAt: Date.now() - 1_000,
        result: 'keep me',
      });

      await runtime.recoverWorkflowBackedTask(SPACE_ID, task.id, 'in_progress');

      const recoveredExecution = nodeExecutionRepo.getById(execution.id)!;
      expect(recoveredExecution.status).toBe('in_progress');
      expect(recoveredExecution.agentSessionId).toBe('live-session');
      expect(recoveredExecution.result).toBe('keep me');
      expect(recoveredExecution.completedAt).toBeNull();
      expect(preparedSessions).toEqual(['live-session']);
    });

    test('preserves generic reopen/resume behavior for non-workflow tasks', async () => {
      const manager = new SpaceTaskManager(db, SPACE_ID);
      const task = await manager.createTask({
        title: 'Plain task',
        description: '',
        status: 'open',
      });
      const completedAt = Date.now() - 1_000;
      taskRepo.updateTask(task.id, { status: 'cancelled', completedAt });

      const reopened = await manager.setTaskStatus(task.id, 'open');
      expect(reopened.status).toBe('open');
      expect(reopened.workflowRunId).toBeUndefined();
      expect(reopened.completedAt).toBeNull();

      taskRepo.updateTask(task.id, { status: 'cancelled', completedAt });
      const resumed = await manager.setTaskStatus(task.id, 'in_progress');
      expect(resumed.status).toBe('in_progress');
      expect(resumed.workflowRunId).toBeUndefined();
      expect(resumed.completedAt).toBeNull();
    });

    test('resets blocked retry counter on recovery so auto-retry is not exhausted', async () => {
      runtime = new SpaceRuntime({
        db,
        spaceManager,
        longHorizonAgentRepo,
        spaceWorkflowManager: workflowManager,
        workflowRunRepo,
        taskRepo,
        nodeExecutionRepo,
      });

      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Retry counter');
      const task = tasks[0];

      const blockAll = () => {
        workflowRunRepo.transitionStatus(run.id, 'blocked');
        const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
        nodeExecutionRepo.update(execution.id, {
          status: 'blocked',
          result: 'test block',
        });
        taskRepo.updateTask(task.id, {
          status: 'blocked',
          blockReason: 'execution_failed',
          result: 'blocked',
        });
      };

      blockAll();
      await runtime.executeTick();
      expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');

      blockAll();
      await runtime.executeTick();
      expect(workflowRunRepo.getRun(run.id)!.status).toBe('blocked');

      await runtime.recoverWorkflowBackedTask(SPACE_ID, task.id, 'in_progress');

      blockAll();
      await runtime.executeTick();

      const retriedRun = workflowRunRepo.getRun(run.id)!;
      expect(retriedRun.status).toBe('in_progress');
    });
  });

  describe('startWorkflowRun()', () => {
    test('creates run record with in_progress status', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Test Run');

      expect(run.spaceId).toBe(SPACE_ID);
      expect(run.workflowId).toBe(workflow.id);
      expect(run.definitionVersion).not.toBeNull();
      expect(run.status).toBe('in_progress');
      expect(
        db
          .prepare(
            `SELECT 1 FROM space_workflow_definition_versions
             WHERE workflow_id = ? AND version_hash = ?`
          )
          .get(workflow.id, run.definitionVersion)
      ).toBeDefined();
    });

    test('in-flight run reads its pinned definition, not a later head edit (read cutover)', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
        { id: 'coder-step', name: 'Code', agentId: AGENT_CODER },
      ]);

      const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Pinned Run');
      const pinnedChannelCount = runtime.getWorkflowChannels(run.id).length;

      const head = workflowManager.getWorkflow(workflow.id)!;
      workflowManager.updateWorkflow(workflow.id, {
        channels: [
          ...(head.channels ?? []),
          { id: 'back-code-plan', from: 'Code', to: 'Plan', maxCycles: 3 },
        ],
      });

      expect(workflowManager.getWorkflow(workflow.id)?.channels ?? []).toHaveLength(
        pinnedChannelCount + 1
      );
      expect(runtime.getWorkflowChannels(run.id)).toHaveLength(pinnedChannelCount);
    });

    test('creates initial SpaceTask for the start step', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'My Run');

      expect(tasks).toHaveLength(1);
      const task = tasks[0];
      expect(task.workflowRunId).toBe(run.id);
      expect(task.status).toBe('open');
      expect(task.title).toBe('My Run');
    });

    test('creates task with open status for planner start step', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      expect(tasks[0].status).toBe('open');
    });

    test('creates task with open status for coder start step', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Code', agentId: AGENT_CODER },
      ]);

      const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      expect(tasks[0].status).toBe('open');
    });

    test('registers executor in executors map', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      expect(runtime.executorCount).toBe(1);
      expect(runtime.getExecutor(run.id)).toBeDefined();
    });

    test('throws for unknown workflow', async () => {
      await expect(runtime.startWorkflowRun(SPACE_ID, 'nonexistent-wf-id', 'Run')).rejects.toThrow(
        'Workflow not found'
      );
    });

    test('cancels DB run record when task creation fails (prevents silent rehydration loop)', async () => {
      db.exec('PRAGMA foreign_keys = OFF');
      let workflow: SpaceWorkflow;
      try {
        const repo = new SpaceWorkflowRepository(db);
        workflow = repo.createWorkflow({
          spaceId: SPACE_ID,
          name: `Broken Start ${Date.now()}`,
          description: '',
          nodes: [{ id: 'step-bad', name: 'Step', agentId: AGENT_PLANNER }],
          transitions: [],
          startNodeId: 'nonexistent-start-step-id',
          endNodeId: 'step-bad',
          rules: [],
          tags: [],
          completionAutonomyLevel: 3,
        });
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }

      const runsBefore = workflowRunRepo.listBySpace(SPACE_ID);

      await expect(runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Bad Run')).rejects.toThrow();

      const runsAfter = workflowRunRepo.listBySpace(SPACE_ID);
      const newRun = runsAfter.find((r) => !runsBefore.some((b) => b.id === r.id));
      expect(newRun).toBeDefined();
      expect(newRun!.status).toBe('cancelled');

      expect(runtime.executorCount).toBe(0);
    });

    test('throws for unknown space', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      await expect(
        runtime.startWorkflowRun('nonexistent-space', workflow.id, 'Run')
      ).rejects.toThrow('Space not found');
    });

    test('stores description on run record', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      const { run } = await runtime.startWorkflowRun(
        SPACE_ID,
        workflow.id,
        'My Run',
        'Some description'
      );

      expect(run.description).toBe('Some description');
    });

    test('goalId param is accepted (but not stored — removed from SpaceWorkflowRun in M71)', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      const { run, tasks } = await runtime.startWorkflowRun(
        SPACE_ID,
        workflow.id,
        'Goal Run',
        undefined,
        'goal-abc'
      );

      expect(run).toBeDefined();
      expect(tasks).toHaveLength(1);
    });

    test('goalId defaults to undefined when not provided', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'No Goal');

      expect((run as Record<string, unknown>).goalId).toBeUndefined();
      expect((tasks[0] as Record<string, unknown>).goalId).toBeUndefined();
    });

    test('multi-agent start step: creates one canonical task and node executions per agent', async () => {
      const startNode = {
        id: STEP_A,
        name: 'Multi Step',
        agents: [
          { agentId: AGENT_PLANNER, name: 'planner' },
          { agentId: AGENT_CODER, name: 'coder' },
        ],
      };
      const { nodes, endNodeId } = appendSyntheticEnd([startNode], AGENT_CODER);
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Multi-Agent Start ${Date.now()}`,
        description: '',
        nodes,
        transitions: [],
        startNodeId: STEP_A,
        endNodeId,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Multi Run');

      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('open');
      const executions = nodeExecutionRepo.listByNode(tasks[0].workflowRunId!, STEP_A);
      expect(executions).toHaveLength(2);
    });

    test('multi-agent start step with custom-role first agent: creates canonical task and executions', async () => {
      const startNode = {
        id: STEP_A,
        name: 'Custom Multi Step',
        agents: [
          { agentId: AGENT_CUSTOM, name: 'my-custom-role' },
          { agentId: AGENT_CODER, name: 'coder' },
        ],
      };
      const { nodes, endNodeId } = appendSyntheticEnd([startNode], AGENT_CODER);
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Multi-Agent Custom ${Date.now()}`,
        description: '',
        nodes,
        transitions: [],
        startNodeId: STEP_A,
        endNodeId,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Custom Multi Run');

      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('open');
      const executions = nodeExecutionRepo.listByNode(tasks[0].workflowRunId!, STEP_A);
      expect(executions).toHaveLength(2);
    });

    test('cancels run and clears executor when start step has no agent configuration', async () => {
      db.exec('PRAGMA foreign_keys = OFF');
      let workflow: SpaceWorkflow;
      try {
        const repo = new SpaceWorkflowRepository(db);
        workflow = repo.createWorkflow({
          spaceId: SPACE_ID,
          name: `No Agent Step ${Date.now()}`,
          description: '',
          nodes: [{ id: STEP_A, name: 'Broken Step' } as never],
          transitions: [],
          startNodeId: STEP_A,
          rules: [],
          tags: [],
          completionAutonomyLevel: 3,
        });
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }

      const runsBefore = workflowRunRepo.listBySpace(SPACE_ID);

      await expect(runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Broken Run')).rejects.toThrow();

      const runsAfter = workflowRunRepo.listBySpace(SPACE_ID);
      const newRun = runsAfter.find((r) => !runsBefore.some((b) => b.id === r.id));
      if (newRun) {
        expect(newRun.status).toBe('cancelled');
      }
      expect(runtime.executorCount).toBe(0);
    });
  });

  describe('standalone tasks', () => {
    test('standalone task (no workflowRunId) is not processed by executor map', async () => {
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Standalone Task',
        description: 'No workflow',
        status: 'open',
      });

      await runtime.executeTick();

      expect(runtime.executorCount).toBe(0);

      const unchanged = taskRepo.getTask(task.id)!;
      expect(unchanged.status).toBe('open');
    });

    test('uses preferredWorkflowId when attaching workflow to standalone task', async () => {
      const preferredWorkflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT_CODER },
      ]);
      buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_B, name: 'Fix', agentId: AGENT_GENERAL },
      ]);

      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Fix login bug',
        description: 'Authentication fails for international users',
        status: 'open',
        preferredWorkflowId: preferredWorkflow.id,
      });

      await runtime.executeTick();

      const updated = taskRepo.getTask(task.id)!;
      expect(updated.workflowRunId).not.toBeNull();

      const run = workflowRunRepo.getRun(updated.workflowRunId!);
      expect(run).not.toBeNull();
      expect(run!.workflowId).toBe(preferredWorkflow.id);
    });

    test('falls back to heuristic when preferredWorkflowId workflow is not found', async () => {
      const fallbackWorkflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Work', agentId: AGENT_CODER },
      ]);

      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Some task',
        description: 'Some description',
        status: 'open',
        preferredWorkflowId: 'wf-does-not-exist',
      });

      await runtime.executeTick();

      const updated = taskRepo.getTask(task.id)!;
      expect(updated.workflowRunId).not.toBeNull();

      const run = workflowRunRepo.getRun(updated.workflowRunId!);
      expect(run).not.toBeNull();
      expect(run!.workflowId).toBe(fallbackWorkflow.id);
    });

    test('attaches only one open standalone task by default', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Work', agentId: AGENT_CODER },
      ]);

      const first = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'First task',
        status: 'open',
        preferredWorkflowId: workflow.id,
      });
      const second = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Second task',
        status: 'open',
        preferredWorkflowId: workflow.id,
      });

      await runtime.executeTick();

      const updated = [taskRepo.getTask(first.id)!, taskRepo.getTask(second.id)!];
      expect(updated.filter((task) => task.status === 'in_progress')).toHaveLength(1);
      expect(updated.filter((task) => task.status === 'open')).toHaveLength(1);
    });

    test('attaches multiple open standalone tasks up to the configured limit', async () => {
      await spaceManager.updateSpace(SPACE_ID, { maxConcurrentTasks: 2 });
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Work', agentId: AGENT_CODER },
      ]);

      const tasks = [
        taskRepo.createTask({
          spaceId: SPACE_ID,
          title: 'First task',
          status: 'open',
          preferredWorkflowId: workflow.id,
        }),
        taskRepo.createTask({
          spaceId: SPACE_ID,
          title: 'Second task',
          status: 'open',
          preferredWorkflowId: workflow.id,
        }),
        taskRepo.createTask({
          spaceId: SPACE_ID,
          title: 'Third task',
          status: 'open',
          preferredWorkflowId: workflow.id,
        }),
      ];

      await runtime.executeTick();

      const updated = tasks.map((task) => taskRepo.getTask(task.id)!);
      expect(updated.filter((task) => task.status === 'in_progress')).toHaveLength(2);
      expect(updated.filter((task) => task.status === 'open')).toHaveLength(1);
    });

    test('prioritizes urgent standalone tasks before lower-priority queued tasks', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Work', agentId: AGENT_CODER },
      ]);

      const low = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Low task',
        status: 'open',
        priority: 'low',
        preferredWorkflowId: workflow.id,
      });
      const urgent = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Urgent task',
        status: 'open',
        priority: 'urgent',
        preferredWorkflowId: workflow.id,
      });

      await runtime.executeTick();

      expect(taskRepo.getTask(urgent.id)!.status).toBe('in_progress');
      expect(taskRepo.getTask(low.id)!.status).toBe('open');
    });

    test('does not start dependent standalone tasks until dependencies are done', async () => {
      await spaceManager.updateSpace(SPACE_ID, { maxConcurrentTasks: 2 });
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Work', agentId: AGENT_CODER },
      ]);

      const prerequisite = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Prerequisite',
        status: 'open',
        preferredWorkflowId: workflow.id,
      });
      const dependent = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Dependent',
        status: 'open',
        priority: 'urgent',
        dependsOn: [prerequisite.id],
        preferredWorkflowId: workflow.id,
      });

      await runtime.executeTick();

      expect(taskRepo.getTask(prerequisite.id)!.status).toBe('in_progress');
      expect(taskRepo.getTask(dependent.id)!.status).toBe('open');
    });

    test('starts lower-priority ready tasks when higher-priority dependencies are unmet', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Work', agentId: AGENT_CODER },
      ]);

      const blocker = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Blocker',
        status: 'blocked',
        preferredWorkflowId: workflow.id,
      });
      const urgentBlocked = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Urgent blocked',
        status: 'open',
        priority: 'urgent',
        dependsOn: [blocker.id],
        preferredWorkflowId: workflow.id,
      });
      const normalReady = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Normal ready',
        status: 'open',
        priority: 'normal',
        preferredWorkflowId: workflow.id,
      });

      await runtime.executeTick();

      expect(taskRepo.getTask(urgentBlocked.id)!.status).toBe('open');
      expect(taskRepo.getTask(normalReady.id)!.status).toBe('in_progress');
    });
  });

  describe('rehydrateExecutors()', () => {
    test('rehydration is idempotent (second executeTick does not double-rehydrate)', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      await runtime.executeTick();

      await runtime.executeTick();

      expect(runtime.executorCount).toBeLessThanOrEqual(1);
    });

    test('skips runs whose workflow was deleted', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      const pendingRun = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Orphaned Run',
      });
      workflowRunRepo.transitionStatus(pendingRun.id, 'in_progress');

      new SpaceWorkflowRepository(db).deleteWorkflow(workflow.id);

      const freshRuntime = new SpaceRuntime({
        db,
        spaceManager,
        longHorizonAgentRepo,
        spaceWorkflowManager: workflowManager,
        workflowRunRepo,
        taskRepo,
        nodeExecutionRepo: new NodeExecutionRepository(db),
      });

      await expect(freshRuntime.executeTick()).resolves.toBeUndefined();
      expect(freshRuntime.executorCount).toBe(0);
    });
  });

  describe('executor cleanup', () => {
    test('cleanupTerminalExecutors() removes cancelled runs', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      expect(runtime.executorCount).toBe(1);

      workflowRunRepo.transitionStatus(run.id, 'cancelled');

      await runtime.executeTick();

      expect(runtime.getExecutor(run.id)).toBeUndefined();
    });
  });

  describe('Task Agent integration', () => {
    function makeMockTaskAgentManager(
      overrides: {
        isSpawning?: (taskId: string) => boolean;
        isTaskAgentAlive?: (taskId: string) => boolean;
        spawnWorkflowNodeAgent?: (task: unknown) => Promise<string>;
        cancelBySessionId?: (sessionId: string) => void;
        interruptBySessionId?: (sessionId: string) => Promise<void>;
        rehydrate?: () => Promise<void>;
      } = {}
    ) {
      const spawned: string[] = [];
      const taskIdForExecution = (executionId: string): string => {
        const execution = nodeExecutionRepo.getById(executionId);
        if (!execution) return executionId;
        return taskRepo.listByWorkflowRun(execution.workflowRunId)[0]?.id ?? executionId;
      };
      const spawnImpl =
        overrides.spawnWorkflowNodeAgent ??
        (async (task: unknown) => {
          const t = task as { id: string };
          spawned.push(t.id);
          taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
          return `session:${t.id}`;
        });
      return {
        isExecutionSpawning: (executionId: string) =>
          (overrides.isSpawning ?? (() => false))(taskIdForExecution(executionId)),
        isSessionAlive: (sessionId: string) => {
          const taskId = sessionId.startsWith('session:')
            ? sessionId.slice('session:'.length).split(':')[0]
            : sessionId;
          return (overrides.isTaskAgentAlive ?? (() => false))(taskId);
        },
        isSessionInMemory(sessionId: string): boolean {
          return this.isSessionAlive(sessionId);
        },
        spawnWorkflowNodeAgentForExecution: async (
          task: unknown,
          _space: unknown,
          _workflow: unknown,
          _run: unknown,
          execution: unknown
        ) => {
          const sessionId = await spawnImpl(task);
          const e = execution as { id?: string };
          if (e.id) {
            nodeExecutionRepo.update(e.id, {
              status: 'in_progress',
              agentSessionId: sessionId,
              startedAt: Date.now(),
              completedAt: null,
            });
          }
          return sessionId;
        },
        cancelBySessionId: overrides.cancelBySessionId ?? (() => {}),
        interruptBySessionId: overrides.interruptBySessionId ?? (async () => {}),
        getAgentSessionById: () => null,
        rehydrate: overrides.rehydrate ?? (async () => {}),
        _spawned: spawned,
      };
    }

    function buildRuntimeWithMockTAM(
      tam: ReturnType<typeof makeMockTaskAgentManager>,
      overrideSpaceManager?: {
        getSpace: (id: string) => Promise<unknown>;
        listSpaces: () => Promise<unknown[]>;
      }
    ) {
      return new SpaceRuntime({
        db,
        spaceManager: (overrideSpaceManager ?? spaceManager) as never,
        longHorizonAgentRepo,
        spaceWorkflowManager: workflowManager,
        workflowRunRepo,
        taskRepo,
        nodeExecutionRepo,
        taskAgentManager: tam as never,
      });
    }

    test('spawns Task Agent for pending task when taskAgentManager is configured', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      const tam = makeMockTaskAgentManager();
      const rt = buildRuntimeWithMockTAM(tam);

      const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      expect(tasks[0].status).toBe('open');

      await rt.executeTick();

      expect(tam._spawned).toContain(tasks[0].id);
      const updated = taskRepo.getTask(tasks[0].id)!;
      expect(updated.status).toBe('in_progress');
      expect(updated.taskAgentSessionId).toBe(`session:${tasks[0].id}`);
    });

    test.each([
      'in_progress',
      'approved',
      'rate_limited',
      'usage_limited',
    ] as const)('open workflow task does not spawn when a %s task occupies the only slot', async (occupyingStatus) => {
      const occupyingTask = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: `Occupying ${occupyingStatus}`,
        description: '',
        status: occupyingStatus,
      });
      expect(taskRepo.getTask(occupyingTask.id)?.status).toBe(occupyingStatus);
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const tam = makeMockTaskAgentManager();
      const rt = buildRuntimeWithMockTAM(tam);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Slot-Gated Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0]!;

      await rt.executeTick();

      expect(taskRepo.getTask(tasks[0].id)?.status).toBe('open');
      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('pending');
      expect(nodeExecutionRepo.getById(execution.id)?.agentSessionId).toBeNull();
      expect(tam._spawned).toHaveLength(0);
    });

    test.each([
      'rate_limited',
      'usage_limited',
    ] as const)('%s workflow task does not spawn its pending execution', async (status) => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const tam = makeMockTaskAgentManager();
      const rt = buildRuntimeWithMockTAM(tam);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Limited Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0]!;
      taskRepo.updateTask(tasks[0].id, {
        status,
        restrictions: {
          type: status === 'rate_limited' ? 'rate_limit' : 'usage_limit',
          limit: 'future-reset',
          resetAt: Date.now() + 60_000,
          sessionRole: 'worker',
        },
      });

      await rt.executeTick();

      expect(taskRepo.getTask(tasks[0].id)?.status).toBe(status);
      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('pending');
      expect(nodeExecutionRepo.getById(execution.id)?.agentSessionId).toBeNull();
      expect(tam._spawned).toHaveLength(0);
    });

    test.each([
      'done',
      'cancelled',
      'archived',
      'stopped',
    ] as const)('%s workflow task does not spawn its pending execution', async (status) => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const tam = makeMockTaskAgentManager();
      const rt = buildRuntimeWithMockTAM(tam);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Terminal Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0]!;
      taskRepo.updateTask(tasks[0].id, {
        status,
        completedAt: status === 'done' || status === 'cancelled' ? Date.now() : null,
      });

      await rt.executeTick();

      expect(taskRepo.getTask(tasks[0].id)?.status).toBe(status);
      expect(nodeExecutionRepo.getById(execution.id)?.agentSessionId).toBeNull();
      expect(tam._spawned).toHaveLength(0);
    });

    test('paused space does not spawn a pending workflow execution', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);
      const tam = makeMockTaskAgentManager();
      const rt = buildRuntimeWithMockTAM(tam);
      const { run, tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Paused Run');
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0]!;
      await spaceManager.pauseSpace(SPACE_ID);

      await rt.executeTick();

      expect(taskRepo.getTask(tasks[0].id)?.status).toBe('open');
      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('pending');
      expect(tam._spawned).toHaveLength(0);
    });

    test('skips tick when Task Agent is alive (in_progress task with taskAgentSessionId)', async () => {
      const workflow = buildLinearWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
          { id: STEP_B, name: 'Code', agentId: AGENT_CODER },
        ],
        [{ type: 'always' }]
      );

      let spawnCount = 0;
      const tam = makeMockTaskAgentManager({
        isTaskAgentAlive: () => true,
        spawnWorkflowNodeAgent: async (task: unknown) => {
          const t = task as { id: string };
          spawnCount++;
          taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
          return `session:${t.id}`;
        },
      });
      const rt = buildRuntimeWithMockTAM(tam);

      const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      await rt.executeTick();
      expect(spawnCount).toBe(1);

      const taskAfterSpawn = taskRepo.getTask(tasks[0].id)!;
      expect(taskAfterSpawn.taskAgentSessionId).toBeTruthy();

      await rt.executeTick();
      await rt.executeTick();
      expect(spawnCount).toBe(1);
    });

    test('crashed Task Agent resets to pending on first crash (retry) then needs_attention after max retries', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      let spawnCount = 0;
      const tam = makeMockTaskAgentManager({
        isTaskAgentAlive: () => false,
        spawnWorkflowNodeAgent: async (task: unknown) => {
          const t = task as { id: string };
          spawnCount++;
          taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}:v${spawnCount}` });
          return `session:${t.id}:v${spawnCount}`;
        },
      });
      const rt = buildRuntimeWithMockTAM(tam);

      const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      const firstExecution = nodeExecutionRepo.listByNode(tasks[0].workflowRunId!, STEP_A)[0]!;
      nodeExecutionRepo.update(firstExecution.id, {
        agentSessionId: 'session:dead',
        status: 'in_progress',
      });

      await rt.executeTick();
      let updated = taskRepo.getTask(tasks[0].id)!;
      expect(updated.status).toBe('in_progress');
      expect(spawnCount).toBe(1);

      await rt.executeTick();
      updated = taskRepo.getTask(tasks[0].id)!;
      expect(updated.status).toBe('in_progress');
      expect(spawnCount).toBe(2);

      await rt.executeTick();
      updated = taskRepo.getTask(tasks[0].id)!;
      expect(updated.status).toBe('blocked');
      expect(updated.result).toContain('3 times');
      expect(spawnCount).toBe(2);
    });

    test('concurrency guard: isSpawning() prevents duplicate spawns during concurrent ticks', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      let spawnCount = 0;
      const spawningSet = new Set<string>();
      const tam = makeMockTaskAgentManager({
        isSpawning: (taskId: string) => spawningSet.has(taskId),
        spawnWorkflowNodeAgent: async (task: unknown) => {
          const t = task as { id: string };
          spawnCount++;
          spawningSet.add(t.id);
          taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
          spawningSet.delete(t.id);
          return `session:${t.id}`;
        },
      });
      const rt = buildRuntimeWithMockTAM(tam);

      const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      spawningSet.add(tasks[0].id);

      await rt.executeTick();

      expect(spawnCount).toBe(0);
    });

    test('idempotent spawn: pending task without taskAgentSessionId only spawns once per tick', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
        { id: STEP_B, name: 'Code', agentId: AGENT_CODER },
      ]);

      let spawnCount = 0;
      const tam = makeMockTaskAgentManager({
        isTaskAgentAlive: (taskId: string) => {
          const task = taskRepo.getTask(taskId);
          return !!task?.taskAgentSessionId;
        },
        spawnWorkflowNodeAgent: async (task: unknown) => {
          const t = task as { id: string };
          spawnCount++;
          taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
          return `session:${t.id}`;
        },
      });
      const rt = buildRuntimeWithMockTAM(tam);

      const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      await rt.executeTick();
      await rt.executeTick();
      await rt.executeTick();

      expect(spawnCount).toBe(1);
      expect(taskRepo.getTask(tasks[0].id)!.status).toBe('in_progress');
    });

    test('logs warning and skips spawn when space is null (space deleted mid-run)', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      const tam = makeMockTaskAgentManager({
        spawnWorkflowNodeAgent: async (task: unknown) => {
          const t = task as { id: string };
          taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
          return `session:${t.id}`;
        },
      });
      const realRt = buildRuntimeWithMockTAM(tam);
      const { tasks } = await realRt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      let spawnCount = 0;
      const tamForNull = makeMockTaskAgentManager({
        spawnWorkflowNodeAgent: async (task: unknown) => {
          const t = task as { id: string };
          spawnCount++;
          taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
          return `session:${t.id}`;
        },
      });

      const nullSpaceManager = {
        getSpace: async () => null,
        listSpaces: async () => [{ id: SPACE_ID, workspacePath: WORKSPACE }],
      };
      const rtWithNullSpace = buildRuntimeWithMockTAM(tamForNull, nullSpaceManager);

      await rtWithNullSpace.executeTick();

      expect(spawnCount).toBe(0);
      expect(taskRepo.getTask(tasks[0].id)!.status).toBe('open');
    });

    test('liveness loop resets crashed task to pending (1st crash) and leaves alive sibling untouched', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      const tam = makeMockTaskAgentManager({
        isTaskAgentAlive: (taskId: string) => taskId === 'task-alive',
      });
      const rt = buildRuntimeWithMockTAM(tam);

      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      const taskB = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Plan B',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });

      const taskBId = taskB.id;
      taskRepo.updateTask(taskBId, { taskAgentSessionId: 'session:dead-b' });

      const firstTask = taskRepo.listByWorkflowRun(run.id).find((t) => t.id !== taskBId)!;
      taskRepo.updateTask(firstTask.id, { status: 'in_progress' });

      const aliveId = firstTask.id;
      const customTam = makeMockTaskAgentManager({
        isTaskAgentAlive: (taskId: string) => taskId === aliveId,
      });
      const rt2 = buildRuntimeWithMockTAM(customTam);

      await rt2.executeTick();

      const updatedB = taskRepo.getTask(taskBId)!;
      expect(updatedB.status).toBe('archived');
      expect(updatedB.workflowRunId).toBeUndefined();

      const updatedA = taskRepo.getTask(aliveId)!;
      expect(updatedA.status).toBe('in_progress');
    });

    test('liveness loop marks crashed task needs_attention after max retries exhausted', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      let spawnCount = 0;
      const aliveIds = new Set<string>();
      const tam = makeMockTaskAgentManager({
        isTaskAgentAlive: (taskId: string) => aliveIds.has(taskId),
        spawnWorkflowNodeAgent: async (task: unknown) => {
          const t = task as { id: string };
          spawnCount++;
          const sessionId = `session:${t.id}:v${spawnCount}`;
          taskRepo.updateTask(t.id, { taskAgentSessionId: sessionId });
          return sessionId;
        },
      });
      const rt = buildRuntimeWithMockTAM(tam);
      const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      const firstExecution = nodeExecutionRepo.listByNode(tasks[0].workflowRunId!, STEP_A)[0]!;
      nodeExecutionRepo.update(firstExecution.id, {
        agentSessionId: 'session:dead-initial',
        status: 'in_progress',
      });

      await rt.executeTick();
      await rt.executeTick();
      await rt.executeTick();

      const updated = taskRepo.getTask(tasks[0].id)!;
      expect(updated.status).toBe('blocked');
      expect(updated.result).toContain('3 times');
    });
  });

  describe('space.create seeding (unit-level check)', () => {
    test('seedBuiltInWorkflows seeds templateKey-bound workflows without agent rows', async () => {
      const newSpaceId = 'space-seed-test';
      const newWorkspacePath = '/tmp/seed-test';
      seedSpaceRow(db, newSpaceId, newWorkspacePath);

      const { seedBuiltInWorkflows } = await import(
        '../../../../src/lib/space/workflows/built-in-workflows.ts'
      );

      expect(() => seedBuiltInWorkflows(newSpaceId, workflowManager)).not.toThrow();

      const workflows = workflowManager.listWorkflows(newSpaceId);
      expect(workflows).toHaveLength(5);
      for (const wf of workflows) {
        for (const node of wf.nodes) {
          for (const agent of node.agents) {
            expect(agent.agentId).toBe('');
            expect(agent.templateKey).toMatch(/^worker\./);
          }
        }
      }
    });

    test('seedBuiltInWorkflows is idempotent (calling twice is a no-op)', async () => {
      const newSpaceId = 'space-seed-idempotent';
      const newWorkspacePath = '/tmp/seed-idempotent';
      seedSpaceRow(db, newSpaceId, newWorkspacePath);

      const { seedBuiltInWorkflows } = await import(
        '../../../../src/lib/space/workflows/built-in-workflows.ts'
      );

      seedBuiltInWorkflows(newSpaceId, workflowManager);
      seedBuiltInWorkflows(newSpaceId, workflowManager);

      const workflows = workflowManager.listWorkflows(newSpaceId);
      expect(workflows).toHaveLength(5);
    });
  });

  describe('multi-agent step support', () => {
    test('startWorkflowRun() creates one canonical task and one execution per agent', async () => {
      const startNode = {
        id: STEP_A,
        name: 'Parallel Start',
        agents: [
          {
            agentId: AGENT_CODER,
            name: 'coder',
            instructions: { mode: 'override' as const, value: 'Coder task' },
          },
          {
            agentId: AGENT_PLANNER,
            name: 'planner',
            instructions: { mode: 'override' as const, value: 'Planner task' },
          },
        ],
      };
      const { nodes, endNodeId } = appendSyntheticEnd([startNode], AGENT_CODER);
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Multi-Agent Start ${Date.now()}`,
        nodes,
        transitions: [],
        startNodeId: STEP_A,
        endNodeId,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      expect(tasks).toHaveLength(1);
      expect(tasks[0].workflowRunId).toBe(run.id);
      expect(tasks[0].status).toBe('open');
      const executions = nodeExecutionRepo.listByNode(run.id, STEP_A);
      expect(executions).toHaveLength(2);
      expect(executions.map((e) => e.agentName).sort()).toEqual(['coder', 'planner']);
    });

    test('startWorkflowRun() supports agentId shorthand for single-agent start step', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Start', agentId: AGENT_CODER },
      ]);

      const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('open');
    });

    test('startWorkflowRun() creates executions for multi-agent start step', async () => {
      const startNode = {
        id: STEP_A,
        name: 'Mixed Start',
        agents: [
          { agentId: AGENT_PLANNER, name: 'planner' },
          { agentId: AGENT_CODER, name: 'coder' },
        ],
      };
      const { nodes, endNodeId } = appendSyntheticEnd([startNode], AGENT_CODER);
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Multi-Agent TaskType ${Date.now()}`,
        nodes,
        transitions: [],
        startNodeId: STEP_A,
        endNodeId,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('open');
      const executions = nodeExecutionRepo.listByNode(tasks[0].workflowRunId!, STEP_A);
      expect(executions).toHaveLength(2);
    });

    test('executeTick() does not complete run when only some parallel executions are done', async () => {
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Partial Complete ${Date.now()}`,
        nodes: [
          {
            id: STEP_A,
            name: 'Parallel A',
            agents: [
              { agentId: AGENT_CODER, name: 'coder' },
              { agentId: AGENT_PLANNER, name: 'planner' },
            ],
          },
          { id: STEP_B, name: 'Step B', agentId: AGENT_CODER },
        ],
        transitions: [{ from: STEP_A, to: STEP_B, condition: { type: 'always' }, order: 0 }],
        startNodeId: STEP_A,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      expect(tasks).toHaveLength(1);

      const executions = nodeExecutionRepo.listByNode(run.id, STEP_A);
      expect(executions).toHaveLength(2);
      nodeExecutionRepo.update(executions[0].id, { status: 'idle' });

      await runtime.executeTick();

      const updatedRun = workflowRunRepo.getRun(run.id)!;
      expect(updatedRun.status).toBe('in_progress');
      expect(taskRepo.listByWorkflowRun(run.id)).toHaveLength(1);
    });

    test('executeTick() marks run blocked when one parallel execution is blocked', async () => {
      const startNode = {
        id: STEP_A,
        name: 'Parallel Fail',
        agents: [
          { agentId: AGENT_CODER, name: 'coder' },
          { agentId: AGENT_PLANNER, name: 'planner' },
        ],
      };
      const { nodes, endNodeId } = appendSyntheticEnd([startNode], AGENT_CODER);
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Partial Failure ${Date.now()}`,
        nodes,
        transitions: [],
        startNodeId: STEP_A,
        endNodeId,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      expect(tasks).toHaveLength(1);

      const executions = nodeExecutionRepo.listByNode(run.id, STEP_A);
      nodeExecutionRepo.update(executions[0].id, { status: 'idle' });
      nodeExecutionRepo.update(executions[1].id, { status: 'blocked', result: 'Build failed' });

      await runtime.executeTick();

      const updatedRun = workflowRunRepo.getRun(run.id)!;
      expect(updatedRun.status).toBe('blocked');
    });

    test('executeTick() marks run blocked when one execution is blocked and one is in_progress', async () => {
      const startNode = {
        id: STEP_A,
        name: 'Parallel Waiting',
        agents: [
          { agentId: AGENT_CODER, name: 'coder' },
          { agentId: AGENT_PLANNER, name: 'planner' },
        ],
      };
      const { nodes, endNodeId } = appendSyntheticEnd([startNode], AGENT_CODER);
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Partial Terminal ${Date.now()}`,
        nodes,
        transitions: [],
        startNodeId: STEP_A,
        endNodeId,
        rules: [],
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      expect(tasks).toHaveLength(1);

      const executions = nodeExecutionRepo.listByNode(run.id, STEP_A);
      nodeExecutionRepo.update(executions[0].id, { status: 'blocked', result: 'Fail' });
      nodeExecutionRepo.update(executions[1].id, { status: 'in_progress' });

      await runtime.executeTick();

      const updatedRun = workflowRunRepo.getRun(run.id)!;
      expect(updatedRun.status).toBe('blocked');
    });
  });

  describe('channel topology resolution', () => {
    test('storeWorkflowChannels: step with channels stores channels in memory', async () => {
      const AGENT_REVIEWER = 'agent-reviewer';
      seedAgentRow(db, AGENT_REVIEWER, SPACE_ID, 'Reviewer');

      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Channel Step ${Date.now()}`,
        nodes: [
          { id: STEP_A, name: 'Code', agents: [{ agentId: AGENT_CODER, name: 'coder' }] },
          {
            id: 'step-review',
            name: 'Review',
            agents: [{ agentId: AGENT_REVIEWER, name: 'reviewer' }],
          },
        ],
        channels: [{ id: 'ch-1', from: 'Code', to: 'Review', label: 'submit' }],
        startNodeId: STEP_A,
        tags: [],
        completionAutonomyLevel: 3,
      });

      const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      const channels = runtime.getRunWorkflowChannels(run.id);
      expect(Array.isArray(channels)).toBe(true);
      expect(channels.length).toBeGreaterThan(0);
      expect(channels[0].from).toBe('Code');
      expect(channels[0].to).toBe('Review');
    });

    test('storeWorkflowChannels: workflow without channels returns empty array', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'No Channels', agentId: AGENT_CODER },
      ]);

      const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      const channels = runtime.getRunWorkflowChannels(run.id);
      expect(Array.isArray(channels)).toBe(true);
      expect(channels.length).toBe(0);
    });

    test('storeWorkflowChannels: no auto-generated channels for multi-agent step', async () => {
      const AGENT_CODER_2 = 'agent-coder-2-duplicate-role';
      seedAgentRow(db, AGENT_CODER_2, SPACE_ID, 'Coder 2');

      const stepId = `step-dedup-${Date.now()}`;
      const startNode = {
        id: stepId,
        name: 'Two Coders',
        agents: [
          { agentId: AGENT_CODER, name: 'coder' },
          { agentId: AGENT_CODER_2, name: 'coder-2' },
        ],
      };
      const { nodes, endNodeId } = appendSyntheticEnd([startNode], AGENT_CODER);
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: 'Duplicate Role Test',
        nodes,
        startNodeId: stepId,
        endNodeId,
        completionAutonomyLevel: 3,
      });

      const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      const channels = runtime.getRunWorkflowChannels(run.id);
      expect(Array.isArray(channels)).toBe(true);
      expect(channels.length).toBe(0);
    });
  });
});
