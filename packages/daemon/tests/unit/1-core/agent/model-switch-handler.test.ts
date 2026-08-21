import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import {
  ModelSwitchHandler,
  type ModelSwitchHandlerContext,
} from '../../../../src/lib/agent/model-switch-handler';
import type { Session, ModelInfo } from '@hyperneo/shared';
import type { MessageHub } from '@hyperneo/shared';
import type { DaemonHub } from '../../../../tests/helpers/daemon-hub';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { Database } from '../../../../src/storage/database';
import type { ContextTracker } from '../../../../src/lib/agent/context-tracker';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { QueryLifecycleManager } from '../../../../src/lib/agent/query-lifecycle-manager';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { ErrorManager } from '../../../../src/lib/error-manager';
import type { Logger } from '../../../../src/lib/logger';
import { generateUUID } from '@hyperneo/shared';
import {
  resetProviderFactory,
  initializeProviders,
  waitForOptionalProviderRegistration,
  getProviderRegistry,
} from '../../../../src/lib/providers/factory';
import { resetProviderRegistry } from '../../../../src/lib/providers/registry';
import { setModelsCache, clearModelsCache } from '../../../../src/lib/model-service';
import { AcpProvider } from '../../../../src/lib/providers/acp-provider';
import { disposeAcpSessions } from '../../../../src/lib/acp/acp-model-fetcher';

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
    id: 'kimi-k3[1m]',
    name: 'Kimi K3',
    alias: 'k3',
    family: 'kimi',
    provider: 'kimi',
    contextWindow: 1_048_576,
    description: 'Kimi K3 1M context',
    releaseDate: '2026-01-01',
    available: true,
    providerAliases: ['k3', 'kimi-k3', 'k3[1m]', 'kimi-k3[1m]'],
    providerAliasPrefixes: ['moonshot-k3'],
  },
  {
    id: 'k3-256k',
    name: 'Kimi K3 (256K)',
    alias: 'k3-256k',
    family: 'kimi',
    provider: 'kimi',
    contextWindow: 262_144,
    description: 'Kimi K3 256K context',
    releaseDate: '2026-01-01',
    available: true,
    providerAliases: ['kimi-k3-256k'],
  },
  {
    id: 'claude-opus-4.6',
    name: 'Claude Opus 4.6 (Copilot)',
    alias: 'copilot-anthropic-opus',
    family: 'opus',
    provider: 'anthropic-copilot',
    contextWindow: 200000,
    description: 'Claude Opus via GitHub Copilot',
    releaseDate: '2025-11-01',
    available: true,
  },
  {
    id: 'claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6 (Copilot)',
    alias: 'copilot-anthropic-sonnet',
    family: 'sonnet',
    provider: 'anthropic-copilot',
    contextWindow: 200000,
    description: 'Claude Sonnet 4.6 via Copilot',
    releaseDate: '2025-11-01',
    available: true,
  },
];

describe('ModelSwitchHandler', () => {
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
  let mockLifecycleManager: QueryLifecycleManager;

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
    mockInternalEventBus = {
      publish: emitSpy,
      publishAsync: emitSpy,
      subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
    } as unknown as InternalEventBus<any>;
    updateSessionSpy = mock(() => {});
    setModelSpy = mock(async () => {});
    handleErrorSpy = mock(async () => {});
    setModelTrackerSpy = mock(() => {});
    restartSpy = mock(async () => {});

    mockDb = {
      updateSession: updateSessionSpy,
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
    } as unknown as QueryLifecycleManager;
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
      disposeAcpSessions: mock(async () => {}) as typeof disposeAcpSessions,
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

  describe('getCurrentModel', () => {
    it('should return current model info', () => {
      handler = createHandler();
      const modelInfo = handler.getCurrentModel();
      expect(modelInfo.id).toBe('default');
      expect(modelInfo.info).toBeNull();
    });

    it('should reflect session config model', () => {
      mockSession.config.model = 'opus';
      handler = createHandler();
      const modelInfo = handler.getCurrentModel();
      expect(modelInfo.id).toBe('opus');
    });

    it('should return info as null (fetched asynchronously)', () => {
      handler = createHandler();
      const modelInfo = handler.getCurrentModel();
      expect(modelInfo).toEqual({
        id: 'default',
        info: null,
      });
    });

    it('should track model changes in session config', () => {
      handler = createHandler();
      expect(handler.getCurrentModel().id).toBe('default');

      mockSession.config.model = 'haiku';
      expect(handler.getCurrentModel().id).toBe('haiku');

      mockSession.config.model = 'opus';
      expect(handler.getCurrentModel().id).toBe('opus');
    });
  });

  describe('constructor', () => {
    it('should accept all required dependencies', () => {
      const newHandler = createHandler();
      expect(newHandler).toBeDefined();
      expect(newHandler.getCurrentModel).toBeDefined();
      expect(newHandler.switchModel).toBeDefined();
    });
  });

  describe('context usage', () => {
    it('should use session from context', () => {
      handler = createHandler();
      const modelInfo = handler.getCurrentModel();
      expect(modelInfo.id).toBe(mockSession.config.model);
    });
  });

  describe('switchModel', () => {
    const VALID_MODEL = 'opus';

    describe('when query not started', () => {
      it('should update config without starting an empty query when query not started', async () => {
        handler = createHandler({ queryObject: null });
        const result = await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(result.success).toBe(true);
        expect(updateSessionSpy).toHaveBeenCalledWith(
          mockSession.id,
          expect.objectContaining({
            config: expect.objectContaining({ model: 'opus', provider: expect.any(String) }),
          })
        );
        expect(setModelTrackerSpy).toHaveBeenCalled();
        expect(restartSpy).not.toHaveBeenCalled();
      });

      it('should pass only serializable config fields (no closures or cyclic refs)', async () => {
        const mockCallback = () => {};
        const liveObj = { handler: mockCallback };
        (mockSession.config as Record<string, unknown>)['mcpServers'] = { 'room-tools': liveObj };

        handler = createHandler({ queryObject: null });
        const result = await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(result.success).toBe(true);
        const callArg = updateSessionSpy.mock.calls[0][1] as { config: Record<string, unknown> };
        expect(callArg.config).toHaveProperty('model', 'opus');
        expect(callArg.config).not.toHaveProperty('mcpServers');
      });

      it('should emit session.updated event', async () => {
        handler = createHandler({ queryObject: null });
        await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(emitSpy).toHaveBeenCalledWith(
          'session.updated',
          expect.objectContaining({
            sessionId: mockSession.id,
            source: 'model-switch',
          })
        );
      });

      it('should emit model-switching event', async () => {
        handler = createHandler({ queryObject: null });
        await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(publishSpy).toHaveBeenCalledWith(
          'session.model-switching',
          expect.objectContaining({
            from: 'default',
          }),
          { channel: 'session:' + mockSession.id }
        );
      });

      it('should emit model-switched event on success', async () => {
        handler = createHandler({ queryObject: null });
        await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(publishSpy).toHaveBeenCalledWith(
          'session.model-switched',
          expect.objectContaining({
            from: 'default',
          }),
          { channel: 'session:' + mockSession.id }
        );
      });

      it('should align provider with model for pre-query cross-provider switches', async () => {
        mockSession.config.model = 'glm-5';
        mockSession.config.provider = 'glm';

        handler = createHandler({ queryObject: null });
        const result = await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(result.success).toBe(true);
        expect(mockSession.config.provider).toBe('anthropic');
      });

      it('clears ACP resume and context usage state when switching providers', async () => {
        mockSession.config.model = 'acp-default';
        mockSession.config.provider = 'acp';
        mockSession.acpSessionId = 'remote-acp-session';
        mockSession.metadata = {
          ...mockSession.metadata,
          acpContextUsageEstimate: 12000,
        };

        handler = createHandler({ queryObject: null });
        const result = await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(result.success).toBe(true);
        expect(mockSession.acpSessionId).toBeUndefined();
        expect(mockSession.metadata.acpContextUsageEstimate).toBeUndefined();
        expect(updateSessionSpy).toHaveBeenCalledWith(
          mockSession.id,
          expect.objectContaining({
            acpSessionId: undefined,
            metadata: expect.objectContaining({ acpContextUsageEstimate: undefined }),
          })
        );
      });

      it('disposes the remote ACP session when switching away from ACP', async () => {
        const acpProvider = getProviderRegistry().get('acp') as AcpProvider;
        acpProvider.setAcpCommand('devin acp');
        const disposeAcpSessionsSpy = mock(async () => {});

        mockSession.config.model = 'acp-default';
        mockSession.config.provider = 'acp';
        mockSession.acpSessionId = 'remote-acp-session';
        mockSession.metadata = {
          ...mockSession.metadata,
          acpContextUsageEstimate: 12000,
        };

        handler = createHandler({ queryObject: null, disposeAcpSessions: disposeAcpSessionsSpy });
        const result = await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(result.success).toBe(true);
        expect(disposeAcpSessionsSpy).toHaveBeenCalledWith(
          'devin acp',
          ['remote-acp-session'],
          undefined,
          expect.any(AbortSignal)
        );
        expect(mockSession.acpSessionId).toBeUndefined();
      });

      it('disposes the remote ACP session after restarting an active query', async () => {
        const acpProvider = getProviderRegistry().get('acp') as AcpProvider;
        acpProvider.setAcpCommand('devin acp');
        const disposeAcpSessionsSpy = mock(async () => {});

        mockSession.config.model = 'acp-default';
        mockSession.config.provider = 'acp';
        mockSession.acpSessionId = 'remote-acp-session';
        mockSession.metadata = {
          ...mockSession.metadata,
          acpContextUsageEstimate: 12000,
        };

        handler = createHandler({ disposeAcpSessions: disposeAcpSessionsSpy });
        const result = await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(result.success).toBe(true);
        expect(restartSpy).toHaveBeenCalled();
        expect(disposeAcpSessionsSpy).toHaveBeenCalledWith(
          'devin acp',
          ['remote-acp-session'],
          undefined,
          expect.any(AbortSignal)
        );
        expect(mockSession.acpSessionId).toBeUndefined();
      });

      it('disposes with the command that created the remote session', async () => {
        const acpProvider = getProviderRegistry().get('acp') as AcpProvider;
        acpProvider.setAcpCommand('new acp');
        const disposeAcpSessionsSpy = mock(async () => {});

        mockSession.config.model = 'acp-default';
        mockSession.config.provider = 'acp';
        mockSession.acpSessionId = 'remote-acp-session';
        mockSession.metadata = {
          ...mockSession.metadata,
          acpSessionCommand: 'old acp',
        };

        handler = createHandler({ queryObject: null, disposeAcpSessions: disposeAcpSessionsSpy });
        const result = await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(result.success).toBe(true);
        expect(disposeAcpSessionsSpy).toHaveBeenCalledWith(
          'old acp',
          ['remote-acp-session'],
          undefined,
          expect.any(AbortSignal)
        );
        expect(mockSession.metadata?.acpSessionCommand).toBeUndefined();
      });
    });

    describe('when transport not ready', () => {
      it('should restart query when queryObject exists even if transport not ready', async () => {
        handler = createHandler({ firstMessageReceived: false });
        const result = await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(result.success).toBe(true);
        expect(updateSessionSpy).toHaveBeenCalled();
        expect(restartSpy).toHaveBeenCalled();
      });

      it('should not restart when queryObject does not exist (query not started)', async () => {
        handler = createHandler({ queryObject: null, firstMessageReceived: false });
        const result = await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(result.success).toBe(true);
        expect(updateSessionSpy).toHaveBeenCalled();
        expect(restartSpy).not.toHaveBeenCalled();
      });

      it('should restart when query startup is in flight before queryObject exists', async () => {
        handler = createHandler({
          queryObject: null,
          queryPromise: new Promise(() => {}),
          firstMessageReceived: false,
        });

        const result = await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(result.success).toBe(true);
        expect(updateSessionSpy).toHaveBeenCalled();
        expect(restartSpy).toHaveBeenCalled();
      });
    });

    describe('when query is running', () => {
      it('should restart query when running', async () => {
        handler = createHandler();
        const result = await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(result.success).toBe(true);
        expect(restartSpy).toHaveBeenCalled();
      });

      it('should update session config before restart', async () => {
        handler = createHandler();
        await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(updateSessionSpy).toHaveBeenCalledWith(
          mockSession.id,
          expect.objectContaining({
            config: expect.objectContaining({ model: 'opus', provider: expect.any(String) }),
          })
        );
      });
    });

    describe('validation', () => {
      it('should reject invalid model', async () => {
        handler = createHandler();
        const result = await handler.switchModel('invalid-model-12345', 'anthropic');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid model');
        expect(result.model).toBe('default');
      });

      it('should return success with message when already using model', async () => {
        handler = createHandler({ queryObject: null });
        await handler.switchModel('haiku', 'anthropic');
        const result = await handler.switchModel('haiku', 'anthropic');

        expect(result.success).toBe(true);
        expect(result.error).toContain('Already using');
      });
    });

    describe('error handling', () => {
      it('should handle errors and call error manager', async () => {
        restartSpy.mockRejectedValue(new Error('Restart failed'));
        handler = createHandler();

        const result = await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Restart failed');
        expect(handleErrorSpy).toHaveBeenCalled();
      });

      it('restores ACP context usage state when a provider switch rolls back', async () => {
        mockSession.config.model = 'acp-default';
        mockSession.config.provider = 'acp';
        mockSession.acpSessionId = 'remote-acp-session';
        mockSession.metadata = {
          ...mockSession.metadata,
          acpContextUsageEstimate: 12000,
        };
        restartSpy.mockRejectedValue(new Error('Restart failed'));
        handler = createHandler();

        const result = await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(result.success).toBe(false);
        expect(mockSession.acpSessionId).toBe('remote-acp-session');
        expect(mockSession.metadata.acpContextUsageEstimate).toBe(12000);
        expect(updateSessionSpy.mock.calls.at(-1)?.[1]).toEqual(
          expect.objectContaining({
            acpSessionId: 'remote-acp-session',
            metadata: expect.objectContaining({ acpContextUsageEstimate: 12000 }),
          })
        );
      });

      it('rollback restores the literal stored provider, not the guard inference (P1)', async () => {
        mockSession.config.model = 'gemini-3.1-pro-preview';
        (mockSession.config as Record<string, unknown>).provider = undefined;
        restartSpy.mockRejectedValue(new Error('Restart failed'));
        handler = createHandler();

        const result = await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(result.success).toBe(false);
        expect(mockSession.config.model).toBe('gemini-3.1-pro-preview');
        expect(mockSession.config.provider).toBeUndefined();
        const rollbackCall = updateSessionSpy.mock.calls.at(-1);
        expect(rollbackCall?.[1]).toEqual(
          expect.objectContaining({
            config: expect.objectContaining({
              model: 'gemini-3.1-pro-preview',
              provider: undefined,
            }),
          })
        );
      });

      it('should return error when session has no provider and no model to infer from', async () => {
        (mockSession.config as Record<string, unknown>).provider = undefined;
        (mockSession.config as Record<string, unknown>).model = undefined;
        handler = createHandler({ queryObject: null });

        const result = await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Session has no provider configured');
      });

      it('infers provider from the stored model when provider is empty (Task #768)', async () => {
        mockSession.config.model = 'glm-5';
        (mockSession.config as Record<string, unknown>).provider = undefined;
        handler = createHandler({ queryObject: null });

        const result = await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(result.success).toBe(true);
        expect(mockSession.config.provider).toBe('anthropic');
      });

      it('switches a kimi session whose provider was never stored, even to the same model (Task #768 regression)', async () => {
        mockSession.config.model = 'kimi-k3[1m]';
        (mockSession.config as Record<string, unknown>).provider = undefined;
        handler = createHandler({ queryObject: null });

        const result = await handler.switchModel('k3[1m]', 'kimi');

        expect(result.success).toBe(true);
        expect(mockSession.config.model).toBe('kimi-k3[1m]');
        expect(mockSession.config.provider).toBe('kimi');
      });
    });

    describe('context tracker update', () => {
      it('should update context tracker model', async () => {
        handler = createHandler({ queryObject: null });
        await handler.switchModel('haiku', 'anthropic');

        expect(setModelTrackerSpy).toHaveBeenCalled();
      });
    });
  });

  describe('provider routing', () => {
    describe('same-provider switch (copilot opus to copilot sonnet)', () => {
      beforeEach(() => {
        mockSession.config.model = 'claude-opus-4.6';
        mockSession.config.provider = 'anthropic-copilot';
      });

      it('switches copilot opus to copilot sonnet with explicit provider', async () => {
        handler = createHandler({ queryObject: null });
        const result = await handler.switchModel('claude-sonnet-4.6', 'anthropic-copilot');

        expect(result.success).toBe(true);
        expect(result.model).toBe('claude-sonnet-4.6');
        expect(mockSession.config.provider).toBe('anthropic-copilot');
      });

      it('stores anthropic-copilot in persisted config', async () => {
        handler = createHandler({ queryObject: null });
        await handler.switchModel('claude-sonnet-4.6', 'anthropic-copilot');

        expect(updateSessionSpy).toHaveBeenCalledWith(
          mockSession.id,
          expect.objectContaining({
            config: expect.objectContaining({ provider: 'anthropic-copilot' }),
          })
        );
      });

      it('already on copilot-opus via alias; no-op expected', async () => {
        handler = createHandler({ queryObject: null });
        const result = await handler.switchModel('copilot-anthropic-opus', 'anthropic-copilot');

        expect(result.success).toBe(true);
        expect(result.error).toContain('Already using');
        expect(updateSessionSpy).not.toHaveBeenCalled();
      });
    });

    describe('cross-provider switch (anthropic to copilot, explicit provider)', () => {
      beforeEach(() => {
        mockSession.config.model = 'default';
        mockSession.config.provider = 'anthropic';
      });

      it('switches to anthropic-copilot when explicitly requested', async () => {
        handler = createHandler({ queryObject: null });
        const result = await handler.switchModel('claude-sonnet-4.6', 'anthropic-copilot');

        expect(result.success).toBe(true);
        expect(result.model).toBe('claude-sonnet-4.6');
        expect(mockSession.config.provider).toBe('anthropic-copilot');
      });

      it('persists the new provider in the database', async () => {
        handler = createHandler({ queryObject: null });
        await handler.switchModel('claude-sonnet-4.6', 'anthropic-copilot');

        expect(updateSessionSpy).toHaveBeenCalledWith(
          mockSession.id,
          expect.objectContaining({
            config: expect.objectContaining({
              model: 'claude-sonnet-4.6',
              provider: 'anthropic-copilot',
            }),
          })
        );
      });
    });

    describe('cross-provider switch (glm to anthropic, explicit provider)', () => {
      it('switches from glm to anthropic when explicit provider given', async () => {
        mockSession.config.model = 'glm-5';
        mockSession.config.provider = 'glm';

        handler = createHandler({ queryObject: null });
        const result = await handler.switchModel('opus', 'anthropic');

        expect(result.success).toBe(true);
        expect(mockSession.config.provider).toBe('anthropic');
        expect(updateSessionSpy).toHaveBeenCalledWith(
          mockSession.id,
          expect.objectContaining({
            config: expect.objectContaining({
              model: 'opus',
              provider: 'anthropic',
            }),
          })
        );
      });
    });
    describe('Kimi K3 [1m] suffix preservation', () => {
      it('persists the [1m] suffix when switching to the k3 alias', async () => {
        handler = createHandler({ queryObject: null });
        const result = await handler.switchModel('k3[1m]', 'kimi');

        expect(result.success).toBe(true);
        expect(result.model).toBe('kimi-k3[1m]');
        expect(mockSession.config.model).toBe('kimi-k3[1m]');
        expect(mockSession.config.provider).toBe('kimi');
      });

      it('treats k3[1m] as already in use when the session is on K3 1M', async () => {
        mockSession.config.model = 'kimi-k3[1m]';
        mockSession.config.provider = 'kimi';

        handler = createHandler({ queryObject: null });
        const result = await handler.switchModel('k3[1m]', 'kimi');

        expect(result.success).toBe(true);
        expect(result.error).toContain('Already using');
      });

      it('does not append the [1m] suffix when switching to k3-256k', async () => {
        handler = createHandler({ queryObject: null });
        const result = await handler.switchModel('k3-256k', 'kimi');

        expect(result.success).toBe(true);
        expect(result.model).toBe('k3-256k');
        expect(mockSession.config.model).toBe('k3-256k');
      });
    });
  });
});
