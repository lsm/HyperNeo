import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import {
  ModelSwitchHandler,
  type ModelSwitchHandlerContext,
} from '../../../../src/lib/agent/model-switch-handler';
import {
  QueryLifecycleManager,
  type QueryLifecycleManagerContext,
} from '../../../../src/lib/agent/query-lifecycle-manager';
import { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { Session, ModelInfo } from '@hyperneo/shared';
import type { MessageHub } from '@hyperneo/shared';
import type { DaemonHub } from '../../../../tests/helpers/daemon-hub';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { Database } from '../../../../src/storage/database';
import type { ContextTracker } from '../../../../src/lib/agent/context-tracker';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { QueryLifecycleManager as QLMType } from '../../../../src/lib/agent/query-lifecycle-manager';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { ErrorManager } from '../../../../src/lib/error-manager';
import type { Logger } from '../../../../src/lib/logger';
import type { SDKMessageHandler } from '../../../../src/lib/agent/sdk-message-handler';
import type { InterruptHandler } from '../../../../src/lib/agent/interrupt-handler';
import { generateUUID } from '@hyperneo/shared';
import {
  resetProviderFactory,
  initializeProviders,
  waitForOptionalProviderRegistration,
} from '../../../../src/lib/providers/factory';
import { resetProviderRegistry } from '../../../../src/lib/providers/registry';
import { setModelsCache, clearModelsCache } from '../../../../src/lib/model-service';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_MODELS: ModelInfo[] = [
  {
    id: 'default',
    name: 'Claude Sonnet 4.5',
    alias: 'sonnet',
    family: 'sonnet',
    provider: 'anthropic',
    contextWindow: 200000,
    description: 'Default Sonnet model',
    releaseDate: '2025-01-01',
    available: true,
  },
  {
    id: 'opus',
    name: 'Claude Opus 4.5',
    alias: 'opus',
    family: 'opus',
    provider: 'anthropic',
    contextWindow: 200000,
    description: 'Opus model',
    releaseDate: '2025-01-01',
    available: true,
  },
  {
    id: 'haiku',
    name: 'Claude Haiku 4.5',
    alias: 'haiku',
    family: 'haiku',
    provider: 'anthropic',
    contextWindow: 200000,
    description: 'Haiku model',
    releaseDate: '2025-01-01',
    available: true,
  },
  {
    id: 'glm-5',
    name: 'GLM-5',
    alias: 'glm',
    family: 'glm',
    provider: 'glm',
    contextWindow: 200000,
    description: 'GLM model',
    releaseDate: '2026-01-01',
    available: true,
  },
  {
    id: 'acp-default',
    name: 'ACP Default',
    alias: 'acp',
    family: 'acp',
    provider: 'acp',
    contextWindow: 200000,
    description: 'ACP model',
    releaseDate: '2026-01-01',
    available: true,
  },
];

describe('ModelSwitchHandler — session continuity (sdkSessionId)', () => {
  let handler: ModelSwitchHandler;
  let mockSession: Session;
  let mockDb: Database;
  let mockMessageHub: MessageHub;
  let mockDaemonHub: DaemonHub;
  let mockInternalEventBus: InternalEventBus<any>;
  let mockContextTracker: ContextTracker;
  let mockStateManager: ProcessingStateManager;
  let mockErrorManager: ErrorManager;
  let mockLogger: Logger;
  let mockLifecycleManager: QLMType;

  let publishSpy: ReturnType<typeof mock>;
  let emitSpy: ReturnType<typeof mock>;
  let updateSessionSpy: ReturnType<typeof mock>;
  let setModelSpy: ReturnType<typeof mock>;
  let handleErrorSpy: ReturnType<typeof mock>;
  let setModelTrackerSpy: ReturnType<typeof mock>;
  let restartSpy: ReturnType<typeof mock>;

  beforeEach(async () => {
    resetProviderRegistry();
    resetProviderFactory();
    clearModelsCache();
    const registry = initializeProviders();
    await waitForOptionalProviderRegistration(registry);

    const cache = new Map<string, ModelInfo[]>();
    cache.set('global', TEST_MODELS);
    setModelsCache(cache);

    const sessionId = generateUUID();

    mockSession = {
      id: sessionId,
      title: 'Test Session',
      workspacePath: '/test/workspace',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: {
        model: 'default',
        provider: 'anthropic',
        maxTokens: 8192,
        temperature: 1.0,
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

    publishSpy = mock(async () => {});
    emitSpy = mock(async () => {});
    updateSessionSpy = mock(() => {});
    setModelSpy = mock(async () => {});
    handleErrorSpy = mock(async () => {});
    setModelTrackerSpy = mock(() => {});
    restartSpy = mock(async () => {});

    mockDb = {
      updateSession: updateSessionSpy,
      saveHyperNeoActionMessage: mock(() => {}),
    } as unknown as Database;

    mockMessageHub = {
      event: publishSpy,
      onRequest: mock((_method: string, _handler: Function) => () => {}),
      query: mock(async () => ({})),
      command: mock(async () => {}),
    } as unknown as MessageHub;

    mockDaemonHub = {
      emit: emitSpy,
    } as unknown as DaemonHub;

    mockContextTracker = {
      setModel: setModelTrackerSpy,
    } as unknown as ContextTracker;

    mockStateManager = {
      getState: mock(() => ({ status: 'idle' })),
    } as unknown as ProcessingStateManager;

    mockErrorManager = {
      handleError: handleErrorSpy,
    } as unknown as ErrorManager;

    mockLogger = {
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      debug: mock(() => {}),
    } as unknown as Logger;

    mockLifecycleManager = {
      restart: restartSpy,
    } as unknown as QLMType;
    mockInternalEventBus = {
      publish: mock(async () => {}),
      publishAsync: mock(async () => {}),
      subscribe: mock(() => () => {}),
    } as unknown as InternalEventBus<any>;
  });

  function createContext(
    overrides: Partial<ModelSwitchHandlerContext> = {}
  ): ModelSwitchHandlerContext {
    return {
      session: mockSession,
      db: mockDb,
      messageHub: mockMessageHub,
      daemonHub: mockDaemonHub,
      internalEventBus: mockInternalEventBus,
      contextTracker: mockContextTracker,
      stateManager: mockStateManager,
      errorManager: mockErrorManager,
      logger: mockLogger,
      lifecycleManager: mockLifecycleManager,
      queryObject: { setModel: setModelSpy } as unknown as Query,
      queryPromise: null,
      messageQueue: { isRunning: mock(() => false) } as unknown as MessageQueue,
      firstMessageReceived: true,
      ...overrides,
    };
  }

  function createHandler(overrides: Partial<ModelSwitchHandlerContext> = {}): ModelSwitchHandler {
    return new ModelSwitchHandler(createContext(overrides));
  }

  afterEach(() => {
    resetProviderRegistry();
    resetProviderFactory();
    clearModelsCache();
  });

  it('switchModel preserves sdkSessionId (query running)', async () => {
    const sdkId = 'test-sdk-session-abc';
    mockSession.sdkSessionId = sdkId;

    handler = createHandler();
    const result = await handler.switchModel('opus', 'anthropic');

    expect(result.success).toBe(true);
    expect(mockSession.sdkSessionId).toBe(sdkId);
  });

  it('switchModel does NOT pass sdkSessionId: undefined in DB update', async () => {
    const sdkId = 'test-sdk-session-abc';
    mockSession.sdkSessionId = sdkId;

    handler = createHandler();
    await handler.switchModel('opus', 'anthropic');

    expect(updateSessionSpy).toHaveBeenCalledTimes(1);
    const updateArg = updateSessionSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(updateArg).not.toHaveProperty('sdkSessionId');
  });

  it('switchModel preserves sdkSessionId when query not started', async () => {
    const sdkId = 'test-sdk-session-abc';
    mockSession.sdkSessionId = sdkId;

    handler = createHandler({ queryObject: null });
    const result = await handler.switchModel('opus', 'anthropic');

    expect(result.success).toBe(true);
    expect(mockSession.sdkSessionId).toBe(sdkId);
  });

  it('sdkSessionId remains stable across multiple rapid switches', async () => {
    const sdkId = 'test-sdk-session-abc';
    mockSession.sdkSessionId = sdkId;

    handler = createHandler();

    await handler.switchModel('opus', 'anthropic');
    expect(mockSession.sdkSessionId).toBe(sdkId);

    await handler.switchModel('haiku', 'anthropic');
    expect(mockSession.sdkSessionId).toBe(sdkId);

    await handler.switchModel('glm-5', 'glm');
    expect(mockSession.sdkSessionId).toBe(sdkId);
  });

  it('restarts the query when only the message queue is running', async () => {
    const sdkId = 'test-sdk-session-abc';
    mockSession.sdkSessionId = sdkId;

    handler = createHandler({
      queryObject: null,
      queryPromise: null,
      messageQueue: { isRunning: mock(() => true) } as unknown as MessageQueue,
    });
    const result = await handler.switchModel('opus', 'anthropic');

    expect(result.success).toBe(true);
    expect(mockSession.sdkSessionId).toBe(sdkId);
    expect(restartSpy).toHaveBeenCalledTimes(1);
  });

  it('skips the restart when nothing is running (idle in-place switch)', async () => {
    const sdkId = 'test-sdk-session-abc';
    mockSession.sdkSessionId = sdkId;

    handler = createHandler({
      queryObject: null,
      queryPromise: null,
      messageQueue: { isRunning: mock(() => false) } as unknown as MessageQueue,
    });
    const result = await handler.switchModel('opus', 'anthropic');

    expect(result.success).toBe(true);
    expect(mockSession.sdkSessionId).toBe(sdkId);
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('clears acpSessionId when switching away from ACP', async () => {
    mockSession.config.model = 'acp-default';
    mockSession.config.provider = 'acp';
    mockSession.acpSessionId = 'acp-session-abc';

    handler = createHandler();
    const result = await handler.switchModel('opus', 'anthropic');

    expect(result.success).toBe(true);
    expect(mockSession.acpSessionId).toBeUndefined();
    expect(updateSessionSpy).toHaveBeenCalledWith(
      mockSession.id,
      expect.objectContaining({ acpSessionId: undefined })
    );
  });

  it('clears sdkSessionId and sdkOriginPath when switching into ACP', async () => {
    mockSession.sdkSessionId = 'sdk-session-abc';
    mockSession.sdkOriginPath = '/test/workspace';

    handler = createHandler();
    const result = await handler.switchModel('acp-default', 'acp');

    expect(result.success).toBe(true);
    expect(mockSession.sdkSessionId).toBeUndefined();
    expect(mockSession.sdkOriginPath).toBeUndefined();
    expect(updateSessionSpy).toHaveBeenCalledWith(
      mockSession.id,
      expect.objectContaining({ sdkSessionId: undefined, sdkOriginPath: undefined })
    );
  });
});

describe('QueryLifecycleManager restart() — session continuity (sdkSessionId)', () => {
  let manager: QueryLifecycleManager;
  let messageQueue: MessageQueue;
  let mockContext: QueryLifecycleManagerContext;
  let startStreamingCalled: boolean;

  let updateSessionSpy: ReturnType<typeof mock>;
  let emitSpy: ReturnType<typeof mock>;
  let publishSpy: ReturnType<typeof mock>;
  let setIdleSpy: ReturnType<typeof mock>;
  let setQueuedSpy: ReturnType<typeof mock>;
  let getStateSpy: ReturnType<typeof mock>;
  let resetCircuitBreakerSpy: ReturnType<typeof mock>;
  let getInterruptPromiseSpy: ReturnType<typeof mock>;
  let handleErrorSpy: ReturnType<typeof mock>;
  let clearModelsCacheSpy: ReturnType<typeof mock>;

  let tmpDir: string;

  function createSdkFile(basePath: string, sdkSessionId: string): void {
    const projectKey = basePath.replace(/[/.]/g, '-');
    const sessionDir = join(tmpDir, 'projects', projectKey);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, `${sdkSessionId}.jsonl`), '');
  }

  function createMockContext(
    overrides: Partial<QueryLifecycleManagerContext> = {}
  ): QueryLifecycleManagerContext {
    const mockSession: Session = {
      id: 'test-session',
      title: 'Test Session',
      workspacePath: '/test/workspace',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: { model: 'default', maxTokens: 8192, temperature: 1.0, provider: 'anthropic' },
      metadata: {},
    };

    updateSessionSpy = mock(() => {});
    emitSpy = mock(async () => {});
    publishSpy = mock(async () => {});
    setIdleSpy = mock(async () => {});
    setQueuedSpy = mock(async () => {});
    getStateSpy = mock(() => ({ status: 'idle' }));
    resetCircuitBreakerSpy = mock(() => {});
    getInterruptPromiseSpy = mock(() => null);
    handleErrorSpy = mock(async () => {});
    clearModelsCacheSpy = mock(async () => {});

    startStreamingCalled = false;
    return {
      session: mockSession,
      messageQueue,
      db: {
        updateSession: updateSessionSpy,
        saveHyperNeoActionMessage: mock(() => {}),
      } as unknown as Database,
      messageHub: {
        event: publishSpy,
        onRequest: mock((_method: string, _handler: Function) => () => {}),
        query: mock(async () => ({})),
        command: mock(async () => {}),
      } as unknown as MessageHub,
      daemonHub: {
        emit: emitSpy,
      } as unknown as DaemonHub,
      internalEventBus: {
        publish: mock(async () => {}),
        publishAsync: mock(async () => {}),
        subscribe: mock(() => () => {}),
      } as unknown as InternalEventBus<any>,
      stateManager: {
        setIdle: setIdleSpy,
        setQueued: setQueuedSpy,
        getState: getStateSpy,
      } as unknown as ProcessingStateManager,
      messageHandler: {
        resetCircuitBreaker: resetCircuitBreakerSpy,
        cancelSuppressedResultWait: mock(() => {}),
      } as unknown as SDKMessageHandler,
      interruptHandler: {
        getInterruptPromise: getInterruptPromiseSpy,
      } as unknown as InterruptHandler,
      errorManager: {
        handleError: handleErrorSpy,
      } as unknown as ErrorManager,
      queryObject: null,
      queryPromise: null,
      firstMessageReceived: true,
      processExitedPromise: null,
      resetProcessExitedPromise: mock(() => {}),
      startupTimeoutTimer: null,
      queryAbortController: null,
      terminateTrackedAgentProcesses: mock(() => {}),
      snapshotTrackedAgentProcesses: mock(() => []),
      pendingRestartReason: null,
      startStreamingQuery: async () => {
        startStreamingCalled = true;
      },
      setCleaningUp: mock(() => {}),
      cleanupEventSubscriptions: mock(() => {}),
      clearModelsCache: clearModelsCacheSpy,
      ...overrides,
    };
  }

  beforeEach(() => {
    messageQueue = new MessageQueue('test-session');
    tmpDir = mkdtempSync(join(tmpdir(), 'kai-test-'));
    process.env.TEST_SDK_SESSION_DIR = tmpDir;
    mockContext = createMockContext();
    manager = new QueryLifecycleManager(mockContext);
  });

  afterEach(() => {
    delete process.env.TEST_SDK_SESSION_DIR;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    'restart() preserves sdkSessionId when session file exists',
    async () => {
      const sdkId = 'sdk-continuity-preserves';
      createSdkFile('/test/workspace', sdkId);

      mockContext.session.sdkSessionId = sdkId;
      manager = new QueryLifecycleManager(mockContext);

      await manager.restart();

      expect(mockContext.session.sdkSessionId).toBe(sdkId);
      const calls = updateSessionSpy.mock.calls;
      for (const call of calls) {
        const arg = call[1] as Record<string, unknown>;
        expect(arg).not.toHaveProperty('sdkSessionId');
      }
    },
    { timeout: 5000 }
  );

  it(
    'restart() emits sdkResumeChoice when session file is missing — user decides',
    async () => {
      const sdkId = 'sdk-continuity-missing';

      mockContext.session.sdkSessionId = sdkId;
      mockContext.session.sdkOriginPath = '/some/path';
      manager = new QueryLifecycleManager(mockContext);

      await manager.restart();

      expect(mockContext.session.sdkSessionId).toBe(sdkId);
      expect(publishSpy).toHaveBeenCalledWith(
        'state.sdkMessages.delta',
        expect.objectContaining({
          added: [expect.objectContaining({ action: 'sdk_resume_choice', resolved: false })],
        }),
        expect.any(Object)
      );
    },
    { timeout: 5000 }
  );
});
