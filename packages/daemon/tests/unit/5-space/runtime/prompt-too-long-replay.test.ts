import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
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
    name: 'stderr JSON-wrapped Anthropic detailed (previously breaker-only)',
    content:
      '<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 205616 tokens > 200000 maximum"}}</local-command-stderr>',
    detected: true,
    tripReason: 'prompt_too_long:200000',
    tripMessageContains: '200000',
  },
  {
    name: 'stderr JSON-wrapped Kimi bare (previously breaker-only)',
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
        expect(isPromptTooLongErrorMessage(message as never)).toBe(enc.detected);
        const breaker = await tripBreaker(enc.content);
        expect(breaker.tripReason).toBe(enc.tripReason);
        if (enc.tripMessageContains) {
          expect(breaker.message).toContain(enc.tripMessageContains);
        }
        const breakerClassifiesPromptTooLong =
          breaker.tripReason?.startsWith('prompt_too_long') ?? false;
        expect(breakerClassifiesPromptTooLong).toBe(enc.detected);
      });
    }
  });

  test('result-field encodings never trip the circuit breaker (breaker scans only user messages)', async () => {
    for (const enc of RESULT_ENCODINGS.filter((e) => e.detected)) {
      const breaker = new ApiErrorCircuitBreaker('replay-test');
      const msg = { ...enc.message, type: 'result' };
      for (let i = 0; i < 3; i++) await breaker.checkMessage(msg);
      expect(breaker.isTripped()).toBe(false);
    }
  });
});

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

  function expectEscalated(runId: string, executionId: string, reasonSubstring: string): void {
    const execution = nodeExecutionRepo.getById(executionId)!;
    expect(execution.status).toBe('blocked');
    expect(execution.result).toContain(reasonSubstring);
    expect(execution.agentSessionId).toBeNull();

    expect(workflowRunRepo.getRun(runId)?.status).toBe('blocked');

    const task = taskRepo.listByWorkflowRun(runId)[0]!;
    expect(task.status).toBe('blocked');
    expect(task.blockReason).toBe('execution_failed');
    expect(task.result).toContain(reasonSubstring);

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

    await rt.executeTick();
    saveResultMessage('session:cap', { promptTooLong: true });
    await rt.executeTick();
    saveResultMessage('session:cap', { promptTooLong: true });
    await rt.executeTick();

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

    await rt.executeTick();
    expect(injections.map((i) => i.message)).toEqual(['/compact']);

    const state = recoveryState(rt, runId, executionId) as {
      awaitingContinueSince: number | null;
    };
    state!.awaitingContinueSince = Date.now() - (COMPACT_RESULT_TIMEOUT_MS + 1000);
    await rt.executeTick();

    expectEscalated(runId, executionId, 'the /compact turn did not produce a result within');
  });

  test('resumed-turn timeout — reason records the resume-wait path', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const { runId, executionId } = await setupIdleOverflow(rt, 'session:resume-hang');

    await rt.executeTick();
    saveResultMessage('session:resume-hang', { promptTooLong: false });
    await rt.executeTick();

    const state = recoveryState(rt, runId, executionId) as {
      awaitingResumeSince: number | null;
    };
    state!.awaitingResumeSince = Date.now() - (COMPACT_RESULT_TIMEOUT_MS + 1000);
    await rt.executeTick();

    expectEscalated(runId, executionId, 'the resumed turn did not produce a result within');
  });

  test('auto-compact triggers BEFORE continuation (compact-then-continue order)', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    await setupIdleOverflow(rt, 'session:order');

    await rt.executeTick();
    expect(injections[0].message).toBe('/compact');
    expect(injections.some((i) => i.message === buildPromptTooLongContinueNag())).toBe(false);

    saveResultMessage('session:order', { promptTooLong: false });
    await rt.executeTick();
    expect(injections.at(-1)!.message).toBe(buildPromptTooLongContinueNag());
  });
});

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

    expect(injections.some((i) => i.message === '/compact')).toBe(true);
    expect(injections.some((i) => i.message.includes('[Runtime recovery — terminal error]'))).toBe(
      false
    );
    expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('idle');
  });
});
