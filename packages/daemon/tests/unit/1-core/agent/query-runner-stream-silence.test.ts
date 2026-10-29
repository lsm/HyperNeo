import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const SAVED_SILENCE_ENV = process.env.HYPERNEO_SDK_STREAM_SILENCE_TIMEOUT_MS;
process.env.HYPERNEO_SDK_STREAM_SILENCE_TIMEOUT_MS = '120';

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

import { tmpdir } from 'node:os';
import type { MessageHub, Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { AskUserQuestionHandler } from '../../../../src/lib/agent/ask-user-question-handler';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { QueryLike } from '../../../../src/lib/agent/query-like';
import { QueryAttemptRegistry } from '../../../../src/lib/agent/query-attempt-token';

function sdkMessage(): SDKMessage {
  return { type: 'system', subtype: 'init', session_id: 'sdk-session' } as unknown as SDKMessage;
}

import type { QueryOptionsBuilder } from '../../../../src/lib/agent/query-options-builder';
import type { QueryRunnerContext } from '../../../../src/lib/agent/query-runner';
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

interface SilentQuery {
  queryObject: QueryLike;
  closeCount: number;
}

describe('QueryRunner stream silence watchdog', () => {
  let events: string[];
  let handleErrorSpy: ReturnType<typeof mock>;

  function createRunner(sessionId: string): {
    runner: InstanceType<typeof QueryRunner>;
    ctx: QueryRunnerContext;
  } {
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
      size: () => 1,
      getGeneration: () => 0,
      enqueueWithId: async () => {},
      messageGenerator: mock(async function* () {}),
    } as unknown as MessageQueue;

    const ctx: QueryRunnerContext = {
      session,
      db: {
        getSession: () => session,
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
        getState: () => ({ status: 'processing' }),
        setIdle: async () => {},
        setProcessing: async () => {},
        beginTerminalIdle: () => {},
        idleOwnerForQuery: (generation: number) => ({ queryGeneration: generation, turnToken: 0 }),
        cancelTerminalIdleArm: () => {},
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
    return { runner: new QueryRunner(ctx), ctx };
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`waitFor timed out after ${timeoutMs}ms; events=${events.join(',')}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  let spawnCounter: number;
  let spawnNexts: Array<Array<Deferred<IteratorResult<SDKMessage>>>>;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    events = [];
    spawnCounter = 0;
    spawnNexts = [];
    handleErrorSpy = mock(async () => {});
    resetSdkStartupGateForTests();
    const gate = getSdkStartupGate();
    const originalAcquire = gate.acquire.bind(gate);
    gate.acquire = async (options: { sessionId: string; signal?: AbortSignal }) => {
      const permit = await originalAcquire(options);
      events.push(`admit:${options.sessionId}`);
      const originalRelease = permit.release.bind(permit);
      permit.release = () => {
        events.push(`free:${options.sessionId}`);
        originalRelease();
      };
      return permit;
    };
    queryFactory = () => {
      const index = spawnCounter++;
      events.push(`spawn${index}`);
      spawnNexts.push([]);
      const silent: SilentQuery = { queryObject: null as unknown as QueryLike, closeCount: 0 };
      silent.queryObject = {
        interrupt: mock(async () => undefined),
        close: () => {
          silent.closeCount++;
          events.push(`close${index}`);
        },
        [Symbol.asyncIterator]: () => ({
          next: () => {
            const d = defer<IteratorResult<SDKMessage>>();
            spawnNexts[index].push(d);
            return d.promise;
          },
          return: async () => ({ value: undefined, done: true }),
        }),
      } as unknown as QueryLike;
      return silent.queryObject;
    };
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    queryFactory = null;
    resetSdkStartupGateForTests();
  });

  afterAll(() => {
    if (SAVED_SILENCE_ENV === undefined) delete process.env.HYPERNEO_SDK_STREAM_SILENCE_TIMEOUT_MS;
    else process.env.HYPERNEO_SDK_STREAM_SILENCE_TIMEOUT_MS = SAVED_SILENCE_ENV;
  });

  function streamEvent(): SDKMessage {
    return {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '.' } },
      session_id: 'sdk-session',
    } as unknown as SDKMessage;
  }

  it('retries a silent request once, then holds the turn for the network while stalls still count', async () => {
    const { runner, ctx } = createRunner('s1');
    const outage = mock(async (_errorText: string) => true);
    ctx.onNetworkOutage = outage;
    runner.start();

    await waitFor(() => (spawnNexts[0]?.length ?? 0) >= 1);
    spawnNexts[0][0].resolve({ value: sdkMessage(), done: false });
    await waitFor(() => events.includes('close0'));
    await waitFor(() => (spawnNexts[1]?.length ?? 0) >= 1);
    spawnNexts[1][0].resolve({ value: sdkMessage(), done: false });
    await waitFor(() => outage.mock.calls.length > 0);
    await ctx.queryPromise;
    expect(spawnNexts.length).toBe(2);
    expect(String(outage.mock.calls[0][0])).toContain('Model stream stalled');
    expect(handleErrorSpy.mock.calls.length).toBe(0);
    expect(ctx.session.metadata.queryFailureEpisode?.failures).toBe(2);
    expect(ctx.session.metadata.queryFailureEpisode?.failed).toBe(false);
  });

  it('never cuts a slow request that keeps streaming', async () => {
    const { runner } = createRunner('s1');
    runner.start();

    await waitFor(() => (spawnNexts[0]?.length ?? 0) >= 1);
    spawnNexts[0][0].resolve({ value: sdkMessage(), done: false });
    for (let index = 1; index <= 8; index++) {
      await waitFor(() => (spawnNexts[0]?.length ?? 0) > index);
      await new Promise((resolve) => setTimeout(resolve, 60));
      spawnNexts[0][index].resolve({ value: streamEvent(), done: false });
    }
    expect(events.filter((event) => event.startsWith('close'))).toEqual([]);
    expect(spawnNexts.length).toBe(1);
    expect(handleErrorSpy.mock.calls.length).toBe(0);
  });
});
