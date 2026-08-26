/// <reference types="bun" />
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
const { providerEnvCoordinator } = await import(
  '../../../../src/lib/providers/provider-env-enrollment'
);
const { resetSdkStartupGateForTests } = await import('../../../../src/lib/agent/sdk-startup-gate');

import type { MessageHub, Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { QueryLike } from '../../../../src/lib/agent/query-like';
import type { QueryRunnerContext } from '../../../../src/lib/agent/query-runner';
import type { AskUserQuestionHandler } from '../../../../src/lib/agent/ask-user-question-handler';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { QueryOptionsBuilder } from '../../../../src/lib/agent/query-options-builder';
import type { SDKMessageHandler } from '../../../../src/lib/agent/sdk-message-handler';
import type { ErrorManager } from '../../../../src/lib/error-manager';
import type { Logger } from '../../../../src/lib/logger';
import type { Database } from '../../../../src/storage/database';
import { QueryAttemptRegistry } from '../../../../src/lib/agent/query-attempt-token';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface ControlledQuery {
  pendingNexts: Array<Deferred<IteratorResult<SDKMessage>>>;
  queryObject: QueryLike;
}

function createControlledQuery(): ControlledQuery {
  const controlled: ControlledQuery = {
    pendingNexts: [],
    queryObject: null as unknown as QueryLike,
  };
  controlled.queryObject = {
    interrupt: mock(async () => undefined),
    close: () => {},
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

const GLM_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';

describe('QueryRunner provider-env lease enrollment', () => {
  let handleErrorSpy: ReturnType<typeof mock>;
  let savedEnv: Record<string, string | undefined>;

  function createRunner(
    sessionId: string,
    overrides: {
      provider?: string;
      build?: () => Promise<Record<string, unknown>>;
    } = {}
  ): { runner: InstanceType<typeof QueryRunner>; ctx: QueryRunnerContext } {
    const session: Session = {
      id: sessionId,
      title: sessionId,
      workspacePath: tmpdir(),
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: {
        model: 'default',
        maxTokens: 8192,
        temperature: 1.0,
        ...(overrides.provider
          ? { provider: overrides.provider as Session['config']['provider'] }
          : {}),
      },
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
        setIdle: async () => {},
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
        build:
          overrides.build ??
          (async () => ({ model: 'claude-sonnet-4-20250514' }) as Record<string, unknown>),
        addSessionStateOptions: (options: unknown) => options,
        setCanUseTool: () => {},
        setAskUserQuestionHook: () => {},
        getDeferredPermissionMode: () => undefined,
        getCurrentPermissionMode: () => undefined,
        getEffectiveMcpServers: () => ({}),
        getEffectiveThinkingLevel: () => undefined,
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
    return { runner: new QueryRunner(ctx), ctx };
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

  beforeEach(() => {
    savedEnv = {};
    for (const key of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'CLAUDE_CODE_SUBAGENT_MODEL',
      'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'API_TIMEOUT_MS',
      'ENABLE_TOOL_SEARCH',
      'GLM_API_KEY',
      'ZHIPU_API_KEY',
      'HYPERNEO_SDK_STARTUP_MAX_CONCURRENT',
    ]) {
      savedEnv[key] = process.env[key];
    }
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT = '4';
    handleErrorSpy = mock(async () => {});
    resetSdkStartupGateForTests();
    queryFactory = () => createControlledQuery().queryObject;
  });

  afterEach(() => {
    queryFactory = null;
    resetSdkStartupGateForTests();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('holds the query-runner lease across setup and releases it before the query streams', async () => {
    const parkSetup = defer<void>();
    const { runner, ctx } = createRunner('sess-holder', {
      build: async () => {
        await parkSetup.promise;
        return { model: 'claude-sonnet-4-20250514' };
      },
    });

    runner.start();
    await waitFor(() => providerEnvCoordinator.activeHolder()?.enrolledAs === 'query-runner');
    expect(providerEnvCoordinator.roleOf('query-runner')).toBe('owner');
    expect(ctx.originalEnvVars).toEqual({});

    parkSetup.resolve(undefined);
    await waitFor(() => !providerEnvCoordinator.isLeaseHeld());
    expect(ctx.originalEnvVars).toEqual({});
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-test-key');

    await waitFor(() => !!ctx.queryAbortController);
    ctx.queryAbortController!.abort();
    await ctx.queryPromise?.catch(() => {});
    expect(providerEnvCoordinator.isLeaseHeld()).toBe(false);
  });

  it('serializes overlapping setups so the queued session snapshots the restored baseline', async () => {
    process.env.GLM_API_KEY = 'glm-test-key';
    const parkHolder = defer<void>();
    const buildCalls: string[] = [];
    const glmOptions: Record<string, unknown> = { model: 'default' };
    const anthropicOptions: Record<string, unknown> = { model: 'claude-sonnet-4-20250514' };

    const holder = createRunner('sess-glm', {
      provider: 'glm',
      build: async () => {
        buildCalls.push('holder');
        await parkHolder.promise;
        return glmOptions;
      },
    });
    const queued = createRunner('sess-anthropic', {
      build: async () => {
        buildCalls.push('queued');
        return anthropicOptions;
      },
    });

    holder.runner.start();
    await waitFor(() => buildCalls.includes('holder'));
    queued.runner.start();
    await settle();

    expect(buildCalls).toEqual(['holder']);
    expect(providerEnvCoordinator.isLeaseHeld()).toBe(true);

    parkHolder.resolve(undefined);
    await waitFor(() => buildCalls.includes('queued'));
    await waitFor(() => !!holder.ctx.queryAbortController && !!queued.ctx.queryAbortController);
    holder.ctx.queryAbortController!.abort();
    queued.ctx.queryAbortController!.abort();
    await Promise.all([
      holder.ctx.queryPromise?.catch(() => {}),
      queued.ctx.queryPromise?.catch(() => {}),
    ]);

    const glmEnv = (glmOptions as { env?: Record<string, string | undefined> }).env;
    const anthropicEnv = (anthropicOptions as { env?: Record<string, string | undefined> }).env;
    expect(glmEnv).toMatchObject({ ANTHROPIC_BASE_URL: GLM_BASE_URL });
    expect(anthropicEnv?.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(anthropicEnv?.ANTHROPIC_API_KEY).toBe('sk-test-key');
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(holder.ctx.originalEnvVars).toEqual({});
    expect(queued.ctx.originalEnvVars).toEqual({});
    expect(providerEnvCoordinator.isLeaseHeld()).toBe(false);
  });

  it('halts a stale setup after a replacement bumps the generation and frees the lease untouched', async () => {
    process.env.GLM_API_KEY = 'glm-test-key';
    const parkSetup = defer<void>();
    let buildCount = 0;
    const stale = createRunner('sess-stale', {
      provider: 'glm',
      build: async () => {
        buildCount++;
        await parkSetup.promise;
        return { model: 'default' };
      },
    });

    stale.runner.start();
    await waitFor(() => buildCount === 1);

    stale.ctx.incrementQueryGeneration();
    parkSetup.resolve(undefined);
    await stale.ctx.queryPromise;

    expect(handleErrorSpy).not.toHaveBeenCalled();
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(stale.ctx.originalEnvVars).toEqual({});
    expect(providerEnvCoordinator.isLeaseHeld()).toBe(false);
    const probe = await providerEnvCoordinator.acquire('query-runner');
    providerEnvCoordinator.release(probe);
  });

  it('keeps the late finalizer backstop inert so an expired attempt cannot overwrite active credentials', async () => {
    const first = createRunner('sess-first');
    first.runner.start();
    await waitFor(() => !!first.ctx.queryAbortController);

    expect(first.ctx.originalEnvVars).toEqual({});
    expect(providerEnvCoordinator.isLeaseHeld()).toBe(false);
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();

    const token = await providerEnvCoordinator.acquire('query-runner');
    const baselineAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-oat-second-active';

    first.ctx.queryAbortController?.abort();
    await first.ctx.queryPromise;

    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-oat-second-active');
    providerEnvCoordinator.release(token);
    if (baselineAuthToken === undefined) {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    } else {
      process.env.ANTHROPIC_AUTH_TOKEN = baselineAuthToken;
    }
  });

  it('releases the lease when setup fails mid-window so later sessions can still start', async () => {
    const failing = createRunner('sess-failing', {
      build: async () => {
        throw new Error('options build exploded');
      },
    });
    failing.runner.start();
    await failing.ctx.queryPromise;

    expect(handleErrorSpy).toHaveBeenCalled();
    expect(failing.ctx.originalEnvVars).toEqual({});
    expect(providerEnvCoordinator.isLeaseHeld()).toBe(false);
    const probe = await providerEnvCoordinator.acquire('query-runner');
    providerEnvCoordinator.release(probe);
  });
});
