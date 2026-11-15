import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const SAVED_DELAY_ENV = process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS;
process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS = '0';

let queryFactory: (() => unknown) | null = null;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
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
    instance: { connect() {}, disconnect() {} },
  })),
  tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema,
    handler,
  }),
}));

const { QueryRunner } = await import('../../../../src/lib/agent/query-runner');

import { tmpdir } from 'node:os';
import type { MessageHub, Session } from '@hyperneo/shared';
import type { AskUserQuestionHandler } from '../../../../src/lib/agent/ask-user-question-handler';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { QueryLike } from '../../../../src/lib/agent/query-like';
import { QueryAttemptRegistry } from '../../../../src/lib/agent/query-attempt-token';
import type { QueryOptionsBuilder } from '../../../../src/lib/agent/query-options-builder';
import type { QueryRunnerContext } from '../../../../src/lib/agent/query-runner';
import type { SDKMessageHandler } from '../../../../src/lib/agent/sdk-message-handler';
import type { ErrorManager } from '../../../../src/lib/error-manager';
import type { Logger } from '../../../../src/lib/logger';
import type { Database } from '../../../../src/storage/database';

const OVERLOADED =
  '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';

describe('QueryRunner overload hold', () => {
  let spawns: number;
  let handleErrorSpy: ReturnType<typeof mock>;

  function createRunner(onRateLimitExhausted: QueryRunnerContext['onRateLimitExhausted']) {
    const session: Session = {
      id: 'overloaded',
      title: 'overloaded',
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
      clear: mock(() => {}),
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
      onRateLimitExhausted,
    };
    return { runner: new QueryRunner(ctx), ctx, messageQueue };
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out; spawns=${spawns}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    spawns = 0;
    handleErrorSpy = mock(async () => {});
    queryFactory = () => {
      spawns++;
      return {
        interrupt: mock(async () => undefined),
        close: () => {},
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error(OVERLOADED)),
          return: async () => ({ value: undefined, done: true }),
        }),
      } as unknown as QueryLike;
    };
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    queryFactory = null;
  });

  afterAll(() => {
    if (SAVED_DELAY_ENV === undefined) delete process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS;
    else process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS = SAVED_DELAY_ENV;
  });

  it('never latches "stopped" on repeated 529s and holds the turn once retries run out', async () => {
    const onRateLimitExhausted = mock(async () => true);
    const { runner, ctx, messageQueue } = createRunner(onRateLimitExhausted);
    runner.start();

    await waitFor(
      () => onRateLimitExhausted.mock.calls.length > 0 || handleErrorSpy.mock.calls.length > 0
    );
    await ctx.queryPromise;

    expect(spawns).toBe(4);
    expect(ctx.session.metadata.queryFailureEpisode?.failures ?? 0).toBe(0);
    expect(ctx.session.metadata.queryFailureEpisode?.failed ?? false).toBe(false);
    expect(handleErrorSpy).not.toHaveBeenCalled();
    expect(messageQueue.clear).not.toHaveBeenCalled();
    expect(onRateLimitExhausted).toHaveBeenCalledTimes(1);
    expect(onRateLimitExhausted.mock.calls[0][2]).toEqual({ hold: 'overloaded' });
  });
});
