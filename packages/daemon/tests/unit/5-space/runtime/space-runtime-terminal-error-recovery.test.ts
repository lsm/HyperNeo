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
import { ToolContinuationRecoveryRepository } from '../../../../src/storage/repositories/tool-continuation-recovery-repository';
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
    const cancelled: string[] = [];
    const spawnSnapshots: Array<{ agentSessionIdAtSpawn: string | null }> = [];
    return {
      isSessionAlive: overrides.isSessionAlive ?? (() => true),
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
          // Snapshot the DB state at spawn time so tests can verify the stale
          // agentSessionId was cleared before the fresh session is assigned.
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
      injectRuntimeRecoveryMessage:
        overrides.injectRuntimeRecoveryMessage ??
        (async (sessionId: string, message: string) => {
          injected.push({ sessionId, message });
          return `continue-msg:${injected.length}`;
        }),
      injectIntoTaskAgent: async () => ({ injected: false, reason: 'no-session' }),
      _injected: injected,
      _cancelled: cancelled,
      _spawnSnapshots: spawnSnapshots,
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

  /**
   * Simulate `handleSubSessionComplete` returning a continued execution to
   * `idle` after the resumed turn ends, optionally re-writing the persisted
   * terminal result (e.g. to a different error signature). Production flips the
   * execution to `in_progress` on a continue; tests must move it back to idle
   * for the sweep to re-evaluate it on the next tick.
   */
  function resumeToIdle(
    executionId: string,
    opts: { subtype: string; errors?: string[]; terminalReason?: string }
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
    } catch {
      /* ignore */
    }
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
    // Execution stays idle: handleSubSessionComplete is a one-shot callback that
    // already fired for the terminal error, so flipping to in_progress would
    // leave it stuck. The sweep re-evaluates idle rows every tick instead.
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');
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

  test('dead terminal-error session is reset for a FRESH re-spawn (stale session cleared)', async () => {
    const { executionId } = seedIdleErrorRun({
      subtype: 'error_during_execution',
      sessionAlive: false,
    });
    const tam = makeTam({ isSessionAlive: () => false });
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    // A dead session cannot be continued. The crash-retry path only scans
    // in_progress/pending, so this sweep resets the idle row for a bounded
    // re-spawn. The stale (terminal-tainted) agentSessionId is cleared BEFORE
    // the spawn so createSubSession spawns a fresh session instead of
    // rehydrating/reusing the dead one.
    expect(tam._injected).toHaveLength(0);
    expect(tam._spawnSnapshots.length).toBeGreaterThanOrEqual(1);
    expect(tam._spawnSnapshots[0].agentSessionIdAtSpawn).toBeNull();
    // The spawn loop then re-spawns a fresh session.
    const updated = nodeExecutionRepo.getById(executionId)!;
    expect(updated.status).toBe('in_progress');
  });

  test('active tool continuation is preserved (no continue injected)', async () => {
    const { runId, executionId } = seedIdleErrorRun({
      subtype: 'error_during_execution',
    });
    // Seed an active tool_use for this execution — the pending tool_result is
    // the next valid transcript item; injecting a user continue would race it.
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

    // First tick → continue #1 (max-turns, signature stored).
    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);

    // Resumed turn hits max-turns AGAIN with the SAME (empty) signature.
    resumeToIdle(executionId, { subtype: 'error_max_turns' });

    // Second tick → max-turns is exempt from the deterministic-repeat shortcut,
    // so it gets continue #2 (the cap), not an immediate block.
    await rt.executeTick();
    expect(tam._injected).toHaveLength(2);

    // Third occurrence → cap (2) exhausted → blocked.
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

    // A dead cost-guarded session is NOT re-spawned — the subtype guards run
    // before the dead-session reset, so non-retryable subtypes are skipped
    // consistently whether the session is live or dead (no guaranteed-to-re-fail
    // re-spawns).
    expect(tam._injected).toHaveLength(0);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');
  });

  test('a shared session across idle rows injects only one continue per tick', async () => {
    // Simulate a reused agent session: two idle node executions reference the
    // SAME agentSessionId, both ending on the terminal error result for it.
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

    // One continue for the shared session — not one per idle row.
    expect(tam._injected).toHaveLength(1);
    expect(tam._injected[0].sessionId).toBe('session:shared');
  });

  test('task not in_progress is left alone', async () => {
    seedIdleErrorRun({ subtype: 'error_during_execution', taskStatus: 'done' });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    await rt.executeTick();

    expect(tam._injected).toHaveLength(0);
  });

  test('retries up to the cap then escalates to blocked (clearing the stale session)', async () => {
    const { runId, taskId, executionId } = seedIdleErrorRun({
      subtype: 'error_during_execution',
      errors: ['transient hiccup A'],
    });
    const tam = makeTam();
    const rt = new SpaceRuntime(buildConfig(tam));
    (rt as unknown as { recoveryDone: boolean }).recoveryDone = true;

    // First tick → continue #1 (signature A); execution flips to in_progress.
    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);

    // Simulate the resumed turn ending back at idle with a DIFFERENT error so
    // the signature changes and the cap (not the repeat guard) is what trips.
    resumeToIdle(executionId, {
      subtype: 'error_during_execution',
      errors: ['transient hiccup B'],
    });

    // Second tick → continue #2 (signature B, under cap of 2).
    await rt.executeTick();
    expect(tam._injected).toHaveLength(2);

    resumeToIdle(executionId, {
      subtype: 'error_during_execution',
      errors: ['transient hiccup C'],
    });

    // Third tick → cap (2) exhausted → blocked.
    await rt.executeTick();

    const execution = nodeExecutionRepo.getById(executionId)!;
    expect(execution.status).toBe('blocked');
    // The stale live session is cancelled and cleared so attemptBlockedRunRecovery
    // re-spawns a FRESH session instead of re-promoting this one.
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

    // First tick → continue #1, signature stored.
    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);

    // Resumed turn re-errored identically → same signature next evaluation.
    resumeToIdle(executionId, {
      subtype: 'error_during_execution',
      errors: ['Codex 400 invalid_request_error'],
    });

    // Second tick → grace (0) passed, repeat detected → blocked, no 2nd continue.
    await rt.executeTick();

    expect(tam._injected).toHaveLength(1);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('blocked');
    expect(nodeExecutionRepo.getById(executionId)?.agentSessionId).toBeNull();
    expect(workflowRunRepo.getRun(runId)?.status).toBe('blocked');
    expect(taskRepo.getTask(taskId)?.status).toBe('blocked');
  });

  test('grace cooldown suppresses a re-evaluation before the prior continue is consumed', async () => {
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

    // Resumed turn ends back at idle with a distinct signature. Even though the
    // signature differs (so neither the repeat nor the cap would trip), the
    // cooldown must give the prior continue its grace window before acting again.
    resumeToIdle(executionId, {
      subtype: 'error_during_execution',
      errors: ['different'],
    });

    // Immediate second tick → within grace → no new continue.
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
    // fresh error result, back to idle.
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

    // First tick → injection fails (failure 1); execution stays idle.
    await rt.executeTick();
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');

    // Second tick → still within grace(0)? grace=0 means cooldown never blocks,
    // but failedInjectionCount(1) < cap(2) → retry → fails again (failure 2).
    await rt.executeTick();
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('idle');

    // Third tick → failedInjectionCount(2) >= cap → escalate to blocked.
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

    // Tick 1 → continue #1 (signature stored).
    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);

    // Simulate the injected continue being consumed / the agent mid-turn: the
    // last message is briefly a non-error (assistant) message. The recovery
    // state must NOT be cleared here — getLastSDKMessage returns consumed user
    // rows too, so resetting on any non-error message would defeat the
    // repeat/cap guards (unbounded continues).
    db.prepare(`DELETE FROM sdk_messages WHERE session_id = ?`).run(SESSION);
    sdkMessageRepo.saveSDKMessage(SESSION, {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'working...' }],
        stop_reason: null,
      },
    } as never);

    // Tick 2 → non-error last message → execution skipped, no state change.
    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);

    // The resumed turn then fails with the SAME terminal error.
    db.prepare(`DELETE FROM sdk_messages WHERE session_id = ?`).run(SESSION);
    saveResultError(SESSION, { subtype: 'error_during_execution', errors: ['generic 400'] });

    // Tick 3 → state was preserved → deterministic-repeat detected → blocked.
    // (A fresh budget only comes from a re-spawn / new session id, not from a
    // transient non-error last message.)
    await rt.executeTick();
    expect(tam._injected).toHaveLength(1);
    expect(nodeExecutionRepo.getById(executionId)?.status).toBe('blocked');
    expect(workflowRunRepo.getRun(runId)?.status).toBe('blocked');
    expect(taskRepo.getTask(taskId)?.status).toBe('blocked');
  });
});
