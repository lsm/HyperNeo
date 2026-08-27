import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { tmpdir } from 'node:os';

let queryFactory: (() => unknown) | null = null;

mock.module('@anthropic-ai/claude-agent-sdk', () => {
  class MockMcpServer {
    readonly _registeredTools: Record<string, object> = {};
    connect(): void {}
    disconnect(): void {}
  }
  return {
    query: () => queryFactory?.(),
    interrupt: mock(async () => {}),
    supportedModels: mock(async () => {
      throw new Error('SDK unavailable in unit test');
    }),
    createSdkMcpServer: mock((options: { name: string; version?: string; tools?: unknown[] }) => ({
      type: 'sdk' as const,
      name: options.name,
      version: options.version ?? '1.0.0',
      tools: options.tools ?? [],
      instance: new MockMcpServer(),
    })),
    tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({
      name,
      description,
      inputSchema,
      handler,
    }),
  };
});

const { QueryRunner } = await import('../../../../src/lib/agent/query-runner');
const { getSdkStartupGate, resetSdkStartupGateForTests } = await import(
  '../../../../src/lib/agent/sdk-startup-gate'
);

import type { MessageHub, Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { AskUserQuestionHandler } from '../../../../src/lib/agent/ask-user-question-handler';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { QueryLike } from '../../../../src/lib/agent/query-like';
import { QueryAttemptRegistry } from '../../../../src/lib/agent/query-attempt-token';
import type { QueryOptionsBuilder } from '../../../../src/lib/agent/query-options-builder';
import type { SDKMessageHandler } from '../../../../src/lib/agent/sdk-message-handler';
import type { ErrorManager } from '../../../../src/lib/error-manager';
import type { Logger } from '../../../../src/lib/logger';
import type { Database } from '../../../../src/storage/database';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  settled: boolean;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const guarded: Deferred<T> = {
    promise,
    settled: false,
    resolve: (value: T) => {
      if (guarded.settled) return;
      guarded.settled = true;
      resolve(value);
    },
    reject: (reason?: unknown) => {
      if (guarded.settled) return;
      guarded.settled = true;
      reject(reason);
    },
  };
  return guarded;
}

interface ControlledQuery {
  queryObject: QueryLike;
  pendingNexts: Array<Deferred<IteratorResult<SDKMessage>>>;
  closeCount: number;
}

function createControlledQuery(): ControlledQuery {
  const controlled: ControlledQuery = {
    pendingNexts: [],
    closeCount: 0,
    queryObject: null as unknown as QueryLike,
  };
  controlled.queryObject = {
    interrupt: mock(async () => undefined),
    close: () => {
      controlled.closeCount++;
    },
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const d = defer<IteratorResult<SDKMessage>>();
        controlled.pendingNexts.push(d);
        return d.promise;
      },
      return: async () => ({ value: undefined, done: true }),
    }),
  } as unknown as QueryLike;
  return controlled;
}

function sdkMessage(): SDKMessage {
  return { type: 'system', subtype: 'init', session_id: 'sdk-session' } as unknown as SDKMessage;
}

async function completeQuery(
  query: ControlledQuery,
  waitFor: (predicate: () => boolean, timeoutMs?: number) => Promise<void>
): Promise<void> {
  await waitFor(() => query.pendingNexts.some((d) => !d.settled));
  const open = [...query.pendingNexts].reverse().find((d) => !d.settled);
  open?.resolve({ value: undefined, done: true });
}

describe('QueryRunner startup gate', () => {
  let spawned: ControlledQuery[];
  let handleErrorSpy: ReturnType<typeof mock>;
  let setIdleSpy: ReturnType<typeof mock>;

  function createRunner(
    sessionId: string,
    overrides: Partial<QueryRunnerContext> = {}
  ): { runner: QueryRunner; ctx: QueryRunnerContext } {
    const session: Session = {
      id: sessionId,
      title: sessionId,
      workspacePath: tmpdir(),
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: { model: 'default', maxTokens: 8192, temperature: 1.0 },
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
      },
    };
    let queryGeneration = 0;
    let isRunning = false;
    const messageQueue = {
      isRunning: () => isRunning,
      start: () => {
        isRunning = true;
      },
      stop: () => {
        isRunning = false;
      },
      clear: () => {},
      size: () => 0,
      getGeneration: () => 0,
      enqueueWithId: async () => {},
      messageGenerator: mock(async function* () {}),
    } as unknown as MessageQueue;

    const ctx: QueryRunnerContext = {
      session,
      db: {
        saveSDKMessage: () => {},
        updateSession: () => {},
        getSDKMessages: () => ({ messages: [], hasMore: false }),
        updateMessageStatus: () => {},
        getNodeExecutionRepo: () => ({ getByAgentSessionId: () => null }),
        getSpaceTaskRepo: () => ({ getTask: () => null }),
      } as unknown as Database,
      messageHub: {
        event: async () => {},
        onRequest: () => () => {},
        query: async () => ({}),
        command: async () => {},
      } as unknown as MessageHub,
      internalEventBus: {
        publish: async () => {},
      } as unknown as QueryRunnerContext['internalEventBus'],
      messageQueue,
      stateManager: {
        getState: () => ({ status: 'idle' }),
        setIdle: setIdleSpy,
        setProcessing: async () => {},
        beginTerminalIdle: () => {},
      } as unknown as ProcessingStateManager,
      errorManager: { handleError: handleErrorSpy } as unknown as ErrorManager,
      logger: {
        log: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
        info: () => {},
      } as unknown as Logger,
      optionsBuilder: {
        build: async () => ({ model: 'claude-sonnet-4-20250514' }),
        addSessionStateOptions: (options: unknown) => options,
        setCanUseTool: () => {},
        setAskUserQuestionHook: () => {},
        getDeferredPermissionMode: () => undefined,
        getEffectiveMcpServers: () => ({}),
      } as unknown as QueryOptionsBuilder,
      askUserQuestionHandler: {
        createCanUseToolCallback: () => async () => true,
        createPreToolUseHook: () => async () => ({}),
      } as unknown as AskUserQuestionHandler,
      messageHandler: {} as unknown as SDKMessageHandler,

      queryObject: null,
      queryPromise: null,
      queryAbortController: null,
      firstMessageReceived: false,
      startupTimeoutTimer: null,
      originalEnvVars: {},
      processExitedPromise: null,
      resetProcessExitedPromise: () => {},
      trackAgentProcess: () => {},
      snapshotTrackedAgentProcesses: () => [],
      terminateTrackedAgentProcesses: () => {},

      incrementQueryGeneration: () => ++queryGeneration,
      getQueryGeneration: () => queryGeneration,
      isCleaningUp: () => false,
      attemptTokens: new QueryAttemptRegistry(),

      onSDKMessage: async () => {},
      onSlashCommandsFetched: async () => {},
      onModelsFetched: async () => {},
      onMarkApiSuccess: async () => {},
    };
    const merged: QueryRunnerContext = { ...ctx, ...overrides };
    return { runner: new QueryRunner(merged), ctx: merged };
  }

  const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`waitFor timed out after ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  function deliverFirstMessage(query: ControlledQuery): void {
    query.pendingNexts[0]?.resolve({ value: sdkMessage(), done: false });
  }

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    spawned = [];
    handleErrorSpy = mock(async () => {});
    setIdleSpy = mock(async () => {});
    resetSdkStartupGateForTests();
    queryFactory = () => {
      const controlled = createControlledQuery();
      spawned.push(controlled);
      return controlled.queryObject;
    };
  });

  afterEach(() => {
    delete process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT;
    delete process.env.ANTHROPIC_API_KEY;
    queryFactory = null;
    resetSdkStartupGateForTests();
  });

  it('bounds concurrent cold-starts at the configured cap', async () => {
    process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT = '2';
    const runners = ['s1', 's2', 's3', 's4', 's5'].map((id) => createRunner(id));
    for (const { runner } of runners) runner.start();
    await waitFor(() => spawned.length === 2);
    await settle();

    expect(spawned.length).toBe(2);
    expect(getSdkStartupGate().getStats()).toEqual({
      active: 2,
      queued: 3,
      maxConcurrent: 2,
    });
  });

  it('admits queued sessions FIFO as first messages arrive (not at turn end)', async () => {
    process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT = '2';
    const runners = ['s1', 's2', 's3', 's4'].map((id) => createRunner(id));
    for (const { runner } of runners) runner.start();
    await waitFor(() => spawned.length === 2);

    deliverFirstMessage(spawned[0]);
    await waitFor(() => spawned.length === 3);

    deliverFirstMessage(spawned[1]);
    await waitFor(() => spawned.length === 4);
    expect(getSdkStartupGate().getStats().active).toBe(2);
  });

  it('does not starve queued starts while earlier sessions stream', async () => {
    process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT = '1';
    const [first, second] = ['s1', 's2'].map((id) => createRunner(id));
    first.runner.start();
    second.runner.start();
    await waitFor(() => spawned.length === 1);

    deliverFirstMessage(spawned[0]);
    await waitFor(() => spawned.length === 2);
    expect(spawned[0].pendingNexts.length).toBeGreaterThanOrEqual(2);
    expect(getSdkStartupGate().getStats().active).toBe(1);
  });

  it('releases the slot when a pre-first-message query is aborted (process exit path)', async () => {
    process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT = '1';
    const [first, second] = ['s1', 's2'].map((id) => createRunner(id));
    first.runner.start();
    await waitFor(() => spawned.length === 1);
    second.runner.start();
    await waitFor(() => getSdkStartupGate().getStats().queued === 1);

    first.ctx.queryAbortController?.abort();

    await waitFor(() => spawned.length === 2);
    expect(getSdkStartupGate().getStats().active).toBe(1);
    await first.ctx.queryPromise;
  });

  it('releases the slot when the SDK query throws before first message (catch path)', async () => {
    process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT = '1';
    const [first, second] = ['s1', 's2'].map((id) => createRunner(id));
    first.runner.start();
    second.runner.start();
    await waitFor(() => spawned.length === 1);

    spawned[0].pendingNexts[0]?.reject(new Error('boom: stream failed'));

    await waitFor(() => spawned.length === 2);
    await waitFor(() => handleErrorSpy.mock.calls.length > 0);
  });

  it('aborts a queued start instead of spawning an orphaned subprocess', async () => {
    process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT = '1';
    const [first, second] = ['s1', 's2'].map((id) => createRunner(id));
    first.runner.start();
    await waitFor(() => spawned.length === 1);

    second.runner.start();
    await waitFor(() => getSdkStartupGate().getStats().queued === 1);

    second.ctx.queryAbortController?.abort();
    await second.ctx.queryPromise;

    expect(spawned.length).toBe(1);
    expect(handleErrorSpy).not.toHaveBeenCalled();
    expect(getSdkStartupGate().getStats()).toEqual({
      active: 1,
      queued: 0,
      maxConcurrent: 1,
    });

    await completeQuery(spawned[0], waitFor);
    await first.ctx.queryPromise;
    expect(getSdkStartupGate().getStats()).toEqual({
      active: 0,
      queued: 0,
      maxConcurrent: 1,
    });
  });

  it('drains to zero after every session finishes normally', async () => {
    process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT = '2';
    const runners = ['s1', 's2', 's3'].map((id) => createRunner(id));
    for (const { runner } of runners) runner.start();
    await waitFor(() => spawned.length === 2);

    deliverFirstMessage(spawned[0]);
    deliverFirstMessage(spawned[1]);
    await waitFor(() => spawned.length === 3);
    deliverFirstMessage(spawned[2]);

    for (const query of spawned) {
      await completeQuery(query, waitFor);
    }
    for (const { ctx } of runners) await ctx.queryPromise;

    expect(getSdkStartupGate().getStats()).toEqual({
      active: 0,
      queued: 0,
      maxConcurrent: 2,
    });
  });

  it('registers the AskUserQuestion hook and applies the deferred mode after spawn (runQuery wiring)', async () => {
    const setPermissionMode = mock(async () => {});
    const buildOverrides: Array<{ askUserQuestionHook?: unknown }> = [];
    const preToolUseHook = mock(async () => ({}));
    const createPreToolUseHook = mock(() => preToolUseHook);
    queryFactory = () => {
      const controlled = createControlledQuery();
      Object.assign(controlled.queryObject, { setPermissionMode });
      spawned.push(controlled);
      return controlled.queryObject;
    };

    const { runner, ctx } = createRunner('auq-wiring', {
      optionsBuilder: {
        build: async (overrides?: { askUserQuestionHook?: unknown }) => {
          buildOverrides.push(overrides ?? {});
          return { model: 'claude-sonnet-4-20250514' };
        },
        addSessionStateOptions: (options: unknown) => options,
        setCanUseTool: () => {},
        setAskUserQuestionHook: () => {},
        getDeferredPermissionMode: () => 'bypassPermissions',
        getEffectiveMcpServers: () => ({}),
      } as unknown as QueryOptionsBuilder,
      askUserQuestionHandler: {
        createCanUseToolCallback: () => async () => true,
        createPreToolUseHook,
      } as unknown as AskUserQuestionHandler,
    });

    runner.start();
    await waitFor(() => spawned.length === 1);
    await waitFor(() => buildOverrides.some((overrides) => overrides.askUserQuestionHook));
    await waitFor(() => setPermissionMode.mock.calls.length > 0);
    await settle();

    const installedHook = buildOverrides.find((overrides) => overrides.askUserQuestionHook)
      ?.askUserQuestionHook as unknown as (
      input: unknown,
      toolUseId: string | undefined,
      options: { signal: AbortSignal }
    ) => Promise<unknown>;
    await installedHook(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'tu-wiring',
        tool_input: { questions: [] },
      },
      'tu-wiring',
      { signal: new AbortController().signal }
    );
    expect(preToolUseHook).toHaveBeenCalled();
    expect(setPermissionMode).toHaveBeenCalledWith('bypassPermissions');

    await completeQuery(spawned[0], waitFor);
    await ctx.queryPromise;
  });
});
