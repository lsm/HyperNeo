/**
 * SpaceRuntime Integration Tests
 *
 * Covers:
 * - startWorkflowRun(): creates run, executor, first task with correct taskType
 * - executeTick(): advances completed tasks to next step
 * - Gate enforcement: human gate blocks advancement, needs_attention set
 * - Standalone tasks: tasks without workflowRunId are not processed by executor map
 * - Rule injection: getRulesForStep() filters correctly
 * - Rehydration: executors reconstructed from DB on startup
 * - Executor cleanup: removed from map on run complete/cancel
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { PendingAgentMessageRepository } from '../../../../src/storage/repositories/pending-agent-message-repository.ts';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceWorkflow, SpaceWorkflowRun } from '@hyperneo/shared';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
  // Use in-memory SQLite — faster than file-based DB and avoids filesystem
  // I/O contention that caused beforeEach hook timeouts in CI.
  const db = new BunDatabase(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, () => {});

  // runMigrations() applies migrations only; these unit fixtures need the base
  // sdk_messages table because runtime recovery inspects persisted SDK output.
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
  conditions: Array<{ type: 'always' | 'human'; description?: string }> = [],
  opts: { channels?: SpaceWorkflow['channels']; gates?: SpaceWorkflow['gates'] } = {}
): SpaceWorkflow {
  // Build transitions: step[i] → step[i+1] with conditions[i]
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

/**
 * End-node validation requires exactly 1 agent (validator enforced — they own
 * the `task.reportedStatus` completion signal). When a test workflow has its
 * last node as multi-agent (which used to double as start+end), append a
 * synthetic single-agent terminal node so the multi-agent node remains the
 * start (or middle) and validation passes. Tests that don't activate the
 * synthetic end node continue to behave the same.
 */
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

// ---------------------------------------------------------------------------
// Test suite setup
// ---------------------------------------------------------------------------

describe('SpaceRuntime', () => {
  let db: BunDatabase;

  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let nodeExecutionRepo: NodeExecutionRepository;
  let agentManager: SpaceAgentManager;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;
  let runtime: SpaceRuntime;

  const SPACE_ID = 'space-rt-1';
  const WORKSPACE = '/tmp/runtime-ws';

  // Agent IDs for preset roles
  const AGENT_PLANNER = 'agent-planner';
  const AGENT_CODER = 'agent-coder';
  const AGENT_GENERAL = 'agent-general';
  const AGENT_CUSTOM = 'agent-custom';

  // Step ID constants
  const STEP_A = 'step-a';
  const STEP_B = 'step-b';
  const STEP_C = 'step-c';

  beforeEach(() => {
    db = makeDb();

    // Seed space
    seedSpaceRow(db, SPACE_ID, WORKSPACE);

    // Seed agents with different roles
    seedAgentRow(db, AGENT_PLANNER, SPACE_ID, 'Planner');
    seedAgentRow(db, AGENT_CODER, SPACE_ID, 'Coder');
    seedAgentRow(db, AGENT_GENERAL, SPACE_ID, 'General');
    seedAgentRow(db, AGENT_CUSTOM, SPACE_ID, 'Custom');

    // Build managers and repos
    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    taskRepo = new SpaceTaskRepository(db);
    nodeExecutionRepo = new NodeExecutionRepository(db);

    const agentRepo = new SpaceAgentRepository(db);
    agentManager = new SpaceAgentManager(agentRepo);

    const workflowRepo = new SpaceWorkflowRepository(db);
    workflowManager = new SpaceWorkflowManager(workflowRepo);

    spaceManager = new SpaceManager(db);

    const config: SpaceRuntimeConfig = {
      db,
      spaceManager,
      spaceAgentManager: agentManager,
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
    } catch {
      /* ignore */
    }
    try {
    } catch {
      /* ignore */
    }
  });

  // -------------------------------------------------------------------------
  // getRulesForStep — removed in M71; no tests needed
  // -------------------------------------------------------------------------

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
        spaceAgentManager: agentManager,
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
        prepareSubSessionForWorkflowResume: async (sessionId: string) => {
          preparedSessions.push(sessionId);
          return true;
        },
      } as SpaceRuntimeConfig['taskAgentManager'];
      runtime = new SpaceRuntime({
        db,
        spaceManager,
        spaceAgentManager: agentManager,
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

    describe('recoverWorkflowBackedTask() — handoff expiration regression', () => {
      /** Minimal taskAgentManager stub that satisfies the runtime's tick loop. */
      function makeStubTam() {
        return {
          isSessionAlive: (_sid: string) => false,
          isExecutionSpawning: (_eid: string) => false,
          spawnWorkflowNodeAgentForExecution: async () => {
            throw new Error('spawn failed');
          },
          rehydrate: async () => {},
          getAgentSessionById: (_sid: string) => null,
          interruptBySessionId: async () => {},
          flushPendingMessagesForTarget: async () => {},
          tryResumeNodeAgentSession: async () => {},
        } as unknown as SpaceRuntimeConfig['taskAgentManager'];
      }

      test('clears expired queued handoffs so next tick does not re-block the run', async () => {
        const pendingMessageRepo = new PendingAgentMessageRepository(db);
        runtime = new SpaceRuntime({
          db,
          spaceManager,
          spaceAgentManager: agentManager,
          spaceWorkflowManager: workflowManager,
          workflowRunRepo,
          taskRepo,
          nodeExecutionRepo,
          pendingMessageRepo,
          taskAgentManager: makeStubTam(),
        });

        const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
          { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
          { id: STEP_B, name: 'Review', agentId: AGENT_CODER },
        ]);
        const { run, tasks } = await runtime.startWorkflowRun(
          SPACE_ID,
          workflow.id,
          'Handoff expiry'
        );
        const task = tasks[0];

        // Simulate an expired queued handoff message to the reviewer node.
        // In production, expireStale() inside repairQueuedWorkflowNodeHandoffs
        // converts pending → expired; here we pre-expire to force the blocked path.
        pendingMessageRepo.enqueue({
          workflowRunId: run.id,
          spaceId: SPACE_ID,
          taskId: task.id,
          targetKind: 'node_agent',
          targetAgentName: 'Review',
          message: 'handoff to reviewer',
          expiresAt: Date.now() - 1, // already expired
        });

        // Tick to trigger the expired-handoff → blocked path
        await runtime.executeTick();

        // Verify the run is now blocked due to expired handoff
        const blockedRun = workflowRunRepo.getRun(run.id)!;
        expect(blockedRun.status).toBe('blocked');

        const blockedTask = taskRepo.getTask(task.id)!;
        expect(blockedTask.status).toBe('blocked');

        // Now recover the task
        await runtime.recoverWorkflowBackedTask(SPACE_ID, task.id, 'in_progress');

        // Verify expired messages were cleared
        const allMessages = pendingMessageRepo.listAllForRun(run.id);
        const expiredMessages = allMessages.filter((m) => m.status === 'expired');
        expect(expiredMessages).toHaveLength(0);

        // Run the tick again — should NOT re-block
        await runtime.executeTick();

        const recoveredTask = taskRepo.getTask(task.id)!;
        const recoveredRun = workflowRunRepo.getRun(run.id)!;
        expect(recoveredTask.status).toBe('in_progress');
        expect(recoveredRun.status).toBe('in_progress');
      });

      test('clearTerminalForRun clears expired, failed, and delivered but preserves pending', async () => {
        const pendingMessageRepo = new PendingAgentMessageRepository(db);

        // Create a run to attach messages to
        const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
          { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
        ]);
        const { run, tasks } = await runtime.startWorkflowRun(
          SPACE_ID,
          workflow.id,
          'Clear terminal'
        );
        const task = tasks[0];

        // Enqueue messages with different fates
        pendingMessageRepo.enqueue({
          workflowRunId: run.id,
          spaceId: SPACE_ID,
          taskId: task.id,
          targetKind: 'node_agent',
          targetAgentName: 'Plan',
          message: 'will expire',
          expiresAt: Date.now() - 1,
        });
        pendingMessageRepo.expireStale(run.id); // convert to expired

        const failedResult = pendingMessageRepo.enqueue({
          workflowRunId: run.id,
          spaceId: SPACE_ID,
          taskId: task.id,
          targetKind: 'node_agent',
          targetAgentName: 'Plan',
          message: 'will fail',
          maxAttempts: 1,
        });
        pendingMessageRepo.markAttemptFailed(failedResult.record.id, 'test failure');

        pendingMessageRepo.enqueue({
          workflowRunId: run.id,
          spaceId: SPACE_ID,
          taskId: task.id,
          targetKind: 'node_agent',
          targetAgentName: 'Plan',
          message: 'stays pending',
        });

        // Verify setup: 1 expired, 1 failed, 1 pending
        const before = pendingMessageRepo.listAllForRun(run.id);
        expect(before.filter((m) => m.status === 'expired')).toHaveLength(1);
        expect(before.filter((m) => m.status === 'failed')).toHaveLength(1);
        expect(before.filter((m) => m.status === 'pending')).toHaveLength(1);

        // Clear terminal messages
        const deleted = pendingMessageRepo.clearTerminalForRun(run.id);
        expect(deleted).toBe(2); // expired + failed

        // Verify: only pending remains
        const after = pendingMessageRepo.listAllForRun(run.id);
        expect(after).toHaveLength(1);
        expect(after[0].status).toBe('pending');
        expect(after[0].message).toBe('stays pending');
      });

      test('resets blocked retry counter on recovery so auto-retry is not exhausted', async () => {
        runtime = new SpaceRuntime({
          db,
          spaceManager,
          spaceAgentManager: agentManager,
          spaceWorkflowManager: workflowManager,
          workflowRunRepo,
          taskRepo,
          nodeExecutionRepo,
        });

        const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
          { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
        ]);
        const { run, tasks } = await runtime.startWorkflowRun(
          SPACE_ID,
          workflow.id,
          'Retry counter'
        );
        const task = tasks[0];

        // Helper to manually block run + executions + task
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

        // Block and tick — auto-retry fires (counter becomes 1),
        // resets execution to pending, run → in_progress.
        // MAX_BLOCKED_RUN_RETRIES = 1.
        blockAll();
        await runtime.executeTick();
        expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');

        // Block again and tick — counter (1) >= MAX (1), retries exhausted,
        // run stays blocked.
        blockAll();
        await runtime.executeTick();
        expect(workflowRunRepo.getRun(run.id)!.status).toBe('blocked');

        // Recover — should reset the retry counter
        await runtime.recoverWorkflowBackedTask(SPACE_ID, task.id, 'in_progress');

        // Block again and tick — auto-retry should fire again (counter was reset)
        blockAll();
        await runtime.executeTick();

        const retriedRun = workflowRunRepo.getRun(run.id)!;
        expect(retriedRun.status).toBe('in_progress');
      });
    });
  });

  // -------------------------------------------------------------------------
  // startWorkflowRun()
  // -------------------------------------------------------------------------

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
      // Baseline: whatever channels the pinned definition has immediately after start
      // (robust to whether transitions are materialized as channels).
      const pinnedChannelCount = runtime.getWorkflowChannels(run.id).length;

      // Edit the head AFTER the run was pinned — append a back-channel that did not exist
      // at run creation. An in-flight run must keep executing its pinned version.
      const head = workflowManager.getWorkflow(workflow.id)!;
      workflowManager.updateWorkflow(workflow.id, {
        channels: [
          ...(head.channels ?? []),
          { id: 'back-code-plan', from: 'Code', to: 'Plan', maxCycles: 3 },
        ],
      });

      // The head now carries one more channel; the run's runtime read stays pinned.
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
      // workflowNodeId was removed from SpaceTask in M71; node tracking moved to node_executions
      expect(task.status).toBe('open');
      expect(task.title).toBe('My Run');
    });

    test('creates task with open status for planner start step', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      // taskType removed from SpaceTask in M71; role-to-type mapping no longer stored on task
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

    // maxIterations removed from CreateSpaceWorkflowParams and CreateWorkflowRunParams;
    // per-channel maxCycles via ChannelCycleRepository replaces global iteration tracking.

    test('throws for unknown workflow', async () => {
      await expect(runtime.startWorkflowRun(SPACE_ID, 'nonexistent-wf-id', 'Run')).rejects.toThrow(
        'Workflow not found'
      );
    });

    test('cancels DB run record when task creation fails (prevents silent rehydration loop)', async () => {
      // Create a workflow where the startNodeId references a valid node but the
      // agentId references an agent that is then deleted, causing createTask to fail
      // due to the foreign key constraint on space_tasks.agent_id.
      // Instead, use FK-bypass to create a workflow with a bogus startNodeId to
      // trigger the "Start node not found" path which also exercises the cleanup.
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

      // Count runs before
      const runsBefore = workflowRunRepo.listBySpace(SPACE_ID);

      await expect(runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Bad Run')).rejects.toThrow();

      // The newly created run should be cancelled, not left as in_progress
      const runsAfter = workflowRunRepo.listBySpace(SPACE_ID);
      const newRun = runsAfter.find((r) => !runsBefore.some((b) => b.id === r.id));
      expect(newRun).toBeDefined();
      expect(newRun!.status).toBe('cancelled');

      // Executor map should not retain the failed run
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
      // goalId was removed from SpaceWorkflowRun in M71; the param is silently ignored
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

      // run and task should still be created successfully
      expect(run).toBeDefined();
      expect(tasks).toHaveLength(1);
    });

    test('goalId defaults to undefined when not provided', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'No Goal');

      // goalId removed from SpaceWorkflowRun and SpaceTask in M71
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
      // Bypass FK + manager validation to insert a step with no agentId/agents
      db.exec('PRAGMA foreign_keys = OFF');
      let workflow: SpaceWorkflow;
      try {
        const repo = new SpaceWorkflowRepository(db);
        // Insert step JSON directly with no agentId and no agents[]
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

      // Run should not remain active in the executor map
      const runsAfter = workflowRunRepo.listBySpace(SPACE_ID);
      const newRun = runsAfter.find((r) => !runsBefore.some((b) => b.id === r.id));
      if (newRun) {
        expect(newRun.status).toBe('cancelled');
      }
      expect(runtime.executorCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Standalone tasks
  // -------------------------------------------------------------------------

  describe('standalone tasks', () => {
    test('standalone task (no workflowRunId) is not processed by executor map', async () => {
      // Create a standalone task directly via repo
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Standalone Task',
        description: 'No workflow',
        status: 'open',
      });

      // Tick should not throw and executor count stays 0
      await runtime.executeTick();

      expect(runtime.executorCount).toBe(0);

      // Task status unchanged
      const unchanged = taskRepo.getTask(task.id)!;
      expect(unchanged.status).toBe('open');
    });

    test('uses preferredWorkflowId when attaching workflow to standalone task', async () => {
      // Create two workflows — one preferred, one that would match heuristically
      const preferredWorkflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT_CODER },
      ]);
      // Second workflow with tags that would win the heuristic for "fix bug" keywords
      buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_B, name: 'Fix', agentId: AGENT_GENERAL },
      ]);

      // Create task with explicit preferredWorkflowId
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Fix login bug',
        description: 'Authentication fails for international users',
        status: 'open',
        preferredWorkflowId: preferredWorkflow.id,
      });

      // Tick attaches the preferred workflow
      await runtime.executeTick();

      const updated = taskRepo.getTask(task.id)!;
      expect(updated.workflowRunId).not.toBeNull();

      // Verify the run uses the preferred workflow
      const run = workflowRunRepo.getRun(updated.workflowRunId!);
      expect(run).not.toBeNull();
      expect(run!.workflowId).toBe(preferredWorkflow.id);
    });

    test('falls back to heuristic when preferredWorkflowId workflow is not found', async () => {
      const fallbackWorkflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Work', agentId: AGENT_CODER },
      ]);

      // Create task with a non-existent preferred workflow ID
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Some task',
        description: 'Some description',
        status: 'open',
        preferredWorkflowId: 'wf-does-not-exist',
      });

      await runtime.executeTick();

      // Runtime should have fallen back and attached a workflow
      const updated = taskRepo.getTask(task.id)!;
      expect(updated.workflowRunId).not.toBeNull();

      const run = workflowRunRepo.getRun(updated.workflowRunId!);
      expect(run).not.toBeNull();
      // Fallback: uses the only available workflow
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

  // -------------------------------------------------------------------------
  // Rehydration
  // -------------------------------------------------------------------------

  describe('rehydrateExecutors()', () => {
    test('rehydration is idempotent (second executeTick does not double-rehydrate)', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      // First tick — triggers rehydration check (rehydrated already set)
      await runtime.executeTick();

      // Second tick — should not duplicate executors
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

      // Delete the workflow
      // Simulate a workflow deleted out from under an active run — a legacy
      // orphan the deletion guard (RFC §4 #3) now prevents in normal operation,
      // but which rehydration must still tolerate. Bypass the manager guard by
      // deleting at the repo level (no active-run check).
      new SpaceWorkflowRepository(db).deleteWorkflow(workflow.id);

      // Fresh runtime — should not throw, should skip the orphaned run
      const freshRuntime = new SpaceRuntime({
        db,
        spaceManager,
        spaceAgentManager: agentManager,
        spaceWorkflowManager: workflowManager,
        workflowRunRepo,
        taskRepo,
        nodeExecutionRepo: new NodeExecutionRepository(db),
      });

      await expect(freshRuntime.executeTick()).resolves.toBeUndefined();
      expect(freshRuntime.executorCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Executor cleanup
  // -------------------------------------------------------------------------

  describe('executor cleanup', () => {
    test('cleanupTerminalExecutors() removes cancelled runs', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      const { run } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
      expect(runtime.executorCount).toBe(1);

      // Externally cancel the run
      workflowRunRepo.transitionStatus(run.id, 'cancelled');

      // executeTick → processCompletedTasks skips cancelled, cleanupTerminalExecutors removes it
      await runtime.executeTick();

      expect(runtime.getExecutor(run.id)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Task Agent integration (taskAgentManager configured)
  // -------------------------------------------------------------------------

  describe('queued workflow node handoff repair', () => {
    function makeWorkflowForHandoffRepair() {
      return workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Handoff Repair ${Date.now()}-${Math.random()}`,
        description: 'Test queued handoff repair',
        nodes: [
          { id: 'coding-node', name: 'Coder', agentId: AGENT_CODER },
          { id: 'review-node', name: 'Review', agentId: AGENT_GENERAL },
          { id: 'qa-node', name: 'QA', agentId: AGENT_PLANNER },
        ],
        transitions: [],
        channels: [
          { id: 'review-to-coding', from: 'Review', to: 'Coder' },
          { id: 'qa-to-coding', from: 'QA', to: 'Coder' },
        ],
        startNodeId: 'coding-node',
        endNodeId: 'coding-node',
        rules: [],
        completionAutonomyLevel: 3,
      });
    }

    function makeRepairTam(
      overrides: {
        spawn?: (executionId: string) => Promise<string>;
        spawningExecutionIds?: Set<string>;
        liveSessions?: Set<string>;
        resume?: (runId: string, agentName: string) => Promise<void>;
        flush?: (runId: string, agentName: string, sessionId: string) => Promise<void>;
      } = {}
    ) {
      const spawnedExecutionIds: string[] = [];
      const liveSessions = overrides.liveSessions ?? new Set<string>();
      return {
        isExecutionSpawning: (executionId: string) =>
          overrides.spawningExecutionIds?.has(executionId) ?? false,
        isSessionAlive: (sessionId: string) => liveSessions.has(sessionId),
        tryResumeNodeAgentSession: async (runId: string, agentName: string) => {
          await overrides.resume?.(runId, agentName);
        },
        spawnWorkflowNodeAgentForExecution: async (
          _task: unknown,
          _space: unknown,
          _workflow: unknown,
          _run: unknown,
          execution: { id: string }
        ) => {
          spawnedExecutionIds.push(execution.id);
          const sessionId = overrides.spawn
            ? await overrides.spawn(execution.id)
            : `session:${execution.id}`;
          liveSessions.add(sessionId);
          nodeExecutionRepo.update(execution.id, {
            status: 'in_progress',
            agentSessionId: sessionId,
            startedAt: Date.now(),
            completedAt: null,
          });
          return sessionId;
        },
        flushPendingMessagesForTarget: async (
          runId: string,
          agentName: string,
          sessionId: string
        ) => {
          if (overrides.flush) {
            await overrides.flush(runId, agentName, sessionId);
            return;
          }
          const repo = new PendingAgentMessageRepository(db);
          for (const row of repo.listPendingForTarget(runId, agentName))
            repo.markDelivered(row.id, sessionId);
        },
        cancelBySessionId: () => {},
        interruptBySessionId: async () => {},
        getAgentSessionById: () => null,
        rehydrate: async () => {},
        _spawnedExecutionIds: spawnedExecutionIds,
      };
    }

    async function setupQueuedHandoff(
      opts: {
        ttlMs?: number;
        maxAttempts?: number;
        createTargetExecution?: boolean;
        taskStatus?: 'open' | 'in_progress' | 'done' | 'cancelled' | 'archived';
        message?: string;
      } = {}
    ) {
      const workflow = makeWorkflowForHandoffRepair();
      const { run, tasks } = await runtime.startWorkflowRun(
        SPACE_ID,
        workflow.id,
        'Queued handoff'
      );
      const task = tasks[0];
      taskRepo.updateTask(task.id, {
        status: opts.taskStatus ?? 'in_progress',
        completedAt:
          opts.taskStatus === 'done' || opts.taskStatus === 'cancelled' ? Date.now() : null,
      });
      const existing = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(existing.id, { status: 'idle', agentSessionId: null });
      if (opts.createTargetExecution ?? true) {
        nodeExecutionRepo.createOrIgnore({
          workflowRunId: run.id,
          workflowNodeId: 'coding-node',
          agentName: 'Coder',
          agentId: AGENT_CODER,
          status: 'pending',
        });
      }
      const pendingRepo = new PendingAgentMessageRepository(db);
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'reviewer',
        targetKind: 'node_agent',
        targetAgentName: 'Coder',
        message: opts.message ?? 'please revise',
        ttlMs: opts.ttlMs ?? 60_000,
        maxAttempts: opts.maxAttempts ?? 3,
      });
      return { run, task, pendingRepo };
    }

    function buildRepairRuntime(
      tam: ReturnType<typeof makeRepairTam>,
      pendingRepo: PendingAgentMessageRepository
    ) {
      return new SpaceRuntime({
        db,
        spaceManager,
        spaceAgentManager: agentManager,
        spaceWorkflowManager: workflowManager,
        workflowRunRepo,
        taskRepo,
        nodeExecutionRepo,
        taskAgentManager: tam as never,
        pendingMessageRepo: pendingRepo,
      });
    }

    test('repairs a queued handoff when target execution has no agentSessionId', async () => {
      const { run, pendingRepo } = await setupQueuedHandoff();
      await buildRepairRuntime(makeRepairTam(), pendingRepo).executeTick();
      const targetExec = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .find((execution) => execution.agentName === 'Coder')!;
      expect(targetExec.agentSessionId).toBe(`session:${targetExec.id}`);
      expect(targetExec.status).toBe('in_progress');
      expect(pendingRepo.listAllForRun(run.id)[0].status).toBe('delivered');
    });

    test('recovers a stuck handoff after daemon restart by creating the target execution', async () => {
      const { run, pendingRepo } = await setupQueuedHandoff({ createTargetExecution: false });
      await buildRepairRuntime(makeRepairTam(), pendingRepo).executeTick();
      const targetExec = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .find((execution) => execution.agentName === 'Coder')!;
      expect(targetExec.workflowNodeId).toBe('coding-node');
      expect(targetExec.agentSessionId).toBe(`session:${targetExec.id}`);
      expect(pendingRepo.listAllForRun(run.id)[0].status).toBe('delivered');
    });

    test('duplicate repair ticks do not spawn duplicate sessions or messages', async () => {
      const { run, pendingRepo } = await setupQueuedHandoff();
      const tam = makeRepairTam();
      const rt = buildRepairRuntime(tam, pendingRepo);
      await rt.executeTick();
      await rt.executeTick();
      expect(tam._spawnedExecutionIds).toHaveLength(1);
      expect(pendingRepo.listAllForRun(run.id)).toHaveLength(1);
      expect(pendingRepo.listAllForRun(run.id)[0].status).toBe('delivered');
    });

    test('drains two same-slot nodes independently (node-scoped recovery)', async () => {
      // Round-10 regression: two nodes both declare 'reviewer'; each has a
      // queued handoff row stamped with its workflowNodeId. Recovery must
      // group by (agentName, nodeId) and drain each to its own node —
      // otherwise it picks the first node, strands the other's row, and the
      // run eventually blocks.
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Same-slot recovery ${Date.now()}-${Math.random()}`,
        description: '',
        nodes: [
          { id: 'coding-node', name: 'Coder', agentId: AGENT_CODER },
          { id: 'rev-a', name: 'Review A', agentId: AGENT_GENERAL },
          { id: 'rev-b', name: 'Review B', agentId: AGENT_GENERAL },
        ],
        transitions: [],
        channels: [],
        startNodeId: 'coding-node',
        endNodeId: 'coding-node',
        rules: [],
        completionAutonomyLevel: 3,
      });
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Same-slot');
      const task = tasks[0];
      // Idle the start-node execution so it isn't treated as the repair target.
      const startExec = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      if (startExec)
        nodeExecutionRepo.update(startExec.id, { status: 'idle', agentSessionId: null });

      // Seed the two reviewer executions (pending, no session) + a queued row
      // for each, stamped with its node id.
      nodeExecutionRepo.createOrIgnore({
        workflowRunId: run.id,
        workflowNodeId: 'rev-a',
        agentName: 'reviewer',
        agentId: AGENT_GENERAL,
        status: 'pending',
      });
      nodeExecutionRepo.createOrIgnore({
        workflowRunId: run.id,
        workflowNodeId: 'rev-b',
        agentName: 'reviewer',
        agentId: AGENT_GENERAL,
        status: 'pending',
      });
      const pendingRepo = new PendingAgentMessageRepository(db);
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'coder',
        targetKind: 'node_agent',
        targetAgentName: 'reviewer',
        workflowNodeId: 'rev-a',
        message: 'for rev-a',
        ttlMs: 60_000,
        maxAttempts: 3,
      });
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'coder',
        targetKind: 'node_agent',
        targetAgentName: 'reviewer',
        workflowNodeId: 'rev-b',
        message: 'for rev-b',
        ttlMs: 60_000,
        maxAttempts: 3,
      });

      // Node-scoped flush (mirrors the real flushPendingMessagesForTarget):
      // drain only rows whose workflowNodeId matches the session's execution.
      const tam = makeRepairTam({
        flush: async (runId: string, agentName: string, sessionId: string) => {
          const exec = nodeExecutionRepo
            .listByWorkflowRun(runId)
            .find((e) => e.agentSessionId === sessionId);
          const repo = new PendingAgentMessageRepository(db);
          for (const row of repo.listPendingForTarget(runId, agentName, exec?.workflowNodeId))
            repo.markDelivered(row.id, sessionId);
        },
      });
      await buildRepairRuntime(tam, pendingRepo).executeTick();

      // Both reviewer executions spawned (each on its own node).
      const execs = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .filter((e) => e.agentName === 'reviewer');
      expect(execs).toHaveLength(2);
      expect(execs.every((e) => e.agentSessionId)).toBe(true);
      // Both rows delivered, each to its own node's session — neither stranded.
      const rows = pendingRepo.listAllForRun(run.id);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.status === 'delivered')).toBe(true);
      const deliveredNodes = new Set(
        rows.map(
          (r) =>
            execs.find((e) => e.agentSessionId === r.deliveredSessionId)?.workflowNodeId ?? null
        )
      );
      expect(deliveredNodes).toEqual(new Set(['rev-a', 'rev-b']));
    });

    test('skips repair spawn while target execution is already spawning', async () => {
      const { run, pendingRepo } = await setupQueuedHandoff();
      const targetExec = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .find((execution) => execution.agentName === 'Coder')!;
      const tam = makeRepairTam({ spawningExecutionIds: new Set([targetExec.id]) });
      await buildRepairRuntime(tam, pendingRepo).executeTick();
      expect(tam._spawnedExecutionIds).toHaveLength(0);
      expect(pendingRepo.listPendingForTarget(run.id, 'Coder')).toHaveLength(1);
    });

    test('resumes repaired handoffs with the resolved execution agent name', async () => {
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Multi-slot Handoff Repair ${Date.now()}-${Math.random()}`,
        description: 'Test queued handoff repair with node-name addressing',
        nodes: [
          {
            id: 'coding-node',
            name: 'Coder',
            agents: [{ name: 'coder-slot', agentId: AGENT_CODER }],
          },
          { id: 'review-node', name: 'Review', agentId: AGENT_GENERAL },
        ],
        transitions: [],
        channels: [{ id: 'review-to-coding', from: 'Review', to: 'Coder' }],
        startNodeId: 'coding-node',
        endNodeId: 'coding-node',
        rules: [],
        completionAutonomyLevel: 3,
      });
      const { run, tasks } = await runtime.startWorkflowRun(
        SPACE_ID,
        workflow.id,
        'Queued handoff'
      );
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'in_progress' });
      const existing = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
      nodeExecutionRepo.update(existing.id, {
        status: 'pending',
        agentSessionId: 'session:coder-slot',
        completedAt: null,
      });
      const pendingRepo = new PendingAgentMessageRepository(db);
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'reviewer',
        targetKind: 'node_agent',
        targetAgentName: 'Coder',
        message: 'please revise',
        ttlMs: 60_000,
        maxAttempts: 3,
      });
      let resumedAgentName: string | null = null;
      const tam = makeRepairTam({
        resume: async (_runId, agentName) => {
          resumedAgentName = agentName;
        },
      });
      await buildRepairRuntime(tam, pendingRepo).executeTick();
      expect(resumedAgentName).toBe('coder-slot');
      expect(tam._spawnedExecutionIds).toHaveLength(1);
    });

    test('repairs pending execution state when it references a live session before spawn', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coder', agentId: AGENT_CODER },
      ]);
      const { run, tasks } = await runtime.startWorkflowRun(
        SPACE_ID,
        workflow.id,
        'Respawn repair'
      );
      taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'pending',
        agentSessionId: 'session:live-respawn',
        startedAt: null,
        completedAt: null,
      });
      const tam = makeRepairTam({ liveSessions: new Set(['session:live-respawn']) });
      await buildRepairRuntime(tam, new PendingAgentMessageRepository(db)).executeTick();
      const updated = nodeExecutionRepo.getById(execution.id)!;
      expect(updated.status).toBe('in_progress');
      expect(updated.agentSessionId).toBe('session:live-respawn');
      expect(updated.startedAt).toBeTruthy();
      expect(tam._spawnedExecutionIds).toHaveLength(0);
    });

    test('clears dead pending session references and spawns a fresh session', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coder', agentId: AGENT_CODER },
      ]);
      const { run, tasks } = await runtime.startWorkflowRun(
        SPACE_ID,
        workflow.id,
        'Dead respawn repair'
      );
      taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0]!;
      nodeExecutionRepo.update(execution.id, {
        status: 'pending',
        agentSessionId: 'session:dead-respawn',
        startedAt: null,
        result: 'stale error',
        completedAt: Date.now(),
      });
      const tam = makeRepairTam();
      await buildRepairRuntime(tam, new PendingAgentMessageRepository(db)).executeTick();
      const updated = nodeExecutionRepo.getById(execution.id)!;
      expect(tam._spawnedExecutionIds).toEqual([execution.id]);
      expect(updated.status).toBe('in_progress');
      expect(updated.agentSessionId).toBe(`session:${execution.id}`);
      expect(updated.result).toBeNull();
      expect(updated.completedAt).toBeNull();
    });

    test('resolved handoffs do not bind to a different live slot on the same node', async () => {
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Exact Slot Handoff Repair ${Date.now()}-${Math.random()}`,
        description: 'Test queued handoff repair exact slot matching',
        nodes: [
          {
            id: 'coding-node',
            name: 'Coder',
            agents: [
              { name: 'coder-slot', agentId: AGENT_CODER },
              { name: 'helper-slot', agentId: AGENT_GENERAL },
            ],
          },
          { id: 'review-node', name: 'Review', agentId: AGENT_GENERAL },
        ],
        transitions: [],
        channels: [{ id: 'review-to-coding', from: 'Review', to: 'Coder' }],
        startNodeId: 'coding-node',
        endNodeId: 'review-node',
        rules: [],
        completionAutonomyLevel: 3,
      });
      const { run, tasks } = await runtime.startWorkflowRun(
        SPACE_ID,
        workflow.id,
        'Queued handoff'
      );
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'in_progress' });
      const coderExec = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .find((execution) => execution.agentName === 'coder-slot')!;
      nodeExecutionRepo.update(coderExec.id, {
        status: 'pending',
        agentSessionId: null,
        completedAt: null,
      });
      const helperExec = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .find((execution) => execution.agentName === 'helper-slot')!;
      nodeExecutionRepo.update(helperExec.id, {
        status: 'pending',
        agentSessionId: 'session:helper-slot',
        completedAt: null,
      });
      const pendingRepo = new PendingAgentMessageRepository(db);
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'reviewer',
        targetKind: 'node_agent',
        targetAgentName: 'Coder',
        message: 'please revise',
        ttlMs: 60_000,
        maxAttempts: 3,
      });
      const tam = makeRepairTam({ liveSessions: new Set(['session:helper-slot']) });
      await buildRepairRuntime(tam, pendingRepo).executeTick();
      expect(tam._spawnedExecutionIds).toEqual([coderExec.id]);
      expect(nodeExecutionRepo.getById(helperExec.id)!.agentSessionId).toBe('session:helper-slot');
    });

    // Compound "nodeName/agentName" handoff targets — regression coverage for
    // the message-delivery v2 scoped queue rows emitted by agent-message-router
    // (scopedAgentName) and task-agent-manager. The resolver must split the
    // compound form and match node-by-name + slot-by-name; plain slot names and
    // node names (no "/") keep resolving for backward compatibility. Without
    // this, every Coding-workflow coder→reviewer handoff blocks the run.
    function makeCompoundHandoffWorkflow() {
      return workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Compound Handoff ${Date.now()}-${Math.random()}`,
        description: 'Compound nodeName/agentName handoff resolution',
        nodes: [
          { id: 'coding-node', name: 'Coding', agents: [{ name: 'coder', agentId: AGENT_CODER }] },
          {
            id: 'review-node',
            name: 'Review',
            agents: [{ name: 'reviewer', agentId: AGENT_GENERAL }],
          },
          { id: 'qa-node', name: 'QA', agents: [{ name: 'qa', agentId: AGENT_PLANNER }] },
        ],
        transitions: [],
        channels: [
          { id: 'coding-to-review', from: 'Coding', to: 'Review' },
          { id: 'review-to-qa', from: 'Review', to: 'QA' },
        ],
        startNodeId: 'coding-node',
        endNodeId: 'qa-node',
        rules: [],
        completionAutonomyLevel: 3,
      });
    }

    // The real flushPendingMessagesForTarget drains both the bare slot name and
    // the compound "nodeName/agentName" form; mirror that so compound queue rows
    // are marked delivered in these tests. This is a deliberate simplification
    // of the real drain: it omits the workflowNodeId scoping, the
    // targetKind === 'node_agent' filter, and the executionless guard. That's
    // fine here because the compound rows enqueued below carry a null
    // workflowNodeId and targetKind 'node_agent', so scoped/unscoped queries
    // both find them and there are no executionless (merger) sessions in play.
    function makeCompoundAwareFlush(workflow: SpaceWorkflow) {
      const nodeNameById = new Map(workflow.nodes.map((node) => [node.id, node.name]));
      return async (runId: string, agentName: string, sessionId: string) => {
        const repo = new PendingAgentMessageRepository(db);
        const execution = nodeExecutionRepo.getByAgentSessionId(sessionId);
        const nodeName = execution ? nodeNameById.get(execution.workflowNodeId) : undefined;
        // Mirror real flushPendingMessagesForTarget: bare agent + "<name>/<agent>".
        // (No "<id>/<agent>" alias — see flushPendingMessagesForTarget.)
        const targets = [agentName, ...(nodeName ? [`${nodeName}/${agentName}`] : [])];
        const seen = new Set<string>();
        for (const target of targets) {
          const rows =
            execution?.workflowNodeId != null
              ? repo.listPendingForTarget(runId, target, execution.workflowNodeId)
              : repo.listPendingForTarget(runId, target);
          for (const row of rows) {
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            repo.markDelivered(row.id, sessionId);
          }
        }
      };
    }

    test('resolves a compound "Review/reviewer" handoff target (coder→reviewer)', async () => {
      const workflow = makeCompoundHandoffWorkflow();
      const { run, tasks } = await runtime.startWorkflowRun(
        SPACE_ID,
        workflow.id,
        'Compound handoff'
      );
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'in_progress' });
      // Idle the start node so the sweep focuses on the queued reviewer handoff.
      nodeExecutionRepo.update(nodeExecutionRepo.listByWorkflowRun(run.id)[0]!.id, {
        status: 'idle',
        agentSessionId: null,
      });

      const pendingRepo = new PendingAgentMessageRepository(db);
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'coder',
        targetKind: 'node_agent',
        targetAgentName: 'Review/reviewer',
        message: 'please review',
        ttlMs: 60_000,
        maxAttempts: 3,
      });
      const tam = makeRepairTam({ flush: makeCompoundAwareFlush(workflow) });
      await buildRepairRuntime(tam, pendingRepo).executeTick();

      const reviewerExec = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .find((execution) => execution.workflowNodeId === 'review-node')!;
      expect(reviewerExec).toBeTruthy();
      expect(reviewerExec.agentName).toBe('reviewer');
      expect(reviewerExec.agentId).toBe(AGENT_GENERAL);
      expect(reviewerExec.status).toBe('in_progress');
      expect(reviewerExec.agentSessionId).toBe(`session:${reviewerExec.id}`);
      expect(pendingRepo.listAllForRun(run.id)[0].status).toBe('delivered');
    });

    test('resolves a compound "Coding/coder" handoff target', async () => {
      const workflow = makeCompoundHandoffWorkflow();
      const { run, tasks } = await runtime.startWorkflowRun(
        SPACE_ID,
        workflow.id,
        'Compound handoff'
      );
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'in_progress' });
      nodeExecutionRepo.update(nodeExecutionRepo.listByWorkflowRun(run.id)[0]!.id, {
        status: 'pending',
        agentSessionId: null,
        completedAt: null,
      });

      const pendingRepo = new PendingAgentMessageRepository(db);
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'reviewer',
        targetKind: 'node_agent',
        targetAgentName: 'Coding/coder',
        message: 'please revise',
        ttlMs: 60_000,
        maxAttempts: 3,
      });
      const tam = makeRepairTam({ flush: makeCompoundAwareFlush(workflow) });
      await buildRepairRuntime(tam, pendingRepo).executeTick();

      const coderExec = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .find((execution) => execution.workflowNodeId === 'coding-node')!;
      expect(coderExec.agentName).toBe('coder');
      expect(coderExec.status).toBe('in_progress');
      expect(coderExec.agentSessionId).toBe(`session:${coderExec.id}`);
      expect(pendingRepo.listAllForRun(run.id)[0].status).toBe('delivered');
    });

    test('resolves a pinned bare slot name that contains "/" (restart-recovery form)', async () => {
      // Pinned rows (workflowNodeId set) carry the BARE slot name — including
      // enqueueRestartRecoveryMessage and the router's new emission. A slot whose
      // name contains "/" (e.g. "Review/reviewer") must match exactly, not be
      // stripped to "reviewer" by the compound prefix-match.
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Slash slot ${Date.now()}-${Math.random()}`,
        description: 'Pinned bare slot name containing "/"',
        nodes: [
          { id: 'coding-node', name: 'Coding', agents: [{ name: 'coder', agentId: AGENT_CODER }] },
          {
            id: 'review-node',
            name: 'Review',
            agents: [{ name: 'Review/reviewer', agentId: AGENT_GENERAL }],
          },
        ],
        transitions: [],
        channels: [],
        startNodeId: 'coding-node',
        endNodeId: 'review-node',
        rules: [],
        completionAutonomyLevel: 3,
      });
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Slash slot');
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'in_progress' });
      nodeExecutionRepo.update(nodeExecutionRepo.listByWorkflowRun(run.id)[0]!.id, {
        status: 'idle',
        agentSessionId: null,
      });

      const pendingRepo = new PendingAgentMessageRepository(db);
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'coder',
        targetKind: 'node_agent',
        targetAgentName: 'Review/reviewer',
        workflowNodeId: 'review-node',
        message: 'please review',
        ttlMs: 60_000,
        maxAttempts: 3,
      });
      const tam = makeRepairTam({ flush: makeCompoundAwareFlush(workflow) });
      await buildRepairRuntime(tam, pendingRepo).executeTick();

      const reviewerExec = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .find((execution) => execution.workflowNodeId === 'review-node')!;
      expect(reviewerExec).toBeTruthy();
      expect(reviewerExec.agentName).toBe('Review/reviewer');
      expect(reviewerExec.status).toBe('in_progress');
      expect(pendingRepo.listAllForRun(run.id)[0].status).toBe('delivered');
    });

    test('resolves a compound target whose node name contains "/"', async () => {
      // Workflow validation does not forbid "/" in node names. A compound like
      // "Pair/Review/reviewer" must match the "Pair/Review" node's reviewer
      // slot — splitting on the first "/" would truncate the node name to "Pair"
      // and miss it, blocking the run.
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Slash-name handoff ${Date.now()}-${Math.random()}`,
        description: 'Compound target with a slash in the node name',
        nodes: [
          { id: 'coding-node', name: 'Coding', agents: [{ name: 'coder', agentId: AGENT_CODER }] },
          {
            id: 'slash-review-node',
            name: 'Pair/Review',
            agents: [{ name: 'reviewer', agentId: AGENT_GENERAL }],
          },
        ],
        transitions: [],
        channels: [],
        startNodeId: 'coding-node',
        endNodeId: 'slash-review-node',
        rules: [],
        completionAutonomyLevel: 3,
      });
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Slash handoff');
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'in_progress' });
      nodeExecutionRepo.update(nodeExecutionRepo.listByWorkflowRun(run.id)[0]!.id, {
        status: 'idle',
        agentSessionId: null,
      });

      const pendingRepo = new PendingAgentMessageRepository(db);
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'coder',
        targetKind: 'node_agent',
        targetAgentName: 'Pair/Review/reviewer',
        message: 'please review',
        ttlMs: 60_000,
        maxAttempts: 3,
      });
      const tam = makeRepairTam({ flush: makeCompoundAwareFlush(workflow) });
      await buildRepairRuntime(tam, pendingRepo).executeTick();

      const reviewerExec = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .find((execution) => execution.workflowNodeId === 'slash-review-node')!;
      expect(reviewerExec).toBeTruthy();
      expect(reviewerExec.agentName).toBe('reviewer');
      expect(reviewerExec.status).toBe('in_progress');
      expect(reviewerExec.agentSessionId).toBe(`session:${reviewerExec.id}`);
      expect(pendingRepo.listAllForRun(run.id)[0].status).toBe('delivered');
    });

    test('an unpinned bare slot name containing "/" resolves to its exact node, not a compound', async () => {
      // Node Review declares "foo"; node Audit declares a slot literally named
      // "Review/foo". A bare unpinned row "Review/foo" (e.g. a generic send to
      // Audit's slot) must resolve to Audit's exact slot — not be parsed as
      // Review's compound "Review/foo" -> foo.
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Slash bare slot ${Date.now()}-${Math.random()}`,
        description: 'Unpinned bare slot name containing "/"',
        nodes: [
          { id: 'coding-node', name: 'Coding', agents: [{ name: 'coder', agentId: AGENT_CODER }] },
          { id: 'review-node', name: 'Review', agents: [{ name: 'foo', agentId: AGENT_GENERAL }] },
          {
            id: 'audit-node',
            name: 'Audit',
            agents: [{ name: 'Review/foo', agentId: AGENT_PLANNER }],
          },
        ],
        transitions: [],
        channels: [],
        startNodeId: 'coding-node',
        endNodeId: 'audit-node',
        rules: [],
        completionAutonomyLevel: 3,
      });
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Slash bare');
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'in_progress' });
      nodeExecutionRepo.update(nodeExecutionRepo.listByWorkflowRun(run.id)[0]!.id, {
        status: 'idle',
        agentSessionId: null,
      });
      const pendingRepo = new PendingAgentMessageRepository(db);
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'coder',
        targetKind: 'node_agent',
        targetAgentName: 'Review/foo',
        message: 'for Audit',
        ttlMs: 60_000,
        maxAttempts: 3,
      });
      const tam = makeRepairTam({ flush: makeCompoundAwareFlush(workflow) });
      await buildRepairRuntime(tam, pendingRepo).executeTick();

      const auditExec = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .find((e) => e.workflowNodeId === 'audit-node');
      expect(auditExec?.agentName).toBe('Review/foo');
      expect(auditExec?.status).toBe('in_progress');
      // Review's "foo" slot must NOT have been spawned (no compound misresolution).
      expect(
        nodeExecutionRepo.listByWorkflowRun(run.id).find((e) => e.workflowNodeId === 'review-node')
      ).toBeUndefined();
      expect(pendingRepo.listAllForRun(run.id)[0].status).toBe('delivered');
    });

    test('a bare node-name target is not captured by another node same-named slot (no slash)', async () => {
      // Node Review's first slot is 'reviewer'; node Other has a slot literally
      // named 'Review'. A bare unpinned 'Review' targets the NODE, and must still
      // resolve to Review (via the bare-node path) — the exact-slot-first pass is
      // limited to slash-shaped values, so it must not hand 'Review' to Other.
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Bare node vs slot ${Date.now()}-${Math.random()}`,
        description: 'Bare node name not captured by a same-named slot',
        nodes: [
          { id: 'coding-node', name: 'Coding', agents: [{ name: 'coder', agentId: AGENT_CODER }] },
          {
            id: 'review-node',
            name: 'Review',
            agents: [{ name: 'reviewer', agentId: AGENT_GENERAL }],
          },
          { id: 'other-node', name: 'Other', agents: [{ name: 'Review', agentId: AGENT_PLANNER }] },
        ],
        transitions: [],
        channels: [],
        startNodeId: 'coding-node',
        endNodeId: 'review-node',
        rules: [],
        completionAutonomyLevel: 3,
      });
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Bare node');
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'in_progress' });
      nodeExecutionRepo.update(nodeExecutionRepo.listByWorkflowRun(run.id)[0]!.id, {
        status: 'idle',
        agentSessionId: null,
      });
      const pendingRepo = new PendingAgentMessageRepository(db);
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'coder',
        targetKind: 'node_agent',
        targetAgentName: 'Review',
        message: 'for Review node',
        ttlMs: 60_000,
        maxAttempts: 3,
      });
      const tam = makeRepairTam({ flush: makeCompoundAwareFlush(workflow) });
      await buildRepairRuntime(tam, pendingRepo).executeTick();

      // Resolves to the Review node's first slot, NOT Other's 'Review' slot.
      const reviewExec = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .find((e) => e.workflowNodeId === 'review-node');
      expect(reviewExec?.agentName).toBe('reviewer');
      expect(reviewExec?.status).toBe('in_progress');
      expect(
        nodeExecutionRepo.listByWorkflowRun(run.id).find((e) => e.workflowNodeId === 'other-node')
      ).toBeUndefined();
    });

    test('disambiguates two nodes sharing a slot name, via the pinned workflowNodeId', async () => {
      // Two nodes both declare a 'reviewer' slot. The router and restart-recovery
      // emit BARE 'reviewer' + each node's workflowNodeId, so the resolver pins
      // the exact node instead of guessing from the slot name — each row reaches
      // its own node and neither leaks to the other.
      const workflow = workflowManager.createWorkflow({
        spaceId: SPACE_ID,
        name: `Same-slot ${Date.now()}-${Math.random()}`,
        description: 'Two nodes sharing a slot name, disambiguated by workflowNodeId',
        nodes: [
          { id: 'rev-a', name: 'Review A', agents: [{ name: 'reviewer', agentId: AGENT_CODER }] },
          { id: 'rev-b', name: 'Review B', agents: [{ name: 'reviewer', agentId: AGENT_GENERAL }] },
        ],
        transitions: [],
        channels: [],
        startNodeId: 'rev-a',
        endNodeId: 'rev-b',
        rules: [],
        completionAutonomyLevel: 3,
      });
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Same-slot');
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'in_progress' });
      nodeExecutionRepo.update(nodeExecutionRepo.listByWorkflowRun(run.id)[0]!.id, {
        status: 'idle',
        agentSessionId: null,
      });

      const pendingRepo = new PendingAgentMessageRepository(db);
      // Two rows with the SAME bare slot name, each pinned to a different node.
      for (const nodeId of ['rev-a', 'rev-b']) {
        pendingRepo.enqueue({
          workflowRunId: run.id,
          spaceId: SPACE_ID,
          taskId: task.id,
          sourceAgentName: 'coder',
          targetKind: 'node_agent',
          targetAgentName: 'reviewer',
          workflowNodeId: nodeId,
          message: `for ${nodeId}`,
          ttlMs: 60_000,
          maxAttempts: 3,
        });
      }
      const tam = makeRepairTam({ flush: makeCompoundAwareFlush(workflow) });
      await buildRepairRuntime(tam, pendingRepo).executeTick();

      // Each node spawned its own reviewer; neither row leaked to the other node.
      const execs = nodeExecutionRepo.listByWorkflowRun(run.id);
      const revA = execs.find((e) => e.workflowNodeId === 'rev-a');
      const revB = execs.find((e) => e.workflowNodeId === 'rev-b');
      expect(revA?.agentName).toBe('reviewer');
      expect(revA?.status).toBe('in_progress');
      expect(revB?.agentName).toBe('reviewer');
      expect(revB?.status).toBe('in_progress');
      const rows = pendingRepo.listAllForRun(run.id);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.status === 'delivered')).toBe(true);
    });

    test('resolves a bare slot name pinned by workflowNodeId (router emission form)', async () => {
      // The router now persists the BARE agent name + resolved workflowNodeId on
      // @worker rows (no compound). Verify the sweep resolves that form end-to-end.
      const workflow = makeCompoundHandoffWorkflow();
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Bare pinned');
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'in_progress' });
      nodeExecutionRepo.update(nodeExecutionRepo.listByWorkflowRun(run.id)[0]!.id, {
        status: 'idle',
        agentSessionId: null,
      });

      const pendingRepo = new PendingAgentMessageRepository(db);
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'coder',
        targetKind: 'node_agent',
        targetAgentName: 'reviewer',
        workflowNodeId: 'review-node',
        message: 'please review',
        ttlMs: 60_000,
        maxAttempts: 3,
      });
      const tam = makeRepairTam({ flush: makeCompoundAwareFlush(workflow) });
      await buildRepairRuntime(tam, pendingRepo).executeTick();

      const reviewerExec = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .find((e) => e.workflowNodeId === 'review-node')!;
      expect(reviewerExec.agentName).toBe('reviewer');
      expect(reviewerExec.status).toBe('in_progress');
      expect(reviewerExec.agentSessionId).toBe(`session:${reviewerExec.id}`);
      expect(pendingRepo.listAllForRun(run.id)[0].status).toBe('delivered');
    });

    test('legacy "<nodeId>/<agent>" rows (prior router) are normalized and delivered', async () => {
      // A row queued by the previous router from an actor-registry handle stored
      // the id-compound "<nodeId>/<agent>" with NO workflowNodeId. The sweep
      // resolves it and rewrites it to bare+workflowNodeId so the flush drains it
      // — otherwise it would expire undelivered now that the compound drain alias
      // is gone.
      const workflow = makeCompoundHandoffWorkflow();
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Legacy id');
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'in_progress' });
      nodeExecutionRepo.update(nodeExecutionRepo.listByWorkflowRun(run.id)[0]!.id, {
        status: 'idle',
        agentSessionId: null,
      });
      const pendingRepo = new PendingAgentMessageRepository(db);
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'coder',
        targetKind: 'node_agent',
        targetAgentName: 'review-node/reviewer',
        message: 'please review',
        ttlMs: 60_000,
        maxAttempts: 3,
      });
      const tam = makeRepairTam({ flush: makeCompoundAwareFlush(workflow) });
      await buildRepairRuntime(tam, pendingRepo).executeTick();

      const reviewerExec = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .find((e) => e.workflowNodeId === 'review-node');
      expect(reviewerExec?.agentName).toBe('reviewer');
      expect(reviewerExec?.status).toBe('in_progress');
      // The row was rescoped to bare+workflowNodeId and delivered.
      const row = pendingRepo.listAllForRun(run.id)[0];
      expect(row.targetAgentName).toBe('reviewer');
      expect(row.workflowNodeId).toBe('review-node');
      expect(row.status).toBe('delivered');
    });

    test('legacy "<nodeId>/<agent>" rows are rescoped even when an execution already exists', async () => {
      // The rescope must run BEFORE the execution lookup — if a matching
      // NodeExecution already exists, the no-execution branch (where rescope used
      // to live) is skipped and the row keeps its old "<nodeId>/<agent>" key, so
      // the flush never drains it.
      const workflow = makeCompoundHandoffWorkflow();
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Legacy exec');
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'in_progress' });
      // Pre-create the target execution with a live session (e.g. spawned earlier).
      nodeExecutionRepo.createOrIgnore({
        workflowRunId: run.id,
        workflowNodeId: 'review-node',
        agentName: 'reviewer',
        agentSessionId: 'session:reviewer',
        status: 'in_progress',
      });
      nodeExecutionRepo.update(
        nodeExecutionRepo.listByWorkflowRun(run.id).find((e) => e.workflowNodeId === 'coding-node')!
          .id,
        { status: 'idle', agentSessionId: null }
      );
      const pendingRepo = new PendingAgentMessageRepository(db);
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'coder',
        targetKind: 'node_agent',
        targetAgentName: 'review-node/reviewer',
        message: 'please review',
        ttlMs: 60_000,
        maxAttempts: 3,
      });
      const tam = makeRepairTam({
        liveSessions: new Set(['session:reviewer']),
        flush: makeCompoundAwareFlush(workflow),
      });
      await buildRepairRuntime(tam, pendingRepo).executeTick();

      const updated = pendingRepo.listAllForRun(run.id)[0];
      expect(updated.targetAgentName).toBe('reviewer');
      expect(updated.workflowNodeId).toBe('review-node');
      expect(updated.status).toBe('delivered');
    });

    test('rescoping a legacy compound row drops it when a bare retry row already exists (idempotency)', async () => {
      // If the new router already inserted a bare retry row for the same
      // idempotency key, rescoping the legacy compound row into the same
      // (run, target, idempotency_key) would violate the unique index. The
      // rescope drops the superseded legacy row instead.
      const workflow = makeCompoundHandoffWorkflow();
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Idempotency');
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'in_progress' });
      nodeExecutionRepo.update(nodeExecutionRepo.listByWorkflowRun(run.id)[0]!.id, {
        status: 'idle',
        agentSessionId: null,
      });
      const pendingRepo = new PendingAgentMessageRepository(db);
      // Legacy compound row from the previous router.
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'coder',
        targetKind: 'node_agent',
        targetAgentName: 'review-node/reviewer',
        message: 'please review',
        idempotencyKey: 'K1',
        ttlMs: 60_000,
        maxAttempts: 3,
      });
      // Bare retry row the new router inserted for the same message.
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'coder',
        targetKind: 'node_agent',
        targetAgentName: 'reviewer',
        workflowNodeId: 'review-node',
        message: 'please review',
        idempotencyKey: 'K1',
        ttlMs: 60_000,
        maxAttempts: 3,
      });
      const tam = makeRepairTam({ flush: makeCompoundAwareFlush(workflow) });
      await buildRepairRuntime(tam, pendingRepo).executeTick();

      const rows = pendingRepo.listAllForRun(run.id);
      // The legacy compound row was dropped; the bare retry row was delivered.
      expect(rows.filter((r) => r.targetAgentName === 'review-node/reviewer')).toHaveLength(0);
      const bare = rows.filter((r) => r.targetAgentName === 'reviewer');
      expect(bare).toHaveLength(1);
      expect(bare[0].status).toBe('delivered');
    });

    test('rescoping a legacy compound row proceeds when the same-key retry row already failed', async () => {
      // The unique index covers only pending rows, so a failed/expired retry
      // with the same idempotency key is NOT a conflict — the legacy row is
      // rescoped and delivered, not dropped (it's the only retryable handoff).
      const workflow = makeCompoundHandoffWorkflow();
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Failed retry');
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'in_progress' });
      nodeExecutionRepo.update(nodeExecutionRepo.listByWorkflowRun(run.id)[0]!.id, {
        status: 'idle',
        agentSessionId: null,
      });
      const pendingRepo = new PendingAgentMessageRepository(db);
      // Bare retry row that already FAILED (terminal), same idempotency key.
      const retry = pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'coder',
        targetKind: 'node_agent',
        targetAgentName: 'reviewer',
        workflowNodeId: 'review-node',
        message: 'please review',
        idempotencyKey: 'K1',
        ttlMs: 60_000,
        maxAttempts: 1,
      });
      pendingRepo.markAttemptFailed(retry.record.id, 'prior failure');
      // Legacy compound row, same key.
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'coder',
        targetKind: 'node_agent',
        targetAgentName: 'review-node/reviewer',
        message: 'please review',
        idempotencyKey: 'K1',
        ttlMs: 60_000,
        maxAttempts: 3,
      });
      const tam = makeRepairTam({ flush: makeCompoundAwareFlush(workflow) });
      await buildRepairRuntime(tam, pendingRepo).executeTick();

      const rows = pendingRepo.listAllForRun(run.id);
      // The legacy compound row was rescoped (not dropped) and delivered.
      expect(rows.filter((r) => r.targetAgentName === 'review-node/reviewer')).toHaveLength(0);
      const delivered = rows.filter(
        (r) => r.targetAgentName === 'reviewer' && r.status === 'delivered'
      );
      expect(delivered).toHaveLength(1);
    });

    test('non-compound "reviewer" slot name still resolves (backward compat)', async () => {
      const workflow = makeCompoundHandoffWorkflow();
      const { run, tasks } = await runtime.startWorkflowRun(
        SPACE_ID,
        workflow.id,
        'Compound handoff'
      );
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'in_progress' });
      nodeExecutionRepo.update(nodeExecutionRepo.listByWorkflowRun(run.id)[0]!.id, {
        status: 'idle',
        agentSessionId: null,
      });

      const pendingRepo = new PendingAgentMessageRepository(db);
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'coder',
        targetKind: 'node_agent',
        targetAgentName: 'reviewer',
        message: 'please review',
        ttlMs: 60_000,
        maxAttempts: 3,
      });
      // Default mock flush drains by the bare slot name, which matches here.
      const tam = makeRepairTam();
      await buildRepairRuntime(tam, pendingRepo).executeTick();

      const reviewerExec = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .find((execution) => execution.workflowNodeId === 'review-node')!;
      expect(reviewerExec).toBeTruthy();
      expect(reviewerExec.agentName).toBe('reviewer');
      expect(reviewerExec.status).toBe('in_progress');
      expect(pendingRepo.listAllForRun(run.id)[0].status).toBe('delivered');
    });

    test('non-compound "Review" node name still resolves (backward compat)', async () => {
      const workflow = makeCompoundHandoffWorkflow();
      const { run, tasks } = await runtime.startWorkflowRun(
        SPACE_ID,
        workflow.id,
        'Compound handoff'
      );
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'in_progress' });
      nodeExecutionRepo.update(nodeExecutionRepo.listByWorkflowRun(run.id)[0]!.id, {
        status: 'idle',
        agentSessionId: null,
      });

      const pendingRepo = new PendingAgentMessageRepository(db);
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'coder',
        targetKind: 'node_agent',
        targetAgentName: 'Review',
        message: 'please review',
        ttlMs: 60_000,
        maxAttempts: 3,
      });
      const tam = makeRepairTam();
      await buildRepairRuntime(tam, pendingRepo).executeTick();

      // Bare node name resolves to the Review node's first (reviewer) slot and
      // spawns it. (A bare node name is a legacy/defensive target — current
      // routing emits slot names or compound forms — so we assert resolution,
      // not delivery, which depends on a matching flush key.)
      const reviewerExec = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .find((execution) => execution.workflowNodeId === 'review-node')!;
      expect(reviewerExec).toBeTruthy();
      expect(reviewerExec.agentName).toBe('reviewer');
      expect(reviewerExec.status).toBe('in_progress');
    });

    test('a compound target with an unknown slot does not silently fall back to another slot', async () => {
      // Compound "nodeName/agentName" is a precise address: a slot name that
      // doesn't exist on the matched node must NOT fall back to slots[0]. The
      // resolver returns null and the sweep surfaces it as an undeclared target.
      // Pins the failure behavior this fix restores and guards against typos
      // like "Review/reveiwer" misdelivering to the reviewer slot.
      const workflow = makeCompoundHandoffWorkflow();
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Bad slot');
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'in_progress' });
      nodeExecutionRepo.update(nodeExecutionRepo.listByWorkflowRun(run.id)[0]!.id, {
        status: 'idle',
        agentSessionId: null,
      });

      const pendingRepo = new PendingAgentMessageRepository(db);
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'coder',
        targetKind: 'node_agent',
        targetAgentName: 'Review/typo-slot',
        message: 'please review',
        ttlMs: 60_000,
        maxAttempts: 1,
      });
      const tam = makeRepairTam();
      await buildRepairRuntime(tam, pendingRepo).executeTick();

      // No execution created or spawned for the Review node, and the row failed
      // with the undeclared-target error instead of misdelivering to the slot.
      expect(tam._spawnedExecutionIds).toHaveLength(0);
      const row = pendingRepo.listAllForRun(run.id)[0];
      expect(row.status).toBe('failed');
      expect(row.lastError).toContain('is not declared in workflow');
      expect(workflowRunRepo.getRun(run.id)!.status).toBe('blocked');
    });

    test('a compound target with an unknown node does not resolve', async () => {
      const workflow = makeCompoundHandoffWorkflow();
      const { run, tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'Bad node');
      const task = tasks[0];
      taskRepo.updateTask(task.id, { status: 'in_progress' });
      nodeExecutionRepo.update(nodeExecutionRepo.listByWorkflowRun(run.id)[0]!.id, {
        status: 'idle',
        agentSessionId: null,
      });

      const pendingRepo = new PendingAgentMessageRepository(db);
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'coder',
        targetKind: 'node_agent',
        targetAgentName: 'UnknownNode/reviewer',
        message: 'please review',
        ttlMs: 60_000,
        maxAttempts: 1,
      });
      const tam = makeRepairTam();
      await buildRepairRuntime(tam, pendingRepo).executeTick();

      expect(tam._spawnedExecutionIds).toHaveLength(0);
      const row = pendingRepo.listAllForRun(run.id)[0];
      expect(row.status).toBe('failed');
      expect(row.lastError).toContain('is not declared in workflow');
      expect(workflowRunRepo.getRun(run.id)!.status).toBe('blocked');
    });

    test('createWorkflow rejects a node id that collides with another node name (channel isolation)', () => {
      // Channel authorization is by node NAME, but worker-handle resolution can
      // resolve a name-authorized ref to a node by ID. A node id equal to another
      // node's name makes that ref ambiguous and can route a message into a node
      // the topology never authorized — reject it at definition time.
      expect(() =>
        workflowManager.createWorkflow({
          spaceId: SPACE_ID,
          name: 'Collision',
          nodes: [
            {
              id: 'node-review',
              name: 'Review',
              agents: [{ name: 'reviewer', agentId: AGENT_GENERAL }],
            },
            { id: 'Review', name: 'Audit', agents: [{ name: 'leaker', agentId: AGENT_PLANNER }] },
          ],
          transitions: [],
          channels: [{ id: 'c-r', from: 'Coding', to: 'Review' }],
          startNodeId: 'node-review',
          endNodeId: 'node-review',
          rules: [],
          completionAutonomyLevel: 3,
        })
      ).toThrow(/must not equal node/);
    });

    test('createWorkflow rejects duplicate node ids', () => {
      expect(() =>
        workflowManager.createWorkflow({
          spaceId: SPACE_ID,
          name: 'Dup ids',
          nodes: [
            { id: 'dup', name: 'A', agents: [{ name: 'a', agentId: AGENT_CODER }] },
            { id: 'dup', name: 'B', agents: [{ name: 'b', agentId: AGENT_GENERAL }] },
          ],
          transitions: [],
          channels: [],
          startNodeId: 'dup',
          endNodeId: 'dup',
          rules: [],
          completionAutonomyLevel: 3,
        })
      ).toThrow(/duplicate node id/);
    });

    test('createWorkflow rejects empty and surrounding-whitespace node ids', () => {
      // Rejecting (rather than silently trimming) keeps a supplied id verbatim so
      // params.layout keys still match — trimming would discard saved positions.
      const base = {
        spaceId: SPACE_ID,
        transitions: [],
        channels: [],
        rules: [],
        completionAutonomyLevel: 3,
      } as const;
      expect(() =>
        workflowManager.createWorkflow({
          ...base,
          name: 'Empty id',
          nodes: [{ id: '', name: 'A', agents: [{ name: 'a', agentId: AGENT_CODER }] }],
          startNodeId: '',
          endNodeId: '',
        })
      ).toThrow(/non-empty string/);
      expect(() =>
        workflowManager.createWorkflow({
          ...base,
          name: 'Whitespace id',
          nodes: [{ id: ' review ', name: 'A', agents: [{ name: 'a', agentId: AGENT_CODER }] }],
          startNodeId: ' review ',
          endNodeId: ' review ',
        })
      ).toThrow(/surrounding whitespace/);
    });

    test('skips repair while target execution is waiting for rebind recovery', async () => {
      const { run, pendingRepo } = await setupQueuedHandoff();
      const targetExec = nodeExecutionRepo
        .listByWorkflowRun(run.id)
        .find((execution) => execution.agentName === 'Coder')!;
      const waitingSessionId = 'session:waiting-rebind';
      nodeExecutionRepo.update(targetExec.id, {
        status: 'waiting_rebind',
        agentSessionId: waitingSessionId,
        lastHeartbeatAt: Date.now(),
      });
      let attemptedResume = false;
      const tam = {
        ...makeRepairTam({ liveSessions: new Set([waitingSessionId]) }),
        tryResumeNodeAgentSession: async () => {
          attemptedResume = true;
          throw new Error('waiting_rebind should skip resume');
        },
      };
      await buildRepairRuntime(tam, pendingRepo).executeTick();
      expect(attemptedResume).toBe(false);
      expect(tam._spawnedExecutionIds).toHaveLength(0);
      expect(pendingRepo.listPendingForTarget(run.id, 'Coder')).toHaveLength(1);
      expect(nodeExecutionRepo.getById(targetExec.id)!.status).toBe('waiting_rebind');
    });

    test('does not repair queued handoffs while the space is paused', async () => {
      const { run, pendingRepo } = await setupQueuedHandoff();
      await spaceManager.pauseSpace(SPACE_ID);
      const tam = makeRepairTam();
      await buildRepairRuntime(tam, pendingRepo).executeTick();
      expect(tam._spawnedExecutionIds).toHaveLength(0);
      expect(pendingRepo.listPendingForTarget(run.id, 'Coder')).toHaveLength(1);
    });

    test('missing space retries and eventually blocks the queued handoff run', async () => {
      const { run, task, pendingRepo } = await setupQueuedHandoff({ maxAttempts: 1 });
      await buildRepairRuntime(makeRepairTam(), pendingRepo)['repairQueuedWorkflowNodeHandoffs'](
        run.id,
        run,
        {
          workflow: workflowManager.getWorkflow(run.workflowId)!,
          spaceId: 'missing-space',
          workspacePath: WORKSPACE,
        },
        task,
        null
      );
      const row = pendingRepo.listAllForRun(run.id)[0];
      expect(row.status).toBe('failed');
      expect(row.lastError).toContain('space missing-space not found');
      expect(workflowRunRepo.getRun(run.id)!.status).toBe('blocked');
      expect(taskRepo.getTask(task.id)!.status).toBe('blocked');
    });

    test('preserves terminal execution state when spawn fails after concurrent cancellation', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coder', agentId: AGENT_CODER },
      ]);
      const { run, tasks } = await runtime.startWorkflowRun(
        SPACE_ID,
        workflow.id,
        'Concurrent spawn cancellation'
      );
      taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0]!;
      const tam = makeRepairTam({
        spawn: async (executionId) => {
          nodeExecutionRepo.update(executionId, {
            status: 'cancelled',
            result: 'cancelled concurrently',
            completedAt: Date.now(),
          });
          throw new Error('spawn failed after cancellation');
        },
      });
      await buildRepairRuntime(tam, new PendingAgentMessageRepository(db)).executeTick();
      const updated = nodeExecutionRepo.getById(execution.id)!;
      expect(updated.status).toBe('cancelled');
      expect(updated.result).toBe('cancelled concurrently');
      expect(updated.agentSessionId).toBeNull();
    });

    test('spawn retry exhaustion blocks the run in the same tick', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coder', agentId: AGENT_CODER },
      ]);
      const { run, tasks } = await runtime.startWorkflowRun(
        SPACE_ID,
        workflow.id,
        'Spawn retry exhaustion'
      );
      taskRepo.updateTask(tasks[0].id, { status: 'in_progress' });
      const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0]!;
      const tam = makeRepairTam({
        spawn: async () => {
          throw new Error('spawn keeps failing');
        },
      });
      const rt = buildRepairRuntime(tam, new PendingAgentMessageRepository(db));

      await rt.executeTick();
      expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
      await rt.executeTick();
      expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
      await rt.executeTick();

      const updated = nodeExecutionRepo.getById(execution.id)!;
      expect(updated.status).toBe('blocked');
      expect(updated.result).toContain('spawn keeps failing');
      expect(workflowRunRepo.getRun(run.id)!.status).toBe('blocked');
      expect(taskRepo.getTask(tasks[0].id)!.status).toBe('blocked');
      expect(taskRepo.getTask(tasks[0].id)!.blockReason).toBe('agent_crashed');
      expect(taskRepo.getTask(tasks[0].id)!.result).toContain('spawn keeps failing');
    });

    test('activation failures are retried and eventually block the run', async () => {
      const { run, task, pendingRepo } = await setupQueuedHandoff({ maxAttempts: 2 });
      const tam = makeRepairTam({
        spawn: async () => {
          throw new Error('spawn failed');
        },
      });
      const rt = buildRepairRuntime(tam, pendingRepo);
      await rt.executeTick();
      expect(pendingRepo.listPendingForTarget(run.id, 'Coder')[0].attempts).toBe(1);
      expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
      await rt.executeTick();
      expect(pendingRepo.listAllForRun(run.id)[0].status).toBe('failed');
      expect(workflowRunRepo.getRun(run.id)!.status).toBe('blocked');
      expect(taskRepo.getTask(task.id)!.status).toBe('blocked');
      expect(taskRepo.getTask(task.id)!.result).toContain('spawn failed');
    });

    test('flush failures that exhaust retries block the run', async () => {
      const { run, task, pendingRepo } = await setupQueuedHandoff({ maxAttempts: 1 });
      const tam = makeRepairTam({
        flush: async (runId, agentName) => {
          const repo = new PendingAgentMessageRepository(db);
          for (const row of repo.listPendingForTarget(runId, agentName)) {
            repo.markAttemptFailed(row.id, 'inject failed');
          }
        },
      });
      await buildRepairRuntime(tam, pendingRepo).executeTick();
      expect(pendingRepo.listAllForRun(run.id)[0].status).toBe('failed');
      expect(workflowRunRepo.getRun(run.id)!.status).toBe('blocked');
      expect(taskRepo.getTask(task.id)!.status).toBe('blocked');
      expect(taskRepo.getTask(task.id)!.result).toContain('inject failed');
    });

    test('historical failed handoffs do not re-block successful later repairs', async () => {
      const { run, pendingRepo } = await setupQueuedHandoff();
      const historical = pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        targetKind: 'node_agent',
        targetAgentName: 'Coder',
        message: 'old failed handoff',
        maxAttempts: 1,
      });
      pendingRepo.markAttemptFailed(historical.record.id, 'old inject failed');

      await buildRepairRuntime(makeRepairTam(), pendingRepo).executeTick();
      const rows = pendingRepo.listAllForRun(run.id);
      expect(rows.find((row) => row.id === historical.record.id)!.status).toBe('failed');
      expect(rows.find((row) => row.id !== historical.record.id)!.status).toBe('delivered');
      expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
    });

    test('expired queued handoffs are swept before stalled-run recovery', async () => {
      const { run, task, pendingRepo } = await setupQueuedHandoff({ ttlMs: -1 });
      await buildRepairRuntime(makeRepairTam(), pendingRepo).executeTick();
      expect(pendingRepo.listAllForRun(run.id)[0].status).toBe('expired');
      expect(workflowRunRepo.getRun(run.id)!.status).toBe('blocked');
      expect(taskRepo.getTask(task.id)!.result).toContain('stalled across daemon restart');
    });

    test('terminal task with queued handoff marks the handoff failed', async () => {
      const { run, pendingRepo } = await setupQueuedHandoff({ taskStatus: 'done' });
      const tam = makeRepairTam();
      await buildRepairRuntime(tam, pendingRepo).executeTick();
      const row = pendingRepo.listAllForRun(run.id)[0];
      expect(row.status).toBe('failed');
      expect(row.lastError).toContain('terminal (done)');
      expect(tam._spawnedExecutionIds).toHaveLength(0);
    });

    test('expired handoff for a terminal task does not overwrite completion', async () => {
      const { run, task, pendingRepo } = await setupQueuedHandoff({
        taskStatus: 'done',
        ttlMs: -1,
      });
      await buildRepairRuntime(makeRepairTam(), pendingRepo).executeTick();
      expect(pendingRepo.listAllForRun(run.id)[0].status).toBe('expired');
      expect(taskRepo.getTask(task.id)!.status).toBe('done');
      expect(taskRepo.getTask(task.id)!.completedAt).not.toBeNull();
      expect(workflowRunRepo.getRun(run.id)!.status).not.toBe('blocked');
    });

    test('repairs generic Review→Coding and QA→Coding handoffs', async () => {
      const { run, pendingRepo } = await setupQueuedHandoff({ message: 'review feedback' });
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        sourceAgentName: 'qa',
        targetKind: 'node_agent',
        targetAgentName: 'Coder',
        message: 'qa feedback',
        idempotencyKey: 'qa-coding',
      });
      await buildRepairRuntime(makeRepairTam(), pendingRepo).executeTick();
      const rows = pendingRepo.listAllForRun(run.id);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.status === 'delivered')).toBe(true);
      expect(rows.map((row) => row.sourceAgentName).sort()).toEqual(['qa', 'reviewer']);
    });
  });

  describe('Task Agent integration', () => {
    /**
     * Minimal mock for TaskAgentManager.
     *
     * The runtime now uses execution-centric APIs
     * (isExecutionSpawning / isSessionAlive / spawnWorkflowNodeAgentForExecution).
     * This helper keeps tests concise by accepting task-centric overrides and mapping
     * execution IDs back to the canonical run task when needed.
     */
    function makeMockTaskAgentManager(
      overrides: {
        isSpawning?: (taskId: string) => boolean;
        isTaskAgentAlive?: (taskId: string) => boolean;
        spawnWorkflowNodeAgent?: (task: unknown) => Promise<string>;
        cancelBySessionId?: (sessionId: string) => void;
        interruptBySessionId?: (sessionId: string) => Promise<boolean>;
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
          // Mirror real TaskAgentManager: writes taskAgentSessionId as a side-effect
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
        spaceAgentManager: agentManager,
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

      // Task Agent should have been spawned
      expect(tam._spawned).toContain(tasks[0].id);
      // Task should be in_progress
      const updated = taskRepo.getTask(tasks[0].id)!;
      expect(updated.status).toBe('in_progress');
      expect(updated.taskAgentSessionId).toBe(`session:${tasks[0].id}`);
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
        isTaskAgentAlive: () => true, // always alive
        spawnWorkflowNodeAgent: async (task: unknown) => {
          const t = task as { id: string };
          spawnCount++;
          taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
          return `session:${t.id}`;
        },
      });
      const rt = buildRuntimeWithMockTAM(tam);

      const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      // First tick: spawns Task Agent (no taskAgentSessionId yet)
      await rt.executeTick();
      expect(spawnCount).toBe(1);

      // Mark task as in_progress (set by SpaceRuntime after spawn)
      // taskAgentSessionId is already set by mock spawnWorkflowNodeAgent
      const taskAfterSpawn = taskRepo.getTask(tasks[0].id)!;
      expect(taskAfterSpawn.taskAgentSessionId).toBeTruthy();

      // Subsequent ticks: agent is alive → skip, no re-spawn
      await rt.executeTick();
      await rt.executeTick();
      expect(spawnCount).toBe(1); // still only spawned once
    });

    test('crashed Task Agent resets to pending on first crash (retry) then needs_attention after max retries', async () => {
      // M9.4 crash-retry: transient crashes reset to pending (up to MAX_TASK_AGENT_CRASH_RETRIES=2).
      // Only after the limit is exhausted does the task escalate to needs_attention.
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      let spawnCount = 0;
      const tam = makeMockTaskAgentManager({
        isTaskAgentAlive: () => false, // agent always reports as dead (crashed)
        spawnWorkflowNodeAgent: async (task: unknown) => {
          const t = task as { id: string };
          spawnCount++;
          taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}:v${spawnCount}` });
          return `session:${t.id}:v${spawnCount}`;
        },
      });
      const rt = buildRuntimeWithMockTAM(tam);

      const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      // Mark the single start-node execution as having a dead session to trigger crash handling.
      const firstExecution = nodeExecutionRepo.listByNode(tasks[0].workflowRunId!, STEP_A)[0]!;
      nodeExecutionRepo.update(firstExecution.id, {
        agentSessionId: 'session:dead',
        status: 'in_progress',
      });

      // Tick 1: crash 1 (count=1 ≤ MAX=2) → reset to pending; runtime re-spawns in same tick
      await rt.executeTick();
      let updated = taskRepo.getTask(tasks[0].id)!;
      expect(updated.status).toBe('in_progress'); // re-spawned after first crash
      expect(spawnCount).toBe(1);

      // Tick 2: crash 2 (count=2 ≤ MAX=2) → reset to pending; runtime re-spawns in same tick
      await rt.executeTick();
      updated = taskRepo.getTask(tasks[0].id)!;
      expect(updated.status).toBe('in_progress'); // re-spawned after second crash
      expect(spawnCount).toBe(2);

      // Tick 3: crash 3 (count=3 > MAX=2) → blocked (M71: needs_attention renamed to blocked)
      await rt.executeTick();
      updated = taskRepo.getTask(tasks[0].id)!;
      expect(updated.status).toBe('blocked');
      // crash info is stored in result field (not error)
      expect(updated.result).toContain('3 times');
      // Only 2 re-spawns happened (crashes 1 and 2 got retries; crash 3 escalated)
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

      // Simulate concurrent tick while first is "spawning"
      spawningSet.add(tasks[0].id); // pretend spawn is in progress

      await rt.executeTick();

      // No additional spawn should happen while isSpawning() returns true
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
          // Alive after spawn (taskAgentSessionId is set)
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

      // Multiple ticks — should only spawn once (agent is alive after first spawn)
      await rt.executeTick();
      await rt.executeTick();
      await rt.executeTick();

      expect(spawnCount).toBe(1);
      // Task should still be in_progress
      expect(taskRepo.getTask(tasks[0].id)!.status).toBe('in_progress');
    });

    test('logs warning and skips spawn when space is null (space deleted mid-run)', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      // Start the run with the real space manager so startWorkflowRun() works.
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

      // Build a fresh runtime that uses a null space manager for getSpace().
      // startWorkflowRun already created the run and executor in the DB; the fresh
      // runtime rehydrates it on first executeTick() and then hits the null space path.
      const nullSpaceManager = {
        getSpace: async () => null,
        listSpaces: async () => [{ id: SPACE_ID, workspacePath: WORKSPACE }],
      };
      const rtWithNullSpace = buildRuntimeWithMockTAM(tamForNull, nullSpaceManager);

      // executeTick() rehydrates the run but getSpace() returns null → spawn skipped
      await rtWithNullSpace.executeTick();

      // No Task Agent spawned — space is null
      expect(spawnCount).toBe(0);
      // Task stays open (M71: 'pending' renamed to 'open')
      expect(taskRepo.getTask(tasks[0].id)!.status).toBe('open');
    });

    test('liveness loop resets crashed task to pending (1st crash) and leaves alive sibling untouched', async () => {
      // M9.4 crash-retry: Two tasks in same step — task A alive, task B crashed (1st crash).
      // Task B resets to pending for retry; task A (alive) remains untouched.
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT_PLANNER },
      ]);

      const tam = makeMockTaskAgentManager({
        isTaskAgentAlive: (taskId: string) => taskId === 'task-alive',
      });
      const rt = buildRuntimeWithMockTAM(tam);

      const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      // Insert a second task for the same step directly via repo (multi-task scenario)
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

      // Create alive task separately by injecting its id into the mock
      const firstTask = taskRepo.listByWorkflowRun(run.id).find((t) => t.id !== taskBId)!;
      taskRepo.updateTask(firstTask.id, { status: 'in_progress' });

      // Override the mock to know which task is alive
      const aliveId = firstTask.id;
      const customTam = makeMockTaskAgentManager({
        isTaskAgentAlive: (taskId: string) => taskId === aliveId,
      });
      const rt2 = buildRuntimeWithMockTAM(customTam);

      await rt2.executeTick();

      // In strict one-task-per-run mode, extra run tasks are archived during tick repair.
      const updatedB = taskRepo.getTask(taskBId)!;
      expect(updatedB.status).toBe('archived');
      expect(updatedB.workflowRunId).toBeUndefined();

      // Alive task A should be untouched
      const updatedA = taskRepo.getTask(aliveId)!;
      expect(updatedA.status).toBe('in_progress');
    });

    test('liveness loop marks crashed task needs_attention after max retries exhausted', async () => {
      // After MAX_TASK_AGENT_CRASH_RETRIES=2 retries, the 3rd crash escalates to needs_attention.
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
          // Keep alive until next tick check
          return sessionId;
        },
      });
      const rt = buildRuntimeWithMockTAM(tam);
      const { tasks } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');

      // Pre-load with a dead execution session to trigger crash detection from tick 1
      const firstExecution = nodeExecutionRepo.listByNode(tasks[0].workflowRunId!, STEP_A)[0]!;
      nodeExecutionRepo.update(firstExecution.id, {
        agentSessionId: 'session:dead-initial',
        status: 'in_progress',
      });

      // 3 ticks: crash 1 → open+respawn, crash 2 → open+respawn, crash 3 → blocked
      await rt.executeTick();
      await rt.executeTick();
      await rt.executeTick();

      const updated = taskRepo.getTask(tasks[0].id)!;
      expect(updated.status).toBe('blocked');
      // crash info is stored in result field (not error)
      expect(updated.result).toContain('3 times');
    });
  });

  // -------------------------------------------------------------------------
  // seedPresetAgents + seedBuiltInWorkflows wiring (space-handlers)
  // -------------------------------------------------------------------------

  describe('space.create seeding (unit-level check)', () => {
    test('seedBuiltInWorkflows can be called after seedPresetAgents successfully', async () => {
      // Create a new space DB row
      const newSpaceId = 'space-seed-test';
      const newWorkspacePath = '/tmp/seed-test';
      seedSpaceRow(db, newSpaceId, newWorkspacePath);

      const { seedPresetAgents } = await import('../../../../src/lib/space/agents/seed-agents.ts');
      const { seedBuiltInWorkflows } = await import(
        '../../../../src/lib/space/workflows/built-in-workflows.ts'
      );

      // Seed agents
      const result = await seedPresetAgents(newSpaceId, agentManager);
      expect(result.errors).toHaveLength(0);
      expect(result.seeded.length).toBeGreaterThan(0);

      // Seed workflows using name resolver (role removed from CreateSpaceWorkerAgentParams in M71;
      // built-in templates use capitalized placeholder names matching agent names)
      const agents = agentManager.listBySpaceId(newSpaceId);
      expect(() =>
        seedBuiltInWorkflows(
          newSpaceId,
          workflowManager,
          (name) => agents.find((a) => a.name === name)?.id
        )
      ).not.toThrow();

      // Four built-in workflows should exist (the stable coder-owned set,
      // minus the removed Plan & Decompose workflow).
      const workflows = workflowManager.listWorkflows(newSpaceId);
      expect(workflows).toHaveLength(4);
    });

    test('seedBuiltInWorkflows is idempotent (calling twice is a no-op)', async () => {
      const newSpaceId = 'space-seed-idempotent';
      const newWorkspacePath = '/tmp/seed-idempotent';
      seedSpaceRow(db, newSpaceId, newWorkspacePath);

      const { seedPresetAgents } = await import('../../../../src/lib/space/agents/seed-agents.ts');
      const { seedBuiltInWorkflows } = await import(
        '../../../../src/lib/space/workflows/built-in-workflows.ts'
      );

      await seedPresetAgents(newSpaceId, agentManager);
      const agents = agentManager.listBySpaceId(newSpaceId);
      // role removed from CreateSpaceWorkerAgentParams in M71; use name lookup instead
      const resolver = (name: string) => agents.find((a) => a.name === name)?.id;

      seedBuiltInWorkflows(newSpaceId, workflowManager, resolver);
      seedBuiltInWorkflows(newSpaceId, workflowManager, resolver); // second call is no-op

      const workflows = workflowManager.listWorkflows(newSpaceId);
      expect(workflows).toHaveLength(4); // still 4, not 8
    });
  });

  // -------------------------------------------------------------------------
  // Multi-agent steps
  // -------------------------------------------------------------------------

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
      // workflowNodeId removed from SpaceTask in M71; node tracking is now in node_executions
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

  // -------------------------------------------------------------------------
  // Channel topology resolution
  // -------------------------------------------------------------------------

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

      // Channels stored in-memory via runtime.getRunWorkflowChannels()
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
