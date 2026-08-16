/**
 * QueryRunner startup gate — startup-timeout release path
 *
 * Exercises the genuine timer-driven path: STARTUP_TIMEOUT_MS is read once at
 * query-runner module load, so this file sets a short timeout (and K=1) in
 * env BEFORE dynamically importing the module under test. Vitest isolates
 * each file's module registry, so the short timeout is guaranteed; when
 * running with `bun test`, run this file on its own (a same-process earlier
 * import of query-runner would have captured the default 15s — same
 * constraint as tests/online/convo/startup-timeout-no-retry.test.ts).
 *
 * Verifies that a startup-timeout abort releases the admission slot, that the
 * single auto-retry re-queues through the gate instead of inheriting the
 * slot, and that a herd of timeout sessions keeps at most K subprocesses in
 * the pre-first-message phase at any moment (rolling admissions).
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const FORCED_STARTUP_TIMEOUT_MS = '60';
const SAVED_TIMEOUT_ENV = process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
const SAVED_MAX_CONCURRENT_ENV = process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT;

process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = FORCED_STARTUP_TIMEOUT_MS;
process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT = '1';

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

// Import AFTER the env assignments and mock registration above (see header).
const { QueryRunner } = await import('../../../../src/lib/agent/query-runner');
const { getSdkStartupGate, resetSdkStartupGateForTests } = await import(
  '../../../../src/lib/agent/sdk-startup-gate'
);

import { tmpdir } from 'node:os';
import type { MessageHub, Session } from '@hyperneo/shared';
import type { AskUserQuestionHandler } from '../../../../src/lib/agent/ask-user-question-handler';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { QueryLike } from '../../../../src/lib/agent/query-like';
import type { QueryOptionsBuilder } from '../../../../src/lib/agent/query-options-builder';
import type { QueryRunnerContext } from '../../../../src/lib/agent/query-runner';
import type { SDKMessageHandler } from '../../../../src/lib/agent/sdk-message-handler';
import type { ErrorManager } from '../../../../src/lib/error-manager';
import type { Logger } from '../../../../src/lib/logger';
import type { Database } from '../../../../src/storage/database';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  settled: boolean;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  const guarded: Deferred<T> = {
    promise,
    settled: false,
    resolve: (value: T) => {
      if (guarded.settled) return;
      guarded.settled = true;
      resolve(value);
    },
  };
  return guarded;
}

/** A spawned "subprocess" that never emits a first message (startup hang). */
interface SilentQuery {
  queryObject: QueryLike;
  closeCount: number;
}

describe('QueryRunner startup gate (startup-timeout path)', () => {
  let events: string[];
  let handleErrorSpy: ReturnType<typeof mock>;

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
        // The silent SDK never consumes input.
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

  /**
   * Fail fast when query-runner was already loaded by an earlier file in the
   * same bun test process (shared module registry → the default 15s timeout
   * was captured, so the short timer never fires). Vitest isolates module
   * registries per file; CI shards are unaffected. Under bun test, run this
   * file on its own.
   */
  async function assertShortTimeoutActive(): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < 1500) {
      if (events.some((event) => event.startsWith('close'))) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      'Short startup timeout is not active: query-runner was loaded before this ' +
        'file set HYPERNEO_SDK_STARTUP_TIMEOUT_MS (shared bun test module registry). ' +
        'Run this file on its own under bun test; vitest (CI shards) isolates ' +
        'module registries per file and is unaffected.'
    );
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

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    events = [];
    spawnCounter = 0;
    handleErrorSpy = mock(async () => {});
    resetSdkStartupGateForTests();
    // Wrap the fresh singleton so every admission/release is observable with
    // session identity — the honest occupancy signal (queryObject.close()
    // fires later, in the finally, so spawn/close interleaving alone cannot
    // prove bounded cold-start concurrency).
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
      const silent: SilentQuery = { queryObject: null as unknown as QueryLike, closeCount: 0 };
      silent.queryObject = {
        interrupt: mock(async () => undefined),
        close: () => {
          silent.closeCount++;
          events.push(`close${index}`);
        },
        [Symbol.asyncIterator]: () => ({
          // Never resolves — the subprocess stays silent past the timeout.
          next: () => defer().promise,
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
    // Restore the process-wide env for files that run after this one.
    if (SAVED_TIMEOUT_ENV === undefined) {
      delete process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS;
    } else {
      process.env.HYPERNEO_SDK_STARTUP_TIMEOUT_MS = SAVED_TIMEOUT_ENV;
    }
    if (SAVED_MAX_CONCURRENT_ENV === undefined) {
      delete process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT;
    } else {
      process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT = SAVED_MAX_CONCURRENT_ENV;
    }
  });

  it('releases the slot on startup-timeout abort; the single retry re-admits through the gate', async () => {
    const { runner, ctx } = createRunner('s1');
    runner.start();

    // Attempt 1 spawns, times out at ~60ms, aborts and releases the slot.
    await waitFor(() => events.includes('spawn0'));
    await assertShortTimeoutActive();
    await waitFor(() => events.includes('close0'));
    // The auto-retry (attempt 2) re-queues and spawns a fresh subprocess.
    await waitFor(() => events.includes('spawn1'));

    // Attempt 2 also times out — retry-once is exhausted, error goes terminal.
    await ctx.queryPromise;
    await waitFor(() => handleErrorSpy.mock.calls.length > 0);

    // The timeout abort freed the first slot BEFORE the retry was admitted
    // (rolling, never inherited), and the terminal attempt freed its own slot.
    const admitIndexes = events
      .map((event, index) => (event === 'admit:s1' ? index : -1))
      .filter((index) => index >= 0);
    const freeIndexes = events
      .map((event, index) => (event === 'free:s1' ? index : -1))
      .filter((index) => index >= 0);
    expect(admitIndexes.length).toBe(2);
    expect(freeIndexes.length).toBe(2);
    expect(admitIndexes[1]).toBeGreaterThan(freeIndexes[0]);
    expect(handleErrorSpy.mock.calls[0][2]).toBe('timeout');
    expect(getSdkStartupGate().getStats()).toEqual({
      active: 0,
      queued: 0,
      maxConcurrent: 1,
    });
  });

  it('bounds a timeout herd to K=1 with rolling admissions (no slot inheritance)', async () => {
    const first = createRunner('s1');
    const second = createRunner('s2');
    first.runner.start();
    second.runner.start();
    await waitFor(() => events.includes('spawn0'));
    await assertShortTimeoutActive();

    // Every session eventually reaches its terminal timeout state.
    await first.ctx.queryPromise;
    await second.ctx.queryPromise;
    await waitFor(() => handleErrorSpy.mock.calls.length >= 2);

    // Rolling admissions through both retries. Which of the two concurrently
    // starting sessions reaches the gate first is not deterministic (dynamic
    // imports precede the acquire), so the order-sensitive assertions are the
    // invariants that actually matter:
    //   - each session is admitted exactly twice (initial + auto-retry);
    //   - per session, admits strictly alternate with frees — the retry is
    //     admitted only AFTER its own earlier attempt released (re-queued,
    //     never slot-inherited);
    //   - occupancy never exceeds K=1 (below) — at most one subprocess is in
    //     the pre-first-message phase at any moment.
    const admissionOrder = events
      .filter((event) => event.startsWith('admit:'))
      .map((event) => event.slice('admit:'.length));
    expect([...admissionOrder].sort()).toEqual(['s1', 's1', 's2', 's2']);
    for (const sessionId of ['s1', 's2']) {
      const sessionEvents = events
        .filter((event) => event.endsWith(`:${sessionId}`))
        .map((event) => event.split(':')[0]);
      expect(sessionEvents).toEqual(['admit', 'free', 'admit', 'free']);
    }
    expect(events.filter((event) => event.startsWith('spawn')).length).toBe(4);

    let held = 0;
    let maxHeld = 0;
    for (const event of events) {
      if (event.startsWith('admit:')) {
        held++;
        maxHeld = Math.max(maxHeld, held);
      } else if (event.startsWith('free:')) {
        held--;
      }
    }
    expect(maxHeld).toBe(1);
    expect(held).toBe(0);
    expect(getSdkStartupGate().getStats()).toEqual({
      active: 0,
      queued: 0,
      maxConcurrent: 1,
    });
  });
});
