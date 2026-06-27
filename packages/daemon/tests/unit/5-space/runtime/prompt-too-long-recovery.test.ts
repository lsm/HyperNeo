/**
 * Prompt-too-long recovery — unit + tick-loop integration tests.
 *
 * Covers:
 *  - `isPromptTooLongResult` detection (terminal_reason + errors[] variants).
 *  - The compact-then-continue state machine driven through the runtime tick:
 *    overflow result → inject `/compact` → compacted result → continue nag.
 *  - Bounded retries: repeated overflow escalates the execution to `blocked`.
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
import type { SpaceWorkflow } from '@neokai/shared';
import {
  isPromptTooLongResult,
  isPromptTooLongUserMessage,
  isPromptTooLongErrorMessage,
  buildPromptTooLongContinueNag,
  COMPACT_RESULT_TIMEOUT_MS,
  MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS,
} from '../../../../src/lib/space/runtime/prompt-too-long-recovery';

// ---------------------------------------------------------------------------
// DB helpers (mirrors space-runtime-tick-loop.test.ts)
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
    name: `Test Workflow ${Date.now()}-${Math.random()}`,
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
// Mock TaskAgentManager
// ---------------------------------------------------------------------------

function makeMockTaskAgentManager(
  taskRepo: SpaceTaskRepository,
  nodeExecutionRepo: NodeExecutionRepository,
  sdkMessages: SDKMessageRepository,
  db: BunDatabase,
  options: {
    inject?: (sessionId: string, message: string) => Promise<string>;
    /** Simulate a real injection that cannot deliver (throws). */
    injectThrows?: boolean;
  } = {}
) {
  const spawned: string[] = [];
  const defaultInject = async (sessionId: string, message: string): Promise<string> => {
    // Mirror production injectMessageIntoSession: persist the injected message
    // with send_status='enqueued'. Critically, getLastSDKMessage EXCLUDES
    // enqueued user messages (sdk-message-repository.ts:995), so the injected
    // /compact is invisible to the idle sweep until the SDK consumes it —
    // exactly like production. Simulating this is what makes the message-advance
    // detection test meaningful.
    sdkMessages.saveSDKMessage(sessionId, {
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
  const inject = options.injectThrows
    ? async (_sid: string, _msg: string) => {
        throw new Error('session could not be rehydrated');
      }
    : (options.inject ?? defaultInject);
  return {
    isSpawning: () => false,
    isTaskAgentAlive: () => false,
    spawnWorkflowNodeAgent: async (task: unknown) => {
      const t = task as { id: string };
      spawned.push(t.id);
      taskRepo.updateTask(t.id, { taskAgentSessionId: `session:${t.id}` });
      return `session:${t.id}`;
    },
    isExecutionSpawning: () => false,
    isSessionAlive: () => true,
    spawnWorkflowNodeAgentForExecution: async (
      task: unknown,
      _space: unknown,
      _workflow: unknown,
      _run: unknown,
      execution: unknown
    ) => {
      const e = execution as { id?: string };
      const t = task as { id?: string };
      const executionId = e.id ?? t.id ?? `exec-${Math.random().toString(36).slice(2)}`;
      const sessionId = `session:${executionId}`;
      spawned.push(t.id ?? executionId);
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
    rehydrate: async () => {},
    cancelBySessionId: () => {},
    interruptBySessionId: async () => {},
    restartStuckSubSession: async () => {},
    injectRuntimeRecoveryMessage: inject,
    getAgentSessionById: () => ({ getProcessingState: () => ({ status: 'processing' }) }),
    injectIntoTaskAgent: async () => ({ injected: false, reason: 'no-session' }),
    _spawned: spawned,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isPromptTooLongResult', () => {
  test('matches result with terminal_reason prompt_too_long', () => {
    const msg = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'prompt_too_long',
      errors: [],
    };
    expect(isPromptTooLongResult(msg as never)).toBe(true);
  });

  test('matches result with prompt-too-long error body (no terminal_reason)', () => {
    const msg = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['prompt is too long: 205616 tokens > 200000 maximum'],
    };
    expect(isPromptTooLongResult(msg as never)).toBe(true);
  });

  test('matches prompt-too-long error body without N>M form', () => {
    const msg = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Prompt is too long'],
    };
    expect(isPromptTooLongResult(msg as never)).toBe(true);
  });

  test('rejects success result', () => {
    const msg = { type: 'result', subtype: 'success', is_error: false, errors: [] };
    expect(isPromptTooLongResult(msg as never)).toBe(false);
  });

  test('rejects max_turns error result', () => {
    const msg = {
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      terminal_reason: 'max_turns',
      errors: ['max_turns exceeded'],
    };
    expect(isPromptTooLongResult(msg as never)).toBe(false);
  });

  test('rejects non-result messages and null', () => {
    expect(isPromptTooLongResult({ type: 'assistant' } as never)).toBe(false);
    expect(isPromptTooLongResult(null)).toBe(false);
    expect(isPromptTooLongResult(undefined)).toBe(false);
  });
});

describe('isPromptTooLongUserMessage', () => {
  test('matches bare "Prompt is too long" inside user message text', () => {
    const msg = {
      type: 'user',
      message: {
        role: 'user',
        content: '<local-command-stderr>Prompt is too long</local-command-stderr>',
      },
      parent_tool_use_id: null,
    };
    expect(isPromptTooLongUserMessage(msg as never)).toBe(true);
  });

  test('matches detailed "N tokens > M maximum" form', () => {
    const msg = {
      type: 'user',
      message: {
        role: 'user',
        content:
          '<local-command-stderr>Error: prompt is too long: 205616 tokens > 200000 maximum</local-command-stderr>',
      },
      parent_tool_use_id: null,
    };
    expect(isPromptTooLongUserMessage(msg as never)).toBe(true);
  });

  test('matches prompt-too-long in array content blocks', () => {
    const msg = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<local-command-stderr>Prompt is too long: 1234 tokens > 1000 maximum</local-command-stderr>',
          },
        ],
      },
      parent_tool_use_id: null,
    };
    expect(isPromptTooLongUserMessage(msg as never)).toBe(true);
  });

  test('rejects user message containing the phrase outside stderr tags', () => {
    const msg = {
      type: 'user',
      message: { role: 'user', content: 'The model said Prompt is too long' },
      parent_tool_use_id: null,
    };
    expect(isPromptTooLongUserMessage(msg as never)).toBe(false);
  });

  test('rejects unrelated user message', () => {
    const msg = {
      type: 'user',
      message: { role: 'user', content: 'Please continue the task' },
      parent_tool_use_id: null,
    };
    expect(isPromptTooLongUserMessage(msg as never)).toBe(false);
  });

  test('rejects result messages and null', () => {
    expect(
      isPromptTooLongUserMessage({ type: 'result', terminal_reason: 'prompt_too_long' } as never)
    ).toBe(false);
    expect(isPromptTooLongUserMessage(null)).toBe(false);
    expect(isPromptTooLongUserMessage(undefined)).toBe(false);
  });
});

describe('isPromptTooLongErrorMessage', () => {
  test('matches result and user-message overflow forms', () => {
    const resultMsg = {
      type: 'result',
      terminal_reason: 'prompt_too_long',
      errors: [],
    };
    const userMsg = {
      type: 'user',
      message: {
        role: 'user',
        content: '<local-command-stderr>Prompt is too long</local-command-stderr>',
      },
      parent_tool_use_id: null,
    };
    expect(isPromptTooLongErrorMessage(resultMsg as never)).toBe(true);
    expect(isPromptTooLongErrorMessage(userMsg as never)).toBe(true);
    expect(isPromptTooLongErrorMessage({ type: 'assistant' } as never)).toBe(false);
  });
});

describe('SpaceRuntime — prompt-too-long recovery', () => {
  let db: BunDatabase;
  let workflowRunRepo: SpaceWorkflowRunRepository;
  let taskRepo: SpaceTaskRepository;
  let agentManager: SpaceAgentManager;
  let workflowManager: SpaceWorkflowManager;
  let spaceManager: SpaceManager;
  let nodeExecutionRepo: NodeExecutionRepository;
  let sdkMessageRepo: SDKMessageRepository;
  let internalEventBus: InternalEventBus<DaemonInternalEventMap>;

  const SPACE_ID = 'space-ptl';
  const AGENT = 'agent-worker';
  const STEP_A = 'step-a';

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

  /** Save a result SDK message as the last message for a session. */
  function saveResultMessage(
    sessionId: string,
    opts: { promptTooLong?: boolean; nonOverflowError?: boolean; minutesAgo?: number }
  ): void {
    const message = {
      type: 'result',
      subtype: opts.promptTooLong
        ? 'error_during_execution'
        : opts.nonOverflowError
          ? 'error_during_execution'
          : 'success',
      is_error: !!(opts.promptTooLong || opts.nonOverflowError),
      terminal_reason: opts.promptTooLong ? 'prompt_too_long' : 'completed',
      errors: opts.promptTooLong
        ? ['prompt is too long: 205616 tokens > 200000 maximum']
        : opts.nonOverflowError
          ? ['API Error: 500 Internal Server Error']
          : [],
      result: opts.promptTooLong || opts.nonOverflowError ? '' : 'ok',
    };
    sdkMessageRepo.saveSDKMessage(sessionId, message as never);
    const minutesAgo = opts.minutesAgo ?? 20;
    const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    db.prepare(`UPDATE sdk_messages SET timestamp = ? WHERE session_id = ?`).run(ts, sessionId);
  }

  /** Save a user SDK message as the last message for a session. */
  function saveUserMessage(
    sessionId: string,
    content: string,
    opts: { minutesAgo?: number } = {}
  ): void {
    sdkMessageRepo.saveSDKMessage(sessionId, {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    } as never);
    const minutesAgo = opts.minutesAgo ?? 20;
    const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    db.prepare(`UPDATE sdk_messages SET timestamp = ? WHERE session_id = ?`).run(ts, sessionId);
  }

  function promptTooLongRecoveryMap(
    rt: SpaceRuntime
  ): Map<string, { compactAttempts: number; awaitingContinue: boolean }> {
    return (
      rt as unknown as {
        promptTooLongRecovery: Map<string, { compactAttempts: number; awaitingContinue: boolean }>;
      }
    ).promptTooLongRecovery;
  }

  /** Build a TAM whose inject persists the message (like production) and records calls. */
  function makeRecordingTam(injections: Array<{ sessionId: string; message: string }>): unknown {
    return makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, sdkMessageRepo, db, {
      inject: async (sessionId, message) => {
        injections.push({ sessionId, message });
        // Mirror production: persist with send_status='enqueued' (excluded from
        // getLastSDKMessage until consumed).
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
      },
    });
  }

  async function setupIdleOverflowExecution(
    rt: SpaceRuntime,
    sessionId: string,
    promptTooLong = true
  ): Promise<{ run: { id: string }; execution: { id: string } }> {
    const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
      { id: STEP_A, name: 'Work', agentId: AGENT },
    ]);
    const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
    nodeExecutionRepo.update(execution.id, { status: 'idle', agentSessionId: sessionId });
    saveResultMessage(sessionId, { promptTooLong });
    return { run, execution };
  }

  async function setupIdleUserOverflowExecution(
    rt: SpaceRuntime,
    sessionId: string,
    content = '<local-command-stderr>Prompt is too long: 205616 tokens > 200000 maximum</local-command-stderr>'
  ): Promise<{ run: { id: string }; execution: { id: string } }> {
    const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
      { id: STEP_A, name: 'Work', agentId: AGENT },
    ]);
    const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
    nodeExecutionRepo.update(execution.id, { status: 'idle', agentSessionId: sessionId });
    saveUserMessage(sessionId, content);
    return { run, execution };
  }

  test('compacts then continues when an idle execution overflows', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:overflow';
    const { run, execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    // Tick 1: overflow detected → inject /compact FIRST.
    await rt.executeTick();
    expect(injections.map((i) => i.message)).toEqual(['/compact']);
    const state = promptTooLongRecoveryMap(rt).get(`${run.id}:${execution.id}`);
    expect(state?.compactAttempts).toBe(1);
    expect(state?.awaitingContinue).toBe(true);

    // Tick 2: the injected /compact is now the last (non-terminal) message — the
    // recovery must still fire (it is not gated on classification.terminal) and
    // wait, not re-inject.
    await rt.executeTick();
    expect(injections.map((i) => i.message)).toEqual(['/compact']);

    // Simulate compaction completing: a success result lands (newer than /compact).
    saveResultMessage(sessionId, { promptTooLong: false });

    // Tick 3: last message advanced past /compact and is non-overflow → continue nag.
    await rt.executeTick();
    expect(injections.map((i) => i.message)).toEqual(['/compact', buildPromptTooLongContinueNag()]);
  });

  test('compacts then continues when the overflow is reported as a Kimi user-message stderr', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:kimi-overflow';
    const { run, execution } = await setupIdleUserOverflowExecution(rt, sessionId);

    // Tick 1: user-message overflow detected → inject /compact FIRST.
    await rt.executeTick();
    expect(injections.map((i) => i.message)).toEqual(['/compact']);
    const state = promptTooLongRecoveryMap(rt).get(`${run.id}:${execution.id}`);
    expect(state?.compactAttempts).toBe(1);
    expect(state?.awaitingContinue).toBe(true);

    // Tick 2: the injected /compact is invisible; recovery waits, not re-injects.
    await rt.executeTick();
    expect(injections.map((i) => i.message)).toEqual(['/compact']);

    // Simulate compaction completing: a success result lands.
    saveResultMessage(sessionId, { promptTooLong: false });

    // Tick 3: continue nag after successful compaction.
    await rt.executeTick();
    expect(injections.map((i) => i.message)).toEqual(['/compact', buildPromptTooLongContinueNag()]);
  });

  test('re-compacts immediately when the /compact turn re-overflows as a Kimi user message', async () => {
    // P2: a newer prompt-too-long user message must clear awaitingContinue and be
    // treated as a completed overflow turn, not left to wait for COMPACT_RESULT_TIMEOUT_MS.
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:kimi-reoverflow';
    const { run, execution } = await setupIdleUserOverflowExecution(rt, sessionId);

    await rt.executeTick(); // → /compact (attempt 1)
    // The /compact turn itself hits the same Kimi overflow, surfaced as a user message.
    saveUserMessage(
      sessionId,
      '<local-command-stderr>Prompt is too long: 205616 tokens > 200000 maximum</local-command-stderr>'
    );
    await rt.executeTick(); // → /compact (attempt 2), no timeout wait
    saveUserMessage(
      sessionId,
      '<local-command-stderr>Prompt is too long: 205616 tokens > 200000 maximum</local-command-stderr>'
    );
    await rt.executeTick(); // attempts exhausted → blocked

    expect(injections.map((i) => i.message)).toEqual(['/compact', '/compact']);
    expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('blocked');
    expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
  });

  test('does not double-inject /compact while awaiting the compacted result', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const { run, execution } = await setupIdleOverflowExecution(rt, 'session:overflow2', true);

    await rt.executeTick(); // inject /compact
    // The injected /compact is the last message; awaitingContinue is set. Two
    // more ticks must NOT inject another /compact.
    await rt.executeTick();
    await rt.executeTick();
    expect(injections.map((i) => i.message)).toEqual(['/compact']);
    expect(promptTooLongRecoveryMap(rt).get(`${run.id}:${execution.id}`)?.compactAttempts).toBe(1);
  });

  test('does not stall when a fresh overflow result follows the /compact', async () => {
    // P1: if the /compact turn itself ends with another prompt-too-long result,
    // the message-advance detection must clear the wait and escalate after MAX.
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:fresh-overflow';
    const { run, execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    // Tick 1: inject /compact (attempt 1).
    await rt.executeTick();
    // The /compact turn ends with ANOTHER overflow (compaction couldn't shrink).
    saveResultMessage(sessionId, { promptTooLong: true });
    // Tick 2: new overflow result → advance detection clears awaiting → attempt 2.
    await rt.executeTick();
    saveResultMessage(sessionId, { promptTooLong: true });
    // Tick 3: attempts exhausted (2) → escalate to blocked.
    await rt.executeTick();

    expect(injections.map((i) => i.message)).toEqual(['/compact', '/compact']);
    const updated = nodeExecutionRepo.getById(execution.id);
    expect(updated?.status).toBe('blocked');
    expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
    expect(promptTooLongRecoveryMap(rt).has(`${run.id}:${execution.id}`)).toBe(false);
  });

  test('does not stall when /compact injection fails', async () => {
    // P1: a thrown injectRuntimeRecoveryMessage must not leave awaitingContinue
    // set; failed attempts count toward the cap and escalate instead of looping
    // forever on the same overflow result.
    const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, sdkMessageRepo, db, {
      injectThrows: true,
    });
    const rt = new SpaceRuntime(buildConfig(tam));
    const { run, execution } = await setupIdleOverflowExecution(rt, 'session:inject-fail', true);

    // After at least one failed inject, awaitingContinue must NOT be set (the bug
    // would leave it true and stall forever on subsequent ticks).
    await rt.executeTick();
    const stateAfterFail = promptTooLongRecoveryMap(rt).get(`${run.id}:${execution.id}`);
    expect(stateAfterFail?.awaitingContinue).toBe(false);
    expect(stateAfterFail?.compactAttempts).toBeGreaterThan(0);

    // Keep ticking — failed attempts accumulate and escalate to blocked rather
    // than retrying indefinitely.
    for (let i = 0; i < 5 && nodeExecutionRepo.getById(execution.id)?.status !== 'blocked'; i++) {
      await rt.executeTick();
    }
    expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('blocked');
  });

  test('does not block a long-running worker whose compactions are productive', async () => {
    // A worker that compacts, makes real progress (a normal terminal result),
    // and only later re-fills context must not be penalised: the progress result
    // clears the recovery state via the terminal-skip path, so the next overflow
    // starts fresh. Contrast with immediate re-overflow (no progress), which
    // accumulates and escalates.
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:long-running';
    const { run, execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    const continueNag = buildPromptTooLongContinueNag();
    // Three productive cycles. Between each, the resumed turn produces a normal
    // success result (progress) which the terminal-skip path uses to clear state.
    for (let cycle = 0; cycle < 3; cycle++) {
      await rt.executeTick(); // → /compact (fresh attempt, state was cleared)
      saveResultMessage(sessionId, { promptTooLong: false }); // compact succeeded
      await rt.executeTick(); // → continue nag
      // Resumed turn completes normally — terminal-skip clears recovery state.
      saveResultMessage(sessionId, { promptTooLong: false });
      await rt.executeTick();
      saveResultMessage(sessionId, { promptTooLong: true }); // re-overflow later
    }

    expect(injections.map((i) => i.message)).toEqual([
      '/compact',
      continueNag,
      '/compact',
      continueNag,
      '/compact',
      continueNag,
    ]);
    expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('idle');
    expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
    // No lingering recovery state (cleared by the last progress result).
    expect(promptTooLongRecoveryMap(rt).has(`${run.id}:${execution.id}`)).toBe(false);
  });

  test('blocks when compaction succeeds but the resume immediately re-overflows', async () => {
    // The counter is NOT reset on nag delivery. If compaction succeeds but the
    // resumed turn immediately re-overflows (no progress result in between),
    // attempts accumulate and escalate — no infinite success→nag→overflow loop.
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:edge-overflow';
    const { run, execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    // Cycle 1: compact succeeds, continue nag, then immediate re-overflow.
    await rt.executeTick(); // → /compact (attempt 1)
    saveResultMessage(sessionId, { promptTooLong: false });
    await rt.executeTick(); // → continue nag (attempts NOT reset)
    saveResultMessage(sessionId, { promptTooLong: true }); // immediate re-overflow
    // Cycle 2: attempts now 1 → /compact (attempt 2)
    await rt.executeTick();
    saveResultMessage(sessionId, { promptTooLong: false });
    await rt.executeTick(); // → continue nag (attempts=2)
    saveResultMessage(sessionId, { promptTooLong: true }); // immediate re-overflow
    // Cycle 3: attempts=2 >= MAX → blocked
    await rt.executeTick();

    expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('blocked');
    expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
  });

  test('preserves attempts while the resume nag is enqueued (no premature reset)', async () => {
    // Round-7 regression: the continue nag is an enqueued user message invisible
    // to getLastSDKMessage, so the sweep keeps seeing the compact-success result.
    // Without the awaitingResume hold, the terminal-skip would clear the recovery
    // state (resetting compactAttempts) before the resumed turn advances. Verify
    // the state — and compactAttempts — survive ticks in that window.
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:nag-enqueued';
    const { run, execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    await rt.executeTick(); // → /compact (attempt 1)
    saveResultMessage(sessionId, { promptTooLong: false }); // compact success
    await rt.executeTick(); // → continue nag delivered (awaitingResume=true)

    // The nag is enqueued; getLastSDKMessage still returns the compact-success
    // result. Multiple ticks must NOT clear/reset the state.
    await rt.executeTick();
    await rt.executeTick();
    const preserved = promptTooLongRecoveryMap(rt).get(`${run.id}:${execution.id}`);
    expect(preserved?.compactAttempts).toBe(1); // still preserved, not reset

    // Now the resumed turn immediately re-overflows → re-compact with attempts
    // preserved (attempt 2), not a fresh attempt 1.
    saveResultMessage(sessionId, { promptTooLong: true });
    await rt.executeTick();
    expect(injections.filter((i) => i.message === '/compact').length).toBe(2);
  });

  test('preserves attempts even when the resume nag is consumed (visible)', async () => {
    // Round-8 regression: production consumes the nag before
    // injectRuntimeRecoveryMessage returns (enqueueWithId resolves after the SDK
    // consumes it), so getLastSDKMessage INCLUDES the nag as a user message.
    // awaitingResume must still wait for a resumed-turn RESULT, not clear on the
    // consumed nag itself — otherwise attempts reset and the edge loop recurs.
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:nag-consumed';
    const { run, execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    await rt.executeTick(); // → /compact (attempt 1)
    saveResultMessage(sessionId, { promptTooLong: false }); // compact success
    await rt.executeTick(); // → continue nag delivered (awaitingResume=true)

    // Simulate production: the nag is consumed (visible to getLastSDKMessage).
    db.prepare(
      `UPDATE sdk_messages SET send_status = 'consumed'
       WHERE id = (
         SELECT id FROM sdk_messages
         WHERE session_id = ? AND message_type = 'user'
         ORDER BY timestamp DESC, rowid DESC LIMIT 1
       )`
    ).run(sessionId);

    // Tick with the consumed nag as the last message — must NOT clear the state
    // (the nag is a user message, not a resumed-turn result).
    await rt.executeTick();
    const preserved = promptTooLongRecoveryMap(rt).get(`${run.id}:${execution.id}`);
    expect(preserved?.compactAttempts).toBe(1);

    // Resumed turn overflows → re-compact with attempts preserved (attempt 2).
    saveResultMessage(sessionId, { promptTooLong: true });
    await rt.executeTick();
    expect(injections.filter((i) => i.message === '/compact').length).toBe(2);
  });

  test('escalates to blocked when the resumed turn hangs (resume-wait timeout)', async () => {
    // P2: if the resumed turn never produces a result after the continue nag,
    // awaitingResume must not wait forever — escalate after COMPACT_RESULT_TIMEOUT_MS.
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:hung-resume';
    const { run, execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    await rt.executeTick(); // → /compact
    saveResultMessage(sessionId, { promptTooLong: false }); // compact success
    await rt.executeTick(); // → continue nag (awaitingResume=true)

    // Simulate the resumed turn hanging (no result ever lands).
    const states = (
      rt as unknown as {
        promptTooLongRecovery: Map<string, { awaitingResumeSince: number | null }>;
      }
    ).promptTooLongRecovery;
    const state = states.get(`${run.id}:${execution.id}`);
    expect(state?.awaitingResumeSince).not.toBeNull();
    state!.awaitingResumeSince = Date.now() - (COMPACT_RESULT_TIMEOUT_MS + 1000);

    await rt.executeTick(); // → resume-wait timeout → blocked
    expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('blocked');
    expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
  });

  test('processes a resumed success past the timeout window instead of blocking', async () => {
    // Round-10: a visible resumed-turn RESULT is processed BEFORE the timeout —
    // a turn that took longer than the window but completed must not be mis-blocked.
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:late-success';
    const { run, execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    await rt.executeTick(); // → /compact
    saveResultMessage(sessionId, { promptTooLong: false }); // compact success
    await rt.executeTick(); // → continue nag (awaitingResume=true)

    // Simulate the tick loop being delayed past the timeout, but the resumed
    // turn DID produce a (late) success result.
    const states = (
      rt as unknown as {
        promptTooLongRecovery: Map<string, { awaitingResumeSince: number | null }>;
      }
    ).promptTooLongRecovery;
    const state = states.get(`${run.id}:${execution.id}`);
    state!.awaitingResumeSince = Date.now() - (COMPACT_RESULT_TIMEOUT_MS + 1000);
    saveResultMessage(sessionId, { promptTooLong: false }); // resumed success

    await rt.executeTick(); // → processes the result (productive), NOT blocked
    expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('idle');
    expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
  });

  test('re-compacts when the resumed turn errors (non-overflow), not silent clear', async () => {
    // P2: a non-overflow ERROR result from the resumed turn (auth/rate-limit) is
    // not "productive progress" — route it to re-compact/escalate instead of
    // silently clearing the recovery state and leaving the run idle.
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:resume-error';
    const { execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    await rt.executeTick(); // → /compact (attempt 1)
    saveResultMessage(sessionId, { promptTooLong: false }); // compact success
    await rt.executeTick(); // → continue nag
    // Resumed turn errors with a non-overflow error.
    saveResultMessage(sessionId, { nonOverflowError: true });
    await rt.executeTick(); // → re-compact (attempt 2, NOT a silent clear)

    // No continue nag should have been sent for the errored resume, and a second
    // /compact was injected (re-compact path, not productive clear).
    expect(injections.some((i) => i.message === buildPromptTooLongContinueNag())).toBe(true); // the one productive nag after compact success
    expect(injections.filter((i) => i.message === '/compact').length).toBe(2);
  });

  test('escalates to blocked when the /compact turn hangs (wait timeout)', async () => {
    // P2: if the /compact turn never produces a result, awaitingContinue must not
    // wait forever — the recovery escalates after COMPACT_RESULT_TIMEOUT_MS.
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:hung-compact';
    const { run, execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    // Tick 1: inject /compact. The turn "hangs" — no result lands.
    await rt.executeTick();
    expect(injections.map((i) => i.message)).toEqual(['/compact']);

    // Simulate the timeout elapsing with no result (the /compact is still the
    // last message, so the wait has not cleared).
    const states = (
      rt as unknown as {
        promptTooLongRecovery: Map<string, { awaitingContinueSince: number | null }>;
      }
    ).promptTooLongRecovery;
    const state = states.get(`${run.id}:${execution.id}`);
    expect(state?.awaitingContinueSince).not.toBeNull();
    state!.awaitingContinueSince = Date.now() - (COMPACT_RESULT_TIMEOUT_MS + 1000);

    await rt.executeTick(); // → timeout → blocked

    expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('blocked');
    expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
  });

  test('retries then escalates when the resume nag cannot be delivered', async () => {
    // P2: a failed continue-nag injection must not be silently swallowed — it
    // retries and escalates to blocked if delivery keeps failing.
    const injections: Array<{ sessionId: string; message: string }> = [];
    // /compact succeeds, but the continue nag always fails.
    let injectCallCount = 0;
    const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, sdkMessageRepo, db, {
      inject: async (sessionId, message) => {
        injectCallCount += 1;
        if (message === '/compact') {
          // /compact persists + returns dbId (success)
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
          return row.id;
        }
        // continue nag always fails
        injections.push({ sessionId, message });
        throw new Error('session gone');
      },
    });
    const rt = new SpaceRuntime(buildConfig(tam));
    const sessionId = 'session:nag-fail';
    const { run, execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    await rt.executeTick(); // → /compact (succeeds)
    saveResultMessage(sessionId, { promptTooLong: false }); // compaction succeeded
    await rt.executeTick(); // → continue nag (fails, attempt 1)
    await rt.executeTick(); // → continue nag (fails, attempt 2) → blocked

    expect(injections.filter((i) => i.message !== '/compact').length).toBeGreaterThanOrEqual(2);
    expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('blocked');
  });

  test('re-compacts instead of resuming when /compact errors (non-overflow)', async () => {
    // P2: a non-overflow ERROR result (model/auth/rate-limit) means compaction
    // failed — the recovery must NOT treat it as success and resume into an
    // unchanged over-limit context. It re-compacts (counting as unproductive).
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:compact-error';
    const { run, execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    await rt.executeTick(); // → /compact (attempt 1)
    // The /compact turn fails with a NON-overflow error.
    saveResultMessage(sessionId, { nonOverflowError: true });
    await rt.executeTick(); // → re-compact (attempt 2), NOT a continue nag
    // Still failing → re-compact attempt 2 already used; another error escalates.
    saveResultMessage(sessionId, { nonOverflowError: true });
    await rt.executeTick(); // attempts exhausted → blocked

    // No continue nag should ever have been sent (compaction never succeeded).
    expect(injections.some((i) => i.message === buildPromptTooLongContinueNag())).toBe(false);
    expect(injections.filter((i) => i.message === '/compact').length).toBeGreaterThanOrEqual(2);
    expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('blocked');
  });

  test('detaches the overflowed session when escalating to blocked', async () => {
    // P2: escalation clears agentSessionId so the bounded blocked-run retry
    // spawns fresh instead of resurrecting the terminal-overflow session.
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:block-clear';
    const { execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    // Force exhaustion: two unproductive compactions (fresh overflow each time).
    await rt.executeTick(); // /compact 1
    saveResultMessage(sessionId, { promptTooLong: true });
    await rt.executeTick(); // /compact 2
    saveResultMessage(sessionId, { promptTooLong: true });
    await rt.executeTick(); // → blocked

    const blocked = nodeExecutionRepo.getById(execution.id);
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.agentSessionId).toBeNull();
  });
});
