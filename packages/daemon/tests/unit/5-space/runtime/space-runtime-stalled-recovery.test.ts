import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository.ts';
import { ToolContinuationRecoveryRepository } from '../../../../src/storage/repositories/tool-continuation-recovery-repository.ts';
import {
  PendingAgentMessageRepository,
  DEFAULT_PENDING_MESSAGE_RETENTION_MS,
} from '../../../../src/storage/repositories/pending-agent-message-repository.ts';
import {
  ChannelCycleRepository,
  DEAD_LOOP_WINDOW_MS,
} from '../../../../src/storage/repositories/channel-cycle-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceTaskManager } from '../../../../src/lib/space/managers/space-task-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { PermanentSpawnError } from '../../../../src/lib/space/runtime/workflow-node-execution-validation.ts';
import type { SpaceWorkflow, NodeExecutionStatus } from '@hyperneo/shared';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';

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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sdk_messages_task_id ON sdk_messages(task_id)`);
  return db;
}

function seedSpaceRow(db: BunDatabase, spaceId: string, workspacePath = '/tmp/ws'): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', ?, ?)`
  ).run(spaceId, workspacePath, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, `Agent ${agentId}`, Date.now(), Date.now());
}

function buildLinearWorkflow(
  spaceId: string,
  workflowManager: SpaceWorkflowManager,
  nodes: Array<{ id: string; name: string; agentId: string }>,
  opts: {
    channels?: SpaceWorkflow['channels'];
    endNodeId?: string;
  } = {}
): SpaceWorkflow {
  const transitions = nodes.slice(0, -1).map((step, i) => ({
    from: step.id,
    to: nodes[i + 1].id,
    condition: { type: 'always' as const },
    order: 0,
  }));
  return workflowManager.createWorkflow({
    spaceId,
    name: `Workflow-${Date.now()}-${Math.random()}`,
    description: 'Test',
    nodes,
    transitions,
    channels:
      opts.channels ??
      nodes.slice(0, -1).map((step, i) => ({
        id: `${step.id}-to-${nodes[i + 1].id}`,
        from: step.name,
        to: nodes[i + 1].name,
      })),
    startNodeId: nodes[0].id,
    endNodeId: opts.endNodeId ?? nodes.at(-1)?.id,
    rules: [],
    tags: [],
    completionAutonomyLevel: 3,
  });
}

describe('SpaceRuntime — recoverStalledRuns()', () => {
  let db: BunDatabase;

  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let agentManager: SpaceAgentManager;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;
  let nodeExecutionRepo: NodeExecutionRepository;
  let sdkMessageRepo: SDKMessageRepository;
  let bus: InternalEventBus<DaemonInternalEventMap>;
  let busUnsubs: Array<() => void>;
  let notifications: Array<{ kind: string; payload: Record<string, unknown> }>;

  const SPACE_EVENT_MAP: Record<string, string> = {
    'space.task.blocked': 'task_blocked',
    'space.workflowRun.blocked': 'workflow_run_blocked',
    'space.task.timeout': 'task_timeout',
    'space.workflowRun.completed': 'workflow_run_completed',
    'space.workflowRun.reopened': 'workflow_run_reopened',
    'space.agent.crashed': 'agent_crash',
    'space.workflowRun.retry': 'task_retry',
    'space.workflowRun.needsAttention': 'workflow_run_needs_attention',
    'space.task.awaitingApproval': 'task_awaiting_approval',
    'space.workflowRun.deadLoop': 'workflow_run_dead_loop',
  };

  const SPACE_ID = 'space-recovery-1';
  const AGENT = 'agent-recovery-1';
  const STEP_A = 'step-a';
  const STEP_B = 'step-b';

  function makeRuntime(overrides?: Partial<SpaceRuntimeConfig>): SpaceRuntime {
    return new SpaceRuntime({
      db,
      spaceManager,
      spaceAgentManager: agentManager,
      spaceWorkflowManager: workflowManager,
      workflowRunRepo,
      taskRepo,
      nodeExecutionRepo,
      sdkMessageRepo,
      internalEventBus: bus,
      ...overrides,
    });
  }

  function findExec(runId: string, nodeId: string) {
    return nodeExecutionRepo.listByNode(runId, nodeId)[0];
  }

  function seedExec(
    runId: string,
    nodeId: string,
    agentName: string,
    status: NodeExecutionStatus,
    opts: { agentSessionId?: string | null; result?: string | null } = {}
  ) {
    const existing = findExec(runId, nodeId);
    if (existing) {
      nodeExecutionRepo.update(existing.id, {
        status,
        agentSessionId: opts.agentSessionId ?? null,
        result: opts.result ?? null,
      });
      return existing;
    }
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
    });
    return created;
  }

  beforeEach(() => {
    db = makeDb();
    seedSpaceRow(db, SPACE_ID);
    seedAgentRow(db, AGENT, SPACE_ID);

    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    taskRepo = new SpaceTaskRepository(db);
    const agentRepo = new SpaceAgentRepository(db);
    agentManager = new SpaceAgentManager(agentRepo);
    const workflowRepo = new SpaceWorkflowRepository(db);
    workflowManager = new SpaceWorkflowManager(workflowRepo);
    spaceManager = new SpaceManager(db);
    nodeExecutionRepo = new NodeExecutionRepository(db);
    sdkMessageRepo = new SDKMessageRepository(db);
    bus = new InternalEventBus<DaemonInternalEventMap>();
    busUnsubs = [];
    for (const [eventName, kind] of Object.entries(SPACE_EVENT_MAP)) {
      const unsub = bus.subscribe(
        eventName as keyof DaemonInternalEventMap,
        (payload) => {
          notifications.push({ kind, payload: payload as Record<string, unknown> });
        },
        { subscriberName: `test-stalled:${eventName}` }
      );
      busUnsubs.push(unsub);
    }
    notifications = [];
  });

  afterEach(() => {
    for (const unsub of busUnsubs) unsub();
    busUnsubs = [];
    try {
      db.close();
    } catch {}
  });

  function saveAssistantMessage(sessionId: string, content: unknown[], stopReason: string | null) {
    sdkMessageRepo.saveSDKMessage(sessionId, {
      type: 'assistant',
      session_id: sessionId,
      uuid: `${sessionId}-assistant-${Date.now()}-${Math.random()}`,
      parent_tool_use_id: null,
      message: {
        id: `${sessionId}-message`,
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    } as any);
  }

  function saveSystemMessage(sessionId: string, timestamp: string) {
    db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, origin, is_renderable, is_terminal)
			 VALUES (?, ?, 'system', ?, ?, 'consumed', 'sdk', 1, 0)`
    ).run(
      `${sessionId}-system-${timestamp}`,
      sessionId,
      JSON.stringify({
        type: 'system',
        session_id: sessionId,
        uuid: `${sessionId}-system-uuid-${timestamp}`,
        subtype: 'init',
      }),
      timestamp
    );
  }

  describe('non-terminal idle last-message recovery', () => {
    test('idle coder with recent system last message is preserved without Space Agent notification', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);
      db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Recent System Idle Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Recent System Idle Run',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      const execution = seedExec(run.id, STEP_A, 'Step A', 'idle', {
        agentSessionId: 'recent-system-session',
      });
      saveSystemMessage('recent-system-session', new Date().toISOString());
      const nudges: string[] = [];
      const rt = makeRuntime({
        taskAgentManager: {
          rehydrate: async () => {},
          isSessionAlive: () => false,
          getAgentSessionById: () => null,
          isExecutionSpawning: () => false,
          injectRuntimeRecoveryMessage: async (_sessionId: string, message: string) => {
            nudges.push(message);
            return 'nudge-message-id';
          },
        } as any,
        agentNoProgressThresholdMs: 60_000,
      });
      (rt as any).recoveryDone = true;
      await rt.executeTick();

      const updated = nodeExecutionRepo.getById(execution.id)!;
      expect(updated.status).toBe('idle');
      expect(updated.agentSessionId).toBe('recent-system-session');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');
      expect(nudges).toHaveLength(0);
      expect(notifications).not.toContainEqual(expect.objectContaining({ kind: 'task_blocked' }));
    });

    test('idle execution with unresolved tool_use is preserved and not advanced', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);
      db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Non Terminal Idle Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Non Terminal Idle Run',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      const execution = seedExec(run.id, STEP_A, 'Step A', 'idle', {
        agentSessionId: 'non-terminal-session',
      });
      saveAssistantMessage(
        'non-terminal-session',
        [{ type: 'tool_use', id: 'tool-1', name: 'do_work', input: {} }],
        'tool_use'
      );

      const rt = makeRuntime({
        taskAgentManager: {
          rehydrate: async () => {},
          isSessionAlive: () => false,
          getAgentSessionById: () => null,
          isExecutionSpawning: () => false,
        } as any,
      });
      (rt as any).recoveryDone = true;
      await rt.executeTick();

      const updated = nodeExecutionRepo.getById(execution.id)!;
      expect(updated.status).toBe('idle');
      expect(updated.agentSessionId).toBe('non-terminal-session');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');
      expect(notifications).not.toContainEqual(expect.objectContaining({ kind: 'task_blocked' }));
      expect(notifications.some((event) => event.kind === 'task_retry')).toBe(false);
    });

    test('recoverStalledRuns rechecks paused runs after the space resumes', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);
      db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Paused Restart Stall Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Paused Restart Stall Run',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      const execution = seedExec(run.id, STEP_A, 'Step A', 'idle');

      const rt = makeRuntime();
      await rt.recoverStalledRuns();

      expect((rt as unknown as { recoveryDone: boolean }).recoveryDone).toBe(false);
      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('idle');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');

      db.prepare(`UPDATE spaces SET paused = 0 WHERE id = ?`).run(SPACE_ID);
      await rt.recoverStalledRuns();

      expect((rt as unknown as { recoveryDone: boolean }).recoveryDone).toBe(true);
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
      expect(taskRepo.getTask(task.id)?.status).toBe('blocked');
    });

    test('recoverStalledRuns preserves non-terminal idle execution instead of blocking', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);
      db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Restart Non Terminal Idle Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Restart Non Terminal Idle Run',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      const execution = seedExec(run.id, STEP_A, 'Step A', 'idle', {
        agentSessionId: 'restart-non-terminal-session',
      });
      saveAssistantMessage(
        'restart-non-terminal-session',
        [{ type: 'tool_use', id: 'tool-restart', name: 'do_work', input: {} }],
        'tool_use'
      );

      const rt = makeRuntime();
      await rt.recoverStalledRuns();

      const updated = nodeExecutionRepo.getById(execution.id)!;
      expect(updated.status).toBe('idle');
      expect(updated.agentSessionId).toBe('restart-non-terminal-session');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');
      expect(notifications).not.toContainEqual(expect.objectContaining({ kind: 'task_blocked' }));
      expect(notifications.some((event) => event.kind === 'task_retry')).toBe(false);
      expect(notifications.some((event) => event.kind === 'workflow_run_needs_attention')).toBe(
        false
      );
    });

    test('repeated non-terminal idle remains preserved without escalation', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);
      db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Repeated Non Terminal Idle Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Repeated Non Terminal Idle Run',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      const execution = seedExec(run.id, STEP_A, 'Step A', 'idle', {
        agentSessionId: 'non-terminal-repeat',
      });
      saveAssistantMessage('non-terminal-repeat', [{ type: 'thinking', thinking: 'hmm' }], null);
      const rt = makeRuntime({
        taskAgentManager: {
          rehydrate: async () => {},
          isSessionAlive: () => false,
          getAgentSessionById: () => null,
          isExecutionSpawning: () => false,
        } as any,
      });
      (rt as any).recoveryDone = true;
      (rt as any).nonTerminalIdleStates.set(`${run.id}:${execution.id}`, {
        lastSessionId: 'non-terminal-repeat',
        lastObservedMessageId: 'message-id',
        lastObservedProgressMessageId: 'message-id',
        lastObservedProgressMessageAt: Date.now() - 60_000,
        lastRuntimeNudgeMessageId: 'nudge-id',
        nudgeCount: 3,
        failedNudgeCount: 0,
        lastNudgeAt: Date.now() - 60_000,
        lastAttentionLogAt: null,
      });
      await rt.executeTick();

      const updated = nodeExecutionRepo.getById(execution.id)!;
      expect(updated.status).toBe('idle');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');
      expect(notifications.some((event) => event.kind === 'workflow_run_needs_attention')).toBe(
        false
      );
    });

    test('non-terminal idle preservation does not set blockedRetryCounts', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Block retry budget test',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Block retry budget test',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      const execution = seedExec(run.id, STEP_A, 'Step A', 'idle', {
        agentSessionId: 'non-terminal-blocked-session',
      });
      saveAssistantMessage(
        'non-terminal-blocked-session',
        [{ type: 'tool_use', id: 'tu-1', name: 'test', input: {} }],
        null
      );

      const rt = makeRuntime();
      (rt as any).nonTerminalIdleStates.set(`${run.id}:${execution.id}`, {
        lastSessionId: 'non-terminal-blocked-session',
        lastObservedMessageId: 'message-id',
        lastObservedProgressMessageId: 'message-id',
        lastObservedProgressMessageAt: Date.now() - 60_000,
        lastRuntimeNudgeMessageId: 'nudge-id',
        nudgeCount: 3,
        failedNudgeCount: 0,
        lastNudgeAt: Date.now() - 60_000,
        lastAttentionLogAt: null,
      });
      const outcome = await (rt as any).handleNonTerminalIdleExecutions(
        run.id,
        SPACE_ID,
        taskRepo.getTask(task.id)!,
        workflow
      );

      expect(outcome).toBe('preserved');
      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('idle');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect((rt as any).blockedRetryCounts.get(run.id)).toBeUndefined();
    });
  });

  describe('orphaned tool_result waiting_rebind recovery', () => {
    test('queued continuation resets waiting_rebind execution to pending for one deterministic retry', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);
      db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Orphan Recovery Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Orphan Recovery Run',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      const execution = seedExec(run.id, STEP_A, 'Step A', 'waiting_rebind', {
        agentSessionId: 'dead-session',
        result: 'waiting for orphaned tool_result recovery',
      });
      const recoveryRepo = new ToolContinuationRecoveryRepository(db);
      recoveryRepo.ensureSchema();
      recoveryRepo.recordToolUse({
        toolUseId: 'tool-rebind-1',
        sessionId: 'dead-session',
        ttlMs: 60_000,
        owner: { executionId: execution.id, workflowRunId: run.id },
      });
      recoveryRepo.queueContinuation({
        toolUseId: 'tool-rebind-1',
        sessionId: 'dead-session',
        requestBody: { messages: [{ role: 'user', content: [] }] },
        reason: 'late continuation arrived after session timeout',
        ttlMs: 60_000,
      });

      const rt = makeRuntime({
        taskAgentManager: {
          rehydrate: async () => {},
          isSessionAlive: () => false,
          getAgentSessionById: () => null,
          isExecutionSpawning: () => false,
        } as any,
      });
      await rt.executeTick();

      const updated = nodeExecutionRepo.getById(execution.id)!;
      const inbox = recoveryRepo.listPendingInboxForExecution(execution.id);
      expect(updated.status).toBe('pending');
      expect(updated.agentSessionId).toBe('dead-session');
      expect(updated.data?.orphanedToolContinuation).toMatchObject({
        state: 'rebound',
        retryCount: 1,
        queuedContinuations: 1,
      });
      expect(inbox).toHaveLength(0);
      expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');
      expect(notifications.some((event) => event.kind === 'task_retry')).toBe(true);
    });

    test('empty inbox with no active tool_use fails waiting_rebind execution forward to blocked', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);
      db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Expired Orphan Recovery Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Expired Orphan Recovery Run',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      const execution = seedExec(run.id, STEP_A, 'Step A', 'waiting_rebind', {
        agentSessionId: 'dead-session',
        result: 'waiting for orphaned tool_result recovery',
      });
      const recoveryRepo = new ToolContinuationRecoveryRepository(db);
      recoveryRepo.ensureSchema();

      const rt = makeRuntime({
        taskAgentManager: {
          rehydrate: async () => {},
          isSessionAlive: () => false,
          getAgentSessionById: () => null,
          isExecutionSpawning: () => false,
        } as any,
      });
      await rt.executeTick();

      const reason = 'orphaned tool_result recovery expired before a continuation arrived';
      const updated = nodeExecutionRepo.getById(execution.id)!;
      const updatedRun = workflowRunRepo.getRun(run.id)!;
      const updatedTask = taskRepo.getTask(task.id)!;
      const runBlockedEvents = notifications.filter(
        (event) => event.kind === 'workflow_run_blocked'
      );
      expect(updated.status).toBe('blocked');
      expect(updated.result).toBe(reason);
      expect(updated.data?.orphanedToolContinuation).toMatchObject({
        state: 'failed',
        retryCount: 0,
        reason,
      });
      expect(updatedRun.status).toBe('blocked');
      expect(updatedTask.status).toBe('blocked');
      expect(updatedTask.blockReason).toBe('execution_failed');
      expect(updatedTask.result).toBe(reason);
      expect(recoveryRepo.listPendingInboxForExecution(execution.id)).toHaveLength(0);
      expect(runBlockedEvents).toHaveLength(1);
      expect(runBlockedEvents[0]).toMatchObject({
        kind: 'workflow_run_blocked',
        payload: {
          spaceId: SPACE_ID,
          runId: run.id,
          reason,
        },
      });
    });

    test('live waiting_rebind session is not failed forward after tool_use is consumed', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);
      db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Live Rebind Session Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Live Rebind Session Run',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      const execution = seedExec(run.id, STEP_A, 'Step A', 'waiting_rebind', {
        agentSessionId: 'live-session',
        result: 'waiting for orphaned tool_result recovery',
      });
      const recoveryRepo = new ToolContinuationRecoveryRepository(db);
      recoveryRepo.ensureSchema();
      recoveryRepo.recordToolUse({
        toolUseId: 'tool-live-consumed',
        sessionId: 'live-session',
        ttlMs: 60_000,
        owner: { executionId: execution.id, workflowRunId: run.id },
      });
      recoveryRepo.markConsumed('tool-live-consumed');

      const rt = makeRuntime({
        taskAgentManager: {
          rehydrate: async () => {},
          isSessionAlive: (sessionId: string) => sessionId === 'live-session',
          getAgentSessionById: () => null,
          isExecutionSpawning: () => false,
        } as any,
      });
      await rt.executeTick();

      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('waiting_rebind');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');
      expect(notifications.some((event) => event.kind === 'workflow_run_blocked')).toBe(false);
    });

    test('live waiting_rebind session with queued inbox is not rebound', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);
      db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Live Rebind Inbox Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Live Rebind Inbox Run',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      const execution = seedExec(run.id, STEP_A, 'Step A', 'waiting_rebind', {
        agentSessionId: 'live-session-with-inbox',
        result: 'waiting for orphaned tool_result recovery',
      });
      const recoveryRepo = new ToolContinuationRecoveryRepository(db);
      recoveryRepo.ensureSchema();
      recoveryRepo.recordToolUse({
        toolUseId: 'tool-live-inbox',
        sessionId: 'live-session-with-inbox',
        ttlMs: 60_000,
        owner: { executionId: execution.id, workflowRunId: run.id },
      });
      recoveryRepo.queueContinuation({
        toolUseId: 'tool-live-inbox',
        sessionId: 'live-session-with-inbox',
        requestBody: { messages: [{ role: 'user', content: [] }] },
        reason: 'late continuation while original session is still live',
        ttlMs: 60_000,
      });

      const rt = makeRuntime({
        taskAgentManager: {
          rehydrate: async () => {},
          isSessionAlive: (sessionId: string) => sessionId === 'live-session-with-inbox',
          getAgentSessionById: () => null,
          isExecutionSpawning: () => false,
        } as any,
      });
      await rt.executeTick();

      const updated = nodeExecutionRepo.getById(execution.id)!;
      expect(updated.status).toBe('waiting_rebind');
      expect(updated.agentSessionId).toBe('live-session-with-inbox');
      expect(recoveryRepo.listPendingInboxForExecution(execution.id)).toHaveLength(1);
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');
      expect(notifications.filter((event) => event.kind === 'task_retry')).toHaveLength(0);
      expect(notifications.filter((event) => event.kind === 'workflow_run_blocked')).toHaveLength(
        0
      );
    });

    test('blocking one waiting_rebind execution stops later same-tick rebounds', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
        { id: STEP_B, name: 'Step B', agentId: AGENT },
      ]);
      db.prepare(`UPDATE spaces SET paused = 1 WHERE id = ?`).run(SPACE_ID);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Multiple Waiting Rebind Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Multiple Waiting Rebind Run',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      const expiredExecution = seedExec(run.id, STEP_A, 'Step A', 'waiting_rebind', {
        agentSessionId: 'dead-session-a',
        result: 'waiting for orphaned tool_result recovery',
      });
      const reboundCandidate = seedExec(run.id, STEP_B, 'Step B', 'waiting_rebind', {
        agentSessionId: 'dead-session-b',
        result: 'waiting for orphaned tool_result recovery',
      });
      const recoveryRepo = new ToolContinuationRecoveryRepository(db);
      recoveryRepo.ensureSchema();
      recoveryRepo.recordToolUse({
        toolUseId: 'tool-rebind-after-block',
        sessionId: 'dead-session-b',
        ttlMs: 60_000,
        owner: { executionId: reboundCandidate.id, workflowRunId: run.id },
      });
      recoveryRepo.queueContinuation({
        toolUseId: 'tool-rebind-after-block',
        sessionId: 'dead-session-b',
        requestBody: { messages: [{ role: 'user', content: [] }] },
        reason: 'late continuation for sibling execution',
        ttlMs: 60_000,
      });

      const rt = makeRuntime({
        taskAgentManager: {
          rehydrate: async () => {},
          isSessionAlive: () => false,
          getAgentSessionById: () => null,
          isExecutionSpawning: () => false,
        } as any,
      });
      await rt.executeTick();

      expect(nodeExecutionRepo.getById(expiredExecution.id)?.status).toBe('blocked');
      expect(nodeExecutionRepo.getById(reboundCandidate.id)?.status).toBe('waiting_rebind');
      expect(recoveryRepo.listPendingInboxForExecution(reboundCandidate.id)).toHaveLength(1);
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
      expect(taskRepo.getTask(task.id)?.status).toBe('blocked');
      expect(notifications.filter((event) => event.kind === 'task_retry')).toHaveLength(0);
      expect(notifications.filter((event) => event.kind === 'workflow_run_blocked')).toHaveLength(
        1
      );
    });
  });

  describe('runs with all node executions terminal and no completion signal', () => {
    test('coder idle and reviewer never created → reviewer is activated pending on daemon restart', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
        { id: STEP_B, name: 'Review', agentId: AGENT },
      ]);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Recover missing reviewer',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Recover missing reviewer',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      seedExec(run.id, STEP_A, 'Coding', 'idle');
      const pendingRepo = new PendingAgentMessageRepository(db);

      await makeRuntime({ pendingMessageRepo: pendingRepo }).recoverStalledRuns();

      const reviewer = findExec(run.id, STEP_B);
      expect(reviewer.status).toBe('pending');
      expect(reviewer.agentSessionId).toBeNull();
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');
      expect(pendingRepo.listPendingForTarget(run.id, 'Review')[0].message).toContain(
        'Daemon restart recovery'
      );
    });

    test('coder idle and reviewer idle from previous cycle → reviewer resets to pending', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
        { id: STEP_B, name: 'Review', agentId: AGENT },
      ]);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Recover idle reviewer',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Recover idle reviewer',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      seedExec(run.id, STEP_A, 'Coding', 'idle');
      const previousReviewer = seedExec(run.id, STEP_B, 'Review', 'idle', {
        agentSessionId: 'dead-review-session',
        result: 'previous review finished',
      });
      saveAssistantMessage(
        'dead-review-session',
        [{ type: 'text', text: 'Review complete' }],
        'end_turn'
      );

      await makeRuntime({
        pendingMessageRepo: new PendingAgentMessageRepository(db),
      }).recoverStalledRuns();

      const reviewer = nodeExecutionRepo.getById(previousReviewer.id)!;
      expect(reviewer.status).toBe('pending');
      expect(reviewer.agentSessionId).toBe('dead-review-session');
      expect(reviewer.result).toBeNull();
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      const pending = new PendingAgentMessageRepository(db).listPendingForTarget(run.id, 'Review');
      expect(pending[0].message).toContain("Review node's previous session ended");
    });

    test('coder cancelled and reviewer never created → run blocked', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
        { id: STEP_B, name: 'Review', agentId: AGENT },
      ]);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Do not recover cancelled source',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Do not recover cancelled source',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      seedExec(run.id, STEP_A, 'Coding', 'cancelled');

      await makeRuntime({
        pendingMessageRepo: new PendingAgentMessageRepository(db),
      }).recoverStalledRuns();

      expect(findExec(run.id, STEP_B)).toBeUndefined();
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
      expect(taskRepo.getTask(task.id)?.blockReason).toBe('execution_failed');
    });

    test('expired queued handoff does not cause stalled-run recovery to skip', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
        { id: STEP_B, name: 'Review', agentId: AGENT },
      ]);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Expired queued handoff recovery',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Expired queued handoff recovery',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      seedExec(run.id, STEP_A, 'Coding', 'idle');
      const pendingRepo = new PendingAgentMessageRepository(db);
      const { record } = pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'Coding',
        targetKind: 'node_agent',
        targetAgentName: 'Review',
        message: 'stale review request',
      });
      db.prepare('UPDATE pending_agent_messages SET created_at = ? WHERE id = ?').run(
        Date.now() - DEFAULT_PENDING_MESSAGE_RETENTION_MS - 1,
        record.id
      );

      await makeRuntime({
        pendingMessageRepo: pendingRepo,
      }).recoverStalledRuns();

      expect(pendingRepo.getById(record.id)?.status).toBe('expired');
      expect(findExec(run.id, STEP_B).status).toBe('pending');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(taskRepo.getTask(task.id)?.status).toBe('in_progress');
    });

    test('coder idle with queued handoff and reviewer never created → tick repair creates and spawns reviewer', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
        { id: STEP_B, name: 'Review', agentId: AGENT },
      ]);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Queued handoff repair',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Queued handoff repair',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      seedExec(run.id, STEP_A, 'Coding', 'idle');
      const pendingRepo = new PendingAgentMessageRepository(db);
      pendingRepo.enqueue({
        workflowRunId: run.id,
        spaceId: SPACE_ID,
        taskId: task.id,
        sourceAgentName: 'Coding',
        targetKind: 'node_agent',
        targetAgentName: 'Review',
        message: 'please review',
      });
      const live = new Set<string>();
      const tam = {
        rehydrate: async () => {},
        isSessionAlive: (sessionId: string) => live.has(sessionId),
        getAgentSessionById: () => null,
        isExecutionSpawning: () => false,
        tryResumeNodeAgentSession: async () => {},
        spawnWorkflowNodeAgentForExecution: async (
          _task: unknown,
          _space: unknown,
          _workflow: unknown,
          _run: unknown,
          execution: { id: string }
        ) => {
          const sessionId = `session:${execution.id}`;
          live.add(sessionId);
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
          for (const row of pendingRepo.listPendingForTarget(runId, agentName))
            pendingRepo.markDelivered(row.id, sessionId);
        },
        cancelBySessionId: () => {},
        interruptBySessionId: async () => {},
      };

      await makeRuntime({
        pendingMessageRepo: pendingRepo,
        taskAgentManager: tam as any,
      }).executeTick();

      const reviewer = findExec(run.id, STEP_B);
      expect(reviewer.status).toBe('in_progress');
      expect(reviewer.agentSessionId).toBe(`session:${reviewer.id}`);
      expect(pendingRepo.listAllForRun(run.id)[0].status).toBe('delivered');
    });

    test('coder idle and reviewer cancelled from prior activation → reviewer resets pending', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
        { id: STEP_B, name: 'Review', agentId: AGENT },
      ]);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Recover cancelled reviewer',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Recover cancelled reviewer',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      seedExec(run.id, STEP_A, 'Coding', 'idle');
      const cancelledReviewer = seedExec(run.id, STEP_B, 'Review', 'cancelled', {
        agentSessionId: 'cancelled-review-session',
        result: 'review cancelled during restart',
      });

      await makeRuntime({
        pendingMessageRepo: new PendingAgentMessageRepository(db),
      }).recoverStalledRuns();

      const reviewer = nodeExecutionRepo.getById(cancelledReviewer.id)!;
      expect(reviewer.status).toBe('pending');
      expect(reviewer.agentSessionId).toBe('cancelled-review-session');
      expect(reviewer.result).toBeNull();
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
    });

    test('linear run stalled after later node → only latest handoff is recovered', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Plan', agentId: AGENT },
        { id: STEP_B, name: 'Code', agentId: AGENT },
        { id: 'step-c', name: 'Review', agentId: AGENT },
      ]);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Recover latest handoff only',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Recover latest handoff only',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      const plan = seedExec(run.id, STEP_A, 'Plan', 'idle');
      const code = seedExec(run.id, STEP_B, 'Code', 'idle');

      await makeRuntime({
        pendingMessageRepo: new PendingAgentMessageRepository(db),
      }).recoverStalledRuns();

      expect(nodeExecutionRepo.getById(plan.id)?.status).toBe('idle');
      expect(nodeExecutionRepo.getById(code.id)?.status).toBe('idle');
      expect(findExec(run.id, 'step-c').status).toBe('pending');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
    });

    test('agent-name channel recovers handoff when node names differ', async () => {
      const workflow = buildLinearWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: STEP_A, name: 'Implementation', agentId: AGENT },
          { id: STEP_B, name: 'Verification', agentId: AGENT },
        ],
        {
          channels: [{ id: 'coder-to-reviewer', from: 'coder', to: 'reviewer' }],
        }
      );
      workflow.nodes[0].agents[0].name = 'coder';
      workflow.nodes[1].agents[0].name = 'reviewer';
      workflowManager.updateWorkflow(workflow.id, { nodes: workflow.nodes });
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Recover agent-name channel',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Recover agent-name channel',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      const coder = seedExec(run.id, STEP_A, 'coder', 'idle');

      await makeRuntime({
        pendingMessageRepo: new PendingAgentMessageRepository(db),
      }).recoverStalledRuns();

      expect(nodeExecutionRepo.getById(coder.id)?.status).toBe('idle');
      expect(findExec(run.id, STEP_B).status).toBe('pending');
      expect(findExec(run.id, STEP_B).agentName).toBe('reviewer');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
    });

    test('multi-agent target recovers missing slot when sibling slot is idle', async () => {
      const workflow = buildLinearWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: STEP_A, name: 'Coding', agentId: AGENT },
          { id: STEP_B, name: 'Review', agentId: AGENT },
          { id: 'step-done', name: 'Done', agentId: AGENT },
        ],
        { endNodeId: 'step-done' }
      );
      workflow.nodes[1].agents = [
        { agentId: AGENT, name: 'Reviewer A' },
        { agentId: AGENT, name: 'Reviewer B' },
      ];
      workflowManager.updateWorkflow(workflow.id, { nodes: workflow.nodes });
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Recover missing reviewer slot',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Recover missing reviewer slot',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      seedExec(run.id, STEP_A, 'Coding', 'idle');
      const reviewerA = seedExec(run.id, STEP_B, 'Reviewer A', 'idle', {
        agentSessionId: 'dead-reviewer-a-session',
        result: 'reviewer A already exited',
      });
      saveAssistantMessage(
        'dead-reviewer-a-session',
        [{ type: 'text', text: 'Reviewer A done' }],
        'end_turn'
      );

      await makeRuntime({
        pendingMessageRepo: new PendingAgentMessageRepository(db),
      }).recoverStalledRuns();

      const reviewExecutions = nodeExecutionRepo.listByNode(run.id, STEP_B);
      expect(nodeExecutionRepo.getById(reviewerA.id)?.status).toBe('pending');
      expect(reviewExecutions.map((execution) => execution.agentName)).toContain('Reviewer A');
      expect(reviewExecutions.map((execution) => execution.agentName)).toContain('Reviewer B');
      expect(
        nodeExecutionRepo
          .listByNode(run.id, STEP_B)
          .find((execution) => execution.agentName === 'Reviewer B')?.status
      ).toBe('pending');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
    });

    test('fan-out recovery only activates the stalled target branch', async () => {
      const workflow = buildLinearWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: STEP_A, name: 'Coding', agentId: AGENT },
          { id: STEP_B, name: 'Docs', agentId: AGENT },
          { id: 'step-c', name: 'Review', agentId: AGENT },
        ],
        {
          channels: [
            { id: 'coding-to-docs', from: 'Coding', to: 'Docs' },
            { id: 'coding-to-review', from: 'Coding', to: 'Review' },
          ],
        }
      );
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Recover one fan-out branch',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Recover one fan-out branch',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      const coder = seedExec(run.id, STEP_A, 'Coding', 'idle');
      const docs = seedExec(run.id, STEP_B, 'Docs', 'idle', {
        agentSessionId: 'dead-docs-session',
        result: 'docs branch already finished',
      });
      saveAssistantMessage(
        'dead-docs-session',
        [{ type: 'text', text: 'Docs complete' }],
        'end_turn'
      );

      await makeRuntime({
        pendingMessageRepo: new PendingAgentMessageRepository(db),
      }).recoverStalledRuns();

      expect(nodeExecutionRepo.getById(coder.id)?.status).toBe('idle');
      expect(nodeExecutionRepo.getById(docs.id)?.status).toBe('idle');
      expect(nodeExecutionRepo.getById(docs.id)?.agentSessionId).toBe('dead-docs-session');
      expect(nodeExecutionRepo.getById(docs.id)?.result).toBe('docs branch already finished');
      expect(findExec(run.id, 'step-c').status).toBe('pending');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
    });

    test('wildcard target recovery does not broadcast to unrelated nodes', async () => {
      const workflow = buildLinearWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: STEP_A, name: 'Coding', agentId: AGENT },
          { id: STEP_B, name: 'Docs', agentId: AGENT },
          { id: 'step-c', name: 'Review', agentId: AGENT },
        ],
        {
          channels: [{ id: 'coding-to-any', from: 'Coding', to: '*' }],
        }
      );
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Do not broadcast wildcard target',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Do not broadcast wildcard target',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      const coder = seedExec(run.id, STEP_A, 'Coding', 'idle');
      const docs = seedExec(run.id, STEP_B, 'Docs', 'idle', {
        agentSessionId: 'dead-docs-session',
        result: 'docs branch already finished',
      });
      const reviewer = seedExec(run.id, 'step-c', 'Review', 'idle', {
        agentSessionId: 'dead-review-session',
        result: 'review branch already finished',
      });
      saveAssistantMessage(
        'dead-docs-session',
        [{ type: 'text', text: 'Docs complete' }],
        'end_turn'
      );
      saveAssistantMessage(
        'dead-review-session',
        [{ type: 'text', text: 'Review complete' }],
        'end_turn'
      );

      await makeRuntime({
        pendingMessageRepo: new PendingAgentMessageRepository(db),
      }).recoverStalledRuns();

      expect(nodeExecutionRepo.getById(coder.id)?.status).toBe('idle');
      expect(nodeExecutionRepo.getById(docs.id)?.status).toBe('idle');
      expect(nodeExecutionRepo.getById(docs.id)?.agentSessionId).toBe('dead-docs-session');
      expect(nodeExecutionRepo.getById(docs.id)?.result).toBe('docs branch already finished');
      expect(nodeExecutionRepo.getById(reviewer.id)?.status).toBe('idle');
      expect(nodeExecutionRepo.getById(reviewer.id)?.agentSessionId).toBe('dead-review-session');
      expect(nodeExecutionRepo.getById(reviewer.id)?.result).toBe('review branch already finished');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
    });

    test('cyclic channel in a dead loop → run blocked', async () => {
      const workflow = buildLinearWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: STEP_A, name: 'Coding', agentId: AGENT },
          { id: STEP_B, name: 'Review', agentId: AGENT },
        ],
        {
          channels: [
            { id: 'coding-to-review', from: 'Coding', to: 'Review' },
            { id: 'review-to-coding', from: 'Review', to: 'Coding', maxCycles: 1 },
          ],
          endNodeId: STEP_B,
        }
      );
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Dead-loop handoff',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Dead-loop handoff',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      seedExec(run.id, STEP_B, 'Review', 'idle');
      const cycleRepo = new ChannelCycleRepository(db);
      const now = Date.now();
      for (let i = 0; i < 15; i++) cycleRepo.recordCycleEvent(run.id, 1, now - i * 1000);

      await makeRuntime({
        pendingMessageRepo: new PendingAgentMessageRepository(db),
      }).recoverStalledRuns();

      expect(findExec(run.id, STEP_A)).toBeUndefined();
      expect(findExec(run.id, STEP_B).status).toBe('idle');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
      expect(taskRepo.getTask(task.id)?.blockReason).toBe('execution_failed');

      const deadLoopNotes = notifications.filter((n) => n.kind === 'workflow_run_dead_loop');
      expect(deadLoopNotes).toHaveLength(1);
      expect(deadLoopNotes[0].payload.runId).toBe(run.id);
      expect(deadLoopNotes[0].payload.recentCount).toBe(15);
    });

    test('cyclic channel one short of the dead-loop threshold → recovery activates and records exactly one traversal', async () => {
      const workflow = buildLinearWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: STEP_A, name: 'Coding', agentId: AGENT },
          { id: STEP_B, name: 'Review', agentId: AGENT },
        ],
        {
          channels: [
            { id: 'coding-to-review', from: 'Coding', to: 'Review' },
            { id: 'review-to-coding', from: 'Review', to: 'Coding', maxCycles: 1 },
          ],
          endNodeId: STEP_B,
        }
      );
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Boundary Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Boundary Run',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      seedExec(run.id, STEP_B, 'Review', 'idle');
      const cycleRepo = new ChannelCycleRepository(db);
      const now = Date.now();
      for (let i = 0; i < 14; i++) cycleRepo.recordCycleEvent(run.id, 1, now - i * 1000);

      await makeRuntime({
        pendingMessageRepo: new PendingAgentMessageRepository(db),
      }).recoverStalledRuns();

      expect(findExec(run.id, STEP_A)).toBeDefined();
      expect(cycleRepo.countRecentCycleEvents(run.id, 1)).toBe(15);
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(notifications.filter((n) => n.kind === 'workflow_run_dead_loop')).toHaveLength(0);
    });

    test('done/cancelled are reopenable → rate window retained; archiving the task clears it', async () => {
      const workflow = buildLinearWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: STEP_A, name: 'Coding', agentId: AGENT },
          { id: STEP_B, name: 'Review', agentId: AGENT },
        ],
        {
          channels: [
            { id: 'coding-to-review', from: 'Coding', to: 'Review' },
            { id: 'review-to-coding', from: 'Review', to: 'Coding', maxCycles: 1 },
          ],
          endNodeId: STEP_B,
        }
      );
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Reopen retain',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Reopen retain',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      const cycleRepo = new ChannelCycleRepository(db);
      const now = Date.now();
      for (let i = 0; i < 5; i++) cycleRepo.recordCycleEvent(run.id, 1, now - i * 1000);
      expect(cycleRepo.countRecentCycleEvents(run.id, 1)).toBe(5);

      const runtime = makeRuntime({
        pendingMessageRepo: new PendingAgentMessageRepository(db),
      });

      await runtime.cancelWorkflowRun(SPACE_ID, run.id);
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('cancelled');
      expect(cycleRepo.countRecentCycleEvents(run.id, 1)).toBe(5);

      const taskManager = new SpaceTaskManager(db, SPACE_ID);
      await taskManager.setTaskStatus(task.id, 'archived');
      expect(cycleRepo.countRecentCycleEvents(run.id, 1)).toBe(0);
    });

    test('clearing run dead-loop history waits until ALL its tasks are archived', async () => {
      const workflow = buildLinearWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: STEP_A, name: 'Coding', agentId: AGENT },
          { id: STEP_B, name: 'Review', agentId: AGENT },
        ],
        {
          channels: [
            { id: 'coding-to-review', from: 'Coding', to: 'Review' },
            { id: 'review-to-coding', from: 'Review', to: 'Coding', maxCycles: 1 },
          ],
          endNodeId: STEP_B,
        }
      );
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Multi-task run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const taskA = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Multi-task A',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'open',
      });
      const taskB = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Multi-task B',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_B,
        status: 'open',
      });
      const cycleRepo = new ChannelCycleRepository(db);
      const now = Date.now();
      for (let i = 0; i < 3; i++) cycleRepo.recordCycleEvent(run.id, 1, now - i * 1000);
      expect(cycleRepo.countRecentCycleEvents(run.id, 1)).toBe(3);

      const taskManager = new SpaceTaskManager(db, SPACE_ID);
      await taskManager.setTaskStatus(taskA.id, 'archived');
      expect(cycleRepo.countRecentCycleEvents(run.id, 1)).toBe(3);
      await taskManager.setTaskStatus(taskB.id, 'archived');
      expect(cycleRepo.countRecentCycleEvents(run.id, 1)).toBe(0);
    });

    test('pruneExpiredCycleEvents drops window-aged retained history (throttled)', async () => {
      const workflow = buildLinearWorkflow(
        SPACE_ID,
        workflowManager,
        [
          { id: STEP_A, name: 'Coding', agentId: AGENT },
          { id: STEP_B, name: 'Review', agentId: AGENT },
        ],
        {
          channels: [
            { id: 'coding-to-review', from: 'Coding', to: 'Review' },
            { id: 'review-to-coding', from: 'Review', to: 'Coding', maxCycles: 1 },
          ],
          endNodeId: STEP_B,
        }
      );
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Prune sweep',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Prune sweep',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      const cycleRepo = new ChannelCycleRepository(db);
      const now = Date.now();
      cycleRepo.recordCycleEvent(run.id, 1, now - 1000);
      cycleRepo.recordCycleEvent(run.id, 1, now - DEAD_LOOP_WINDOW_MS - 60_000);

      const runtime = makeRuntime({
        pendingMessageRepo: new PendingAgentMessageRepository(db),
      });
      await runtime.cancelWorkflowRun(SPACE_ID, run.id);

      runtime.pruneExpiredCycleEvents(now);
      expect(cycleRepo.countRecentCycleEvents(run.id, 1)).toBe(1);

      cycleRepo.recordCycleEvent(run.id, 1, now - DEAD_LOOP_WINDOW_MS - 60_000);
      runtime.pruneExpiredCycleEvents(now + 1000);
      expect(cycleRepo.resetAllForRun(run.id)).toBe(2);
    });

    test('single-node run with idle execution → run blocked, task blocked, notifications emitted', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Stalled Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Stalled Run',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });

      seedExec(run.id, STEP_A, 'Step A', 'idle');

      const rt = makeRuntime();
      await rt.recoverStalledRuns();

      const updatedRun = workflowRunRepo.getRun(run.id)!;
      expect(updatedRun.status).toBe('blocked');

      const updatedTask = taskRepo.getTask(task.id)!;
      expect(updatedTask.status).toBe('blocked');
      expect(updatedTask.blockReason).toBe('execution_failed');
      expect(updatedTask.result).toContain('stalled across daemon restart');

      const taskBlockedEvents = notifications.filter((n) => n.kind === 'task_blocked');
      const runBlockedEvents = notifications.filter((n) => n.kind === 'workflow_run_blocked');
      expect(taskBlockedEvents.length).toBe(1);
      expect(runBlockedEvents.length).toBe(1);
      expect(taskBlockedEvents[0]).toMatchObject({
        kind: 'task_blocked',
        payload: {
          spaceId: SPACE_ID,
          taskId: task.id,
        },
      });
      expect(runBlockedEvents[0]).toMatchObject({
        kind: 'workflow_run_blocked',
        payload: {
          spaceId: SPACE_ID,
          runId: run.id,
        },
      });
    });

    test('multi-node run with no idle source execution → blocked', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
        { id: STEP_B, name: 'Step B', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Multi-Stalled',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Multi-Stalled',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });

      seedExec(run.id, STEP_A, 'Step A', 'cancelled');
      seedExec(run.id, STEP_B, 'Step B', 'cancelled');

      const rt = makeRuntime();
      await rt.recoverStalledRuns();

      expect(workflowRunRepo.getRun(run.id)!.status).toBe('blocked');
    });

    test('run with no canonical task still transitions run → blocked (defensive)', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Orphan Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      seedExec(run.id, STEP_A, 'Step A', 'idle');

      const rt = makeRuntime();
      await rt.recoverStalledRuns();

      expect(workflowRunRepo.getRun(run.id)!.status).toBe('blocked');
      expect(notifications.filter((n) => n.kind === 'workflow_run_blocked').length).toBe(1);
      expect(notifications.filter((n) => n.kind === 'task_blocked').length).toBe(0);
    });
  });

  describe('runs with completion signal are left to the tick loop', () => {
    test('all idle executions + canonical task with reportedStatus="done" → not blocked', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Completion Pending',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Completion Pending',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      taskRepo.updateTask(task.id, { reportedStatus: 'done' });

      seedExec(run.id, STEP_A, 'Step A', 'idle');

      const rt = makeRuntime();
      await rt.recoverStalledRuns();

      expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
      expect(notifications.filter((n) => n.kind === 'workflow_run_blocked').length).toBe(0);
      expect(notifications.filter((n) => n.kind === 'task_blocked').length).toBe(0);
    });

    test('canonical task already done → not blocked', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Done Task Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Done Task Run',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'done',
      });

      seedExec(run.id, STEP_A, 'Step A', 'idle');

      const rt = makeRuntime();
      await rt.recoverStalledRuns();

      expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
    });

    test('canonical task in `review` → run + task untouched, no blocked notifications (task #127)', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Review-Pending Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Review-Pending Run',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'review',
      });

      seedExec(run.id, STEP_A, 'Step A', 'idle');

      const rt = makeRuntime();
      await rt.recoverStalledRuns();

      expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
      const after = taskRepo.getTask(task.id)!;
      expect(after.status).toBe('review');
      expect(after.blockReason).toBeNull();
      expect(notifications.filter((n) => n.kind === 'workflow_run_blocked').length).toBe(0);
      expect(notifications.filter((n) => n.kind === 'task_blocked').length).toBe(0);
    });

    test('canonical task in `review` with pendingCheckpointType=task_completion → not blocked', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Submit-For-Approval Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Submit-For-Approval Run',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'review',
      });
      taskRepo.updateTask(task.id, { pendingCheckpointType: 'task_completion' });

      seedExec(run.id, STEP_A, 'Step A', 'idle');

      const rt = makeRuntime();
      await rt.recoverStalledRuns();

      expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
      const after = taskRepo.getTask(task.id)!;
      expect(after.status).toBe('review');
      expect(after.pendingCheckpointType).toBe('task_completion');
      expect(notifications.filter((n) => n.kind === 'task_blocked').length).toBe(0);
    });

    test('canonical task in `approved` → run + task untouched (post-approval may be in flight)', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Approved Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Approved Run',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'approved',
      });

      seedExec(run.id, STEP_A, 'Step A', 'idle');

      const rt = makeRuntime();
      await rt.recoverStalledRuns();

      expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
      expect(taskRepo.getTask(task.id)!.status).toBe('approved');
      expect(notifications.filter((n) => n.kind === 'workflow_run_blocked').length).toBe(0);
      expect(notifications.filter((n) => n.kind === 'task_blocked').length).toBe(0);
    });
  });

  describe('runs with driveable executions are skipped', () => {
    test('pending execution → run untouched (tick will spawn)', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Pending Exec',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      seedExec(run.id, STEP_A, 'Step A', 'pending');

      const rt = makeRuntime();
      await rt.recoverStalledRuns();

      expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
      expect(findExec(run.id, STEP_A)!.status).toBe('pending');
      expect(notifications.length).toBe(0);
    });

    test('run with deleted workflow is blocked during restart recovery', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Deleted Workflow Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Deleted Workflow Run',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      const execution = seedExec(run.id, STEP_A, 'Step A', 'in_progress', {
        agentSessionId: 'session:missing-workflow',
      });
      new SpaceWorkflowRepository(db).deleteWorkflow(workflow.id);
      const cancelledSessions: string[] = [];
      const tam = {
        rehydrate: async () => {},
        cancelBySessionId: (sessionId: string) => cancelledSessions.push(sessionId),
      };

      const rt = makeRuntime({ taskAgentManager: tam as never });
      await rt.recoverStalledRuns();

      const reason = `Workflow ${workflow.id} no longer exists; workflow run cannot continue`;
      expect(workflowRunRepo.getRun(run.id)!.status).toBe('blocked');
      expect(taskRepo.getTask(task.id)!.status).toBe('blocked');
      expect(taskRepo.getTask(task.id)!.blockReason).toBe('workflow_invalid');
      expect(nodeExecutionRepo.getById(execution.id)!.status).toBe('cancelled');
      expect(nodeExecutionRepo.getById(execution.id)!.agentSessionId).toBe(
        'session:missing-workflow'
      );
      expect(nodeExecutionRepo.getById(execution.id)!.result).toBe(reason);
      expect(cancelledSessions).toEqual(['session:missing-workflow']);
      expect(notifications.some((n) => n.kind === 'workflow_run_blocked')).toBe(true);
    });

    test('stale pending execution is cancelled when tick attempts spawn', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Stale Pending Exec',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Stale Pending Exec',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });

      const stale = seedExec(run.id, 'deleted-node', 'Step A', 'pending');
      const tam = {
        rehydrate: async () => {},
        isExecutionSpawning: () => false,
        isSessionAlive: () => false,
        tryResumeNodeAgentSession: async () => {},
        spawnWorkflowNodeAgentForExecution: async () => {
          throw new PermanentSpawnError(
            'Workflow node deleted-node no longer exists in workflow definition'
          );
        },
        flushPendingMessagesForTarget: async () => {},
        cancelBySessionId: () => {},
        interruptBySessionId: async () => {},
      };

      const rt = makeRuntime({ taskAgentManager: tam as never });
      await rt.recoverStalledRuns();
      expect(nodeExecutionRepo.getById(stale.id)!.status).toBe('pending');

      await rt.executeTick();

      const after = nodeExecutionRepo.getById(stale.id)!;
      expect(after.status).toBe('cancelled');
      expect(after.result).toContain('Workflow node deleted-node no longer exists');
      expect(workflowRunRepo.getRun(run.id)!.status).toBe('blocked');
      expect(taskRepo.getTask(task.id)!.status).toBe('blocked');
      expect(taskRepo.getTask(task.id)!.blockReason).toBe('workflow_invalid');
    });

    test('permanent spawn failure leaves a driveable sibling run active', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
        { id: STEP_B, name: 'Step B', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Partially Stale Pending Exec',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Partially Stale Pending Exec',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });

      const stale = seedExec(run.id, 'deleted-node', 'Step A', 'pending');
      const sibling = seedExec(run.id, STEP_B, 'Step B', 'pending');
      db.prepare('UPDATE node_executions SET created_at = ? WHERE id = ?').run(1, stale.id);
      db.prepare('UPDATE node_executions SET created_at = ? WHERE id = ?').run(2, sibling.id);
      const spawnAttempts: string[] = [];
      const tam = {
        rehydrate: async () => {},
        isExecutionSpawning: () => false,
        isSessionAlive: () => false,
        tryResumeNodeAgentSession: async () => {},
        spawnWorkflowNodeAgentForExecution: async (
          _task: unknown,
          _space: unknown,
          _workflow: unknown,
          _run: unknown,
          execution: { id: string }
        ) => {
          spawnAttempts.push(execution.id);
          if (execution.id === stale.id) {
            throw new PermanentSpawnError(
              'Workflow node deleted-node no longer exists in workflow definition'
            );
          }
          nodeExecutionRepo.update(execution.id, {
            status: 'in_progress',
            agentSessionId: `session:${execution.id}`,
            startedAt: Date.now(),
          });
          return `session:${execution.id}`;
        },
        flushPendingMessagesForTarget: async () => {},
        cancelBySessionId: () => {},
        interruptBySessionId: async () => {},
      };

      const rt = makeRuntime({ taskAgentManager: tam as never });
      await rt.recoverStalledRuns();
      await rt.executeTick();

      expect(spawnAttempts).toEqual([stale.id, sibling.id]);
      expect(nodeExecutionRepo.getById(stale.id)!.status).toBe('cancelled');
      expect(nodeExecutionRepo.getById(sibling.id)!.status).toBe('in_progress');
      expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
      expect(taskRepo.getTask(task.id)!.status).toBe('in_progress');
      expect(taskRepo.getTask(task.id)!.blockReason).toBeNull();
    });

    test('blocked execution → run untouched (existing blocked-recovery path owns it)', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Blocked Exec',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      seedExec(run.id, STEP_A, 'Step A', 'blocked', {
        result: 'agent crashed',
      });

      const rt = makeRuntime();
      await rt.recoverStalledRuns();

      expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
      expect(notifications.filter((n) => n.kind === 'workflow_run_blocked').length).toBe(0);
    });

    test('orphan in_progress execution with dead session → recovery does NOT touch it', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Orphan In-Progress',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      const exec = seedExec(run.id, STEP_A, 'Step A', 'in_progress', {
        agentSessionId: 'session:dead',
      });

      const tam = {
        isExecutionSpawning: () => false,
        isSessionAlive: () => false,
        spawnWorkflowNodeAgentForExecution: async () => 'session:new',
        cancelBySessionId: () => {},
        interruptBySessionId: async () => {},
        rehydrate: async () => {},
      };

      const rt = makeRuntime({ taskAgentManager: tam as never });
      await rt.recoverStalledRuns();

      const after = nodeExecutionRepo.getById(exec.id)!;
      expect(after.status).toBe('in_progress');
      expect(after.agentSessionId).toBe('session:dead');
      expect(workflowRunRepo.getRun(run.id)!.status).toBe('in_progress');
      expect(notifications.length).toBe(0);
    });
  });

  describe('idempotency', () => {
    test('calling recoverStalledRuns twice acts only once', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Idempotent',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Idempotent',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });

      seedExec(run.id, STEP_A, 'Step A', 'idle');

      const rt = makeRuntime();
      await rt.recoverStalledRuns();
      await rt.recoverStalledRuns();

      expect(notifications.filter((n) => n.kind === 'task_blocked').length).toBe(1);
      expect(notifications.filter((n) => n.kind === 'workflow_run_blocked').length).toBe(1);
    });

    test('executeTick after recoverStalledRuns does not re-emit blocked notifications', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Tick Idempotent',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Tick Idempotent',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });

      seedExec(run.id, STEP_A, 'Step A', 'idle');

      const rt = makeRuntime();
      await rt.recoverStalledRuns();
      const beforeTick = notifications.length;

      await rt.executeTick();

      const taskBlockedAfter = notifications.filter((n) => n.kind === 'task_blocked').length;
      const runBlockedAfter = notifications.filter((n) => n.kind === 'workflow_run_blocked').length;

      expect(taskBlockedAfter).toBe(1);
      expect(runBlockedAfter).toBe(1);
      expect(notifications.length).toBeGreaterThanOrEqual(beforeTick);
    });
  });

  describe('first executeTick triggers recovery', () => {
    test('stalled run is blocked on first tick even without explicit recoverStalledRuns call', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);

      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Tick Recovery',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');

      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Tick Recovery',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });

      seedExec(run.id, STEP_A, 'Step A', 'idle');

      const rt = makeRuntime();
      await rt.executeTick();

      expect(workflowRunRepo.getRun(run.id)!.status).toBe('blocked');
    });
  });

  describe('multiple stalled runs', () => {
    test('multiple stalled runs in the same space all get blocked', async () => {
      const wf1 = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-multi-1', name: 'Step 1', agentId: AGENT },
      ]);
      const wf2 = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'step-multi-2', name: 'Step 2', agentId: AGENT },
      ]);

      const run1 = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: wf1.id,
        title: 'Stalled 1',
      });
      workflowRunRepo.transitionStatus(run1.id, 'in_progress');
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Stalled 1',
        description: '',
        workflowRunId: run1.id,
        workflowNodeId: 'step-multi-1',
        status: 'in_progress',
      });
      seedExec(run1.id, 'step-multi-1', 'Step 1', 'idle');

      const run2 = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: wf2.id,
        title: 'Stalled 2',
      });
      workflowRunRepo.transitionStatus(run2.id, 'in_progress');
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Stalled 2',
        description: '',
        workflowRunId: run2.id,
        workflowNodeId: 'step-multi-2',
        status: 'in_progress',
      });
      seedExec(run2.id, 'step-multi-2', 'Step 2', 'idle');

      const rt = makeRuntime();
      await rt.recoverStalledRuns();

      expect(workflowRunRepo.getRun(run1.id)!.status).toBe('blocked');
      expect(workflowRunRepo.getRun(run2.id)!.status).toBe('blocked');
      expect(notifications.filter((n) => n.kind === 'workflow_run_blocked').length).toBe(2);
    });
  });

  describe('stale custom-agent reference on a downstream node', () => {
    const STALE_AGENT = 'agent-stale-downstream';

    function seedStaleRun(nodeAId: string, nodeBId: string, workflowId: string) {
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId,
        title: 'Stale downstream agent',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Stale downstream agent',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: nodeAId,
        status: 'in_progress',
      });
      seedExec(run.id, nodeAId, 'Coding', 'idle');
      return { run, task };
    }

    test('downstream node referencing a deleted custom agent → run blocked with actionable diagnostic', async () => {
      seedAgentRow(db, STALE_AGENT, SPACE_ID);
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
        { id: STEP_B, name: 'Review', agentId: STALE_AGENT },
      ]);
      db.prepare(`DELETE FROM space_agents WHERE id = ?`).run(STALE_AGENT);
      const { run, task } = seedStaleRun(STEP_A, STEP_B, workflow.id);

      await makeRuntime({
        pendingMessageRepo: new PendingAgentMessageRepository(db),
      }).recoverStalledRuns();

      const blockedRun = workflowRunRepo.getRun(run.id)!;
      const blockedTask = taskRepo.getTask(task.id)!;
      expect(blockedRun.status).toBe('blocked');
      expect(blockedTask.status).toBe('blocked');
      expect(blockedTask.blockReason).toBe('workflow_invalid');
      expect(blockedTask.result).toContain(run.id);
      expect(blockedTask.result).toContain('Review');
      expect(blockedTask.result).toContain(STALE_AGENT);
      expect(blockedTask.result).not.toMatch(/FOREIGN KEY/i);
      expect(findExec(run.id, STEP_B)).toBeUndefined();
      expect(notifications).toContainEqual(
        expect.objectContaining({ kind: 'workflow_run_blocked' })
      );
      expect(notifications).toContainEqual(expect.objectContaining({ kind: 'task_blocked' }));
    });

    test('a stale-agent run is blocked while an unrelated valid run in the same space still recovers', async () => {
      const GOOD_AGENT = 'agent-good-sibling';
      seedAgentRow(db, STALE_AGENT, SPACE_ID);
      seedAgentRow(db, GOOD_AGENT, SPACE_ID);

      const staleWf = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'stale-a', name: 'Coding', agentId: GOOD_AGENT },
        { id: 'stale-b', name: 'Review', agentId: STALE_AGENT },
      ]);
      db.prepare(`DELETE FROM space_agents WHERE id = ?`).run(STALE_AGENT);
      const staleCtx = seedStaleRun('stale-a', 'stale-b', staleWf.id);

      const goodWf = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: 'good-a', name: 'Plan', agentId: GOOD_AGENT },
        { id: 'good-b', name: 'Verify', agentId: GOOD_AGENT },
      ]);
      const goodRun = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: goodWf.id,
        title: 'Valid sibling run',
      });
      workflowRunRepo.transitionStatus(goodRun.id, 'in_progress');
      taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Valid sibling run',
        description: '',
        workflowRunId: goodRun.id,
        workflowNodeId: 'good-a',
        status: 'in_progress',
      });
      seedExec(goodRun.id, 'good-a', 'Plan', 'idle');

      await makeRuntime({
        pendingMessageRepo: new PendingAgentMessageRepository(db),
      }).recoverStalledRuns();

      expect(workflowRunRepo.getRun(staleCtx.run.id)?.status).toBe('blocked');
      expect(findExec(staleCtx.run.id, 'stale-b')).toBeUndefined();
      expect(workflowRunRepo.getRun(goodRun.id)?.status).toBe('in_progress');
      expect(findExec(goodRun.id, 'good-b').status).toBe('pending');
    });

    test('a stale-agent-blocked run is not retried across repeated recovery passes (no retry forever)', async () => {
      seedAgentRow(db, STALE_AGENT, SPACE_ID);
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
        { id: STEP_B, name: 'Review', agentId: STALE_AGENT },
      ]);
      db.prepare(`DELETE FROM space_agents WHERE id = ?`).run(STALE_AGENT);
      const { run } = seedStaleRun(STEP_A, STEP_B, workflow.id);

      const rt = makeRuntime({ pendingMessageRepo: new PendingAgentMessageRepository(db) });
      await rt.recoverStalledRuns();
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');

      (rt as unknown as { recoveryDone: boolean }).recoveryDone = false;
      await rt.recoverStalledRuns();

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
      expect(findExec(run.id, STEP_B)).toBeUndefined();
    });

    test('worker slot with a present custom agent alongside is still recovered when the agent exists', async () => {
      seedAgentRow(db, STALE_AGENT, SPACE_ID);
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
        { id: STEP_B, name: 'Review', agentId: STALE_AGENT },
      ]);
      const { run } = seedStaleRun(STEP_A, STEP_B, workflow.id);

      await makeRuntime({
        pendingMessageRepo: new PendingAgentMessageRepository(db),
      }).recoverStalledRuns();

      expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
      expect(findExec(run.id, STEP_B).status).toBe('pending');
      expect(findExec(run.id, STEP_B).agentId).toBe(STALE_AGENT);
    });
  });

  describe('park-during-recovery CAS (tasks #1190/#1194/#1195, stagedRun ADR 0004)', () => {
    test('task parked stopped while handleAliveStuckExecutions blocks stays stopped', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Park During Recovery Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Park During Recovery Run',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      const execution = seedExec(run.id, STEP_A, 'Step A', 'in_progress', {
        agentSessionId: 'session-stuck',
      });
      db.prepare('UPDATE node_executions SET started_at = ? WHERE id = ?').run(
        Date.now() - 20 * 60_000,
        execution.id
      );

      const liveSessions = new Set(['session-stuck']);
      const parkedStatuses: Array<string | null> = [];
      const taskStatusesAfterPark: Array<string | null> = [];
      const tam = {
        rehydrate: async () => {},
        isExecutionSpawning: () => false,
        isSessionAlive: (sessionId: string) => liveSessions.has(sessionId),
        getAgentSessionById: () => null,
        injectRuntimeRecoveryMessage: async (sessionId: string) => `runtime-nag:${sessionId}`,
        restartStuckSubSession: async () => {},
        spawnWorkflowNodeAgentForExecution: async () => 'session:respawn',
        cancelBySessionId: () => {},
        interruptBySessionId: async () => {},
        getSubSessionIdsForTasks: () => [],
        stopSessionsVerified: async (sessionIds: string[]) => {
          for (const sessionId of sessionIds) liveSessions.delete(sessionId);
          return sessionIds.map((sessionId) => ({ sessionId, stopped: true }));
        },
        cleanup: async () => {},
      };

      const rt = makeRuntime({
        taskAgentManager: tam as never,
        onWorkflowRunUpdated: async (payload) => {
          if (payload.run.status !== 'blocked') return;
          const parked = await rt.parkStoppedWorkflowTask(SPACE_ID, task.id);
          parkedStatuses.push(parked?.status ?? null);
          taskStatusesAfterPark.push(taskRepo.getTask(task.id)?.status ?? null);
        },
      });
      (rt as any).agentStuckRecovery.set(`${run.id}:${execution.id}`, {
        nagCount: 1,
        restartCount: 1,
        lastAction: 'restart',
        lastActionAt: Date.now() - 60_000,
        lastObservedMessageId: null,
        lastObservedMessageAt: null,
        lastObservedProgressMessageId: null,
        lastObservedProgressMessageAt: null,
        lastRuntimeNagMessageId: null,
        lastSessionId: 'session-stuck',
        pendingRestartNotice: null,
      });

      await expect(rt.executeTick()).resolves.toBeUndefined();

      expect(parkedStatuses).toEqual(['stopped']);
      expect(taskStatusesAfterPark).toEqual(['stopped']);

      const taskAfter = taskRepo.getTask(task.id)!;
      expect(taskAfter.status).toBe('stopped');
      expect(taskAfter.blockReason).toBeNull();
      expect(taskAfter.result ?? '').not.toContain(
        'Agent stuck without observable progress after runtime nag/restart recovery'
      );
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('blocked');
      expect(notifications.some((n) => n.kind === 'task_blocked')).toBe(false);
      expect(notifications.some((n) => n.kind === 'workflow_run_blocked')).toBe(false);
    });

    test('superseded CAS stops the tick instead of running further recovery on the blocked run', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
        { id: STEP_B, name: 'Step B', agentId: AGENT },
      ]);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Park During Recovery Sibling Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Park During Recovery Sibling Run',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      const execution = seedExec(run.id, STEP_A, 'Step A', 'in_progress', {
        agentSessionId: 'session-stuck',
      });
      const waitingExec = seedExec(run.id, STEP_B, 'Step B', 'waiting_rebind');
      db.prepare('UPDATE node_executions SET started_at = ? WHERE id = ?').run(
        Date.now() - 20 * 60_000,
        execution.id
      );

      const liveSessions = new Set(['session-stuck']);
      const tam = {
        rehydrate: async () => {},
        isExecutionSpawning: () => false,
        isSessionAlive: (sessionId: string) => liveSessions.has(sessionId),
        getAgentSessionById: () => null,
        injectRuntimeRecoveryMessage: async (sessionId: string) => `runtime-nag:${sessionId}`,
        restartStuckSubSession: async () => {},
        spawnWorkflowNodeAgentForExecution: async () => 'session:respawn',
        cancelBySessionId: () => {},
        interruptBySessionId: async () => {},
        getSubSessionIdsForTasks: () => [],
        stopSessionsVerified: async (sessionIds: string[]) => {
          for (const sessionId of sessionIds) liveSessions.delete(sessionId);
          return sessionIds.map((sessionId) => ({ sessionId, stopped: true }));
        },
        cleanup: async () => {},
      };

      const rt = makeRuntime({
        taskAgentManager: tam as never,
        onWorkflowRunUpdated: async (payload) => {
          if (payload.run.status !== 'blocked') return;
          await rt.parkStoppedWorkflowTask(SPACE_ID, task.id);
        },
      });
      (rt as any).agentStuckRecovery.set(`${run.id}:${execution.id}`, {
        nagCount: 1,
        restartCount: 1,
        lastAction: 'restart',
        lastActionAt: Date.now() - 60_000,
        lastObservedMessageId: null,
        lastObservedMessageAt: null,
        lastObservedProgressMessageId: null,
        lastObservedProgressMessageAt: null,
        lastRuntimeNagMessageId: null,
        lastSessionId: 'session-stuck',
        pendingRestartNotice: null,
      });

      await rt.executeTick();

      expect(taskRepo.getTask(task.id)?.status).toBe('stopped');
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
      expect(nodeExecutionRepo.getById(waitingExec.id)?.status).toBe('waiting_rebind');
    });

    test('stuck-agent block with no concurrent status change lands the full blocked outcome', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Step A', agentId: AGENT },
      ]);
      const run = workflowRunRepo.createRun({
        spaceId: SPACE_ID,
        workflowId: workflow.id,
        title: 'Unparked Stuck Block Run',
      });
      workflowRunRepo.transitionStatus(run.id, 'in_progress');
      const task = taskRepo.createTask({
        spaceId: SPACE_ID,
        title: 'Unparked Stuck Block Run',
        description: '',
        workflowRunId: run.id,
        workflowNodeId: STEP_A,
        status: 'in_progress',
      });
      const execution = seedExec(run.id, STEP_A, 'Step A', 'in_progress', {
        agentSessionId: 'session-stuck',
      });
      db.prepare('UPDATE node_executions SET started_at = ? WHERE id = ?').run(
        Date.now() - 20 * 60_000,
        execution.id
      );

      const liveSessions = new Set(['session-stuck']);
      const tam = {
        rehydrate: async () => {},
        isExecutionSpawning: () => false,
        isSessionAlive: (sessionId: string) => liveSessions.has(sessionId),
        getAgentSessionById: () => null,
        injectRuntimeRecoveryMessage: async (sessionId: string) => `runtime-nag:${sessionId}`,
        restartStuckSubSession: async () => {},
        spawnWorkflowNodeAgentForExecution: async () => 'session:respawn',
        cancelBySessionId: () => {},
        interruptBySessionId: async () => {},
        getSubSessionIdsForTasks: () => [],
        stopSessionsVerified: async (sessionIds: string[]) => {
          for (const sessionId of sessionIds) liveSessions.delete(sessionId);
          return sessionIds.map((sessionId) => ({ sessionId, stopped: true }));
        },
        cleanup: async () => {},
      };

      const rt = makeRuntime({ taskAgentManager: tam as never });
      (rt as any).agentStuckRecovery.set(`${run.id}:${execution.id}`, {
        nagCount: 1,
        restartCount: 1,
        lastAction: 'restart',
        lastActionAt: Date.now() - 60_000,
        lastObservedMessageId: null,
        lastObservedMessageAt: null,
        lastObservedProgressMessageId: null,
        lastObservedProgressMessageAt: null,
        lastRuntimeNagMessageId: null,
        lastSessionId: 'session-stuck',
        pendingRestartNotice: null,
      });

      await rt.executeTick();

      const taskAfter = taskRepo.getTask(task.id)!;
      expect(taskAfter.status).toBe('blocked');
      expect(taskAfter.blockReason).toBe('execution_failed');
      expect(taskAfter.result).toContain(
        'Agent stuck without observable progress after runtime nag/restart recovery'
      );
      expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
      expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('blocked');
      expect(notifications.some((n) => n.kind === 'task_blocked')).toBe(true);
      expect(notifications.some((n) => n.kind === 'workflow_run_blocked')).toBe(true);
    });
  });
});
