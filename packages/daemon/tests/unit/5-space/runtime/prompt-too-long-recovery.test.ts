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
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';
import type { SpaceRuntimeConfig } from '../../../../src/lib/space/runtime/space-runtime.ts';
import type { SpaceWorkflow } from '@hyperneo/shared';
import {
  isPromptTooLongResult,
  isPromptTooLongUserMessage,
  isPromptTooLongErrorMessage,
  buildPromptTooLongContinueNag,
  COMPACT_RESULT_TIMEOUT_MS,
  MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS,
} from '../../../../src/lib/space/runtime/prompt-too-long-recovery';

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

function makeMockTaskAgentManager(
  taskRepo: SpaceTaskRepository,
  nodeExecutionRepo: NodeExecutionRepository,
  sdkMessages: SDKMessageRepository,
  db: BunDatabase,
  options: {
    inject?: (sessionId: string, message: string) => Promise<string>;
    injectThrows?: boolean;
  } = {}
) {
  const spawned: string[] = [];
  const defaultInject = async (sessionId: string, message: string): Promise<string> => {
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

  test('matches Kimi blocking_limit result with phrase in result text (no errors[], no prompt_too_long reason)', () => {
    const msg = {
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Prompt is too long',
      terminal_reason: 'blocking_limit',
      errors: null,
      stop_reason: 'stop_sequence',
      api_error_status: null,
    };
    expect(isPromptTooLongResult(msg as never)).toBe(true);
  });

  test('matches detailed "N tokens > M maximum" phrase in result text', () => {
    const msg = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'Error: prompt is too long: 205616 tokens > 200000 maximum',
      terminal_reason: 'blocking_limit',
      errors: null,
    };
    expect(isPromptTooLongResult(msg as never)).toBe(true);
  });

  test('rejects blocking_limit result whose result text is not prompt-too-long', () => {
    const msg = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'Rate limit exceeded, please retry',
      terminal_reason: 'blocking_limit',
      errors: null,
    };
    expect(isPromptTooLongResult(msg as never)).toBe(false);
  });

  test('rejects non-error result whose text happens to contain the phrase', () => {
    const msg = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Noted the model said prompt is too long earlier',
      terminal_reason: 'completed',
      errors: null,
    };
    expect(isPromptTooLongResult(msg as never)).toBe(false);
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

  test('matches Kimi blocking_limit result with phrase in result text', () => {
    const kimiMsg = {
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Prompt is too long',
      terminal_reason: 'blocking_limit',
      errors: null,
      stop_reason: 'stop_sequence',
      api_error_status: null,
    };
    expect(isPromptTooLongErrorMessage(kimiMsg as never)).toBe(true);
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

  function makeRecordingTam(injections: Array<{ sessionId: string; message: string }>): unknown {
    return makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, sdkMessageRepo, db, {
      inject: async (sessionId, message) => {
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

    await rt.executeTick();
    expect(injections.map((i) => i.message)).toEqual(['/compact']);
    const state = promptTooLongRecoveryMap(rt).get(`${run.id}:${execution.id}`);
    expect(state?.compactAttempts).toBe(1);
    expect(state?.awaitingContinue).toBe(true);

    await rt.executeTick();
    expect(injections.map((i) => i.message)).toEqual(['/compact']);

    saveResultMessage(sessionId, { promptTooLong: false });

    await rt.executeTick();
    expect(injections.map((i) => i.message)).toEqual(['/compact', buildPromptTooLongContinueNag()]);
  });

  test('compacts then continues when the overflow is reported as a Kimi user-message stderr', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:kimi-overflow';
    const { run, execution } = await setupIdleUserOverflowExecution(rt, sessionId);

    await rt.executeTick();
    expect(injections.map((i) => i.message)).toEqual(['/compact']);
    const state = promptTooLongRecoveryMap(rt).get(`${run.id}:${execution.id}`);
    expect(state?.compactAttempts).toBe(1);
    expect(state?.awaitingContinue).toBe(true);

    await rt.executeTick();
    expect(injections.map((i) => i.message)).toEqual(['/compact']);

    saveResultMessage(sessionId, { promptTooLong: false });

    await rt.executeTick();
    expect(injections.map((i) => i.message)).toEqual(['/compact', buildPromptTooLongContinueNag()]);
  });

  test('re-compacts immediately when the /compact turn re-overflows as a Kimi user message', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:kimi-reoverflow';
    const { run, execution } = await setupIdleUserOverflowExecution(rt, sessionId);

    await rt.executeTick();
    saveUserMessage(
      sessionId,
      '<local-command-stderr>Prompt is too long: 205616 tokens > 200000 maximum</local-command-stderr>'
    );
    await rt.executeTick();
    saveUserMessage(
      sessionId,
      '<local-command-stderr>Prompt is too long: 205616 tokens > 200000 maximum</local-command-stderr>'
    );
    await rt.executeTick();

    expect(injections.map((i) => i.message)).toEqual(['/compact', '/compact']);
    expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('blocked');
    expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
  });

  test('does not double-inject /compact while awaiting the compacted result', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const { run, execution } = await setupIdleOverflowExecution(rt, 'session:overflow2', true);

    await rt.executeTick();
    await rt.executeTick();
    await rt.executeTick();
    expect(injections.map((i) => i.message)).toEqual(['/compact']);
    expect(promptTooLongRecoveryMap(rt).get(`${run.id}:${execution.id}`)?.compactAttempts).toBe(1);
  });

  test('does not stall when a fresh overflow result follows the /compact', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:fresh-overflow';
    const { run, execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    await rt.executeTick();
    saveResultMessage(sessionId, { promptTooLong: true });
    await rt.executeTick();
    saveResultMessage(sessionId, { promptTooLong: true });
    await rt.executeTick();

    expect(injections.map((i) => i.message)).toEqual(['/compact', '/compact']);
    const updated = nodeExecutionRepo.getById(execution.id);
    expect(updated?.status).toBe('blocked');
    expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
    expect(promptTooLongRecoveryMap(rt).has(`${run.id}:${execution.id}`)).toBe(false);
  });

  test('does not stall when /compact injection fails', async () => {
    const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, sdkMessageRepo, db, {
      injectThrows: true,
    });
    const rt = new SpaceRuntime(buildConfig(tam));
    const { run, execution } = await setupIdleOverflowExecution(rt, 'session:inject-fail', true);

    await rt.executeTick();
    const stateAfterFail = promptTooLongRecoveryMap(rt).get(`${run.id}:${execution.id}`);
    expect(stateAfterFail?.awaitingContinue).toBe(false);
    expect(stateAfterFail?.compactAttempts).toBeGreaterThan(0);

    for (let i = 0; i < 5 && nodeExecutionRepo.getById(execution.id)?.status !== 'blocked'; i++) {
      await rt.executeTick();
    }
    expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('blocked');
  });

  test('does not block a long-running worker whose compactions are productive', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:long-running';
    const { run, execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    const continueNag = buildPromptTooLongContinueNag();
    for (let cycle = 0; cycle < 3; cycle++) {
      await rt.executeTick();
      saveResultMessage(sessionId, { promptTooLong: false });
      await rt.executeTick();
      saveResultMessage(sessionId, { promptTooLong: false });
      await rt.executeTick();
      saveResultMessage(sessionId, { promptTooLong: true });
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
    expect(promptTooLongRecoveryMap(rt).has(`${run.id}:${execution.id}`)).toBe(false);
  });

  test('blocks when compaction succeeds but the resume immediately re-overflows', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:edge-overflow';
    const { run, execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    await rt.executeTick();
    saveResultMessage(sessionId, { promptTooLong: false });
    await rt.executeTick();
    saveResultMessage(sessionId, { promptTooLong: true });
    await rt.executeTick();
    saveResultMessage(sessionId, { promptTooLong: false });
    await rt.executeTick();
    saveResultMessage(sessionId, { promptTooLong: true });
    await rt.executeTick();

    expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('blocked');
    expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
  });

  test('preserves attempts while the resume nag is enqueued (no premature reset)', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:nag-enqueued';
    const { run, execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    await rt.executeTick();
    saveResultMessage(sessionId, { promptTooLong: false });
    await rt.executeTick();

    await rt.executeTick();
    await rt.executeTick();
    const preserved = promptTooLongRecoveryMap(rt).get(`${run.id}:${execution.id}`);
    expect(preserved?.compactAttempts).toBe(1);

    saveResultMessage(sessionId, { promptTooLong: true });
    await rt.executeTick();
    expect(injections.filter((i) => i.message === '/compact').length).toBe(2);
  });

  test('preserves attempts even when the resume nag is consumed (visible)', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:nag-consumed';
    const { run, execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    await rt.executeTick();
    saveResultMessage(sessionId, { promptTooLong: false });
    await rt.executeTick();

    db.prepare(
      `UPDATE sdk_messages SET send_status = 'consumed'
       WHERE id = (
         SELECT id FROM sdk_messages
         WHERE session_id = ? AND message_type = 'user'
         ORDER BY timestamp DESC, rowid DESC LIMIT 1
       )`
    ).run(sessionId);

    await rt.executeTick();
    const preserved = promptTooLongRecoveryMap(rt).get(`${run.id}:${execution.id}`);
    expect(preserved?.compactAttempts).toBe(1);

    saveResultMessage(sessionId, { promptTooLong: true });
    await rt.executeTick();
    expect(injections.filter((i) => i.message === '/compact').length).toBe(2);
  });

  test('escalates to blocked when the resumed turn hangs (resume-wait timeout)', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:hung-resume';
    const { run, execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    await rt.executeTick();
    saveResultMessage(sessionId, { promptTooLong: false });
    await rt.executeTick();

    const states = (
      rt as unknown as {
        promptTooLongRecovery: Map<string, { awaitingResumeSince: number | null }>;
      }
    ).promptTooLongRecovery;
    const state = states.get(`${run.id}:${execution.id}`);
    expect(state?.awaitingResumeSince).not.toBeNull();
    state!.awaitingResumeSince = Date.now() - (COMPACT_RESULT_TIMEOUT_MS + 1000);

    await rt.executeTick();
    expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('blocked');
    expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
  });

  test('clears awaitingResume and re-compacts when the resumed turn re-overflows as a Kimi user message', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:kimi-resume-reoverflow';
    const { run, execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    await rt.executeTick();
    saveResultMessage(sessionId, { promptTooLong: false });
    await rt.executeTick();

    saveUserMessage(
      sessionId,
      '<local-command-stderr>Prompt is too long: 205616 tokens > 200000 maximum</local-command-stderr>'
    );

    await rt.executeTick();

    expect(injections.filter((i) => i.message === '/compact').length).toBe(2);
    expect(injections.filter((i) => i.message === buildPromptTooLongContinueNag()).length).toBe(1);
    const state = promptTooLongRecoveryMap(rt).get(`${run.id}:${execution.id}`);
    expect(state?.awaitingContinue).toBe(true);
    expect(state?.awaitingResume).toBe(false);
  });

  test('processes a resumed success past the timeout window instead of blocking', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:late-success';
    const { run, execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    await rt.executeTick();
    saveResultMessage(sessionId, { promptTooLong: false });
    await rt.executeTick();

    const states = (
      rt as unknown as {
        promptTooLongRecovery: Map<string, { awaitingResumeSince: number | null }>;
      }
    ).promptTooLongRecovery;
    const state = states.get(`${run.id}:${execution.id}`);
    state!.awaitingResumeSince = Date.now() - (COMPACT_RESULT_TIMEOUT_MS + 1000);
    saveResultMessage(sessionId, { promptTooLong: false });

    await rt.executeTick();
    expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('idle');
    expect(workflowRunRepo.getRun(run.id)?.status).toBe('in_progress');
  });

  test('re-compacts when the resumed turn errors (non-overflow), not silent clear', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:resume-error';
    const { execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    await rt.executeTick();
    saveResultMessage(sessionId, { promptTooLong: false });
    await rt.executeTick();
    saveResultMessage(sessionId, { nonOverflowError: true });
    await rt.executeTick();

    expect(injections.some((i) => i.message === buildPromptTooLongContinueNag())).toBe(true);
    expect(injections.filter((i) => i.message === '/compact').length).toBe(2);
  });

  test('escalates to blocked when the /compact turn hangs (wait timeout)', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:hung-compact';
    const { run, execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    await rt.executeTick();
    expect(injections.map((i) => i.message)).toEqual(['/compact']);

    const states = (
      rt as unknown as {
        promptTooLongRecovery: Map<string, { awaitingContinueSince: number | null }>;
      }
    ).promptTooLongRecovery;
    const state = states.get(`${run.id}:${execution.id}`);
    expect(state?.awaitingContinueSince).not.toBeNull();
    state!.awaitingContinueSince = Date.now() - (COMPACT_RESULT_TIMEOUT_MS + 1000);

    await rt.executeTick();

    expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('blocked');
    expect(workflowRunRepo.getRun(run.id)?.status).toBe('blocked');
  });

  test('retries then escalates when the resume nag cannot be delivered', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    let injectCallCount = 0;
    const tam = makeMockTaskAgentManager(taskRepo, nodeExecutionRepo, sdkMessageRepo, db, {
      inject: async (sessionId, message) => {
        injectCallCount += 1;
        if (message === '/compact') {
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
        injections.push({ sessionId, message });
        throw new Error('session gone');
      },
    });
    const rt = new SpaceRuntime(buildConfig(tam));
    const sessionId = 'session:nag-fail';
    const { run, execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    await rt.executeTick();
    saveResultMessage(sessionId, { promptTooLong: false });
    await rt.executeTick();
    await rt.executeTick();

    expect(injections.filter((i) => i.message !== '/compact').length).toBeGreaterThanOrEqual(2);
    expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('blocked');
  });

  test('re-compacts instead of resuming when /compact errors (non-overflow)', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:compact-error';
    const { run, execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    await rt.executeTick();
    saveResultMessage(sessionId, { nonOverflowError: true });
    await rt.executeTick();
    saveResultMessage(sessionId, { nonOverflowError: true });
    await rt.executeTick();

    expect(injections.some((i) => i.message === buildPromptTooLongContinueNag())).toBe(false);
    expect(injections.filter((i) => i.message === '/compact').length).toBeGreaterThanOrEqual(2);
    expect(nodeExecutionRepo.getById(execution.id)?.status).toBe('blocked');
  });

  test('detaches the overflowed session when escalating to blocked', async () => {
    const injections: Array<{ sessionId: string; message: string }> = [];
    const rt = new SpaceRuntime(buildConfig(makeRecordingTam(injections)));
    const sessionId = 'session:block-clear';
    const { execution } = await setupIdleOverflowExecution(rt, sessionId, true);

    await rt.executeTick();
    saveResultMessage(sessionId, { promptTooLong: true });
    await rt.executeTick();
    saveResultMessage(sessionId, { promptTooLong: true });
    await rt.executeTick();

    const blocked = nodeExecutionRepo.getById(execution.id);
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.agentSessionId).toBeNull();
  });
});
