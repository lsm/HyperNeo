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
  buildPromptTooLongContinueNag,
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
  inject: (sessionId: string, message: string) => Promise<string>
) {
  const spawned: string[] = [];
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
    opts: { promptTooLong?: boolean; minutesAgo?: number }
  ): void {
    const message = {
      type: 'result',
      subtype: opts.promptTooLong ? 'error_during_execution' : 'success',
      is_error: !!opts.promptTooLong,
      terminal_reason: opts.promptTooLong ? 'prompt_too_long' : 'completed',
      errors: opts.promptTooLong ? ['prompt is too long: 205616 tokens > 200000 maximum'] : [],
      result: opts.promptTooLong ? '' : 'ok',
    };
    sdkMessageRepo.saveSDKMessage(sessionId, message as never);
    const minutesAgo = opts.minutesAgo ?? 20;
    const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    db.prepare(`UPDATE sdk_messages SET timestamp = ? WHERE session_id = ?`).run(ts, sessionId);
  }

  /** Remove every SDK message for a session (used to swap the "last" message). */
  function clearMessages(sessionId: string): void {
    db.prepare(`DELETE FROM sdk_messages WHERE session_id = ?`).run(sessionId);
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

  test('compacts then continues when an idle execution overflows', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const tam = makeMockTaskAgentManager(
      taskRepo,
      nodeExecutionRepo,
      async (sessionId, message) => {
        injections.push({ sessionId, message });
        return `injected:${injections.length}`;
      }
    );
    const rt = new SpaceRuntime(buildConfig(tam));
    const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
      { id: STEP_A, name: 'Work', agentId: AGENT },
    ]);
    const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
    const sessionId = 'session:overflow';
    nodeExecutionRepo.update(execution.id, { status: 'idle', agentSessionId: sessionId });
    saveResultMessage(sessionId, { promptTooLong: true });

    // Tick 1: overflow detected → inject /compact FIRST.
    await rt.executeTick();
    expect(injections.map((i) => i.message)).toEqual(['/compact']);
    const state = promptTooLongRecoveryMap(rt).get(`${run.id}:${execution.id}`);
    expect(state?.compactAttempts).toBe(1);
    expect(state?.awaitingContinue).toBe(true);

    // Simulate compaction completing: replace the last message with a success result.
    clearMessages(sessionId);
    saveResultMessage(sessionId, { promptTooLong: false });

    // Tick 2: last message no longer overflow → inject the continue nag.
    await rt.executeTick();
    expect(injections.map((i) => i.message)).toEqual(['/compact', buildPromptTooLongContinueNag()]);
    expect(promptTooLongRecoveryMap(rt).get(`${run.id}:${execution.id}`)?.awaitingContinue).toBe(
      false
    );
  });

  test('does not double-inject /compact while awaiting the compacted result', async () => {
    const injections: string[] = [];
    const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, async (_sid, message) => {
      injections.push(message);
      return 'ok';
    });
    const rt = new SpaceRuntime(buildConfig(tam));
    const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
      { id: STEP_A, name: 'Work', agentId: AGENT },
    ]);
    const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
    const sessionId = 'session:overflow2';
    nodeExecutionRepo.update(execution.id, { status: 'idle', agentSessionId: sessionId });
    saveResultMessage(sessionId, { promptTooLong: true });

    await rt.executeTick();
    // The last message is still the overflow result — a second tick must NOT
    // inject another /compact (awaitingContinue guard).
    await rt.executeTick();
    expect(injections).toEqual(['/compact']);
    expect(promptTooLongRecoveryMap(rt).get(`${run.id}:${execution.id}`)?.compactAttempts).toBe(1);
  });

  test('escalates to blocked after MAX attempts when compaction cannot help', async () => {
    const injections: string[] = [];
    const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, async (_sid, message) => {
      injections.push(message);
      return 'ok';
    });
    const rt = new SpaceRuntime(buildConfig(tam));
    const workflow = buildLinearWorkflow(SPACE_ID, workflowManager, [
      { id: STEP_A, name: 'Work', agentId: AGENT },
    ]);
    const { run } = await rt.startWorkflowRun(SPACE_ID, workflow.id, 'Run');
    const execution = nodeExecutionRepo.listByWorkflowRun(run.id)[0];
    const sessionId = 'session:unrecoverable';
    nodeExecutionRepo.update(execution.id, { status: 'idle', agentSessionId: sessionId });

    const continueNag = buildPromptTooLongContinueNag();
    // Realistic "compaction can't help" cycle: each /compact shrinks context
    // (success result → continue nag), but the session re-overflows on the next
    // turn because a single message already exceeds the limit.
    // Cycle 1
    saveResultMessage(sessionId, { promptTooLong: true });
    await rt.executeTick(); // → /compact (attempt 1)
    clearMessages(sessionId);
    saveResultMessage(sessionId, { promptTooLong: false });
    await rt.executeTick(); // → continue nag
    // Cycle 2
    clearMessages(sessionId);
    saveResultMessage(sessionId, { promptTooLong: true });
    await rt.executeTick(); // → /compact (attempt 2)
    clearMessages(sessionId);
    saveResultMessage(sessionId, { promptTooLong: false });
    await rt.executeTick(); // → continue nag
    // Cycle 3: attempts exhausted → escalate to blocked
    clearMessages(sessionId);
    saveResultMessage(sessionId, { promptTooLong: true });
    await rt.executeTick();

    expect(injections).toEqual(['/compact', continueNag, '/compact', continueNag]);
    const updated = nodeExecutionRepo.getById(execution.id);
    expect(updated?.status).toBe('blocked');
    expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
    expect(promptTooLongRecoveryMap(rt).has(`${run.id}:${execution.id}`)).toBe(false);
  });
});
