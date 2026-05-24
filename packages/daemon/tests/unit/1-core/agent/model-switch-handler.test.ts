/**
 * ModelSwitchHandler Tests
 *
 * Tests model switching logic for AgentSession.
 * Note: Tests that require model validation are skipped since model-service
 * functions cannot be easily mocked in ESM modules.
 */

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import {
  ModelSwitchHandler,
  type ModelSwitchHandlerContext,
} from '../../../../src/lib/agent/model-switch-handler';
import type { Session, ModelInfo } from '@neokai/shared';
import type { MessageHub } from '@neokai/shared';
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
import { generateUUID } from '@neokai/shared';
import { resetProviderFactory, initializeProviders } from '../../../../src/lib/providers/factory';
import { resetProviderRegistry } from '../../../../src/lib/providers/registry';
import { setModelsCache, clearModelsCache } from '../../../../src/lib/model-service';

// Test model data for the models cache
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
  // Copilot models — intentionally share IDs with standard Anthropic models.
  // isValidModel/getModelInfo now filter by provider, so 'claude-opus-4.6' under
  // 'anthropic-copilot' and 'claude-opus-4.6' under 'anthropic' are distinct entries.
  // There is no Anthropic entry for 'claude-sonnet-4.6' here because the cross-provider
  // tests that start on 'anthropic' switch *to* 'anthropic-copilot' and only need the
  // copilot entry to resolve. Callers that stay on 'anthropic' use 'default'/'opus'/etc.
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
    // 'claude-sonnet-4.6' registered only under 'anthropic-copilot' in this fixture.
    // isValidModel('claude-sonnet-4.6', 'global', 'anthropic-copilot') → found.
    // isValidModel('claude-sonnet-4.6', 'global', 'anthropic')         → not found
    //   (tests that need an anthropic sonnet use 'default' which resolves to 'default').
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

  beforeEach(() => {
    // Initialize providers for model validation
    resetProviderRegistry();
    resetProviderFactory();
    clearModelsCache();
    initializeProviders();

    // Pre-populate the models cache with test models
    // This allows model validation to work without requiring API calls
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

    // Create mocks
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
      expect(modelInfo.info).toBeNull(); // Info is fetched async
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
    // Use a valid model that's different from 'default'
    // 'opus' is a distinct model that will trigger actual switching
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
        // Simulate a room agent session config with runtime-only non-serializable fields
        const mockCallback = () => {};
        const liveObj = { handler: mockCallback };
        (mockSession.config as Record<string, unknown>)['mcpServers'] = { 'room-tools': liveObj };

        handler = createHandler({ queryObject: null });
        const result = await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(result.success).toBe(true);
        // The spy should have been called with only plain serializable fields
        const callArg = updateSessionSpy.mock.calls[0][1] as { config: Record<string, unknown> };
        expect(callArg.config).toHaveProperty('model', 'opus');
        // mcpServers must NOT be in the persisted config — it's a runtime-only field
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
    });

    describe('when transport not ready', () => {
      it('should restart query when queryObject exists even if transport not ready', async () => {
        // When queryObject exists but firstMessageReceived is false, we still need to
        // restart because the SDK subprocess is already running with the old model.
        // Without restart, the new model would not take effect.
        handler = createHandler({ firstMessageReceived: false });
        const result = await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(result.success).toBe(true);
        expect(updateSessionSpy).toHaveBeenCalled();
        // Restart IS called because queryObject exists - the new model must take effect
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
        expect(result.model).toBe('default'); // Returns current model
      });

      it('should return success with message when already using model', async () => {
        // No query running for simpler test
        handler = createHandler({ queryObject: null });
        // Switch to haiku first
        await handler.switchModel('haiku', 'anthropic');
        // Then try to switch to haiku again
        const result = await handler.switchModel('haiku', 'anthropic');

        expect(result.success).toBe(true);
        expect(result.error).toContain('Already using');
      });
    });

    describe('error handling', () => {
      it('should handle errors and call error manager', async () => {
        // Make restart throw
        restartSpy.mockRejectedValue(new Error('Restart failed'));
        handler = createHandler();

        const result = await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Restart failed');
        expect(handleErrorSpy).toHaveBeenCalled();
      });

      it('should return error when session has no provider configured', async () => {
        // Remove provider from session config
        (mockSession.config as Record<string, unknown>).provider = undefined;
        handler = createHandler({ queryObject: null });

        const result = await handler.switchModel(VALID_MODEL, 'anthropic');

        expect(result.success).toBe(false);
        expect(result.error).toContain('Session has no provider configured');
      });
    });

    describe('context tracker update', () => {
      it('should update context tracker model', async () => {
        // Set query to null so we don't need restart
        handler = createHandler({ queryObject: null });
        // Use haiku to ensure we're switching to a different model
        await handler.switchModel('haiku', 'anthropic');

        expect(setModelTrackerSpy).toHaveBeenCalled();
      });
    });
  });

  describe('provider routing', () => {
    /**
     * Same-provider switch: copilot opus -> copilot sonnet (explicit provider)
     *
     * When a session is on anthropic-copilot and the caller explicitly passes
     * 'anthropic-copilot' as the provider, the switch stays within that provider.
     * Both copilot-opus and copilot-sonnet share canonical IDs with Anthropic models;
     * explicit provider routing (dev approach) means there is no ambiguity.
     */
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
        // copilot-anthropic-opus resolves to claude-opus-4.6 which is the current model.
        // Provider also matches, so the handler takes the "already using" early-return path.
        handler = createHandler({ queryObject: null });
        const result = await handler.switchModel('copilot-anthropic-opus', 'anthropic-copilot');

        expect(result.success).toBe(true);
        expect(result.error).toContain('Already using');
        // No-op: must not write to DB or restart query
        expect(updateSessionSpy).not.toHaveBeenCalled();
      });
    });

    /**
     * Cross-provider switch: anthropic -> copilot (explicit provider)
     *
     * Caller explicitly requests 'anthropic-copilot'; session was on 'anthropic'.
     * The explicit provider arg always wins.
     */
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

    /**
     * Cross-provider switch: GLM -> anthropic (explicit provider)
     *
     * Caller passes 'anthropic' explicitly when switching from GLM to an Anthropic model.
     */
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
  });
});
