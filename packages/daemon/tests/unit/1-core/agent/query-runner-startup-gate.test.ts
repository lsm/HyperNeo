/**
 * QueryRunner × startup-gate integration tests
 *
 * Verifies the daemon-wide admission gate as wired into QueryRunner.runQuery:
 * concurrent cold-starts (spawn→first-message) are capped at
 * HYPERNEO_SDK_STARTUP_MAX_CONCURRENT, queued sessions are admitted FIFO as
 * first messages arrive, streaming sessions hold no slot (no starvation), and
 * every exit path releases the permit (first message, abort, error, EOF,
 * abort-while-queued).
 *
 * The SDK `query()` is replaced with a controllable factory whose async
 * iterator only advances when a test resolves a deferred `next()`. This file
 * keeps the default 15s startup timeout; the timer-driven timeout path is
 * covered separately in query-runner-startup-gate-timeout.test.ts (which must
 * load query-runner with a short timeout env before import).
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { tmpdir } from 'node:os';

// Controlled query factory — assigned per test below. mock.module is hoisted
// above the static imports, so query-runner resolves `query` through this.
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

// Import the module under test dynamically, AFTER mock.module above has
// registered the SDK override: the bun:test→vitest shim does not hoist
// mock.module like vi.mock, so a static import here would load query-runner
// before the mock applies (see session-lifecycle-sdk-title.test.ts).
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

/** One SDK "subprocess": query() call with a test-driven message stream. */
interface ControlledQuery {
  queryObject: QueryLike;
  /** Deferreds for each iterator.next() the runner has pulled. */
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

/** Wait for the query's next open next() pull and end the stream with EOF. */
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

  function createRunner(sessionId: string): { runner: QueryRunner; ctx: QueryRunnerContext } {
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
      messageGenerator: mock(async function* () {
        // No messages — the mocked SDK query never consumes the generator.
      }),
    } as unknown as MessageQueue;

    const ctx: QueryRunnerContext = {
      session,
      db: {
        saveSDKMessage: () => {},
        updateSession: () => {},
        getMessagesByStatus: () => [],
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
        getEffectiveMcpServers: () => ({}),
      } as unknown as QueryOptionsBuilder,
      askUserQuestionHandler: {
        createCanUseToolCallback: () => async () => true,
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

      onSDKMessage: async () => {},
      onSlashCommandsFetched: async () => {},
      onModelsFetched: async () => {},
      onMarkApiSuccess: async () => {},
    };
    return { runner: new QueryRunner(ctx), ctx };
  }

  const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Poll until predicate holds (first-run dynamic imports are slow). */
  async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`waitFor timed out after ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** Resolve the given query's next pending next() with a first SDK message. */
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

    // Only 2 of 5 ever reach spawn; the rest wait at the gate.
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

    // s1's first message frees its slot immediately — s3 is admitted while s1
    // and s2 are still mid-turn (their streams stay open).
    deliverFirstMessage(spawned[0]);
    await waitFor(() => spawned.length === 3);

    // s2's first message admits s4.
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
    // Start sequentially so `first` deterministically holds the only slot.
    first.runner.start();
    await waitFor(() => spawned.length === 1);
    second.runner.start();
    await waitFor(() => getSdkStartupGate().getStats().queued === 1);

    // Simulate the session being stopped: the published controller aborts,
    // the abortable iterator breaks, the attempt ends without a first message.
    first.ctx.queryAbortController?.abort();

    // The slot was released by the attempt exit → s2 is admitted.
    await waitFor(() => spawned.length === 2);
    expect(getSdkStartupGate().getStats().active).toBe(1);
    // First attempt fully finished despite never receiving a message.
    await first.ctx.queryPromise;
  });

  it('releases the slot when the SDK query throws before first message (catch path)', async () => {
    process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT = '1';
    const [first, second] = ['s1', 's2'].map((id) => createRunner(id));
    first.runner.start();
    second.runner.start();
    await waitFor(() => spawned.length === 1);

    spawned[0].pendingNexts[0]?.reject(new Error('boom: stream failed'));

    // Catch-entry release frees the slot → s2 admitted; s1 surfaced an error.
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

    // Interrupt-style abort while s2 waits at the gate.
    second.ctx.queryAbortController?.abort();
    await second.ctx.queryPromise;

    // s2 never spawned and surfaced no error (abort path), and its aborted
    // wait did not leak or steal a slot.
    expect(spawned.length).toBe(1);
    expect(handleErrorSpy).not.toHaveBeenCalled();
    expect(getSdkStartupGate().getStats()).toEqual({
      active: 1,
      queued: 0,
      maxConcurrent: 1,
    });

    // s1 completes → the gate drains fully.
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
});
