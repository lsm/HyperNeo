import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { tmpdir } from 'node:os';

let queryFactory:
  | ((args: { prompt: AsyncIterable<SDKMessage>; options: Options }) => unknown)
  | null = null;

mock.module('@anthropic-ai/claude-agent-sdk', () => {
  class MockMcpServer {
    readonly _registeredTools: Record<string, object> = {};
    connect(): void {}
    disconnect(): void {}
  }
  return {
    query: (args: { prompt: AsyncIterable<SDKMessage>; options: Options }) => queryFactory?.(args),
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
import type { QueryRunnerContext } from '../../../../src/lib/agent/query-runner';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { AskUserQuestionHandler } from '../../../../src/lib/agent/ask-user-question-handler';
import { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { Database as SQLite } from '../../../../src/storage/sqlite-compat.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
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
  ): { runner: InstanceType<typeof QueryRunner>; ctx: QueryRunnerContext } {
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
        getState: () => ({ status: 'idle' }),
        setIdle: setIdleSpy,
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

  async function startObservedRunner(id: string) {
    const created = createRunner(id);
    void created.runner.start();
    await waitFor(() => spawned.length > 0 && spawned.at(-1)!.pendingNexts.length > 0);
    const controlled = spawned.at(-1)!;
    controlled.pendingNexts[0].resolve({
      value: {
        ...sdkMessage(),
        tools: ['Read', 'mcp__browser__navigate'],
        skills: ['browser-instructions'],
        plugins: [{ name: 'browser-wrapper', path: '/private/plugin' }],
        mcp_servers: [{ name: 'browser', status: 'connected' }],
      } as SDKMessage,
      done: false,
    });
    await waitFor(() => controlled.pendingNexts.length > 1);
    return { ...created, controlled };
  }

  it('reads observed init and live server tools without restarting a query', async () => {
    const { runner, controlled } = await startObservedRunner('observed-tools');
    controlled.queryObject.mcpServerStatus = async () => [
      {
        name: 'browser',
        status: 'connected',
        tools: [{ name: 'navigate' }],
        config: { env: { PRIVATE: 'secret' } },
        error: 'secret diagnostic',
      },
    ];
    const result = await runner.getToolInventory();
    expect(result.state).toBe('observed');
    expect(result.tools).toEqual(['Read', 'mcp__browser__navigate']);
    expect(result.skills).toEqual(['browser-instructions']);
    expect(result.mcpServers).toEqual([
      { name: 'browser', status: 'connected', tools: ['navigate'] },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/secret|private|config|error/);
    expect(spawned.length).toBe(1);
    await completeQuery(controlled, waitFor);
  });

  it('delivers hollow notification results to their recovery owner without resetting the failure episode', async () => {
    const { controlled, ctx } = await startObservedRunner('hollow-recovery');
    ctx.session.metadata.queryFailureEpisode!.failures = 1;
    const received: SDKMessage[] = [];
    ctx.onSDKMessage = async (message) => {
      received.push(message);
    };
    for (let turn = 0; turn < 6; turn++) {
      await waitFor(
        () =>
          controlled.pendingNexts.length > turn + 1 ||
          !!ctx.session.metadata.queryFailureEpisode?.failed
      );
      if (ctx.session.metadata.queryFailureEpisode?.failed) break;
      controlled.pendingNexts[turn + 1].resolve({
        done: false,
        value: {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: '',
          origin: { kind: 'task-notification' },
          parent_tool_use_id: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          uuid: `hollow-${turn}`,
          session_id: 'hollow-recovery',
        } as SDKMessage,
      });
    }
    await waitFor(
      () => received.length === 6 || !!ctx.session.metadata.queryFailureEpisode?.failed
    );
    expect(received).toHaveLength(6);
    expect(ctx.session.metadata.queryFailureEpisode?.failures).toBe(1);
    expect(ctx.session.metadata.queryFailureEpisode?.failed).toBe(false);
    await completeQuery(controlled, waitFor);
  });

  it('applies MCP choices to the owning query and refreshes observed status without interruption', async () => {
    const { runner, controlled, ctx } = await startObservedRunner('activate-tools');
    const servers = { selected: { command: 'synthetic-not-executed' } };
    ctx.optionsBuilder.getEffectiveMcpServers = () => servers;
    controlled.queryObject.setMcpServers = mock(async () => ({
      added: ['selected'],
      removed: [],
      errors: {},
    }));
    controlled.queryObject.mcpServerStatus = async () => [
      { name: 'selected', status: 'connected', tools: [{ name: 'navigate' }] },
    ];
    expect(await runner.applyToolChoice()).toEqual({ application: 'live' });
    expect(controlled.queryObject.setMcpServers).toHaveBeenCalledWith(servers);
    expect(controlled.queryObject.interrupt).not.toHaveBeenCalled();
    expect(controlled.closeCount).toBe(0);
    expect((await runner.getToolInventory()).mcpServers).toEqual([
      { name: 'selected', status: 'connected', tools: ['navigate'] },
    ]);
    await completeQuery(controlled, waitFor);
  });

  it('does not certify an MCP application after its query owner is invalidated', async () => {
    const { runner, controlled } = await startObservedRunner('late-activation');
    const applied = defer<{ added: string[]; removed: string[]; errors: Record<string, string> }>();
    controlled.queryObject.setMcpServers = () => applied.promise;
    const pending = runner.applyToolChoice();
    runner.invalidateAttemptTokens();
    applied.resolve({ added: ['stale'], removed: [], errors: {} });
    expect(await pending).toEqual({ application: 'unverified', reason: 'query_changed' });
    expect((await runner.getToolInventory()).state).toBe('not_running');
    await completeQuery(controlled, waitFor);
  });

  it('discloses unsupported live application and SDK failures without leaking errors', async () => {
    const { runner, controlled } = await startObservedRunner('unsupported-activation');
    expect(await runner.applyToolChoice()).toEqual({
      application: 'restart_required',
      reason: 'live_mcp_unavailable',
    });
    controlled.queryObject.setMcpServers = async () => ({
      added: [],
      removed: [],
      errors: { selected: 'private endpoint credential' },
    });
    expect(await runner.applyToolChoice()).toEqual({
      application: 'unverified',
      reason: 'application_failed',
    });
    controlled.queryObject.setMcpServers = async () => {
      throw new Error('private error');
    };
    expect(await runner.applyToolChoice()).toEqual({
      application: 'unverified',
      reason: 'application_failed',
    });
    controlled.queryObject.setMcpServers = async () => ({ added: [], removed: [], errors: {} });
    expect(await runner.applyToolChoice()).toEqual({
      application: 'unverified',
      reason: 'status_unavailable',
    });
    controlled.queryObject.mcpServerStatus = async () => [
      { name: 'bad', status: 'connected', tools: [{ name: 42 }] },
    ];
    expect(await runner.applyToolChoice()).toEqual({
      application: 'unverified',
      reason: 'status_unavailable',
    });
    expect(controlled.queryObject.interrupt).not.toHaveBeenCalled();
    await completeQuery(controlled, waitFor);
  });

  it('reports not running without creating a query', async () => {
    const { runner } = createRunner('stopped-tools');
    expect((await runner.getToolInventory()).state).toBe('not_running');
    expect(spawned.length).toBe(0);
  });

  it('drops late MCP status after its owner is invalidated', async () => {
    const { runner, controlled } = await startObservedRunner('late-tools');
    const status = defer<unknown[]>();
    controlled.queryObject.mcpServerStatus = () => status.promise;
    const pending = runner.getToolInventory();
    runner.invalidateAttemptTokens();
    status.resolve([{ name: 'stale', status: 'connected', tools: [{ name: 'leak' }] }]);
    const result = await pending;
    expect(result.state).toBe('not_running');
    expect(result.mcpServers).toEqual([]);
    await completeQuery(controlled, waitFor);
  });

  it('keeps a newer status read when an earlier refresh finishes later', async () => {
    const { runner, controlled } = await startObservedRunner('status-order');
    const first = defer<unknown[]>();
    controlled.queryObject.mcpServerStatus = () => first.promise;
    const earlier = runner.getToolInventory();
    controlled.queryObject.mcpServerStatus = async () => [
      { name: 'browser', status: 'disabled', tools: [] },
    ];
    const newer = await runner.getToolInventory();
    expect(newer.mcpServers[0].status).toBe('disabled');
    first.resolve([{ name: 'browser', status: 'connected', tools: [{ name: 'old' }] }]);
    expect((await earlier).mcpServers[0].status).toBe('disabled');
    await completeQuery(controlled, waitFor);
  });

  it('shows unavailable status as unverified and recovers on a later read', async () => {
    const { runner, controlled } = await startObservedRunner('failed-status');
    controlled.queryObject.mcpServerStatus = async () => {
      throw new Error('secret error');
    };
    const failed = await runner.getToolInventory();
    expect(failed.mcpServers).toEqual([{ name: 'browser', status: 'unverified', tools: null }]);
    expect(failed.tools).toEqual(['Read', 'mcp__browser__navigate']);
    expect(JSON.stringify(failed)).not.toContain('secret');
    controlled.queryObject.mcpServerStatus = undefined;
    expect((await runner.getToolInventory()).tools).toEqual(['Read', 'mcp__browser__navigate']);
    controlled.queryObject.mcpServerStatus = async () => [
      { name: 'browser', status: 'connected', tools: [] },
    ];
    expect((await runner.getToolInventory()).mcpServers[0].tools).toEqual([]);
    await completeQuery(controlled, waitFor);
  });

  it('does not retain tool attachment once the query stream finishes', async () => {
    const { runner, controlled } = await startObservedRunner('ended-tools');
    await completeQuery(controlled, waitFor);
    await settle();
    expect((await runner.getToolInventory()).state).toBe('not_running');
    expect((await runner.getToolInventory()).tools).toEqual([]);
  });

  it('does not certify malformed SDK status payloads', async () => {
    const { runner, controlled } = await startObservedRunner('malformed-tools');
    controlled.queryObject.mcpServerStatus = async () => [
      { name: 'browser', status: 'connected', tools: [{ name: 42 }] },
    ];
    const malformed = await runner.getToolInventory();
    expect(malformed.mcpServers).toEqual([{ name: 'browser', status: 'unverified', tools: null }]);
    expect(malformed.tools).toEqual(['Read', 'mcp__browser__navigate']);
    await completeQuery(controlled, waitFor);
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

  it('runs consecutive Neo inputs through one ordinary query without spending the prompt feed', async () => {
    const queue = new MessageQueue();
    const inputs: Array<AsyncIterator<SDKMessage>> = [];
    queryFactory = ({ prompt }) => {
      inputs.push(prompt[Symbol.asyncIterator]());
      const controlled = createControlledQuery();
      spawned.push(controlled);
      return controlled.queryObject;
    };
    const { runner, ctx } = createRunner('neo:root', { messageQueue: queue });
    const sqlite = new SQLite(':memory:');
    createNeoTables(sqlite);
    sqlite.exec(
      "INSERT INTO neo_session_bindings(session_id,concern_id,kind) VALUES ('neo:root',NULL,'neo')"
    );
    Object.assign(ctx.db, {
      getDatabase: () => sqlite,
      getSDKMessageRepo: () => ({
        getDeliveryContent: (_sessionId: string, uuid: string) => ({
          inputKind: uuid === 'human-input' ? 'human' : 'task',
        }),
      }),
    });
    const first = queue.enqueueWithId('system-event', 'First', false, { durable: true });
    const second = queue.enqueueWithId('human-input', 'Second', false, { durable: true });
    try {
      await runner.start();
      await waitFor(() => spawned.length === 1);
      const firstWire = (await inputs[0].next()).value!;
      const secondWire = (await inputs[0].next()).value!;
      expect(firstWire.uuid).not.toBe('system-event');
      expect(secondWire.uuid).not.toBe('human-input');
      expect(firstWire.uuid).not.toBe(secondWire.uuid);
      expect(runner.retryPromptIdentity.incoming(firstWire).uuid).toBe('system-event');
      expect(runner.retryPromptIdentity.incoming(secondWire).uuid).toBe('human-input');
      const end = inputs[0].next();
      await Promise.all([first, second]);
      deliverFirstMessage(spawned[0]);
      await completeQuery(spawned[0], waitFor);
      await ctx.queryPromise;
      expect((await end).done).toBe(true);
      expect(spawned).toHaveLength(1);
      expect(queue.size()).toBe(0);
      expect(getSdkStartupGate().getStats().active).toBe(0);
    } finally {
      ctx.queryAbortController?.abort();
      queue.clear();
      queue.stop();
      await Promise.allSettled([first, second, ctx.queryPromise]);
      sqlite.close();
    }
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

  it('does not log a slot release when the gate already released the permit', async () => {
    process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT = '1';
    const gate = getSdkStartupGate();
    const acquire = gate.acquire.bind(gate);
    let firstPermit: Awaited<ReturnType<typeof acquire>> | undefined;
    gate.acquire = async (options) => {
      const permit = await acquire(options);
      firstPermit ??= permit;
      return permit;
    };
    const first = createRunner('expired-startup');
    const second = createRunner('next-startup');
    const warn = mock(() => {});
    first.ctx.logger.warn = warn;
    try {
      first.runner.start();
      await waitFor(() => spawned.length === 1 && spawned[0].pendingNexts.length === 1);
      second.runner.start();
      await waitFor(() => gate.getStats().queued === 1);
      expect(firstPermit?.release()).toBe(true);
      await waitFor(() => spawned.length === 2 && spawned[1].pendingNexts.length === 1);
      deliverFirstMessage(spawned[0]);
      await waitFor(() => first.ctx.firstMessageReceived);
      expect(warn.mock.calls.flat().join(' ')).not.toContain('slot released');
      expect(gate.getStats().active).toBe(1);
      deliverFirstMessage(spawned[1]);
      await waitFor(() => gate.getStats().active === 0);
    } finally {
      gate.acquire = acquire;
      first.ctx.queryAbortController?.abort();
      second.ctx.queryAbortController?.abort();
      await Promise.allSettled([first.ctx.queryPromise, second.ctx.queryPromise]);
    }
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

  it('rechecks the captured owner after waiting for an SDK startup slot', async () => {
    process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT = '1';
    const [first, second] = ['first', 'direct'].map((id) => createRunner(id));
    let allowed = true;
    first.runner.start();
    await waitFor(() => spawned.length === 1);
    second.runner.start(() => {
      if (!allowed) throw Object.assign(new Error('Direct owner stopped'), { name: 'AbortError' });
    });
    await waitFor(() => getSdkStartupGate().getStats().queued === 1);
    allowed = false;
    deliverFirstMessage(spawned[0]);
    await completeQuery(spawned[0], waitFor);
    await first.ctx.queryPromise;
    await second.ctx.queryPromise;
    expect(spawned).toHaveLength(1);
    expect(getSdkStartupGate().getStats().active).toBe(0);
    expect(handleErrorSpy).not.toHaveBeenCalled();
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

  it('registers the AskUserQuestion hook without changing the spawn permission mode', async () => {
    const setPermissionMode = mock(async () => {
      throw new Error('Bypass disabled by worker policy');
    });
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
          return { model: 'claude-sonnet-4-20250514', permissionMode: 'default' };
        },
        addSessionStateOptions: (options: unknown) => options,
        setCanUseTool: () => {},
        setAskUserQuestionHook: () => {},
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
    expect(setPermissionMode).not.toHaveBeenCalled();

    await completeQuery(spawned[0], waitFor);
    await ctx.queryPromise;
  });
});
