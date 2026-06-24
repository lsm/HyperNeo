/**
 * SpaceRuntime — Terminal-Error Idle Recovery (Task #673)
 *
 * Catch-all recovery for node-agent sessions that end on a terminal error
 * result (e.g. Codex 400, `error_during_execution`). Such a session leaves the
 * node idle with a *live* session, and because the result is classified
 * `terminal` no existing sweep recovers it — the worker is only revivable by a
 * manual "continue".
 *
 * `handleTerminalErrorIdleExecutions` injects a bounded number of continues via
 * the same primitive a manual continue uses, then escalates to `blocked`.
 *
 * Behaviour under test:
 *   1. `error_during_execution` (alive session) → one continue injected.
 *   2. `error_max_turns` is retryable → continue injected.
 *   3. Grace cooldown suppresses an immediate second continue.
 *   4. A different error signature earns a second continue (after cooldown).
 *   5. Retry cap (2) exhausted → execution/run/task → `blocked`.
 *   6. Deterministic repeat (identical signature) → blocked immediately.
 *   7. `error_max_budget_usd` (cost guard) → no continue, no blocked.
 *   8. Prompt-too-long result → no continue (deferred to #670 compaction).
 *   9. Dead session → no continue (crash-retry path owns it).
 *  10. Task not `in_progress` → no action.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import { SpaceRuntime } from '../../../../src/lib/space/runtime/space-runtime.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

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
			parent_tool_use_id TEXT,
			task_id TEXT
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

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
      // Collapse the grace cooldown so cap/repeat tests can advance in
      // successive ticks without waiting minutes.
      agentStuckNagGraceMs: 0,
      ...overrides,
    };
  }

  function makeTam(
    overrides: {
      isSessionAlive?: (sessionId: string) => boolean;
      injectRuntimeRecoveryMessage?: (sessionId: string, message: string) => Promise<string>;
    } = {}
  ) {
    const injected: Array<{ sessionId: string; message: string }> = [];
    return {
      isSessionAlive: overrides.isSessionAlive ?? (() => true),
      isExecutionSpawning: () => false,
      isSpawning: () => false,
      isTaskAgentAlive: () => true,
      rehydrate: async () => {},
      cancelBySessionId: () => {},
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
          nodeExecutionRepo.update(exec.id, {
            status: 'in_progress',
            agentSessionId: SESSION,
            startedAt: Date.now(),
            completedAt: null,
          });
        }
        return SESSION;
      },
      injectRuntimeRecoveryMessage:
        overrides.injectRuntimeRecoveryMessage ??
        (async (sessionId: string, message: string) => {
          injected.push({ sessionId, message });
          return `continue-msg:${injected.length}`;
        }),
      injectIntoTaskAgent: async () => ({ injected: false, reason: 'no-session' }),
      _injected: injected,
    };
  }

  /**
   * Persist a terminal `result` message for a session via direct SQL so the
   * subtype round-trips through `getLastSDKMessage` exactly.
   */
  function saveResultError(
    sessionId: string,
    opts: {
      subtype: string;
      errors?: string[];
      terminalReason?: string;
      minutesAgo?: number;
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
    const ts = new Date(Date.now() - (opts.minutesAgo ?? 0) * 60_000).toISOString();
    db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin, is_renderable, is_terminal)
       VALUES (?, ?, 'result', ?, ?, ?, 'consumed', 'sdk', 1, 1)`
    ).run(id, sessionId, opts.subtype, JSON.stringify(message), ts);
  }

  /** Seed a single-node workflow run whose execution is idle on an error result. */
  function seedIdleErrorRun(opts: {
    subtype: string;
    errors?: string[];
    terminalReason?: string;
    taskStatus?: string;
    sessionAlive?: boolean;
    sessionId?: string;
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
    });
    return { runId: run.id, taskId: task.id, executionId: execution.id };
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
    } catch {
      /* ignore */
    }
  });

  test('error_during_execution on a live idle session injects one continue', async () => {
    const { runId, taskId } = seedIdleErrorRun({
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
    // Run/task remain in_progress — recovery is a continue, not a block.
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

  test('prompt-too-long result is not continued (deferred to #670)', async () => {
    const { executionId } = seedIdleErrorRun({
      subtype: 'error_during_execution',
      errors: ['prompt is too long: 205616 tokens > 200000 maximum'],
      terminalReason: 'prompt_too_long',
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(tam._injected).toHaveLength(0);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');
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

    expect(tam._injected).toHaveLength(0);
  });

  test('dead session is not continued (crash-retry path owns it)', async () => {
    seedIdleErrorRun({ subtype: 'error_during_execution', sessionAlive: false });
    const tam = makeTam({ isSessionAlive: () => false });
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(tam._injected).toHaveLength(0);
  });

  test('task not in_progress is left alone', async () => {
    seedIdleErrorRun({ subtype: 'error_during_execution', taskStatus: 'done' });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(tam._injected).toHaveLength(0);
  });

  test('retries up to the cap then escalates to blocked', async () => {
    const { runId, taskId, executionId } = seedIdleErrorRun({
      subtype: 'error_during_execution',
      errors: ['transient hiccup A'],
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    // First tick → continue #1 (signature A).
    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);

    // Re-write the persisted result to a DIFFERENT error so the signature
    // changes and the cap (not the repeat guard) is what trips.
    db.prepare(`DELETE FROM sdk_messages WHERE session_id = ?`).run(SESSION);
    saveResultError(SESSION, {
      subtype: 'error_during_execution',
      errors: ['transient hiccup B'],
    });

    // Second tick → continue #2 (signature B, under cap of 2).
    await rt.executeTick();
    expect(tam._injected).toHaveLength(2);

    // Re-write again to yet another distinct error.
    db.prepare(`DELETE FROM sdk_messages WHERE session_id = ?`).run(SESSION);
    saveResultError(SESSION, {
      subtype: 'error_during_execution',
      errors: ['transient hiccup C'],
    });

    // Third tick → cap (2) exhausted → blocked.
    await rt.executeTick();

    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('blocked');
    expect(workflowRunRepo.getRun(runId)?.status).toBe('blocked');
    expect(taskRepo.getTask(taskId)?.status).toBe('blocked');
    expect(taskRepo.getTask(taskId)?.blockReason).toBe('execution_failed');
    expect(notifications).toContainEqual(expect.objectContaining({ kind: 'task_blocked' }));
    expect(notifications).toContainEqual(expect.objectContaining({ kind: 'workflow_run_blocked' }));
  });

  test('deterministic repeat (identical signature) escalates to blocked immediately', async () => {
    const { runId, taskId, executionId } = seedIdleErrorRun({
      subtype: 'error_during_execution',
      errors: ['Codex 400 invalid_request_error'],
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    // First tick → continue #1, signature stored.
    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);

    // The persisted result is unchanged → same signature next tick. A plain
    // continue already failed to clear it, so escalate immediately.
    await rt.executeTick();

    expect(tam._injected).toHaveLength(1); // no second continue
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('blocked');
    expect(workflowRunRepo.getRun(runId)?.status).toBe('blocked');
    expect(taskRepo.getTask(taskId)?.status).toBe('blocked');
  });

  test('grace cooldown suppresses a second immediate continue', async () => {
    const { executionId } = seedIdleErrorRun({
      subtype: 'error_during_execution',
      errors: ['hiccup'],
    });
    // Non-zero grace so the cooldown window is active.
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam, { agentStuckNagGraceMs: 60_000 }));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    // First tick → continue #1.
    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);

    // Replace with a distinct signature so only the cooldown could suppress it.
    db.prepare(`DELETE FROM sdk_messages WHERE session_id = ?`).run(SESSION);
    saveResultError(SESSION, { subtype: 'error_during_execution', errors: ['different'] });

    // Immediate second tick → within grace → no new continue, execution idle.
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

    // Gen-1 session: continue once.
    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);

    // Simulate a blocked-recovery re-spawn: same execution, new session id,
    // fresh error result.
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
    // Budget reset → a continue fires for the new session despite the prior one.
    expect(tam._injected).toHaveLength(2);
    expect(tam._injected[1].sessionId).toBe('session:gen-2');
  });
});
