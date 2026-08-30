import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { ToolContinuationRecoveryRepository } from '../../../../src/storage/repositories/tool-continuation-recovery-repository';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';

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

function seedSpaceRow(db: BunDatabase, spaceId: string, workspacePath = '/tmp/ws'): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, max_concurrent_tasks, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', ?, 'active', 1, ?, ?)`
  ).run(spaceId, workspacePath, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
}

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string, name: string): void {
  db.prepare(
    `INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', ?, ?)`
  ).run(agentId, spaceId, name, Date.now(), Date.now());
}

describe('SpaceRuntime — terminal-error idle recovery (#673)', () => {
  let db: BunDatabase;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let agentManager: SpaceAgentManager;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;
  let nodeExecutionRepo: NodeExecutionRepository;
  let sdkMessageRepo: SDKMessageRepository;
  let bus: InternalEventBus<DaemonInternalEventMap>;
  let notifications: Array<{ kind: string; payload: Record<string, unknown> }>;

  const SPACE_EVENT_MAP: Record<string, string> = {
    'space.task.blocked': 'task_blocked',
    'space.workflowRun.blocked': 'workflow_run_blocked',
    'space.workflowRun.retry': 'task_retry',
    'space.workflowRun.needsAttention': 'workflow_run_needs_attention',
  };

  const SPACE_ID = 'space-terminal-err';
  const AGENT = 'agent-coder';
  const STEP_A = 'step-a';

  const SESSION = 'session:terminal-err';

  function buildConfig(
    tam: unknown,
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
      internalEventBus: bus,
      taskAgentManager: tam as never,
      agentStuckNagGraceMs: 0,
      ...overrides,
    };
  }

  function makeTam(
    overrides: {
      isSessionAlive?: (sessionId: string) => boolean;
      isSessionInMemory?: (sessionId: string) => boolean;
      injectRuntimeRecoveryMessage?: (sessionId: string, message: string) => Promise<string>;
    } = {}
  ) {
    const injected: Array<{ sessionId: string; message: string }> = [];
    const cancelled: string[] = [];
    const spawnSnapshots: Array<{ agentSessionIdAtSpawn: string | null }> = [];
    return {
      isSessionAlive: overrides.isSessionAlive ?? (() => true),
      isSessionInMemory: overrides.isSessionInMemory ?? overrides.isSessionAlive ?? (() => true),
      isExecutionSpawning: () => false,
      isSpawning: () => false,
      isTaskAgentAlive: () => true,
      rehydrate: async () => {},
      cancelBySessionId: (sessionId: string) => {
        cancelled.push(sessionId);
      },
      interruptBySessionId: async () => {},
      restartStuckSubSession: async () => {},
      getAgentSessionById: () => null,
      spawnWorkflowNodeAgent: async () => SESSION,
      spawnWorkflowNodeAgentForExecution: async (
        _task: unknown,
        _space: unknown,
        _workflow: unknown,
        _run: unknown,
        execution: unknown
      ) => {
        const exec = execution as { id?: string };
        if (exec.id) {
          const current = nodeExecutionRepo.getById(exec.id);
          spawnSnapshots.push({ agentSessionIdAtSpawn: current?.agentSessionId ?? null });
          nodeExecutionRepo.update(exec.id, {
            status: 'in_progress',
            agentSessionId: SESSION,
            startedAt: Date.now(),
            completedAt: null,
          });
        }
        return SESSION;
      },
      injectRuntimeRecoveryMessage: async (sessionId: string, message: string) => {
        injected.push({ sessionId, message });
        if (overrides.injectRuntimeRecoveryMessage) {
          return overrides.injectRuntimeRecoveryMessage(sessionId, message);
        }
        return `continue-msg:${injected.length}`;
      },
      injectIntoTaskAgent: async () => ({ injected: false, reason: 'no-session' }),
      _injected: injected,
      _cancelled: cancelled,
      _spawnSnapshots: spawnSnapshots,
    };
  }

  function saveResultError(
    sessionId: string,
    opts: {
      subtype: string;
      errors?: string[];
      terminalReason?: string;
      minutesAgo?: number;
      resultText?: string;
      apiErrorStatus?: number;
      recoveryIntercepted?: boolean;
    }
  ): void {
    const id = `${sessionId}-result-${Math.random().toString(36).slice(2)}`;
    const message: Record<string, unknown> = {
      type: 'result',
      subtype: opts.subtype,
      is_error: true,
      num_turns: 1,
      total_cost_usd: 0,
      duration_ms: 1000,
      duration_api_ms: 1000,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {},
      permission_denials: [],
      errors: opts.errors ?? [],
      session_id: sessionId,
      uuid: id,
    };
    if (opts.terminalReason) message.terminal_reason = opts.terminalReason;
    if (opts.subtype === 'success') {
      message.result = opts.resultText ?? '';
      if (typeof opts.apiErrorStatus === 'number') message.api_error_status = opts.apiErrorStatus;
    }
    if (opts.recoveryIntercepted) message.recovery_intercepted = 1;
    const ts = new Date(Date.now() - (opts.minutesAgo ?? 0) * 60_000).toISOString();
    db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin, is_renderable, is_terminal)
       VALUES (?, ?, 'result', ?, ?, ?, 'consumed', 'sdk', 1, 1)`
    ).run(id, sessionId, opts.subtype, JSON.stringify(message), ts);
  }

  function seedIdleErrorRun(opts: {
    subtype: string;
    errors?: string[];
    terminalReason?: string;
    taskStatus?: string;
    sessionAlive?: boolean;
    sessionId?: string;
    resultText?: string;
    apiErrorStatus?: number;
    recoveryIntercepted?: boolean;
  }): { runId: string; taskId: string; executionId: string } {
    const workflow = workflowManager.createWorkflow({
      spaceId: SPACE_ID,
      name: `Terminal-error workflow ${Date.now()}-${Math.random()}`,
      description: 'Test',
      nodes: [{ id: STEP_A, name: 'Code', agentId: AGENT }],
      transitions: [],
      startNodeId: STEP_A,
      endNodeId: STEP_A,
      rules: [],
      tags: [],
      completionAutonomyLevel: 3,
    });
    const run = workflowRunRepo.createRun({
      spaceId: SPACE_ID,
      workflowId: workflow.id,
      title: 'Terminal-error run',
    });
    workflowRunRepo.transitionStatus(run.id, 'in_progress');
    const task = taskRepo.createTask({
      spaceId: SPACE_ID,
      title: 'Terminal-error task',
      description: '',
      workflowRunId: run.id,
      workflowNodeId: STEP_A,
      status: opts.taskStatus ?? 'in_progress',
    });
    const execution = nodeExecutionRepo.createOrIgnore({
      workflowRunId: run.id,
      workflowNodeId: STEP_A,
      agentName: 'Coder',
      agentId: AGENT,
      status: 'pending',
    });
    const sessionId = opts.sessionId ?? SESSION;
    nodeExecutionRepo.update(execution.id, {
      status: 'idle',
      agentSessionId: sessionId,
      startedAt: Date.now() - 5 * 60_000,
    });
    saveResultError(sessionId, {
      subtype: opts.subtype,
      errors: opts.errors,
      terminalReason: opts.terminalReason,
      resultText: opts.resultText,
      apiErrorStatus: opts.apiErrorStatus,
      recoveryIntercepted: opts.recoveryIntercepted,
    });
    return { runId: run.id, taskId: task.id, executionId: execution.id };
  }

  function resumeToIdle(
    executionId: string,
    opts: {
      subtype: string;
      errors?: string[];
      terminalReason?: string;
      resultText?: string;
      apiErrorStatus?: number;
      recoveryIntercepted?: boolean;
    }
  ): void {
    const execution = nodeExecutionRepo.getById(executionId);
    const sessionId = execution?.agentSessionId ?? SESSION;
    db.prepare(`DELETE FROM sdk_messages WHERE session_id = ?`).run(sessionId);
    saveResultError(sessionId, opts);
    nodeExecutionRepo.update(executionId, {
      status: 'idle',
      startedAt: Date.now() - 60_000,
    });
  }

  beforeEach(() => {
    db = makeDb();
    seedSpaceRow(db, SPACE_ID);
    seedAgentRow(db, AGENT, SPACE_ID, 'Coder');

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
    for (const [eventName, kind] of Object.entries(SPACE_EVENT_MAP)) {
      bus.subscribe(
        eventName as keyof DaemonInternalEventMap,
        (payload) => {
          notifications.push({ kind, payload: payload as Record<string, unknown> });
        },
        { subscriberName: `test-terminal-err:${eventName}` }
      );
    }
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
  });

  test('error_during_execution on a live idle session injects one continue', async () => {
    const { runId, taskId, executionId } = seedIdleErrorRun({
      subtype: 'error_during_execution',
      errors: ['API Error: 400 {"type":"error","message":"Invalid request"}'],
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(tam._injected).toHaveLength(1);
    expect(tam._injected[0].sessionId).toBe(SESSION);
    expect(tam._injected[0].message).toContain('[Runtime recovery — terminal error]');
    expect(tam._injected[0].message).toContain('error_during_execution');
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');
    expect(workflowRunRepo.getRun(runId)?.status).toBe('in_progress');
    expect(taskRepo.getTask(taskId)?.status).toBe('in_progress');
  });

  test('error_max_turns is retryable', async () => {
    seedIdleErrorRun({ subtype: 'error_max_turns' });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(tam._injected).toHaveLength(1);
  });

  test('api-error success result (is_error + terminal_reason api_error) injects one continue', async () => {
    const { runId, taskId, executionId } = seedIdleErrorRun({
      subtype: 'success',
      terminalReason: 'api_error',
      resultText: 'API Error: Connection refused (ConnectionRefused)',
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(tam._injected).toHaveLength(1);
    expect(tam._injected[0].sessionId).toBe(SESSION);
    expect(tam._injected[0].message).toContain('[Runtime recovery — terminal error]');
    expect(tam._injected[0].message).toContain('Connection refused');
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');
    expect(workflowRunRepo.getRun(runId)?.status).toBe('in_progress');
    expect(taskRepo.getTask(taskId)?.status).toBe('in_progress');
  });

  test('flagged 429 api-error result is carved out (limit machinery owns it)', async () => {
    const { runId, taskId, executionId } = seedIdleErrorRun({
      subtype: 'success',
      terminalReason: 'api_error',
      resultText: 'API Error: Too many requests',
      apiErrorStatus: 429,
      recoveryIntercepted: true,
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(tam._injected).toHaveLength(0);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');
    expect(workflowRunRepo.getRun(runId)?.status).toBe('in_progress');
    expect(taskRepo.getTask(taskId)?.status).toBe('in_progress');
    expect(notifications).not.toContainEqual(expect.objectContaining({ kind: 'task_blocked' }));
  });

  test('flagged usage-limit-text api-error result is carved out (limit machinery owns it)', async () => {
    const { executionId } = seedIdleErrorRun({
      subtype: 'success',
      terminalReason: 'api_error',
      resultText: 'API Error: usage limit reached, upgrades available',
      recoveryIntercepted: true,
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(tam._injected).toHaveLength(0);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');
  });

  test('unflagged status-only 429 result falls through to runtime continue (limit pipeline declined it)', async () => {
    const { executionId } = seedIdleErrorRun({
      subtype: 'success',
      apiErrorStatus: 429,
      resultText: 'API Error: Too many requests',
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(tam._injected).toHaveLength(1);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');
  });

  test('recovery_intercepted flag carves out a generic-text api-error result (limit pipeline owns it)', async () => {
    const { runId, taskId, executionId } = seedIdleErrorRun({
      subtype: 'success',
      terminalReason: 'api_error',
      resultText: 'API Error: 500 Internal Server Error',
      recoveryIntercepted: true,
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(tam._injected).toHaveLength(0);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');
    expect(workflowRunRepo.getRun(runId)?.status).toBe('in_progress');
    expect(taskRepo.getTask(taskId)?.status).toBe('in_progress');
    expect(notifications).not.toContainEqual(expect.objectContaining({ kind: 'task_blocked' }));
  });

  test('generic-text api-error result without the interception flag is still admitted', async () => {
    const { executionId } = seedIdleErrorRun({
      subtype: 'success',
      terminalReason: 'api_error',
      resultText: 'API Error: 500 Internal Server Error',
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(tam._injected).toHaveLength(1);
    expect(tam._injected[0].message).toContain('500 Internal Server Error');
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');
  });

  test('error_max_budget_usd (cost guard) is never continued or blocked', async () => {
    const { runId, taskId, executionId } = seedIdleErrorRun({
      subtype: 'error_max_budget_usd',
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(tam._injected).toHaveLength(0);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');
    expect(workflowRunRepo.getRun(runId)?.status).toBe('in_progress');
    expect(taskRepo.getTask(taskId)?.status).toBe('in_progress');
    expect(notifications).not.toContainEqual(expect.objectContaining({ kind: 'task_blocked' }));
  });

  test('prompt-too-long result is not continued via the terminal-error sweep (deferred to #670)', async () => {
    seedIdleErrorRun({
      subtype: 'error_during_execution',
      errors: ['prompt is too long: 205616 tokens > 200000 maximum'],
      terminalReason: 'prompt_too_long',
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(
      tam._injected.filter((m) => m.message.includes('[Runtime recovery — terminal error]'))
    ).toHaveLength(0);
  });

  test('prompt-too-long detected via errors[] only (no terminal_reason) is also skipped', async () => {
    seedIdleErrorRun({
      subtype: 'error_during_execution',
      errors: ['Error: prompt is too long'],
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(
      tam._injected.filter((m) => m.message.includes('[Runtime recovery — terminal error]'))
    ).toHaveLength(0);
  });

  test('prompt-too-long text on an api-error success result is skipped (deferred to the ptl path)', async () => {
    seedIdleErrorRun({
      subtype: 'success',
      terminalReason: 'api_error',
      resultText: 'API Error: prompt is too long: 205616 tokens > 200000 maximum',
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(
      tam._injected.filter((m) => m.message.includes('[Runtime recovery — terminal error]'))
    ).toHaveLength(0);
  });

  test('dead terminal-error session is reset for a FRESH re-spawn (stale session cleared)', async () => {
    const { executionId } = seedIdleErrorRun({
      subtype: 'error_during_execution',
      sessionAlive: false,
    });
    const tam = makeTam({ isSessionAlive: () => false });
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(tam._injected).toHaveLength(0);
    expect(tam._spawnSnapshots.length).toBeGreaterThanOrEqual(1);
    expect(tam._spawnSnapshots[0].agentSessionIdAtSpawn).toBeNull();
    const updated = nodeExecutionRepo.getById(executionId)!;
    expect(updated.status).toBe('in_progress');
  });

  test('active tool continuation is preserved (no continue injected)', async () => {
    const { runId, executionId } = seedIdleErrorRun({
      subtype: 'error_during_execution',
    });
    const toolRepo = new ToolContinuationRecoveryRepository(db);
    toolRepo.ensureSchema();
    toolRepo.recordToolUse({
      toolUseId: 'tool-pending-1',
      sessionId: SESSION,
      ttlMs: 60_000,
      owner: { executionId, workflowRunId: runId },
    });
    expect(toolRepo.hasActiveToolUseForExecution(executionId)).toBe(true);

    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(tam._injected).toHaveLength(0);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');
  });

  test('error_max_turns consumes the full continue cap (not short-circuited by the repeat guard)', async () => {
    const { executionId } = seedIdleErrorRun({ subtype: 'error_max_turns' });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);

    resumeToIdle(executionId, { subtype: 'error_max_turns' });

    await rt.executeTick();
    expect(tam._injected).toHaveLength(2);

    resumeToIdle(executionId, { subtype: 'error_max_turns' });
    await rt.executeTick();
    expect(tam._injected).toHaveLength(2);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('blocked');
  });

  test('dead NON-retryable terminal-error session is skipped, not wastefully re-spawned', async () => {
    const { executionId } = seedIdleErrorRun({
      subtype: 'error_max_budget_usd',
      sessionAlive: false,
    });
    const tam = makeTam({ isSessionAlive: () => false });
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(tam._injected).toHaveLength(0);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');
  });

  test('a shared session across idle rows injects only one continue per tick', async () => {
    const { runId } = seedIdleErrorRun({
      subtype: 'error_during_execution',
      errors: ['shared-session error'],
      sessionId: 'session:shared',
    });
    const second = nodeExecutionRepo.createOrIgnore({
      workflowRunId: runId,
      workflowNodeId: 'step-b',
      agentName: 'Coder',
      agentId: AGENT,
      status: 'pending',
    });
    nodeExecutionRepo.update(second.id, {
      status: 'idle',
      agentSessionId: 'session:shared',
      startedAt: Date.now() - 5 * 60_000,
    });
    expect(
      nodeExecutionRepo
        .listByWorkflowRun(runId)
        .filter((e) => e.status === 'idle' && e.agentSessionId === 'session:shared')
    ).toHaveLength(2);

    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(tam._injected).toHaveLength(1);
    expect(tam._injected[0].sessionId).toBe('session:shared');
  });

  test('a shared session recovers via the NEWEST execution (not a stale node)', async () => {
    const { runId, executionId: oldestId } = seedIdleErrorRun({
      subtype: 'error_during_execution',
      errors: ['shared-session error'],
      sessionId: 'session:shared',
    });
    const newest = nodeExecutionRepo.createOrIgnore({
      workflowRunId: runId,
      workflowNodeId: 'step-b',
      agentName: 'Coder',
      agentId: AGENT,
      status: 'pending',
    });
    nodeExecutionRepo.update(newest.id, {
      status: 'idle',
      agentSessionId: 'session:shared',
      startedAt: Date.now() - 5 * 60_000,
    });
    db.prepare('UPDATE node_executions SET created_at = ? WHERE id = ?').run(
      Date.now() + 60_000,
      newest.id
    );

    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);

    resumeToIdle(newest.id, {
      subtype: 'error_during_execution',
      errors: ['shared-session error'],
    });
    await rt.executeTick();

    expect(tam._injected).toHaveLength(1);
    expect(nodeExecutionRepo.getById(newest.id)?.status).toBe('blocked');
    expect(nodeExecutionRepo.getById(newest.id)?.agentSessionId).toBeNull();
    expect(nodeExecutionRepo.getById(oldestId)?.agentSessionId).toBeNull();
    expect(nodeExecutionRepo.getById(oldestId)?.status).toBe('idle');
  });

  test('task not in_progress is left alone', async () => {
    seedIdleErrorRun({ subtype: 'error_during_execution', taskStatus: 'done' });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(tam._injected).toHaveLength(0);
  });

  test('a session already active (in_progress) on another execution is not recovered via the stale idle row', async () => {
    const { runId, executionId: idleId } = seedIdleErrorRun({
      subtype: 'error_during_execution',
      errors: ['stale-row error'],
      sessionId: 'session:reused',
    });
    const newer = nodeExecutionRepo.createOrIgnore({
      workflowRunId: runId,
      workflowNodeId: 'step-b',
      agentName: 'Coder',
      agentId: AGENT,
      status: 'pending',
    });
    nodeExecutionRepo.update(newer.id, {
      status: 'in_progress',
      agentSessionId: 'session:reused',
      startedAt: Date.now(),
    });
    db.prepare('UPDATE node_executions SET created_at = ? WHERE id = ?').run(
      Date.now() + 60_000,
      newer.id
    );

    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(tam._injected).toHaveLength(0);
    expect(nodeExecutionRepo.getById(idleId)?.status).toBe('idle');
  });

  test('retries up to the cap then escalates to blocked (clearing the stale session)', async () => {
    const { runId, taskId, executionId } = seedIdleErrorRun({
      subtype: 'error_during_execution',
      errors: ['transient hiccup A'],
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);

    resumeToIdle(executionId, {
      subtype: 'error_during_execution',
      errors: ['transient hiccup B'],
    });

    await rt.executeTick();
    expect(tam._injected).toHaveLength(2);

    resumeToIdle(executionId, {
      subtype: 'error_during_execution',
      errors: ['transient hiccup C'],
    });

    await rt.executeTick();

    const execution = nodeExecutionRepo.getById(executionId)!;
    expect(execution.status).toBe('blocked');
    expect(execution.agentSessionId).toBeNull();
    expect(tam._cancelled).toContain(SESSION);
    expect(workflowRunRepo.getRun(runId)?.status).toBe('blocked');
    expect(taskRepo.getTask(taskId)?.status).toBe('blocked');
    expect(taskRepo.getTask(taskId)?.blockReason).toBe('execution_failed');
    expect(notifications).toContainEqual(expect.objectContaining({ kind: 'task_blocked' }));
    expect(notifications).toContainEqual(expect.objectContaining({ kind: 'workflow_run_blocked' }));
  });

  test('deterministic repeat (identical signature) escalates to blocked', async () => {
    const { runId, taskId, executionId } = seedIdleErrorRun({
      subtype: 'error_during_execution',
      errors: ['Codex 400 invalid_request_error'],
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);

    resumeToIdle(executionId, {
      subtype: 'error_during_execution',
      errors: ['Codex 400 invalid_request_error'],
    });

    await rt.executeTick();

    expect(tam._injected).toHaveLength(1);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('blocked');
    expect(nodeExecutionRepo.getById(executionId)?.agentSessionId).toBeNull();
    expect(workflowRunRepo.getRun(runId)?.status).toBe('blocked');
    expect(taskRepo.getTask(taskId)?.status).toBe('blocked');
  });

  test('an accepted-but-unconsumed continue prompt does not escalate after the grace period', async () => {
    const { runId, taskId, executionId } = seedIdleErrorRun({
      subtype: 'error_during_execution',
      errors: ['Codex 400 invalid_request_error'],
    });
    const promptDbId = 'continue-prompt-parked';
    const seedPromptRow = (status: 'enqueued' | 'failed') =>
      db
        .prepare(
          `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, origin, is_renderable, is_terminal)
           VALUES (?, ?, 'user', ?, ?, ?, 'system', 1, 0)`
        )
        .run(
          promptDbId,
          SESSION,
          JSON.stringify({ type: 'user' }),
          new Date().toISOString(),
          status
        );
    seedPromptRow('enqueued');
    const tam = makeTam({
      injectRuntimeRecoveryMessage: async () => promptDbId,
    });
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);

    resumeToIdle(executionId, {
      subtype: 'error_during_execution',
      errors: ['Codex 400 invalid_request_error'],
    });
    seedPromptRow('enqueued');

    await rt.executeTick();

    expect(tam._injected).toHaveLength(1);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');
    expect(workflowRunRepo.getRun(runId)?.status).toBe('in_progress');
    expect(taskRepo.getTask(taskId)?.status).toBe('in_progress');
  });

  test('a dead-lettered continue prompt escalates to blocked at the failure cap', async () => {
    const { runId, taskId, executionId } = seedIdleErrorRun({
      subtype: 'error_during_execution',
      errors: ['Codex 400 invalid_request_error'],
    });
    const promptDbId = 'continue-prompt-dead';
    const seedPromptRow = () =>
      db
        .prepare(
          `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, origin, is_renderable, is_terminal)
           VALUES (?, ?, 'user', ?, ?, 'failed', 'system', 1, 0)`
        )
        .run(
          promptDbId,
          SESSION,
          JSON.stringify({ type: 'user' }),
          new Date(Date.now() - 60_000).toISOString()
        );
    seedPromptRow();
    const tam = makeTam({
      injectRuntimeRecoveryMessage: async () => promptDbId,
    });
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);

    resumeToIdle(executionId, {
      subtype: 'error_during_execution',
      errors: ['Codex 400 invalid_request_error'],
    });
    seedPromptRow();

    await rt.executeTick();
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');

    await rt.executeTick();

    expect(tam._injected).toHaveLength(1);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('blocked');
    expect(workflowRunRepo.getRun(runId)?.status).toBe('blocked');
    expect(taskRepo.getTask(taskId)?.status).toBe('blocked');
    expect(taskRepo.getTask(taskId)?.result).toContain('dead-lettered');
  });

  test('identical api-error signature recurrence escalates to blocked', async () => {
    const { runId, taskId, executionId } = seedIdleErrorRun({
      subtype: 'success',
      terminalReason: 'api_error',
      resultText: 'API Error: Connection refused (ConnectionRefused)',
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);

    resumeToIdle(executionId, {
      subtype: 'success',
      terminalReason: 'api_error',
      resultText: 'API Error: Connection refused (ConnectionRefused)',
    });

    await rt.executeTick();

    expect(tam._injected).toHaveLength(1);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('blocked');
    expect(nodeExecutionRepo.getById(executionId)?.agentSessionId).toBeNull();
    expect(tam._cancelled).toContain(SESSION);
    expect(workflowRunRepo.getRun(runId)?.status).toBe('blocked');
    expect(taskRepo.getTask(taskId)?.status).toBe('blocked');
    expect(taskRepo.getTask(taskId)?.result).toContain('Connection refused');
    expect(notifications).toContainEqual(expect.objectContaining({ kind: 'task_blocked' }));
    expect(notifications).toContainEqual(expect.objectContaining({ kind: 'workflow_run_blocked' }));
  });

  test('declined blocking-limit result falls through to runtime continue (limit pipeline did not claim it)', async () => {
    const { executionId } = seedIdleErrorRun({
      subtype: 'success',
      terminalReason: 'blocking_limit',
      resultText: 'API Error: usage limit reached',
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(tam._injected).toHaveLength(1);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');
  });

  test('declined rapid-refill-breaker result falls through to runtime continue (limit pipeline did not claim it)', async () => {
    const { executionId } = seedIdleErrorRun({
      subtype: 'success',
      terminalReason: 'rapid_refill_breaker',
      resultText: 'API Error: rapid refill breaker open',
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(tam._injected).toHaveLength(1);
    expect(tam._injected[0].message).toContain('rapid refill breaker');
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');
  });

  test('status-only results with different HTTP statuses are distinct signatures', async () => {
    const { executionId } = seedIdleErrorRun({
      subtype: 'success',
      apiErrorStatus: 502,
      resultText: '',
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);

    resumeToIdle(executionId, {
      subtype: 'success',
      apiErrorStatus: 503,
      resultText: '',
    });
    await rt.executeTick();
    expect(tam._injected).toHaveLength(2);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');

    resumeToIdle(executionId, {
      subtype: 'success',
      apiErrorStatus: 504,
      resultText: '',
    });
    await rt.executeTick();

    expect(tam._injected).toHaveLength(2);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('blocked');
  });

  test('distinct api-error texts are distinct signatures (second continue before budget exhaustion)', async () => {
    const { runId, taskId, executionId } = seedIdleErrorRun({
      subtype: 'success',
      terminalReason: 'api_error',
      resultText: 'API Error: Connection refused (ConnectionRefused)',
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);

    resumeToIdle(executionId, {
      subtype: 'success',
      terminalReason: 'api_error',
      resultText: 'API Error: 502 Bad Gateway',
    });
    await rt.executeTick();
    expect(tam._injected).toHaveLength(2);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');

    resumeToIdle(executionId, {
      subtype: 'success',
      terminalReason: 'api_error',
      resultText: 'API Error: 503 Service Unavailable',
    });
    await rt.executeTick();

    expect(tam._injected).toHaveLength(2);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('blocked');
    expect(workflowRunRepo.getRun(runId)?.status).toBe('blocked');
    expect(taskRepo.getTask(taskId)?.status).toBe('blocked');
  });

  test('grace cooldown suppresses a re-evaluation before the prior continue is consumed', async () => {
    const { executionId } = seedIdleErrorRun({
      subtype: 'error_during_execution',
      errors: ['hiccup'],
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam, { agentStuckNagGraceMs: 60_000 }));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);

    resumeToIdle(executionId, {
      subtype: 'error_during_execution',
      errors: ['different'],
    });

    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');
  });

  test('a re-spawned session (new id) resets the continue budget', async () => {
    const { executionId } = seedIdleErrorRun({
      subtype: 'error_during_execution',
      errors: ['hiccup'],
      sessionId: 'session:gen-1',
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);

    nodeExecutionRepo.update(executionId, {
      status: 'idle',
      agentSessionId: 'session:gen-2',
      startedAt: Date.now() - 60_000,
    });
    saveResultError('session:gen-2', {
      subtype: 'error_during_execution',
      errors: ['hiccup after respawn'],
    });

    await rt.executeTick();
    expect(tam._injected).toHaveLength(2);
    expect(tam._injected[1].sessionId).toBe('session:gen-2');
  });

  test('persistently failing injection escalates to blocked (bounded, no infinite loop)', async () => {
    const { runId, taskId, executionId } = seedIdleErrorRun({
      subtype: 'error_during_execution',
      errors: ['live-but-wedged'],
    });
    const tam = makeTam({
      injectRuntimeRecoveryMessage: async () => {
        throw new Error('rehydration index mismatch');
      },
    });
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');

    await rt.executeTick();
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');

    await rt.executeTick();

    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('blocked');
    expect(nodeExecutionRepo.getById(executionId)?.agentSessionId).toBeNull();
    expect(workflowRunRepo.getRun(runId)?.status).toBe('blocked');
    expect(taskRepo.getTask(taskId)?.status).toBe('blocked');
  });

  test('a non-error last message (consumed continue / transient progress) does NOT reset the budget — same-signature recurrence is bounded', async () => {
    const { runId, taskId, executionId } = seedIdleErrorRun({
      subtype: 'error_during_execution',
      errors: ['generic 400'],
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);

    db.prepare(`DELETE FROM sdk_messages WHERE session_id = ?`).run(SESSION);
    sdkMessageRepo.saveSDKMessage(SESSION, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'working...' }],
        stop_reason: null,
      },
    } as never);

    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);

    db.prepare(`DELETE FROM sdk_messages WHERE session_id = ?`).run(SESSION);
    saveResultError(SESSION, { subtype: 'error_during_execution', errors: ['generic 400'] });

    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('blocked');
    expect(workflowRunRepo.getRun(runId)?.status).toBe('blocked');
    expect(taskRepo.getTask(taskId)?.status).toBe('blocked');
  });
});
