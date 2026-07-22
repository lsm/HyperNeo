/**
 * Prompt-too-long recovery — REPLAY suite (Task #751).
 *
 * The recurring stuck-session failure mode where a worker session overflows its
 * context window is reported by providers in several incompatible shapes.
 * Per-encoding unit tests already cover the detector branches and the state
 * machine; this suite consolidates the encodings into a single REPLAY and
 * asserts the two things the per-encoding tests do NOT:
 *
 *  1. NORMALIZATION — every observed encoding funnels through the ONE canonical
 *     detector (`isPromptTooLongErrorMessage`) and (for user-message forms) the
 *     circuit breaker, and the two agree on what counts as prompt-too-long.
 *     Includes the JSON-wrapped Anthropic/Kimi stderr forms that were only ever
 *     exercised through the circuit breaker, not the recovery detector.
 *
 *  2. FINAL VISIBLE STATUS — driving representative encodings through the
 *     compact-then-continue recovery to escalation asserts the normalized
 *     REASON written to the execution/run/task rows (`result` + `blockReason`),
 *     the session detach, and the surfaced notifications — for every escalation
 *     path (retry cap, /compact-turn timeout, resumed-turn timeout).
 *
 * Input sources replayed: provider result fields, stderr/user-message channel,
 * bare provider text, circuit-breaker trip, and the terminal-error sweep row.
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
import { ApiErrorCircuitBreaker } from '../../../../src/lib/agent/api-error-circuit-breaker';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceWorkflow } from '@hyperneo/shared';
import {
  isPromptTooLongErrorMessage,
  buildPromptTooLongContinueNag,
  COMPACT_RESULT_TIMEOUT_MS,
  MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS,
} from '../../../../src/lib/space/runtime/prompt-too-long-recovery';

// ---------------------------------------------------------------------------
// Encoding catalogue — every observed prompt-too-long shape, one place.
// ---------------------------------------------------------------------------

/** Provider RESULT-field encodings. Detector-only: the circuit breaker never
 *  inspects `result` messages (it only scans `type: 'user'` stderr). */
const RESULT_ENCODINGS: Array<{ name: string; message: unknown; detected: boolean }> = [
  {
    name: 'terminal_reason=prompt_too_long (canonical SDK)',
    message: { type: 'result', terminal_reason: 'prompt_too_long', errors: [] },
    detected: true,
  },
  {
    name: 'errors[] detailed "N tokens > M maximum"',
    message: {
      type: 'result',
      is_error: true,
      errors: ['prompt is too long: 205616 tokens > 200000 maximum'],
    },
    detected: true,
  },
  {
    name: 'errors[] bare (no N>M form)',
    message: { type: 'result', is_error: true, errors: ['Prompt is too long'] },
    detected: true,
  },
  {
    name: 'Kimi blocking_limit — phrase in result text, no errors[]',
    message: {
      type: 'result',
      is_error: true,
      result: 'Prompt is too long',
      terminal_reason: 'blocking_limit',
      errors: null,
    },
    detected: true,
  },
  {
    name: 'Kimi blocking_limit — detailed phrase in result text',
    message: {
      type: 'result',
      is_error: true,
      result: 'Error: prompt is too long: 205616 tokens > 200000 maximum',
      terminal_reason: 'blocking_limit',
      errors: null,
    },
    detected: true,
  },
  {
    name: 'non-overflow error result (negative)',
    message: {
      type: 'result',
      is_error: true,
      result: 'Rate limit exceeded',
      terminal_reason: 'blocking_limit',
      errors: null,
    },
    detected: false,
  },
  {
    name: 'success result that merely mentions the phrase (negative)',
    message: {
      type: 'result',
      is_error: false,
      result: 'noted the model said prompt is too long earlier',
      terminal_reason: 'completed',
      errors: null,
    },
    detected: false,
  },
];

/** User-message / stderr encodings. These are the ONLY forms the circuit
 *  breaker sees, so each is replayed through BOTH the detector and the breaker
 *  to prove they normalize identically. */
const USER_ENCODINGS: Array<{
  name: string;
  content: string;
  detected: boolean;
  tripReason: string | null;
  tripMessageContains?: string;
}> = [
  {
    name: 'stderr bare "Prompt is too long"',
    content: '<local-command-stderr>Prompt is too long</local-command-stderr>',
    detected: true,
    tripReason: 'prompt_too_long',
    tripMessageContains: 'Context limit exceeded',
  },
  {
    name: 'stderr detailed "N tokens > M maximum"',
    content:
      '<local-command-stderr>Error: prompt is too long: 205616 tokens > 200000 maximum</local-command-stderr>',
    detected: true,
    tripReason: 'prompt_too_long:200000',
    tripMessageContains: '200000',
  },
  {
    name: 'stderr JSON-wrapped Anthropic detailed (detector gap)',
    content:
      '<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 205616 tokens > 200000 maximum"}}</local-command-stderr>',
    detected: true,
    tripReason: 'prompt_too_long:200000',
    tripMessageContains: '200000',
  },
  {
    name: 'stderr JSON-wrapped Kimi bare (detector gap)',
    content:
      '<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Prompt is too long"}}</local-command-stderr>',
    detected: true,
    tripReason: 'prompt_too_long',
    tripMessageContains: 'Context limit exceeded',
  },
  {
    name: 'phrase outside stderr tags (negative — not prompt-too-long)',
    content: 'The model said Prompt is too long',
    detected: false,
    tripReason: null,
  },
  {
    name: 'unrelated stderr error (negative — trips as connection_error, not prompt-too-long)',
    content: '<local-command-stderr>Error: Connection error.</local-command-stderr>',
    detected: false,
    tripReason: 'connection_error',
  },
];

/** Feed a user message into a fresh breaker 3× (the trip threshold) and return
 *  the normalized trip reason + user-facing message. */
async function tripBreaker(content: string): Promise<{
  tripped: boolean;
  tripReason: string | null;
  message: string;
}> {
  const cb = new ApiErrorCircuitBreaker('replay-test');
  const msg = { type: 'user' as const, message: { content }, parent_tool_use_id: null };
  for (let i = 0; i < 3; i++) {
    await cb.checkMessage(msg);
  }
  return {
    tripped: cb.isTripped(),
    tripReason: cb.getState().tripReason,
    message: cb.getTripMessage(),
  };
}

describe('prompt-too-long replay — normalization across detector and circuit breaker', () => {
  describe('provider result-field encodings (canonical detector)', () => {
    for (const enc of RESULT_ENCODINGS) {
      test(`${enc.detected ? 'detects' : 'rejects'} ${enc.name}`, () => {
        expect(isPromptTooLongErrorMessage(enc.message as never)).toBe(enc.detected);
      });
    }
  });

  describe('stderr / user-message encodings (detector + circuit breaker agree)', () => {
    for (const enc of USER_ENCODINGS) {
      test(`${enc.detected ? 'detects' : 'rejects'} ${enc.name}`, async () => {
        const message = {
          type: 'user',
          message: { role: 'user', content: enc.content },
          parent_tool_use_id: null,
        };
        // Canonical recovery detector.
        expect(isPromptTooLongErrorMessage(message as never)).toBe(enc.detected);
        // Circuit breaker normalization (feeds the trip threshold).
        const breaker = await tripBreaker(enc.content);
        expect(breaker.tripReason).toBe(enc.tripReason);
        if (enc.tripMessageContains) {
          expect(breaker.message).toContain(enc.tripMessageContains);
        }
        // Cross-layer agreement: the breaker and the detector never disagree on
        // whether a user message is prompt-too-long. (The breaker may trip for a
        // different class — e.g. connection_error — but must not mislabel it.)
        const breakerClassifiesPromptTooLong =
          breaker.tripReason?.startsWith('prompt_too_long') ?? false;
        expect(breakerClassifiesPromptTooLong).toBe(enc.detected);
      });
    }
  });

  test('result-field encodings never trip the circuit breaker (breaker scans only user messages)', async () => {
    // A terminal_reason=prompt_too_long result is the clearest overflow, yet the
    // breaker must not trip on it — it owns user-message loops only; result
    // overflow is the recovery module's job.
    for (const enc of RESULT_ENCODINGS.filter((e) => e.detected)) {
      const breaker = new ApiErrorCircuitBreaker('replay-test');
      const msg = { ...enc.message, type: 'result' };
      for (let i = 0; i < 3; i++) await breaker.checkMessage(msg);
      expect(breaker.isTripped()).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// DB helpers (mirror prompt-too-long-recovery.test.ts)
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

function seedSpaceRow(db: BunDatabase, spaceId: string): void {
  db.prepare(
    `INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, slug, status, max_concurrent_tasks, created_at, updated_at)
     VALUES (?, '/tmp/ws', ?, '', '', '', '[]', '[]', ?, 'active', 1, ?, ?)`
  ).run(spaceId, `Space ${spaceId}`, spaceId, Date.now(), Date.now());
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
  nodes: Array<{ id: string; name: string; agentId: string }>
): SpaceWorkflow {
  return workflowManager.createWorkflow({
    spaceId,
    name: `Replay Workflow ${Date.now()}-${Math.random()}`,
    description: 'Test',
    nodes,
    transitions: nodes.slice(0, -1).map((step, i) => ({
      from: step.id,
      to: nodes[i + 1].id,
      condition: { type: 'always' as const },
      order: 0,
    })),
    startNodeId: nodes[0].id,
    rules: [],
    tags: [],
    completionAutonomyLevel: 3,
  });
}

// ---------------------------------------------------------------------------
// Tests: recovery escalation — normalized reason & final visible status
// ---------------------------------------------------------------------------

describe('prompt-too-long replay — recovery escalation: reason & final visible status', () => {
  let db: BunDatabase;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let agentManager: SpaceAgentManager;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;
  let nodeExecutionRepo: NodeExecutionRepository;
  let sdkMessageRepo: SDKMessageRepository;
  let internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  let notifications: Array<{ kind: string; payload: Record<string, unknown> }>;

  const SPACE_ID = 'space-ptl-replay';
  const AGENT = 'agent-worker';
  const STEP_A = 'step-a';

  const SPACE_EVENT_MAP: Record<string, string> = {
    'space.task.blocked': 'task_blocked',
    'space.workflowRun.blocked': 'workflow_run_blocked',
  };

  beforeEach(() => {
    db = makeDb();
    seedSpaceRow(db, SPACE_ID);
    seedAgentRow(db, AGENT, SPACE_ID, 'Worker');
    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    taskRepo = new SpaceTaskRepository(db);
    nodeExecutionRepo = new NodeExecutionRepository(db);
    sdkMessageRepo = new SDKMessageRepository(db);
    agentManager = new SpaceAgentManager(new SpaceAgentRepository(db));
    workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
    spaceManager = new SpaceManager(db);
    internalEventBus = new InternalEventBus<DaemonInternalEventMap>();

    notifications = [];
    for (const [eventName, kind] of Object.entries(SPACE_EVENT_MAP)) {
      internalEventBus.subscribe(
        eventName as keyof DaemonInternalEventMap,
        (payload) => {
          notifications.push({ kind, payload: payload as Record<string, unknown> });
        },
        { subscriberName: `test-ptl-replay:${eventName}` }
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

  function buildConfig(tam: unknown): SpaceRuntimeConfig {
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
      agentNoProgressThresholdMs: 60_000,
    };
  }

  /** Persist the injected message with send_status='enqueued' so it is excluded
   *  from getLastSDKMessage until the SDK consumes it — exactly like production
   *  (sdk-message-repository excludes enqueued user messages). */
  function makeRecordingTam(injections: Array<{ sessionId: string; message: string }>): unknown {
    const inject = async (sessionId: string, message: string): Promise<string> => {
      injections.push({ sessionId, message });
      sdkMessageRepo.saveSDKMessage(sessionId, {
        type: 'user',
        message: { role: 'user', content: message },
      } as never);
      const row = db
        .prepare(
          `SELECT id FROM sdk_messages WHERE session_id = ? ORDER BY timestamp DESC, rowid DESC LIMIT 1`
        )
        .get(sessionId) as { id: string };
      db.prepare(`UPDATE sdk_messages SET send_status = 'enqueued' WHERE id = ?`).run(row.id);
      return row.id;
    };
    return {
      isSpawning: () => false,
      isTaskAgentAlive: () => false,
      spawnWorkflowNodeAgent: async () => 'unused',
      isExecutionSpawning: () => false,
      isSessionAlive: () => true,
      spawnWorkflowNodeAgentForExecution: async (
        _task: unknown,
        _space: unknown,
        _workflow: unknown,
        _run: unknown,
        _execution: unknown
      ) => 'unused',
      rehydrate: async () => {},
      cancelBySessionId: () => {},
      interruptBySessionId: async () => {},
      restartStuckSubSession: async () => {},
      injectRuntimeRecoveryMessage: inject,
      getAgentSessionById: () => ({ getProcessingState: () => ({ status: 'processing' }) }),
      injectIntoTaskAgent: async () => ({ injected: false, reason: 'no-session' }),
    };
  }

  function saveResultMessage(
    sessionId: string,
    opts: { promptTooLong?: boolean; nonOverflowError?: boolean; minutesAgo?: number }
  ): void {
    const isError = !!(opts.promptTooLong || opts.nonOverflowError);
    const message = {
      type: 'result',
      subtype: isError ? 'error_during_execution' : 'success',
      is_error: isError,
      terminal_reason: opts.promptTooLong ? 'prompt_too_long' : 'completed',
      errors: opts.promptTooLong
        ? ['prompt is too long: 205616 tokens > 200000 maximum']
        : opts.nonOverflowError
          ? ['API Error: 500 Internal Server Error']
          : [],
      result: isError ? '' : 'ok',
    };
    sdkMessageRepo.saveSDKMessage(sessionId, message as never);
    const minutesAgo = opts.minutesAgo ?? 20;
    const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    db.prepare(`UPDATE sdk_messages SET timestamp = ? WHERE session_id = ?`).run(ts, sessionId);
  }

  /** Seed an idle execution ending on a prompt-too-long result. */
  async function setupIdleOverflow(
    rt: SpaceRuntime,
    sessionId: string
  ): Promise<{ runId: string; executionId: string; taskId: string }> {
    const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
      { id: STEP_A, name: 'Work', agentId: AGENT },
    ]);
    const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
    nodeExecutionRepo.update(execution.id, { status: 'idle', agentSessionId: sessionId });
    saveResultMessage(sessionId, { promptTooLong: true });
    const task = taskRepo.listByWorkflowRun(run.id)[0];
    return { runId: run.id, executionId: execution.id, taskId: task.id };
  }

  function recoveryState(rt: SpaceRuntime, runId: string, executionId: string): unknown {
    const map = (rt as unknown as { promptTooLongRecovery: Map<string, unknown> })
      .promptTooLongRecovery;
    return map.get(`${runId}:${executionId}`);
  }

  /** Assert the full final visible status after an escalation, including the
   *  normalized REASON written to every row + the surfaced notifications. */
  function expectEscalated(runId: string, executionId: string, reasonSubstring: string): void {
    // Execution: blocked, reason recorded, overflowed session detached (so the
    // bounded blocked-run retry spawns fresh instead of re-overflowing).
    const execution = nodeExecutionRepo.getById(executionId)!;
    expect(execution.status).toBe('blocked');
    expect(execution.result).toContain(reasonSubstring);
    expect(execution.agentSessionId).toBeNull();

    // Run: blocked.
    expect(workflowRunRepo.getRun(runId)?.status).toBe('blocked');

    // Task: blocked with the canonical reason code + the human-readable reason.
    const task = taskRepo.listByWorkflowRun(runId)[0]!;
    expect(task.status).toBe('blocked');
    expect(task.blockReason).toBe('execution_failed');
    expect(task.result).toContain(reasonSubstring);

    // Notifications surfaced to the UI/peers for BOTH the task and the run,
    // carrying the normalized reason.
    expect(notifications.some((n) => n.kind === 'task_blocked')).toBe(true);
    expect(notifications.some((n) => n.kind === 'workflow_run_blocked')).toBe(true);
    const taskBlocked = notifications.find((n) => n.kind === 'task_blocked');
    expect(String(taskBlocked?.payload.reason)).toContain(reasonSubstring);
    const runBlocked = notifications.find((n) => n.kind === 'workflow_run_blocked');
    expect(String(runBlocked?.payload.reason)).toContain(reasonSubstring);
  }

  test('retry cap exhausted — reason records the compaction attempt count', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const { runId, executionId } = await setupIdleOverflow(rt, 'session:cap');

    // Two unproductive compactions (fresh overflow each time) exhaust the cap.
    await rt.executeTick(); // /compact 1
    saveResultMessage('session:cap', { promptTooLong: true });
    await rt.executeTick(); // /compact 2
    saveResultMessage('session:cap', { promptTooLong: true });
    await rt.executeTick(); // cap (2) → blocked

    expect(injections.filter((i) => i.message === '/compact')).toHaveLength(
      MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS
    );
    expectEscalated(
      runId,
      executionId,
      `could not be resolved after ${MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS} compaction attempt(s)`
    );
    expect(recoveryState(rt, runId, executionId)).toBeUndefined();
  });

  test('/compact-turn timeout — reason records the timeout path', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const { runId, executionId } = await setupIdleOverflow(rt, 'session:compact-hang');

    await rt.executeTick(); // /compact injected, turn "hangs" (no result)
    expect(injections.map((i) => i.message)).toEqual(['/compact']);

    // Simulate the /compact turn never producing a result.
    const state = recoveryState(rt, runId, executionId) as {
      awaitingContinueSince: number | null;
    };
    state!.awaitingContinueSince = Date.now() - (COMPACT_RESULT_TIMEOUT_MS + 1000);
    await rt.executeTick(); // timeout → blocked

    expectEscalated(runId, executionId, 'the /compact turn did not produce a result within');
  });

  test('resumed-turn timeout — reason records the resume-wait path', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const { runId, executionId } = await setupIdleOverflow(rt, 'session:resume-hang');

    await rt.executeTick(); // /compact
    saveResultMessage('session:resume-hang', { promptTooLong: false }); // compaction succeeded
    await rt.executeTick(); // → continue nag (awaitingResume)

    // Simulate the resumed turn hanging after the nag.
    const state = recoveryState(rt, runId, executionId) as {
      awaitingResumeSince: number | null;
    };
    state!.awaitingResumeSince = Date.now() - (COMPACT_RESULT_TIMEOUT_MS + 1000);
    await rt.executeTick(); // resume-wait timeout → blocked

    expectEscalated(runId, executionId, 'the resumed turn did not produce a result within');
  });

  test('auto-compact triggers BEFORE continuation (compact-then-continue order)', async () => {
    // The recovery MUST compact FIRST; a bare continue on an over-long context is
    // useless. Verify the order: the first injected message is always /compact,
    // never the continue nag, and the nag only appears after a compacted result.
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    await setupIdleOverflow(rt, 'session:order');

    await rt.executeTick();
    expect(injections[0].message).toBe('/compact');
    // Still awaiting the compacted result — no nag yet.
    expect(injections.some((i) => i.message === buildPromptTooLongContinueNag())).toBe(false);

    saveResultMessage('session:order', { promptTooLong: false }); // compaction shrank context
    await rt.executeTick();
    // Now — and only now — the continuation nag is delivered.
    expect(injections.at(-1)!.message).toBe(buildPromptTooLongContinueNag());
  });
});

// ---------------------------------------------------------------------------
// Tests: terminal-error sweep defers prompt-too-long to the compact recovery
// ---------------------------------------------------------------------------

describe('prompt-too-long replay — terminal-error row deferral', () => {
  let db: BunDatabase;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let agentManager: SpaceAgentManager;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;
  let nodeExecutionRepo: NodeExecutionRepository;
  let sdkMessageRepo: SDKMessageRepository;
  let internalEventBus: InternalEventBus<DaemonInternalEventMap>;

  const SPACE_ID = 'space-ptl-defer';
  const AGENT = 'agent-coder';
  const STEP_A = 'step-a';

  beforeEach(() => {
    db = makeDb();
    seedSpaceRow(db, SPACE_ID);
    seedAgentRow(db, AGENT, SPACE_ID, 'Coder');
    workflowRunRepo = new SpaceWorkflowRunRepository(db);
    taskRepo = new SpaceTaskRepository(db);
    nodeExecutionRepo = new NodeExecutionRepository(db);
    sdkMessageRepo = new SDKMessageRepository(db);
    agentManager = new SpaceAgentManager(new SpaceAgentRepository(db));
    workflowManager = new SpaceWorkflowManager(new SpaceWorkflowRepository(db));
    spaceManager = new SpaceManager(db);
    internalEventBus = new InternalEventBus<DaemonInternalEventMap>();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  });

  function buildConfig(tam: unknown): SpaceRuntimeConfig {
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
      agentStuckNagGraceMs: 0,
    };
  }

  test('a prompt-too-long terminal error row is owned by compact recovery, not double-continued', async () => {
    // A prompt-too-long result is a TERMINAL error row. Two sweeps could touch
    // it: the catch-all terminal-error sweep (which would inject a plain
    // "[Runtime recovery — terminal error]" continue) and the compact-then-
    // continue recovery. The terminal-error sweep MUST defer so the two never
    // race — only the /compact fires.
    const injections: Array<{ sessionId: string; message: string }> = [];
    const inject = async (sessionId: string, message: string): Promise<string> => {
      injections.push({ sessionId, message });
      sdkMessageRepo.saveSDKMessage(sessionId, {
        type: 'user',
        message: { role: 'user', content: message },
      } as never);
      const row = db
        .prepare(
          `SELECT id FROM sdk_messages WHERE session_id = ? ORDER BY timestamp DESC, rowid DESC LIMIT 1`
        )
        .get(sessionId) as { id: string };
      db.prepare(`UPDATE sdk_messages SET send_status = 'enqueued' WHERE id = ?`).run(row.id);
      return row.id;
    };
    const tam = {
      isSpawning: () => false,
      isTaskAgentAlive: () => false,
      spawnWorkflowNodeAgent: async () => 'unused',
      isExecutionSpawning: () => false,
      isSessionAlive: () => true,
      spawnWorkflowNodeAgentForExecution: async () => 'unused',
      rehydrate: async () => {},
      cancelBySessionId: () => {},
      interruptBySessionId: async () => {},
      restartStuckSubSession: async () => {},
      injectRuntimeRecoveryMessage: inject,
      getAgentSessionById: () => null,
      injectIntoTaskAgent: async () => ({ injected: false, reason: 'no-session' }),
    };

    const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
      { id: STEP_A, name: 'Code', agentId: AGENT },
    ]);
    const rt = new SpaceRuntime(buildConfig(tam));
    const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
    nodeExecutionRepo.update(execution.id, { status: 'idle', agentSessionId: 'session:defer' });
    // Persist the prompt-too-long result exactly as the SDK would (terminal row).
    sdkMessageRepo.saveSDKMessage('session:defer', {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'prompt_too_long',
      errors: ['prompt is too long: 205616 tokens > 200000 maximum'],
    } as never);
    db.prepare(`UPDATE sdk_messages SET timestamp = ? WHERE session_id = ?`).run(
      new Date(Date.now() - 20 * 60_000).toISOString(),
      'session:defer'
    );

    await rt.executeTick();

    // The compact-then-continue recovery owns it: a /compact was injected.
    expect(injections.some((i) => i.message === '/compact')).toBe(true);
    // The terminal-error sweep deferred: NO plain terminal-error continue was
    // injected on top of it (would double-handle and race).
    expect(injections.some((i) => i.message.includes('[Runtime recovery — terminal error]'))).toBe(
      false
    );
    // Execution is still idle (recovery in flight), NOT blocked and NOT
    // bounced to in_progress by a terminal-error continue.
    expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('idle');
  });
});
