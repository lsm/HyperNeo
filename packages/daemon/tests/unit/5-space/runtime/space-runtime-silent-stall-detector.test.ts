import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NodeExecutionStatus, SpaceTaskStatus, SpaceWorkflow } from '@hyperneo/shared';
import { configureLogger, LogLevel, subscribeToStructuredLogs } from '../../../../src/lib/logger';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { PendingAgentMessageRepository } from '../../../../src/storage/repositories/pending-agent-message-repository.ts';
import { ToolContinuationRecoveryRepository } from '../../../../src/storage/repositories/tool-continuation-recovery-repository.ts';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

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
  nodes: Array<{ id: string; name: string; agentId: string }>
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
}

describe('SpaceRuntime — silent-stall detector for terminal-healthy idle tasks', () => {
  let db: BunDatabase;

  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let agentManager: SpaceAgentManager;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;
  let nodeExecutionRepo: NodeExecutionRepository;
  let sdkMessageRepo: SDKMessageRepository;
  let logEvents: Array<{ level: string; message: string }>;
  let unsubscribeLogs: () => void;

  const SPACE_ID = 'space-silent-stall';
  const AGENT = 'agent-silent-stall';
  const STEP_A = 'step-a';
  const STEP_B = 'step-b';

  const nudges: string[] = [];

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
      taskAgentManager: {
        rehydrate: async () => {},
        isSessionAlive: () => true,
        getAgentSessionById: () => null,
        isExecutionSpawning: () => false,
        injectRuntimeRecoveryMessage: async (_sessionId: string, message: string) => {
          nudges.push(message);
          return 'nudge-message-id';
        },
      } as any,
      silentStallAttentionThresholdMs: 60_000,
      ...overrides,
    });
  }

  function seedRun(workflow: SpaceWorkflow, title: string): { runId: string; taskId: string } {
    const run = workflowRunRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title,
    });
    workflowRunRepo.transitionStatus(run.id, 'in_progress');
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title,
      description: '',
      workflowRunId: run.id,
      workflowNodeId: STEP_A,
      status: 'in_progress',
    });
    return { runId: run.id, taskId: task.id };
  }

  function seedExec(
    runId: string,
    nodeId: string,
    agentName: string,
    status: NodeExecutionStatus,
    opts: {
      agentSessionId?: string | null;
      lastActivityAt?: number | null;
      startedAt?: number | null;
    } = {}
  ) {
    const existing = nodeExecutionRepo.listByNode(runId, nodeId)[0];
    const target =
      existing ??
      nodeExecutionRepo.createOrIgnore({
        workflowRunId: runId,
        workflowNodeId: nodeId,
        agentName,
        agentId: AGENT,
        status: 'pending',
      });
    nodeExecutionRepo.update(target.id, {
      status,
      agentSessionId: opts.agentSessionId ?? null,
      lastActivityAt: opts.lastActivityAt ?? null,
      ...(opts.startedAt !== undefined ? { startedAt: opts.startedAt } : {}),
    });
    return nodeExecutionRepo.getById(target.id)!;
  }

  function saveTerminalResultMessage(sessionId: string, at: Date = new Date()) {
    db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin, is_renderable, is_terminal)
			 VALUES (?, ?, 'result', 'success', ?, ?, 'consumed', 'sdk', 1, 1)`
    ).run(
      `${sessionId}-result-${Date.now()}-${Math.random()}`,
      sessionId,
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: sessionId,
        uuid: `${sessionId}-result-uuid-${Date.now()}-${Math.random()}`,
        result: '',
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
      at.toISOString()
    );
  }

  function saveNonTerminalAssistantMessage(sessionId: string, at: Date) {
    db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, origin, is_renderable, is_terminal)
			 VALUES (?, ?, 'assistant', ?, ?, 'consumed', 'sdk', 1, 0)`
    ).run(
      `${sessionId}-assistant-${Date.now()}-${Math.random()}`,
      sessionId,
      JSON.stringify({
        type: 'assistant',
        session_id: sessionId,
        uuid: `${sessionId}-assistant-uuid-${Date.now()}-${Math.random()}`,
        parent_tool_use_id: null,
        message: {
          id: `${sessionId}-assistant-message`,
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'thinking', thinking: 'still working' }],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
      at.toISOString()
    );
  }

  function threeHoursAgo(): Date {
    return new Date(Date.now() - 3 * 60 * 60 * 1000);
  }

  function ninetyMinutesAgo(): Date {
    return new Date(Date.now() - 90 * 60 * 1000);
  }

  async function runTick(rt: SpaceRuntime, runId: string, workflow: SpaceWorkflow): Promise<void> {
    (rt as any).executorMeta.set(runId, {
      workflow,
      spaceId: SPACE_ID,
      workspacePath: '/tmp/ws',
    });
    await (rt as any).processRunTick(runId);
  }

  function runDetector(rt: SpaceRuntime, runId: string, taskId: string): void {
    (rt as any).detectSilentStallForAttention(runId, taskRepo.getTask(taskId)!, null);
  }

  function silentStallWarnings(): Array<{ level: string; message: string }> {
    return logEvents.filter(
      (event) =>
        event.level === 'warn' &&
        event.message.includes('has every node execution idle') &&
        event.message.includes('needs attention')
    );
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
    nudges.length = 0;
    logEvents = [];
    unsubscribeLogs = subscribeToStructuredLogs((event) =>
      logEvents.push({ level: event.level, message: event.message })
    );
    configureLogger({ level: LogLevel.WARN });
  });

  afterEach(() => {
    configureLogger({ level: LogLevel.SILENT });
    unsubscribeLogs();
    try {
      db.close();
    } catch {}
  });

  describe('terminal-looking silence', () => {
    test('fires a needs-attention warning after the threshold even though the last message is a terminal result', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
      ]);
      const { runId, taskId } = seedRun(workflow, 'Silent Stall Run');
      seedExec(runId, STEP_A, 'Coding', 'idle', {
        agentSessionId: 'silent-stall-session',
        lastActivityAt: Date.now() - 3 * 60 * 60 * 1000,
      });
      saveTerminalResultMessage('silent-stall-session', threeHoursAgo());

      const rt = makeRuntime();
      await runTick(rt, runId, workflow);

      const warnings = silentStallWarnings();
      expect(warnings).toHaveLength(1);
      expect(warnings[0].message).toContain(runId);
      expect(warnings[0].message).toContain(taskId);
      expect(warnings[0].message).toContain('silent-stall-session');
      expect(nudges).toHaveLength(0);
    });

    test('stays quiet while the newest activity is within the threshold', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
      ]);
      const { runId } = seedRun(workflow, 'Recent Activity Run');
      seedExec(runId, STEP_A, 'Coding', 'idle', {
        agentSessionId: 'recent-activity-session',
        lastActivityAt: Date.now() - 30_000,
      });
      saveTerminalResultMessage('recent-activity-session');

      const rt = makeRuntime();
      await runTick(rt, runId, workflow);

      expect(silentStallWarnings()).toHaveLength(0);
    });

    test('uses the 2h default threshold when no config override is set', () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
      ]);
      const { runId, taskId } = seedRun(workflow, 'Default Threshold Run');
      seedExec(runId, STEP_A, 'Coding', 'idle', {
        agentSessionId: 'default-threshold-session',
        lastActivityAt: Date.now() - 3 * 60 * 60 * 1000,
      });
      saveTerminalResultMessage('default-threshold-session', ninetyMinutesAgo());

      const rt = makeRuntime({ silentStallAttentionThresholdMs: undefined });
      runDetector(rt, runId, taskId);
      expect(silentStallWarnings()).toHaveLength(0);

      db.prepare('DELETE FROM sdk_messages WHERE session_id = ?').run('default-threshold-session');
      saveTerminalResultMessage(
        'default-threshold-session',
        new Date(Date.now() - 150 * 60 * 1000)
      );
      runDetector(rt, runId, taskId);
      expect(silentStallWarnings()).toHaveLength(1);
    });

    test('stays quiet when the terminal message is fresh even though recorded activity is old', () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
      ]);
      const { runId, taskId } = seedRun(workflow, 'Fresh Terminal Message Run');
      seedExec(runId, STEP_A, 'Coding', 'idle', {
        agentSessionId: 'fresh-terminal-session',
        lastActivityAt: Date.now() - 3 * 60 * 60 * 1000,
      });
      saveTerminalResultMessage('fresh-terminal-session');

      const rt = makeRuntime();
      runDetector(rt, runId, taskId);
      expect(silentStallWarnings()).toHaveLength(0);
    });

    test('stays quiet when an idle session ends on a non-terminal message', () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
      ]);
      const { runId, taskId } = seedRun(workflow, 'Non Terminal Message Run');
      seedExec(runId, STEP_A, 'Coding', 'idle', {
        agentSessionId: 'non-terminal-message-session',
        lastActivityAt: Date.now() - 3 * 60 * 60 * 1000,
      });
      saveNonTerminalAssistantMessage('non-terminal-message-session', threeHoursAgo());

      const rt = makeRuntime();
      runDetector(rt, runId, taskId);
      expect(silentStallWarnings()).toHaveLength(0);
    });

    test('fires from startedAt when a sessionless idle execution has been idle past the threshold', () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
      ]);
      const { runId, taskId } = seedRun(workflow, 'Sessionless Old StartedAt Run');
      seedExec(runId, STEP_A, 'Coding', 'idle', {
        agentSessionId: null,
        lastActivityAt: null,
        startedAt: Date.now() - 3 * 60 * 60 * 1000,
      });

      const rt = makeRuntime();
      runDetector(rt, runId, taskId);
      expect(silentStallWarnings()).toHaveLength(1);
    });

    test('stays quiet when a sessionless idle execution started recently', () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
      ]);
      const { runId, taskId } = seedRun(workflow, 'Sessionless Recent StartedAt Run');
      seedExec(runId, STEP_A, 'Coding', 'idle', {
        agentSessionId: null,
        lastActivityAt: null,
        startedAt: Date.now() - 30_000,
      });

      const rt = makeRuntime();
      runDetector(rt, runId, taskId);
      expect(silentStallWarnings()).toHaveLength(0);
    });

    test('stays quiet when a sessionless idle execution has no startedAt and no other signals', () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
      ]);
      const { runId, taskId } = seedRun(workflow, 'Sessionless No StartedAt Run');
      seedExec(runId, STEP_A, 'Coding', 'idle', {
        agentSessionId: null,
        lastActivityAt: null,
        startedAt: null,
      });

      const rt = makeRuntime();
      runDetector(rt, runId, taskId);
      expect(silentStallWarnings()).toHaveLength(0);
    });
  });

  describe('rate limiting', () => {
    test('emits at most one warning per cooldown window', async () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
      ]);
      const { runId } = seedRun(workflow, 'Cooldown Run');
      seedExec(runId, STEP_A, 'Coding', 'idle', {
        agentSessionId: 'cooldown-session',
        lastActivityAt: Date.now() - 3 * 60 * 60 * 1000,
      });
      saveTerminalResultMessage('cooldown-session', threeHoursAgo());

      const rt = makeRuntime();
      await runTick(rt, runId, workflow);
      expect(silentStallWarnings()).toHaveLength(1);

      await runTick(rt, runId, workflow);
      expect(silentStallWarnings()).toHaveLength(1);

      (rt as any).silentStallAttentionLogAt.set(runId, Date.now() - 6 * 60 * 1000);
      await runTick(rt, runId, workflow);
      expect(silentStallWarnings()).toHaveLength(2);
    });
  });

  describe('gating', () => {
    test.each([
      'review',
      'approved',
      'done',
      'blocked',
      'cancelled',
      'archived',
      'rate_limited',
      'usage_limited',
      'stopped',
    ] as SpaceTaskStatus[])('stays quiet for %s tasks', (status: SpaceTaskStatus) => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
      ]);
      const { runId, taskId } = seedRun(workflow, `Gate ${status} Run`);
      seedExec(runId, STEP_A, 'Coding', 'idle', {
        agentSessionId: `gate-${status}-session`,
        lastActivityAt: Date.now() - 3 * 60 * 60 * 1000,
      });
      saveTerminalResultMessage(`gate-${status}-session`, threeHoursAgo());
      taskRepo.updateTask(taskId, { status });

      const rt = makeRuntime();
      runDetector(rt, runId, taskId);
      expect(silentStallWarnings()).toHaveLength(0);
    });

    test('stays quiet when the task has a reportedStatus', () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
      ]);
      const { runId, taskId } = seedRun(workflow, 'Reported Status Run');
      seedExec(runId, STEP_A, 'Coding', 'idle', {
        agentSessionId: 'reported-status-session',
        lastActivityAt: Date.now() - 3 * 60 * 60 * 1000,
      });
      saveTerminalResultMessage('reported-status-session', threeHoursAgo());
      taskRepo.updateTask(taskId, { reportedStatus: 'done' } as any);

      const rt = makeRuntime();
      runDetector(rt, runId, taskId);
      expect(silentStallWarnings()).toHaveLength(0);
    });

    test('stays quiet when any execution is not idle', () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
        { id: STEP_B, name: 'Review', agentId: AGENT },
      ]);
      const { runId, taskId } = seedRun(workflow, 'Mixed Status Run');
      seedExec(runId, STEP_A, 'Coding', 'idle', {
        agentSessionId: 'mixed-status-session',
        lastActivityAt: Date.now() - 3 * 60 * 60 * 1000,
      });
      saveTerminalResultMessage('mixed-status-session', threeHoursAgo());
      seedExec(runId, STEP_B, 'Review', 'in_progress', {
        agentSessionId: 'active-review-session',
        lastActivityAt: Date.now() - 3 * 60 * 60 * 1000,
      });

      const rt = makeRuntime();
      runDetector(rt, runId, taskId);
      expect(silentStallWarnings()).toHaveLength(0);
    });

    test('stays quiet while a queued node-agent handoff is pending for the run', () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
        { id: STEP_B, name: 'Review', agentId: AGENT },
      ]);
      const { runId, taskId } = seedRun(workflow, 'Queued Handoff Run');
      seedExec(runId, STEP_A, 'Coding', 'idle', {
        agentSessionId: 'queued-handoff-session',
        lastActivityAt: Date.now() - 3 * 60 * 60 * 1000,
      });
      saveTerminalResultMessage('queued-handoff-session', threeHoursAgo());
      const pendingRepo = new PendingAgentMessageRepository(db);
      pendingRepo.enqueue({
        workflowRunId: runId,
        spaceId: SPACE_ID,
        taskId,
        sourceAgentName: 'Coding',
        targetKind: 'node_agent',
        targetAgentName: 'Review',
        message: 'review request',
      });

      const rt = makeRuntime({ pendingMessageRepo: pendingRepo });
      runDetector(rt, runId, taskId);
      expect(silentStallWarnings()).toHaveLength(0);
    });

    test('stays quiet when an execution has an active tool use', () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
      ]);
      const { runId, taskId } = seedRun(workflow, 'Active Tool Use Run');
      const execution = seedExec(runId, STEP_A, 'Coding', 'idle', {
        agentSessionId: 'active-tool-use-session',
        lastActivityAt: Date.now() - 3 * 60 * 60 * 1000,
      });
      saveTerminalResultMessage('active-tool-use-session', threeHoursAgo());
      const recoveryRepo = new ToolContinuationRecoveryRepository(db);
      recoveryRepo.ensureSchema();
      recoveryRepo.recordToolUse({
        toolUseId: 'tool-silent-stall-active',
        sessionId: 'active-tool-use-session',
        ttlMs: 60 * 60 * 1000,
        owner: { executionId: execution.id, workflowRunId: runId },
      });

      const rt = makeRuntime();
      runDetector(rt, runId, taskId);
      expect(silentStallWarnings()).toHaveLength(0);
    });

    test('stays quiet when an execution has a pending tool-continuation inbox entry', () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
      ]);
      const { runId, taskId } = seedRun(workflow, 'Pending Inbox Run');
      const execution = seedExec(runId, STEP_A, 'Coding', 'idle', {
        agentSessionId: 'pending-inbox-session',
        lastActivityAt: Date.now() - 3 * 60 * 60 * 1000,
      });
      saveTerminalResultMessage('pending-inbox-session', threeHoursAgo());
      const recoveryRepo = new ToolContinuationRecoveryRepository(db);
      recoveryRepo.ensureSchema();
      const now = Date.now();
      db.prepare(
        `INSERT INTO tool_continuation_inbox
				 (id, tool_use_id, session_id, execution_id, workflow_run_id, status, request_json, recovery_reason, created_at, updated_at, expires_at)
			 VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
      ).run(
        'inbox-silent-stall-pending',
        'tool-silent-stall-inbox',
        'pending-inbox-session',
        execution.id,
        runId,
        JSON.stringify({ messages: [{ role: 'user', content: [] }] }),
        'continuation waiting to be redelivered',
        now,
        now,
        now + 60 * 60 * 1000
      );
      expect(recoveryRepo.listPendingInboxForExecution(execution.id)).toHaveLength(1);

      const rt = makeRuntime();
      runDetector(rt, runId, taskId);
      expect(silentStallWarnings()).toHaveLength(0);
    });

    test('stays quiet for paused and stopped spaces', () => {
      const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
        { id: STEP_A, name: 'Coding', agentId: AGENT },
      ]);
      const { runId, taskId } = seedRun(workflow, 'Paused Space Run');
      seedExec(runId, STEP_A, 'Coding', 'idle', {
        agentSessionId: 'paused-space-session',
        lastActivityAt: Date.now() - 3 * 60 * 60 * 1000,
      });
      saveTerminalResultMessage('paused-space-session', threeHoursAgo());

      const rt = makeRuntime();
      (rt as any).detectSilentStallForAttention(runId, taskRepo.getTask(taskId)!, {
        paused: true,
        stopped: false,
      });
      (rt as any).detectSilentStallForAttention(runId, taskRepo.getTask(taskId)!, {
        paused: false,
        stopped: true,
      });
      expect(silentStallWarnings()).toHaveLength(0);
    });
  });
});
