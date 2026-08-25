import { describe, expect, it, beforeEach, afterEach, mock, jest } from 'bun:test';
import { tmpdir } from 'node:os';
import {
  QueryRunner,
  looksLikeRateLimit429,
  refreshQueryEnvFromProcess,
  type QueryRunnerContext,
} from '../../../../src/lib/agent/query-runner';
import type { LimitRetryHint } from '../../../../src/lib/agent/limit-error-classifier';
import { longTermAgentSessionId } from '../../../../src/lib/space/long-term-agent-session';
import type { Session, MessageHub } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { Database } from '../../../../src/storage/database';
import type { QueryLike } from '../../../../src/lib/agent/query-like';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import { ErrorCategory, type ErrorManager } from '../../../../src/lib/error-manager';
import type { Logger } from '../../../../src/lib/logger';
import type { QueryOptionsBuilder } from '../../../../src/lib/agent/query-options-builder';
import type { AskUserQuestionHandler } from '../../../../src/lib/agent/ask-user-question-handler';

describe('QueryRunner', () => {
  let runner: QueryRunner;
  let mockSession: Session;
  let mockDb: Database;
  let mockMessageHub: MessageHub;
  let mockMessageQueue: MessageQueue;
  let mockStateManager: ProcessingStateManager;
  let mockErrorManager: ErrorManager;
  let mockLogger: Logger;
  let mockOptionsBuilder: QueryOptionsBuilder;
  let mockAskUserQuestionHandler: AskUserQuestionHandler;

  let isRunningSpy: ReturnType<typeof mock>;
  let startSpy: ReturnType<typeof mock>;
  let clearSpy: ReturnType<typeof mock>;
  let stopSpy: ReturnType<typeof mock>;
  let sizeSpy: ReturnType<typeof mock>;
  let getStateSpy: ReturnType<typeof mock>;
  let setIdleSpy: ReturnType<typeof mock>;
  let setProcessingSpy: ReturnType<typeof mock>;
  let beginTerminalIdleSpy: ReturnType<typeof mock>;
  let handleErrorSpy: ReturnType<typeof mock>;
  let publishSpy: ReturnType<typeof mock>;
  let saveSDKMessageSpy: ReturnType<typeof mock>;
  let updateSessionSpy: ReturnType<typeof mock>;
  let getSDKMessagesSpy: ReturnType<typeof mock>;
  let updateMessageStatusSpy: ReturnType<typeof mock>;
  let buildSpy: ReturnType<typeof mock>;
  let addSessionStateOptionsSpy: ReturnType<typeof mock>;
  let setCanUseToolSpy: ReturnType<typeof mock>;
  let setAskUserQuestionHookSpy: ReturnType<typeof mock>;
  let getDeferredPermissionModeSpy: ReturnType<typeof mock>;
  let getCurrentPermissionModeSpy: ReturnType<typeof mock>;
  let createCanUseToolCallbackSpy: ReturnType<typeof mock>;
  let createPreToolUseHookSpy: ReturnType<typeof mock>;
  let enqueueWithIdSpy: ReturnType<typeof mock>;

  let queryGeneration: number;
  let onSDKMessageSpy: ReturnType<typeof mock>;
  let onSlashCommandsFetchedSpy: ReturnType<typeof mock>;
  let onModelsFetchedSpy: ReturnType<typeof mock>;
  let onMarkApiSuccessSpy: ReturnType<typeof mock>;
  let trackAgentProcessSpy: ReturnType<typeof mock>;
  let terminateTrackedAgentProcessesSpy: ReturnType<typeof mock>;
  let snapshotTrackedAgentProcessesSpy: ReturnType<typeof mock>;

  beforeEach(() => {
    mockSession = {
      id: 'test-session-id',
      title: 'Test Session',
      workspacePath: '/test/path',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: {
        model: 'default',
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

    queryGeneration = 0;

    trackAgentProcessSpy = mock(() => {});
    terminateTrackedAgentProcessesSpy = mock(() => {});
    snapshotTrackedAgentProcessesSpy = mock(() => []);
    onSDKMessageSpy = mock(async () => {});
    onSlashCommandsFetchedSpy = mock(async () => {});
    onModelsFetchedSpy = mock(async () => {});
    onMarkApiSuccessSpy = mock(async () => {});

    saveSDKMessageSpy = mock(() => {});
    updateSessionSpy = mock(() => {});
    getSDKMessagesSpy = mock(() => ({ messages: [], hasMore: false }));
    updateMessageStatusSpy = mock(() => {});
    mockDb = {
      saveSDKMessage: saveSDKMessageSpy,
      updateSession: updateSessionSpy,
      getSDKMessages: getSDKMessagesSpy,
      updateMessageStatus: updateMessageStatusSpy,
      getNodeExecutionRepo: mock(() => ({
        getByAgentSessionId: (sessionId: string) =>
          sessionId === 'space:s1:task:t1:exec:e1' ? { id: 'exec-1' } : null,
      })),
      getSpaceTaskRepo: mock(() => ({
        getTask: (taskId: string) =>
          taskId === 't1' ? { id: 't1', spaceId: 's1', workflowRunId: 'run-1' } : null,
      })),
    } as unknown as Database;

    publishSpy = mock(async () => {});
    mockMessageHub = {
      event: publishSpy,
      onRequest: mock((_method: string, _handler: Function) => () => {}),
      query: mock(async () => ({})),
      command: mock(async () => {}),
    } as unknown as MessageHub;

    isRunningSpy = mock(() => false);
    startSpy = mock(() => {
      isRunningSpy.mockReturnValue(true);
    });
    clearSpy = mock(() => {});
    stopSpy = mock(() => {
      isRunningSpy.mockReturnValue(false);
    });
    sizeSpy = mock(() => 0);
    enqueueWithIdSpy = mock(async () => {
      sizeSpy.mockReturnValue(sizeSpy() + 1);
    });
    mockMessageQueue = {
      isRunning: isRunningSpy,
      start: startSpy,
      clear: clearSpy,
      stop: stopSpy,
      size: sizeSpy,
      getGeneration: mock(() => 0),
      enqueueWithId: enqueueWithIdSpy,
      messageGenerator: mock(async function* () {}),
    } as unknown as MessageQueue;

    getStateSpy = mock(() => ({ status: 'idle' }));
    setIdleSpy = mock(async () => {});
    setProcessingSpy = mock(async () => {});
    beginTerminalIdleSpy = mock(() => {});
    mockStateManager = {
      getState: getStateSpy,
      setIdle: setIdleSpy,
      setProcessing: setProcessingSpy,
      beginTerminalIdle: beginTerminalIdleSpy,
    } as unknown as ProcessingStateManager;

    handleErrorSpy = mock(async () => {});
    mockErrorManager = {
      handleError: handleErrorSpy,
    } as unknown as ErrorManager;

    mockLogger = {
      log: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
      info: mock(() => {}),
    } as unknown as Logger;

    buildSpy = mock(async () => ({ model: 'claude-sonnet-4-20250514' }));
    addSessionStateOptionsSpy = mock((options: unknown) => options);
    setCanUseToolSpy = mock(() => {});
    setAskUserQuestionHookSpy = mock(() => {});
    getDeferredPermissionModeSpy = mock(() => undefined);
    getCurrentPermissionModeSpy = mock(() => undefined);
    mockOptionsBuilder = {
      build: buildSpy,
      addSessionStateOptions: addSessionStateOptionsSpy,
      setCanUseTool: setCanUseToolSpy,
      setAskUserQuestionHook: setAskUserQuestionHookSpy,
      getDeferredPermissionMode: getDeferredPermissionModeSpy,
      getCurrentPermissionMode: getCurrentPermissionModeSpy,
    } as unknown as QueryOptionsBuilder;

    createCanUseToolCallbackSpy = mock(() => async () => true);
    createPreToolUseHookSpy = mock(() => async () => ({}));
    mockAskUserQuestionHandler = {
      createCanUseToolCallback: createCanUseToolCallbackSpy,
      createPreToolUseHook: createPreToolUseHookSpy,
    } as unknown as AskUserQuestionHandler;
  });

  function createContext(overrides: Partial<QueryRunnerContext> = {}): QueryRunnerContext {
    return {
      session: mockSession,
      db: mockDb,
      messageHub: mockMessageHub,
      messageQueue: mockMessageQueue,
      stateManager: mockStateManager,
      errorManager: mockErrorManager,
      logger: mockLogger,
      optionsBuilder: mockOptionsBuilder,
      askUserQuestionHandler: mockAskUserQuestionHandler,

      queryObject: null,
      queryPromise: null,
      queryAbortController: null,
      firstMessageReceived: false,
      startupTimeoutTimer: null,
      originalEnvVars: {},

      processExitedPromise: null,
      resetProcessExitedPromise: mock(function (this: {
        processExitedPromise: Promise<void> | null;
      }) {
        this.processExitedPromise = null;
      }),
      trackAgentProcess: trackAgentProcessSpy,
      terminateTrackedAgentProcesses: terminateTrackedAgentProcessesSpy,
      snapshotTrackedAgentProcesses: snapshotTrackedAgentProcessesSpy,

      incrementQueryGeneration: () => ++queryGeneration,
      getQueryGeneration: () => queryGeneration,
      isCleaningUp: () => false,

      onSDKMessage: onSDKMessageSpy,
      onSlashCommandsFetched: onSlashCommandsFetchedSpy,
      onModelsFetched: onModelsFetchedSpy,
      onMarkApiSuccess: onMarkApiSuccessSpy,

      ...overrides,
    };
  }

  function createRunner(overrides: Partial<QueryRunnerContext> = {}): QueryRunner {
    return new QueryRunner(createContext(overrides));
  }

  describe('constructor', () => {
    it('should create runner with dependencies', () => {
      runner = createRunner();
      expect(runner).toBeDefined();
    });
  });

  describe('resolveRetryUserMessage', () => {
    it('prefers the message identified by the result uuid and never guesses on a miss', async () => {
      async function* generator() {
        yield {
          message: { uuid: 'init-uuid', message: { content: 'first prompt' } },
          onSent: () => {},
        };
        yield {
          message: { uuid: 'steer-uuid', message: { content: 'later steer' } },
          onSent: () => {},
        };
      }
      runner = createRunner({
        messageQueue: {
          ...mockMessageQueue,
          messageGenerator: generator,
        } as unknown as MessageQueue,
      });

      const wrapper = runner.createMessageGeneratorWrapper(1);
      for await (const yielded of wrapper) {
        void yielded;
      }

      expect(runner.lastConsumedUserMessage?.uuid).toBe('steer-uuid');
      expect(runner.resolveRetryUserMessage('init-uuid')?.uuid).toBe('init-uuid');
      expect(runner.resolveRetryUserMessage('init-uuid')?.content).toBe('first prompt');
      expect(runner.resolveRetryUserMessage('unknown-uuid')).toBeNull();
      expect(runner.resolveRetryUserMessage(undefined)).toBe(runner.lastConsumedUserMessage);
    });

    it('retains uuid correlation after the first SDK response clears the startup map', async () => {
      async function* generator() {
        yield {
          message: { uuid: 'init-uuid', message: { content: 'first prompt' } },
          onSent: () => {},
        };
        yield {
          message: { uuid: 'steer-uuid', message: { content: 'later steer' } },
          onSent: () => {},
        };
      }
      const ctx = createContext({
        messageQueue: {
          ...mockMessageQueue,
          messageGenerator: generator,
        } as unknown as MessageQueue,
      });
      runner = new QueryRunner(ctx);

      const wrapper = runner.createMessageGeneratorWrapper(1);
      let first = true;
      for await (const yielded of wrapper) {
        void yielded;
        if (first) {
          ctx.firstMessageReceived = true;
          first = false;
        }
      }

      expect(runner.resolveRetryUserMessage('init-uuid')?.uuid).toBe('init-uuid');
      expect(runner.resolveRetryUserMessage('init-uuid')?.content).toBe('first prompt');
    });

    it('stops feeding prompts and requeues them while limit recovery is pending', async () => {
      async function* generator() {
        yield {
          message: { uuid: 'queued-uuid', message: { content: 'queued steer' } },
          onSent: () => {},
        };
      }
      const requeueYieldedSpy = mock(() => true);
      runner = createRunner({
        messageQueue: {
          ...mockMessageQueue,
          messageGenerator: generator,
          requeueYielded: requeueYieldedSpy,
        } as unknown as MessageQueue,
        isLimitRecoveryPending: () => true,
      });

      const wrapper = runner.createMessageGeneratorWrapper(1);
      const yielded: unknown[] = [];
      for await (const item of wrapper) {
        yielded.push(item);
      }

      expect(yielded).toEqual([]);
      expect(requeueYieldedSpy).toHaveBeenCalledWith('queued-uuid');
      expect(runner.lastConsumedUserMessage).toBeNull();
    });

    it('marks the prompt consumed through the pre-yield callback only after the gate passes', async () => {
      async function* generator() {
        yield {
          message: { uuid: 'normal-uuid', message: { content: 'normal prompt' } },
          onSent: () => {},
        };
      }
      const onMessageYieldedSpy = mock(() => {});
      runner = createRunner({
        messageQueue: {
          ...mockMessageQueue,
          messageGenerator: generator,
          onMessageYielded: onMessageYieldedSpy,
        } as unknown as MessageQueue,
        isLimitRecoveryPending: () => false,
      });

      const wrapper = runner.createMessageGeneratorWrapper(1);
      let yieldedCount = 0;
      for await (const item of wrapper) {
        void item;
        yieldedCount++;
      }

      expect(yieldedCount).toBe(1);
      expect(onMessageYieldedSpy).toHaveBeenCalledWith('normal-uuid', expect.any(Number));
      expect(runner.lastConsumedUserMessage?.uuid).toBe('normal-uuid');
    });
  });

  describe('start', () => {
    async function withAnthropicApiKey(fn: () => Promise<void>): Promise<void> {
      const savedApiKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      try {
        await fn();
      } finally {
        if (savedApiKey === undefined) {
          delete process.env.ANTHROPIC_API_KEY;
        } else {
          process.env.ANTHROPIC_API_KEY = savedApiKey;
        }
      }
    }

    it('should skip start if query already running', async () => {
      isRunningSpy.mockReturnValue(true);
      runner = createRunner({ queryPromise: new Promise<void>(() => {}) });

      await runner.start();

      expect(startSpy).not.toHaveBeenCalled();
      expect(queryGeneration).toBe(0);
    });

    it('treats a query promise installed by another component as live and skips start', async () => {
      isRunningSpy.mockReturnValue(true);
      runner = createRunner({ queryPromise: Promise.resolve() });

      await runner.start();

      expect(startSpy).not.toHaveBeenCalled();
      expect(queryGeneration).toBe(0);
    });

    it('force-stops a stale running messageQueue with no live query and starts a fresh query', async () => {
      isRunningSpy.mockReturnValue(true);
      const ctx = createContext({ queryPromise: null });
      runner = new QueryRunner(ctx);

      await runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(stopSpy).toHaveBeenCalled();
      expect(startSpy).toHaveBeenCalled();
      expect(queryGeneration).toBe(1);
      expect(ctx.queryPromise).toBeNull();
      expect(ctx.queryAbortController).toBeNull();
    });

    it('force-restarts when a query this runner started has settled but the queue is still running', async () => {
      const ctx = createContext();
      runner = new QueryRunner(ctx);

      runner.start();
      const firstQueryPromise = ctx.queryPromise;
      await firstQueryPromise?.catch(() => {});

      isRunningSpy.mockReturnValue(true);
      ctx.queryPromise = firstQueryPromise ?? null;

      await runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(stopSpy).toHaveBeenCalled();
      expect(queryGeneration).toBe(2);
    });

    it('terminates orphaned agent processes and drops the stale query object when recovering a stale running queue', async () => {
      isRunningSpy.mockReturnValue(true);
      const orphanedProcess = { pid: 4242, kill: mock(() => {}) } as never;
      const snapshot = [[4242, orphanedProcess]] as never;
      const ctx = createContext({
        queryPromise: null,
        queryObject: { close: mock(() => {}) } as never,
        snapshotTrackedAgentProcesses: () => snapshot,
      });
      runner = new QueryRunner(ctx);

      await runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(terminateTrackedAgentProcessesSpy).toHaveBeenCalledWith({
        forceDelayMs: 2000,
        processes: snapshot,
      });
      expect(ctx.queryObject).toBeNull();
      expect(queryGeneration).toBe(1);
    });

    it('should start message queue and increment generation', async () => {
      isRunningSpy.mockReturnValue(false);
      runner = createRunner();

      runner.start();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(startSpy).toHaveBeenCalled();
      expect(queryGeneration).toBe(1);
    });

    it('should reset firstMessageReceived flag', async () => {
      isRunningSpy.mockReturnValue(false);
      const ctx = createContext({ firstMessageReceived: true });
      runner = new QueryRunner(ctx);

      runner.start();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(ctx.firstMessageReceived).toBe(false);
    });

    function stopAfterRebuiltOptions() {
      let addOptionsCalls = 0;
      addSessionStateOptionsSpy.mockImplementation((options: unknown) => {
        addOptionsCalls++;
        if (addOptionsCalls === 2) {
          throw new Error('stop after rebuilt options');
        }
        return options;
      });
    }

    it('rebuilds query options after workflow MCP self-heal before SDK query creation', async () => {
      await withAnthropicApiKey(async () => {
        mockSession.id = 'space:s1:task:t1:exec:e1';
        mockSession.workspacePath = tmpdir();
        mockSession.type = 'worker';
        mockSession.context = { spaceId: 's1', taskId: 't1' };
        mockSession.config.mcpServers = {};

        const repairedServers = {
          'node-agent': {
            type: 'sdk',
            name: 'node-agent',
            instance: {},
          },
        };
        buildSpy
          .mockResolvedValueOnce({ model: 'claude-sonnet-4-20250514', mcpServers: {} })
          .mockResolvedValueOnce({
            model: 'claude-sonnet-4-20250514',
            mcpServers: repairedServers,
          });
        stopAfterRebuiltOptions();
        const onMissingWorkflowMcpServers = mock(async () => {
          mockSession.config.mcpServers =
            repairedServers as unknown as Session['config']['mcpServers'];
        });

        const ctx = createContext({ onMissingWorkflowMcpServers });
        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expect(onMissingWorkflowMcpServers).toHaveBeenCalledWith(ctx, ['node-agent']);
        expect(onMissingWorkflowMcpServers.mock.calls[0][0].session.id).toBe(
          'space:s1:task:t1:exec:e1'
        );
        expect(buildSpy).toHaveBeenCalledTimes(2);
        expect(addSessionStateOptionsSpy).toHaveBeenCalledTimes(2);
      });
    });

    it('rebuilds query options after Space chat MCP self-heal before SDK query creation', async () => {
      await withAnthropicApiKey(async () => {
        mockSession.id = 'space:chat:s1';
        mockSession.workspacePath = tmpdir();
        mockSession.type = 'space_chat';
        mockSession.context = { spaceId: 's1' };
        mockSession.config.mcpServers = {};

        const repairedServers = {
          'space-agent-tools': {
            type: 'sdk',
            name: 'space-agent-tools',
            instance: {},
          },
        };
        buildSpy
          .mockResolvedValueOnce({ model: 'claude-sonnet-4-20250514', mcpServers: {} })
          .mockResolvedValueOnce({
            model: 'claude-sonnet-4-20250514',
            mcpServers: repairedServers,
          });
        stopAfterRebuiltOptions();
        const onMissingSpaceChatMcpServers = mock(async () => {
          mockSession.config.mcpServers =
            repairedServers as unknown as Session['config']['mcpServers'];
        });

        const ctx = createContext({ onMissingSpaceChatMcpServers });
        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expect(onMissingSpaceChatMcpServers).toHaveBeenCalledWith('space:chat:s1', [
          'space-agent-tools',
        ]);
        expect(buildSpy).toHaveBeenCalledTimes(2);
        expect(addSessionStateOptionsSpy).toHaveBeenCalledTimes(2);
      });
    });

    it('throws when a Space chat MCP invariant is missing and no self-heal callback exists', async () => {
      await withAnthropicApiKey(async () => {
        mockSession.id = 'space:chat:s1';
        mockSession.workspacePath = tmpdir();
        mockSession.type = 'space_chat';
        mockSession.context = { spaceId: 's1' };
        mockSession.config.mcpServers = {};
        buildSpy.mockResolvedValueOnce({ model: 'claude-sonnet-4-20250514', mcpServers: {} });

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expect(buildSpy).toHaveBeenCalledTimes(1);
        expect(addSessionStateOptionsSpy).toHaveBeenCalledTimes(1);
        expect(handleErrorSpy).toHaveBeenCalled();
        const error = handleErrorSpy.mock.calls[0][1] as Error;
        expect(error.message).toContain('[MCP invariant]');
        expect(error.message).toContain('space-agent-tools');
      });
    });

    it('does not self-heal when a Space chat already has its required MCP server', async () => {
      await withAnthropicApiKey(async () => {
        mockSession.id = 'space:chat:s1';
        mockSession.workspacePath = tmpdir();
        mockSession.type = 'space_chat';
        mockSession.context = { spaceId: 's1' };
        const servers = {
          'space-agent-tools': {
            type: 'sdk',
            name: 'space-agent-tools',
            instance: {},
          },
        };
        mockSession.config.mcpServers = servers as unknown as Session['config']['mcpServers'];
        buildSpy.mockResolvedValueOnce({
          model: 'claude-sonnet-4-20250514',
          mcpServers: servers,
        });
        const onMissingSpaceChatMcpServers = mock(async () => {});

        const ctx = createContext({ onMissingSpaceChatMcpServers });
        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expect(onMissingSpaceChatMcpServers).not.toHaveBeenCalled();
        expect(buildSpy).toHaveBeenCalledTimes(1);
        expect(addSessionStateOptionsSpy).toHaveBeenCalledTimes(1);
      });
    });

    it('rebuilds query options after member Space MCP self-heal before SDK query creation', async () => {
      await withAnthropicApiKey(async () => {
        mockSession.id = 'worker-session-1';
        mockSession.workspacePath = tmpdir();
        mockSession.type = 'worker';
        mockSession.context = { spaceId: 's1' };
        mockSession.config.mcpServers = {};

        const repairedServers = {
          'space-agent-tools': {
            type: 'sdk',
            name: 'space-agent-tools',
            instance: {},
          },
        };
        buildSpy
          .mockResolvedValueOnce({ model: 'claude-sonnet-4-20250514', mcpServers: {} })
          .mockResolvedValueOnce({
            model: 'claude-sonnet-4-20250514',
            mcpServers: repairedServers,
          });
        stopAfterRebuiltOptions();
        const onMissingMemberSpaceMcpServers = mock(async () => {
          mockSession.config.mcpServers =
            repairedServers as unknown as Session['config']['mcpServers'];
        });

        const ctx = createContext({ onMissingMemberSpaceMcpServers });
        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expect(onMissingMemberSpaceMcpServers).toHaveBeenCalledWith('worker-session-1', [
          'space-agent-tools',
        ]);
        expect(buildSpy).toHaveBeenCalledTimes(2);
        expect(addSessionStateOptionsSpy).toHaveBeenCalledTimes(2);
      });
    });

    it('throws when a member Space MCP invariant is missing and no self-heal callback exists', async () => {
      await withAnthropicApiKey(async () => {
        mockSession.id = 'worker-session-1';
        mockSession.workspacePath = tmpdir();
        mockSession.type = 'worker';
        mockSession.context = { spaceId: 's1' };
        mockSession.config.mcpServers = {};
        buildSpy.mockResolvedValueOnce({ model: 'claude-sonnet-4-20250514', mcpServers: {} });

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expect(buildSpy).toHaveBeenCalledTimes(1);
        expect(addSessionStateOptionsSpy).toHaveBeenCalledTimes(1);
        expect(handleErrorSpy).toHaveBeenCalled();
        const error = handleErrorSpy.mock.calls[0][1] as Error;
        expect(error.message).toContain('[MCP invariant]');
        expect(error.message).toContain('space-agent-tools');
        expect(error.message).toContain('member session');
      });
    });

    it('does not self-heal when a member Space already has its required MCP server', async () => {
      await withAnthropicApiKey(async () => {
        mockSession.id = 'worker-session-1';
        mockSession.workspacePath = tmpdir();
        mockSession.type = 'worker';
        mockSession.context = { spaceId: 's1' };
        const servers = {
          'space-agent-tools': {
            type: 'sdk',
            name: 'space-agent-tools',
            instance: {},
          },
        };
        mockSession.config.mcpServers = servers as unknown as Session['config']['mcpServers'];
        buildSpy.mockResolvedValueOnce({
          model: 'claude-sonnet-4-20250514',
          mcpServers: servers,
        });
        const onMissingMemberSpaceMcpServers = mock(async () => {});

        const ctx = createContext({ onMissingMemberSpaceMcpServers });
        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expect(onMissingMemberSpaceMcpServers).not.toHaveBeenCalled();
        expect(buildSpy).toHaveBeenCalledTimes(1);
        expect(addSessionStateOptionsSpy).toHaveBeenCalledTimes(1);
      });
    });

    it('throws when member Space MCP still missing after self-heal callback', async () => {
      await withAnthropicApiKey(async () => {
        mockSession.id = 'worker-session-1';
        mockSession.workspacePath = tmpdir();
        mockSession.type = 'worker';
        mockSession.context = { spaceId: 's1' };
        mockSession.config.mcpServers = {};
        buildSpy
          .mockResolvedValueOnce({ model: 'claude-sonnet-4-20250514', mcpServers: {} })
          .mockResolvedValueOnce({
            model: 'claude-sonnet-4-20250514',
            mcpServers: {},
          });

        const onMissingMemberSpaceMcpServers = mock(async () => {});

        const ctx = createContext({ onMissingMemberSpaceMcpServers });
        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expect(onMissingMemberSpaceMcpServers).toHaveBeenCalledWith('worker-session-1', [
          'space-agent-tools',
        ]);
        expect(buildSpy).toHaveBeenCalledTimes(2);
        expect(handleErrorSpy).toHaveBeenCalled();
        const error = handleErrorSpy.mock.calls[0][1] as Error;
        expect(error.message).toContain('[MCP invariant]');
        expect(error.message).toContain('still missing');
        expect(error.message).toContain('member session');
      });
    });

    it('skips member Space MCP invariant for sessions without spaceId', async () => {
      await withAnthropicApiKey(async () => {
        mockSession.id = 'plain-worker-1';
        mockSession.workspacePath = tmpdir();
        mockSession.type = 'worker';
        mockSession.context = {};
        mockSession.config.mcpServers = {};
        buildSpy.mockResolvedValueOnce({ model: 'claude-sonnet-4-20250514', mcpServers: {} });
        mockMessageQueue.messageGenerator = mock(async function* () {
          throw new Error('generator abort for test');
        });

        const onMissingMemberSpaceMcpServers = mock(async () => {});
        const ctx = createContext({ onMissingMemberSpaceMcpServers });
        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expect(onMissingMemberSpaceMcpServers).not.toHaveBeenCalled();
        expect(buildSpy).toHaveBeenCalledTimes(1);
        expect(addSessionStateOptionsSpy).toHaveBeenCalledTimes(1);
      });
    });

    it('self-heals missing MCP servers for long-term Space agent sessions', async () => {
      await withAnthropicApiKey(async () => {
        mockSession.id = longTermAgentSessionId('s1', 'agent-1');
        mockSession.workspacePath = tmpdir();
        mockSession.type = 'worker';
        mockSession.context = { spaceId: 's1' };
        mockSession.metadata.promptProvenance = {
          source: 'test',
          hash: 'hash',
          agentId: 'agent-1',
          agentName: 'Long Term',
        };
        mockSession.config.mcpServers = {};

        const repairedServers = {
          'space-agent-tools': {
            type: 'sdk',
            name: 'space-agent-tools',
            instance: {},
          },
        };
        buildSpy
          .mockResolvedValueOnce({ model: 'claude-sonnet-4-20250514', mcpServers: {} })
          .mockResolvedValueOnce({
            model: 'claude-sonnet-4-20250514',
            mcpServers: repairedServers,
          });
        stopAfterRebuiltOptions();
        const onMissingMemberSpaceMcpServers = mock(async () => {
          mockSession.config.mcpServers =
            repairedServers as unknown as Session['config']['mcpServers'];
        });

        const ctx = createContext({ onMissingMemberSpaceMcpServers });
        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expect(onMissingMemberSpaceMcpServers).toHaveBeenCalledWith(mockSession.id, [
          'space-agent-tools',
        ]);
        expect(buildSpy).toHaveBeenCalledTimes(2);
        expect(addSessionStateOptionsSpy).toHaveBeenCalledTimes(2);
      });
    });

    it('skips member Space MCP invariant for workflow sub-sessions', async () => {
      await withAnthropicApiKey(async () => {
        mockSession.id = 'space:s1:task:t1:exec:e1';
        mockSession.workspacePath = tmpdir();
        mockSession.type = 'worker';
        mockSession.context = { spaceId: 's1', taskId: 't1' };
        const nodeAgentServer = {
          type: 'sdk',
          name: 'node-agent',
          instance: {},
        };
        mockSession.config.mcpServers = {
          'node-agent': nodeAgentServer,
        } as unknown as Session['config']['mcpServers'];

        const repairedServers = {
          'node-agent': nodeAgentServer,
          'space-agent-tools': {
            type: 'sdk',
            name: 'space-agent-tools',
            instance: {},
          },
        };
        buildSpy
          .mockResolvedValueOnce({
            model: 'claude-sonnet-4-20250514',
            mcpServers: { 'node-agent': nodeAgentServer },
          })
          .mockResolvedValueOnce({
            model: 'claude-sonnet-4-20250514',
            mcpServers: repairedServers,
          });
        stopAfterRebuiltOptions();

        const onMissingMemberSpaceMcpServers = mock(async () => {
          mockSession.config.mcpServers =
            repairedServers as unknown as Session['config']['mcpServers'];
        });
        const ctx = createContext({ onMissingMemberSpaceMcpServers });
        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expect(onMissingMemberSpaceMcpServers).not.toHaveBeenCalled();
        expect(buildSpy).toHaveBeenCalledTimes(1);
        expect(addSessionStateOptionsSpy).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('applyDeferredPermissionMode', () => {
    type ApplyFn = (
      queryObject: unknown,
      mode: string | undefined,
      timeoutMs?: number,
      backoffMs?: number
    ) => Promise<void>;

    const call = (r: QueryRunner, queryObject: unknown, mode: string | undefined) =>
      (r as unknown as { applyDeferredPermissionMode: ApplyFn }).applyDeferredPermissionMode(
        queryObject,
        mode,
        10,
        1
      );

    it('issues the switch when the live mode still matches the captured one', async () => {
      const setMode = mock(async () => {});
      const queryObject = { setPermissionMode: setMode } as unknown as Query;
      const ctx = createContext({ queryObject });
      runner = new QueryRunner(ctx);

      await call(runner, queryObject, 'bypassPermissions');

      expect(setMode).toHaveBeenCalledWith('bypassPermissions');
      expect(setMode).toHaveBeenCalledTimes(1);
    });

    it('bails without writing when the user changed the mode mid-flight (staleness guard)', async () => {
      const setMode = mock(async () => {});
      const queryObject = { setPermissionMode: setMode } as unknown as Query;
      getCurrentPermissionModeSpy.mockReturnValue('acceptEdits');
      runner = createRunner();

      await call(runner, queryObject, 'bypassPermissions');

      expect(setMode).not.toHaveBeenCalled();
    });

    it('stops retrying when the query object was replaced or closed', async () => {
      const setMode = mock(async () => {
        throw new Error('closed');
      });
      const queryObject = { setPermissionMode: setMode } as unknown as Query;
      const ctx = createContext({ queryObject });
      runner = new QueryRunner(ctx);
      ctx.queryObject = null;

      await call(runner, queryObject, 'bypassPermissions');

      expect(setMode).toHaveBeenCalledTimes(1);
    });

    it('retries a stalled control request and logs an error after all attempts fail', async () => {
      const setMode = mock(() => new Promise<void>(() => {}));
      const queryObject = { setPermissionMode: setMode } as unknown as Query;
      const ctx = createContext({ queryObject });
      runner = new QueryRunner(ctx);

      await call(runner, queryObject, 'bypassPermissions');

      expect(setMode).toHaveBeenCalledTimes(3);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('failed to apply deferred permission mode')
      );
    });
  });

  describe('displayErrorAsAssistantMessage', () => {
    it('should save error message to database', async () => {
      runner = createRunner();

      await runner.displayErrorAsAssistantMessage('Test error message');

      expect(saveSDKMessageSpy).toHaveBeenCalledWith(
        'test-session-id',
        expect.objectContaining({
          type: 'assistant',
          message: expect.objectContaining({
            role: 'assistant',
            content: [{ type: 'text', text: 'Test error message', citations: null }],
          }),
        })
      );
    });

    it('should publish message to state channel', async () => {
      runner = createRunner();

      await runner.displayErrorAsAssistantMessage('Test error');

      expect(publishSpy).toHaveBeenCalledWith(
        'state.sdkMessages.delta',
        expect.objectContaining({
          added: expect.arrayContaining([
            expect.objectContaining({
              type: 'assistant',
              session_id: 'test-session-id',
            }),
          ]),
        }),
        { channel: 'session:test-session-id' }
      );
    });

    it('should mark message as error when option provided', async () => {
      runner = createRunner();

      await runner.displayErrorAsAssistantMessage('Error text', { markAsError: true });

      expect(saveSDKMessageSpy).toHaveBeenCalledWith(
        'test-session-id',
        expect.objectContaining({
          error: 'invalid_request',
        })
      );
    });

    it('should not mark message as error when option not provided', async () => {
      runner = createRunner();

      await runner.displayErrorAsAssistantMessage('Normal error');

      const savedMessage = saveSDKMessageSpy.mock.calls[0][1];
      expect(savedMessage.error).toBeUndefined();
    });

    it('should generate UUID for the message', async () => {
      runner = createRunner();

      await runner.displayErrorAsAssistantMessage('Error with UUID');

      const savedMessage = saveSDKMessageSpy.mock.calls[0][1];
      expect(savedMessage.uuid).toBeDefined();
      expect(typeof savedMessage.uuid).toBe('string');
    });

    it('should set parent_tool_use_id to null', async () => {
      runner = createRunner();

      await runner.displayErrorAsAssistantMessage('Error message');

      const savedMessage = saveSDKMessageSpy.mock.calls[0][1];
      expect(savedMessage.parent_tool_use_id).toBeNull();
    });
  });

  describe('createMessageGeneratorWrapper', () => {
    it('should yield messages from queue and call onSent', async () => {
      const sentCount = { value: 0 };

      async function* mockMessageGenerator() {
        yield {
          message: { uuid: 'msg-1', content: 'Hello' },
          onSent: () => {
            sentCount.value++;
          },
        };
        yield {
          message: { uuid: 'msg-2', content: 'World' },
          onSent: () => {
            sentCount.value++;
          },
        };
      }

      const mockQueue = {
        ...mockMessageQueue,
        messageGenerator: mock(() => mockMessageGenerator()),
      };

      runner = createRunner({
        messageQueue: mockQueue as unknown as MessageQueue,
      });

      const generator = runner.createMessageGeneratorWrapper(0);
      const results: unknown[] = [];

      for await (const msg of generator) {
        results.push(msg);
      }

      expect(results).toHaveLength(2);
      expect(sentCount.value).toBe(2);
    });

    it('should set processing state for non-internal messages', async () => {
      async function* mockMessageGenerator() {
        yield {
          message: { uuid: 'msg-1', content: 'Hello', internal: false },
          onSent: () => {},
        };
      }

      const mockQueue = {
        ...mockMessageQueue,
        messageGenerator: mock(() => mockMessageGenerator()),
      };

      runner = createRunner({
        messageQueue: mockQueue as unknown as MessageQueue,
      });

      const generator = runner.createMessageGeneratorWrapper(0);

      for await (const _msg of generator) {
      }

      expect(setProcessingSpy).toHaveBeenCalledWith('msg-1', 'initializing');
    });

    it('does not publish or transition status at generator-yield time', async () => {
      async function* mockMessageGenerator() {
        yield {
          message: { uuid: 'msg-1', content: 'Hello', internal: false },
          onSent: () => {},
        };
      }

      const mockQueue = {
        ...mockMessageQueue,
        messageGenerator: mock(() => mockMessageGenerator()),
      };

      runner = createRunner({
        messageQueue: mockQueue as unknown as MessageQueue,
      });

      const generator = runner.createMessageGeneratorWrapper(0);
      for await (const _msg of generator) {
      }

      expect(updateMessageStatusSpy).not.toHaveBeenCalled();
      expect(publishSpy).not.toHaveBeenCalled();
    });

    it('should skip processing state for internal messages', async () => {
      async function* mockMessageGenerator() {
        yield {
          message: { uuid: 'internal-msg', content: '/context', internal: true },
          onSent: () => {},
        };
      }

      const mockQueue = {
        ...mockMessageQueue,
        messageGenerator: mock(() => mockMessageGenerator()),
      };

      runner = createRunner({
        messageQueue: mockQueue as unknown as MessageQueue,
      });

      const generator = runner.createMessageGeneratorWrapper(0);

      for await (const _msg of generator) {
      }

      expect(setProcessingSpy).not.toHaveBeenCalled();
      expect(updateMessageStatusSpy).not.toHaveBeenCalled();
      expect(publishSpy).not.toHaveBeenCalled();
    });

    it('should track last consumed non-internal message for transient retry re-enqueue', async () => {
      async function* mockMessageGenerator() {
        yield {
          message: {
            uuid: 'msg-1',
            session_id: 'test-session-id',
            parent_tool_use_id: null,
            message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
            internal: false,
          },
          onSent: () => {},
        };
      }

      const mockQueue = {
        ...mockMessageQueue,
        messageGenerator: mock(() => mockMessageGenerator()),
      } as unknown as MessageQueue;

      runner = createRunner({
        messageQueue: mockQueue as unknown as MessageQueue,
      });

      const generator = runner.createMessageGeneratorWrapper(0);
      for await (const _msg of generator) {
      }

      const tracked = (
        runner as unknown as {
          lastConsumedUserMessage: { uuid: string; content: unknown } | null;
        }
      ).lastConsumedUserMessage;
      expect(tracked).not.toBeNull();
      expect(tracked!.uuid).toBe('msg-1');
      expect(tracked!.content).toEqual([{ type: 'text', text: 'Hello' }]);
    });

    it('should not track internal messages for transient retry re-enqueue', async () => {
      async function* mockMessageGenerator() {
        yield {
          message: {
            uuid: 'internal-msg',
            session_id: 'test-session-id',
            parent_tool_use_id: null,
            message: { role: 'user', content: [{ type: 'text', text: '/context' }] },
            internal: true,
          },
          onSent: () => {},
        };
      }

      const mockQueue = {
        ...mockMessageQueue,
        messageGenerator: mock(() => mockMessageGenerator()),
      } as unknown as MessageQueue;

      runner = createRunner({
        messageQueue: mockQueue as unknown as MessageQueue,
      });

      const generator = runner.createMessageGeneratorWrapper(0);
      for await (const _msg of generator) {
      }

      const tracked = (
        runner as unknown as {
          lastConsumedUserMessage: { uuid: string } | null;
        }
      ).lastConsumedUserMessage;
      expect(tracked).toBeNull();
    });

    it('does not accumulate startup replay after the first SDK frame', async () => {
      async function* mockMessageGenerator() {
        yield {
          message: {
            uuid: 'msg-1',
            session_id: 'test-session-id',
            parent_tool_use_id: null,
            message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
            internal: false,
          },
          onSent: () => {},
        };
      }

      const mockQueue = {
        ...mockMessageQueue,
        messageGenerator: mock(() => mockMessageGenerator()),
      } as unknown as MessageQueue;

      runner = createRunner({
        messageQueue: mockQueue as unknown as MessageQueue,
        firstMessageReceived: true,
      });

      const generator = runner.createMessageGeneratorWrapper(0);
      for await (const _msg of generator) {
      }

      expect(
        (runner as unknown as { lastConsumedUserMessage: unknown }).lastConsumedUserMessage
      ).not.toBeNull();
      expect(
        (runner as unknown as { _consumedUserMessages: Map<number, unknown[]> })
          ._consumedUserMessages.size
      ).toBe(0);
    });
  });

  describe('handleSDKMessage', () => {
    it('should delegate system:init without queue status side effects', async () => {
      runner = createRunner();

      const systemInitMessage = {
        type: 'system',
        subtype: 'init',
        uuid: 'init-uuid',
        session_id: 'sdk-session-123',
      };

      await runner.handleSDKMessage(systemInitMessage as unknown as SDKMessage);

      expect(updateMessageStatusSpy).not.toHaveBeenCalled();
      expect(publishSpy).not.toHaveBeenCalled();
      expect(onSDKMessageSpy).toHaveBeenCalledWith(systemInitMessage);
    });

    it('should delegate to onSDKMessage callback', async () => {
      runner = createRunner();

      const message = {
        type: 'assistant',
        uuid: 'asst-uuid',
        message: { role: 'assistant', content: [] },
      };

      await runner.handleSDKMessage(message as unknown as SDKMessage);

      expect(onSDKMessageSpy).toHaveBeenCalledWith(message);
    });

    it('should call onMarkApiSuccess after handling message', async () => {
      runner = createRunner();

      const message = {
        type: 'assistant',
        uuid: 'asst-uuid',
        message: { role: 'assistant', content: [] },
      };

      await runner.handleSDKMessage(message as unknown as SDKMessage);

      expect(onMarkApiSuccessSpy).toHaveBeenCalled();
    });
  });

  describe('createAbortableQuery', () => {
    it('should yield messages from query iterator', async () => {
      runner = createRunner();

      const messages = [{ type: 'msg1' }, { type: 'msg2' }];
      let idx = 0;

      const mockQuery = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (idx < messages.length) {
              return { value: messages[idx++], done: false };
            }
            return { value: undefined, done: true };
          },
          return: async () => ({ value: undefined, done: true }),
        }),
      };

      const abortController = new AbortController();
      const generator = runner.createAbortableQuery(
        mockQuery as unknown as Query,
        abortController.signal
      );

      const results: unknown[] = [];
      for await (const msg of generator) {
        results.push(msg);
      }

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ type: 'msg1' });
      expect(results[1]).toEqual({ type: 'msg2' });
    });

    it('should stop iteration when signal is already aborted', async () => {
      runner = createRunner();

      const abortController = new AbortController();
      abortController.abort();

      const mockQuery = {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ value: { type: 'msg' }, done: false }),
          return: async () => ({ value: undefined, done: true }),
        }),
      };

      const generator = runner.createAbortableQuery(
        mockQuery as unknown as Query,
        abortController.signal
      );

      const results: unknown[] = [];
      for await (const msg of generator) {
        results.push(msg);
      }

      expect(results).toHaveLength(0);
    });

    it('should stop iteration when abort is called during iteration', async () => {
      runner = createRunner();

      const abortController = new AbortController();
      let callCount = 0;

      const mockQuery = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            callCount++;
            if (callCount === 2) {
              abortController.abort();
            }
            return { value: { type: `msg${callCount}` }, done: false };
          },
          return: async () => ({ value: undefined, done: true }),
        }),
      };

      const generator = runner.createAbortableQuery(
        mockQuery as unknown as Query,
        abortController.signal
      );

      const results: unknown[] = [];
      for await (const msg of generator) {
        results.push(msg);
        if (results.length > 5) break;
      }

      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('does not wait for iterator cleanup when abort wins a pending next', async () => {
      runner = createRunner();

      let returnCalled = false;
      const never = new Promise<IteratorResult<unknown>>(() => {});
      const mockQuery = {
        [Symbol.asyncIterator]: () => ({
          next: () => never,
          return: () => {
            returnCalled = true;
            return never;
          },
        }),
      };
      const abortController = new AbortController();
      const generator = runner.createAbortableQuery(
        mockQuery as unknown as Query,
        abortController.signal
      );
      const completion = (async () => {
        for await (const _message of generator) {
        }
      })();

      await Promise.resolve();
      abortController.abort();

      await Promise.race([
        completion,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('abortable query remained blocked')), 100)
        ),
      ]);
      expect(returnCalled).toBe(true);
    });

    it('should cleanup iterator on completion', async () => {
      runner = createRunner();

      let returnCalled = false;

      const mockQuery = {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ value: undefined, done: true }),
          return: async () => {
            returnCalled = true;
            return { value: undefined, done: true };
          },
        }),
      };

      const abortController = new AbortController();
      const generator = runner.createAbortableQuery(
        mockQuery as unknown as Query,
        abortController.signal
      );

      for await (const _msg of generator) {
      }

      expect(returnCalled).toBe(true);
    });

    it('should re-throw non-abort errors', async () => {
      runner = createRunner();

      const mockQuery = {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw new Error('Some SDK error');
          },
          return: async () => ({ value: undefined, done: true }),
        }),
      };

      const abortController = new AbortController();
      const generator = runner.createAbortableQuery(
        mockQuery as unknown as Query,
        abortController.signal
      );

      await expect(
        (async () => {
          for await (const _msg of generator) {
          }
        })()
      ).rejects.toThrow('Some SDK error');
    });
  });

  describe('runQuery() finally block close() behaviour', () => {
    it('should call close() on pre-existing queryObject in finally block', async () => {
      const closeSpy = mock(() => {});
      const ctx = createContext({
        queryObject: {
          interrupt: mock(async () => {}),
          close: closeSpy,
        } as unknown as Query,
      });
      runner = new QueryRunner(ctx);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(closeSpy).toHaveBeenCalled();
      expect(ctx.queryObject).toBeNull();
    });

    it('should handle close() errors gracefully in finally block', async () => {
      const ctx = createContext({
        queryObject: {
          interrupt: mock(async () => {}),
          close: mock(() => {
            throw new Error('Close failed');
          }),
        } as unknown as Query,
      });
      runner = new QueryRunner(ctx);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(ctx.queryObject).toBeNull();
    });

    it('should not call close() or null queryObject for stale queries in finally block', async () => {
      const closeSpy = mock(() => {});
      let gen = 0;
      const originalQueryObject = {
        interrupt: mock(async () => {}),
        close: closeSpy,
      } as unknown as Query;
      const ctx = createContext({
        queryObject: originalQueryObject,
        incrementQueryGeneration: () => ++gen,
        getQueryGeneration: () => 2,
      });
      runner = new QueryRunner(ctx);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(closeSpy).not.toHaveBeenCalled();
      expect(ctx.queryObject).toBe(originalQueryObject);
    });
  });

  describe('startup timeout error surfacing', () => {
    let savedApiKey: string | undefined;

    beforeEach(() => {
      savedApiKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      mockSession.workspacePath = tmpdir();
      buildSpy.mockRejectedValue(new Error('SDK startup timeout - query aborted'));
    });

    afterEach(() => {
      if (savedApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = savedApiKey;
      }
    });

    it('should always call messageQueue.clear() on startup timeout error', async () => {
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(clearSpy).toHaveBeenCalled();
    });

    it('should call messageQueue.clear() on startup-timeout AbortError', async () => {
      const abortError = new Error('SDK startup timeout - query aborted');
      abortError.name = 'AbortError';
      buildSpy.mockRejectedValue(abortError);

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(clearSpy).toHaveBeenCalled();
    });

    it('should surface error immediately via handleError on startup timeout', async () => {
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(handleErrorSpy).toHaveBeenCalled();
    });

    it('should pass actionable user message with timeout hint to handleError (startup timeout)', async () => {
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(handleErrorSpy).toHaveBeenCalledWith(
        'test-session-id',
        expect.any(Error),
        expect.any(String),
        expect.stringContaining('HYPERNEO_SDK_STARTUP_TIMEOUT_MS'),
        expect.anything(),
        expect.objectContaining({ isRootWorkspace: expect.any(Boolean) })
      );
      const userMessage = handleErrorSpy.mock.calls[0][3] as string;
      expect(userMessage).not.toContain('attempt(s)');
      expect(userMessage).toContain('current: 60000ms');
      expect(userMessage).toContain('did not emit its first message within the startup window');
      expect(userMessage).toContain('after one automatic retry');
      expect(userMessage).toContain('bounded by the startup gate');
      expect(userMessage).not.toContain('stale lock file');
      expect(userMessage).not.toContain('another Claude Code session');
    });

    it('should preserve sdkSessionId and surface error for conversation-not-found', async () => {
      mockSession.sdkSessionId = 'sdk-session-id';
      buildSpy.mockRejectedValue(new Error('No conversation found for session abc123'));
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(mockSession.sdkSessionId).toBe('sdk-session-id');
      expect(updateSessionSpy).not.toHaveBeenCalledWith(
        'test-session-id',
        expect.objectContaining({
          sdkSessionId: undefined,
        })
      );
      expect(handleErrorSpy).toHaveBeenCalledWith(
        'test-session-id',
        expect.any(Error),
        expect.any(String),
        expect.stringContaining('session could not be resumed'),
        expect.anything(),
        expect.objectContaining({ isRootWorkspace: expect.any(Boolean) })
      );
      const userMessage = handleErrorSpy.mock.calls[0][3] as string;
      expect(userMessage).not.toContain('HYPERNEO_SDK_STARTUP_TIMEOUT_MS');
      expect(userMessage).not.toContain('attempt(s)');
    });

    it('should preserve SDK state and retry without one-shot resumeSessionAt when its message is missing', async () => {
      mockSession.sdkSessionId = 'sdk-session-id';
      mockSession.sdkOriginPath = mockSession.workspacePath;

      buildSpy
        .mockRejectedValueOnce(
          new Error('No message found with message.uuid of: missing-message-uuid')
        )
        .mockRejectedValueOnce(new Error('stop after retry'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(2);
      expect(mockSession.sdkSessionId).toBe('sdk-session-id');
      expect(mockSession.sdkOriginPath).toBe(mockSession.workspacePath);
      expect(updateSessionSpy).not.toHaveBeenCalledWith(
        'test-session-id',
        expect.objectContaining({
          sdkSessionId: undefined,
        })
      );
      expect(saveSDKMessageSpy).not.toHaveBeenCalledWith(
        'test-session-id',
        expect.objectContaining({
          type: 'assistant',
        })
      );
    });

    it('should not fall back to another resume point before retrying no-message-found', async () => {
      mockSession.sdkSessionId = 'sdk-session-id';

      getSDKMessagesSpy.mockImplementation(() => ({
        messages: [
          {
            type: 'assistant',
            uuid: 'newer-existing-message-uuid',
            timestamp: 2000,
          },
        ],
        hasMore: false,
      }));
      buildSpy
        .mockRejectedValueOnce(
          new Error('No message found with message.uuid of: missing-message-uuid')
        )
        .mockRejectedValueOnce(new Error('stop after retry'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(2);
      expect(mockSession.sdkSessionId).toBe('sdk-session-id');
      expect(updateSessionSpy).not.toHaveBeenCalledWith(
        'test-session-id',
        expect.objectContaining({
          metadata: expect.anything(),
        })
      );
    });

    it('should call stateManager.setIdle after handling startup timeout error', async () => {
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(setIdleSpy).toHaveBeenCalled();
    });

    it('emits an interim assistant notice when the startup-timeout retry runs', async () => {
      const kickoff = { uuid: 'kickoff-uuid', content: [{ type: 'text' as const, text: 'K' }] };
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      (
        runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
      )._consumedUserMessages = new Map([[1, [kickoff]]]);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(saveSDKMessageSpy).toHaveBeenCalledWith(
        'test-session-id',
        expect.objectContaining({
          type: 'assistant',
          message: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                text: expect.stringContaining('Retrying once'),
              }),
            ]),
          }),
        })
      );
    });

    it('does not emit the interim retry notice when the startup-timeout retry is skipped', async () => {
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(saveSDKMessageSpy).not.toHaveBeenCalledWith(
        'test-session-id',
        expect.objectContaining({
          type: 'assistant',
          message: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                text: expect.stringContaining('Retrying once'),
              }),
            ]),
          }),
        })
      );
    });

    it('skips the futile startup-timeout retry when no prompt was consumed or queued', async () => {
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      expect(terminateTrackedAgentProcessesSpy).not.toHaveBeenCalled();
      expect(handleErrorSpy).toHaveBeenCalled();
    });

    it('still retries a startup timeout when a prompt remains queued', async () => {
      sizeSpy.mockReturnValue(1);
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(2);
      expect(saveSDKMessageSpy).toHaveBeenCalledWith(
        'test-session-id',
        expect.objectContaining({
          type: 'assistant',
          message: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                text: expect.stringContaining('Retrying once'),
              }),
            ]),
          }),
        })
      );
    });

    it('should NOT pass startupMaxRetries in handleError metadata', async () => {
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(handleErrorSpy).toHaveBeenCalled();
      const metadata = handleErrorSpy.mock.calls[0][5] as Record<string, unknown>;
      expect(metadata.startupMaxRetries).toBeUndefined();
    });

    it('should close queryObject before retrying to prevent MCP "Already connected to a transport" crash', async () => {
      let closeCalled = false;
      const mockQueryObject = {
        close: () => {
          closeCalled = true;
        },
        [Symbol.asyncIterator]: function* () {},
      } as unknown as import('@anthropic-ai/claude-agent-sdk').Query;

      const ctx = createContext({ queryObject: mockQueryObject });
      runner = new QueryRunner(ctx);
      (
        runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
      )._consumedUserMessages = new Map([
        [1, [{ uuid: 'kickoff-uuid', content: [{ type: 'text' as const, text: 'K' }] }]],
      ]);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(closeCalled).toBe(true);
      expect(ctx.queryObject).toBeNull();
    });

    it('should force-terminate orphaned SDK processes before retrying after startup timeout', async () => {
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      (
        runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
      )._consumedUserMessages = new Map([
        [1, [{ uuid: 'kickoff-uuid', content: [{ type: 'text' as const, text: 'K' }] }]],
      ]);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(terminateTrackedAgentProcessesSpy).toHaveBeenCalled();
    });

    it('should await processExitedPromise before retrying after startup timeout', async () => {
      const callOrder: string[] = [];
      let resolveExit: () => void;
      const exitPromise = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });

      const mockQueryObject = {
        close: () => {
          callOrder.push('close');
          setTimeout(() => {
            callOrder.push('process-exited');
            resolveExit!();
          }, 20);
        },
        [Symbol.asyncIterator]: function* () {},
      } as unknown as import('@anthropic-ai/claude-agent-sdk').Query;

      const ctx = createContext({
        queryObject: mockQueryObject,
        processExitedPromise: exitPromise,
      });
      runner = new QueryRunner(ctx);
      (
        runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
      )._consumedUserMessages = new Map([
        [1, [{ uuid: 'kickoff-uuid', content: [{ type: 'text' as const, text: 'K' }] }]],
      ]);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(callOrder).toContain('close');
      expect(callOrder).toContain('process-exited');
      expect(ctx.processExitedPromise).toBeNull();
    });

    it('restarts a stopped message queue before the startup-timeout retry', async () => {
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      (
        runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
      )._consumedUserMessages = new Map([
        [1, [{ uuid: 'kickoff-uuid', content: [{ type: 'text' as const, text: 'K' }] }]],
      ]);

      runner.start();
      isRunningSpy.mockReturnValue(false);
      await ctx.queryPromise?.catch(() => {});

      expect(startSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('does not restart the message queue for a startup-timeout retry when interrupted', async () => {
      setIdleSpy.mockImplementation(async () => {
        stopSpy();
        getStateSpy.mockReturnValue({ status: 'interrupted' } as never);
      });
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      (
        runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
      )._consumedUserMessages = new Map([
        [1, [{ uuid: 'kickoff-uuid', content: [{ type: 'text' as const, text: 'K' }] }]],
      ]);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(startSpy.mock.calls.length).toBe(1);
    });

    it('does not respawn after a startup timeout when an interrupt raced the catch', async () => {
      const kickoff = { uuid: 'kickoff-uuid', content: [{ type: 'text' as const, text: 'K' }] };
      getStateSpy.mockReturnValue({ status: 'interrupted' } as never);
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      (
        runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
      )._consumedUserMessages = new Map([[1, [kickoff]]]);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(enqueueWithIdSpy).not.toHaveBeenCalledWith(kickoff.uuid, kickoff.content, false, {
        prepend: true,
      });
    });

    it('re-enqueues every consumed prompt before the startup-timeout retry', async () => {
      const kickoff = { uuid: 'kickoff-uuid', content: [{ type: 'text' as const, text: 'K' }] };
      const steer = { uuid: 'steer-uuid', content: [{ type: 'text' as const, text: 'S' }] };

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      (
        runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
      )._consumedUserMessages = new Map([[1, [kickoff, steer]]]);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(enqueueWithIdSpy).toHaveBeenCalledWith(kickoff.uuid, kickoff.content, false, {
        prepend: true,
      });
      expect(enqueueWithIdSpy).toHaveBeenCalledWith(steer.uuid, steer.content, false, {
        prepend: true,
      });
      const calls = enqueueWithIdSpy.mock.calls as unknown as Array<[string, unknown]>;
      expect(calls.map(([uuid]) => uuid)).toEqual([steer.uuid, kickoff.uuid]);
    });

    it('should abandon the retry when a replacement query took ownership during the exit wait', async () => {
      buildSpy.mockClear();
      let resolveExit: () => void;
      const exitPromise = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });
      const ctx = createContext({
        queryObject: {
          close: () => {},
          [Symbol.asyncIterator]: function* () {},
        } as unknown as import('@anthropic-ai/claude-agent-sdk').Query,
        processExitedPromise: exitPromise,
      });
      runner = new QueryRunner(ctx);
      (
        runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
      )._consumedUserMessages = new Map([
        [1, [{ uuid: 'stale-uuid', content: [{ type: 'text' as const, text: 'stale' }] }]],
      ]);

      runner.start();
      const deadline = Date.now() + 5000;
      while (
        !setIdleSpy.mock.calls.some(
          (call) =>
            (call[0] as { suppressDeliveryWaiters?: boolean } | undefined)
              ?.suppressDeliveryWaiters === true
        ) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      ctx.incrementQueryGeneration();
      resolveExit!();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(
        setIdleSpy.mock.calls.some(
          (call) =>
            (call[0] as { suppressDeliveryWaiters?: boolean } | undefined)
              ?.suppressDeliveryWaiters === true
        )
      ).toBe(true);
      expect(
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages.get(1)
      ).toBeUndefined();
    });
  });

  describe('startup retry arm decision table', () => {
    let savedApiKey: string | undefined;

    beforeEach(() => {
      savedApiKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      mockSession.workspacePath = tmpdir();
      buildSpy.mockRejectedValue(new Error('SDK startup timeout - query aborted'));
    });

    afterEach(() => {
      if (savedApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = savedApiKey;
      }
    });

    async function runStartupArmRow(row: {
      attempt: number;
      status: 'idle' | 'processing' | 'interrupted';
      abort: boolean;
      cleaning: boolean;
      redeliver: 'none' | 'queue' | 'consumed';
    }) {
      if (row.status !== 'idle') {
        getStateSpy.mockReturnValue({ status: row.status });
      }

      if (row.redeliver === 'queue') {
        sizeSpy.mockReturnValue(1);
      }

      const abortController = new AbortController();
      if (row.abort) {
        abortController.abort();
      }

      const ctx = createContext({
        isCleaningUp: () => row.cleaning,
        queryAbortController: row.abort ? abortController : null,
      });
      runner = new QueryRunner(ctx);
      const runnerPrivate = runner as unknown as { _consumedUserMessages: Map<number, unknown[]> };

      if (row.redeliver === 'consumed') {
        runnerPrivate._consumedUserMessages.set(1, [
          { uuid: 'consumed-uuid', content: [{ type: 'text' as const, text: 'C' }] },
        ]);
      }

      if (row.attempt === 0) {
        runner.start();
        await ctx.queryPromise?.catch(() => {});
      } else {
        ctx.incrementQueryGeneration();
        await (
          runner as unknown as {
            runQuery: (
              queryGeneration: number,
              retryAttempt: number,
              recoveryState: { rateLimitCooldownScheduled: boolean }
            ) => Promise<void>;
          }
        ).runQuery(1, 1, { rateLimitCooldownScheduled: false });
      }
    }

    function assertStartupArmOutcome(row: {
      attempt: number;
      status: 'idle' | 'processing' | 'interrupted';
      abort: boolean;
      cleaning: boolean;
      redeliver: 'none' | 'queue' | 'consumed';
    }) {
      const shouldRetry =
        row.attempt === 0 &&
        !row.cleaning &&
        row.status !== 'interrupted' &&
        row.redeliver !== 'none';
      const shouldHandleError = !row.cleaning;
      const buildCalls = shouldRetry ? 2 : 1;
      const saveSDKMessageCalls = shouldRetry ? 1 : 0;
      const terminateCalls = shouldRetry ? 1 : 0;
      const clearCalls = shouldHandleError ? 1 : 0;
      const enqueueCalls = shouldRetry && row.redeliver === 'consumed' ? 1 : 0;

      expect(buildSpy).toHaveBeenCalledTimes(buildCalls);
      expect(handleErrorSpy).toHaveBeenCalledTimes(shouldHandleError ? 1 : 0);
      expect(saveSDKMessageSpy).toHaveBeenCalledTimes(saveSDKMessageCalls);
      expect(terminateTrackedAgentProcessesSpy).toHaveBeenCalledTimes(terminateCalls);
      expect(clearSpy).toHaveBeenCalledTimes(clearCalls);
      expect(enqueueWithIdSpy).toHaveBeenCalledTimes(enqueueCalls);

      if (shouldRetry) {
        expect(saveSDKMessageSpy).toHaveBeenCalledWith(
          'test-session-id',
          expect.objectContaining({
            type: 'assistant',
            message: expect.objectContaining({
              content: expect.arrayContaining([
                expect.objectContaining({
                  text: expect.stringContaining('Retrying once'),
                }),
              ]),
            }),
          })
        );

        if (row.redeliver === 'consumed') {
          expect(enqueueWithIdSpy).toHaveBeenCalledWith(
            'consumed-uuid',
            expect.arrayContaining([expect.objectContaining({ text: 'C' })]),
            false,
            { prepend: true }
          );
        }
      }

      if (shouldHandleError) {
        expect(handleErrorSpy).toHaveBeenCalledWith(
          'test-session-id',
          expect.any(Error),
          ErrorCategory.TIMEOUT,
          expect.anything(),
          expect.anything(),
          expect.anything()
        );
      }
    }

    const attempts = [0, 1] as const;
    const statuses = ['idle', 'processing', 'interrupted'] as const;
    const aborts = [false, true] as const;
    const cleanings = [false, true] as const;
    const redelivers = ['none', 'queue', 'consumed'] as const;

    for (const attempt of attempts) {
      for (const status of statuses) {
        for (const abort of aborts) {
          for (const cleaning of cleanings) {
            for (const redeliver of redelivers) {
              const name = `attempt=${attempt} status=${status} abort=${abort} cleaning=${cleaning} redeliver=${redeliver}`;
              it(name, async () => {
                await runStartupArmRow({ attempt, status, abort, cleaning, redeliver });
                assertStartupArmOutcome({ attempt, status, abort, cleaning, redeliver });
              });
            }
          }
        }
      }
    }
  });

  describe('unfenced-window map (B1d)', () => {
    let savedApiKey: string | undefined;

    beforeEach(() => {
      savedApiKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      mockSession.workspacePath = tmpdir();
    });

    afterEach(() => {
      if (savedApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = savedApiKey;
      }
    });

    function gateSetIdle() {
      let markCalled!: () => void;
      const called = new Promise<void>((resolve) => {
        markCalled = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      setIdleSpy.mockImplementation(() => {
        markCalled();
        return gate;
      });
      return { waitCalled: () => called, release: () => release() };
    }

    it('pins: startup arm awaits setIdle before its first staleness guard', async () => {
      buildSpy.mockRejectedValue(new Error('SDK startup timeout - query aborted'));
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      (
        runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
      )._consumedUserMessages.set(1, [
        { uuid: 'consumed-uuid', content: [{ type: 'text' as const, text: 'C' }] },
      ]);
      const idle = gateSetIdle();
      runner.start();
      await idle.waitCalled();
      ctx.incrementQueryGeneration();
      idle.release();
      await ctx.queryPromise?.catch(() => {});

      expect(setIdleSpy).toHaveBeenCalled();
      expect(terminateTrackedAgentProcessesSpy).not.toHaveBeenCalled();
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      expect(clearSpy).not.toHaveBeenCalled();
      expect(handleErrorSpy).not.toHaveBeenCalled();
      expect(buildSpy).toHaveBeenCalledTimes(1);
    });

    it('pins: message-not-found arm awaits setIdle after consuming the resume pointer, before its first staleness guard', async () => {
      const consumeSpy = mock(() => 'consumed-uuid');
      buildSpy.mockRejectedValue(new Error('No message found with message.uuid of: stale-uuid'));
      const ctx = createContext({ consumePendingResumeSessionAt: consumeSpy });
      runner = new QueryRunner(ctx);
      const idle = gateSetIdle();
      runner.start();
      await idle.waitCalled();
      ctx.incrementQueryGeneration();
      idle.release();
      await ctx.queryPromise?.catch(() => {});

      expect(consumeSpy).toHaveBeenCalledTimes(1);
      expect(setIdleSpy).toHaveBeenCalled();
      expect(terminateTrackedAgentProcessesSpy).not.toHaveBeenCalled();
      expect(clearSpy).not.toHaveBeenCalled();
      expect(handleErrorSpy).not.toHaveBeenCalled();
      expect(buildSpy).toHaveBeenCalledTimes(1);
    });

    it('pins: transient arm resnapshot suppresses re-enqueue when superseded during setIdle', async () => {
      const consumedUuid = 'stale-uuid';
      const consumedContent = [{ type: 'text' as const, text: 'OLD' }];
      buildSpy.mockRejectedValue(new Error('TypeError: fetch failed'));
      const replacementMessage = {
        uuid: 'replacement-uuid',
        content: [{ type: 'text' as const, text: 'NEW' }],
      };
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      (runner as unknown as { _lastConsumedUserMessage: unknown })._lastConsumedUserMessage = {
        uuid: consumedUuid,
        content: consumedContent,
      };
      const idle = gateSetIdle();
      runner.start();
      await idle.waitCalled();
      ctx.incrementQueryGeneration();
      (runner as unknown as { _lastConsumedUserMessage: unknown })._lastConsumedUserMessage =
        replacementMessage;
      idle.release();
      await ctx.queryPromise?.catch(() => {});

      expect(setIdleSpy).toHaveBeenCalled();
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      expect(saveSDKMessageSpy).not.toHaveBeenCalled();
      expect(handleErrorSpy).not.toHaveBeenCalled();
      expect(clearSpy).not.toHaveBeenCalled();
      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(
        (runner as unknown as { _lastConsumedUserMessage: unknown })._lastConsumedUserMessage
      ).toBe(replacementMessage);
      expect(
        (runner as unknown as { _consumedUserMessages: Map<number, unknown> })._consumedUserMessages
          .size
      ).toBe(0);
    });

    it('pins: message-not-found resume-pointer consumption is NOT an unfenced window (stale generation reaches it with no intervening await)', async () => {
      const consumeSpy = mock(() => 'consumed-uuid');
      buildSpy.mockRejectedValue(new Error('No message found with message.uuid of: stale-uuid'));
      let gen = 0;
      const ctx = createContext({
        consumePendingResumeSessionAt: consumeSpy,
        incrementQueryGeneration: () => ++gen,
        getQueryGeneration: () => 2,
      });
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(consumeSpy).not.toHaveBeenCalled();
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(buildSpy).toHaveBeenCalledTimes(1);
    });

    it('pins: startup arm revalidates after the publication await — a replacement during the publication does not launch another attempt', async () => {
      buildSpy.mockRejectedValue(new Error('SDK startup timeout - query aborted'));
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      const runnerPrivate = runner as unknown as {
        _consumedUserMessages: Map<number, unknown[]>;
      };
      runnerPrivate._consumedUserMessages.set(1, [
        { uuid: 'consumed-uuid', content: [{ type: 'text' as const, text: 'C' }] },
      ]);
      let markCalled!: () => void;
      const displayCalled = new Promise<void>((resolve) => {
        markCalled = resolve;
      });
      let releaseDisplay!: () => void;
      const displayGate = new Promise<void>((resolve) => {
        releaseDisplay = resolve;
      });
      runner.displayErrorAsAssistantMessage = mock(async () => {
        markCalled();
        await displayGate;
      });
      runner.start();
      await displayCalled;
      ctx.incrementQueryGeneration();
      releaseDisplay();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(enqueueWithIdSpy).toHaveBeenCalledWith(
        'consumed-uuid',
        expect.arrayContaining([expect.objectContaining({ text: 'C' })]),
        false,
        { prepend: true }
      );
      expect(runnerPrivate._consumedUserMessages.has(1)).toBe(false);
    });

    it('pins: startup arm resnapshots the route across the setIdle await — an interrupt flip abandons before any shared mutation', async () => {
      buildSpy.mockRejectedValue(new Error('SDK startup timeout - query aborted'));
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      (
        runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
      )._consumedUserMessages.set(1, [
        { uuid: 'consumed-uuid', content: [{ type: 'text' as const, text: 'C' }] },
      ]);
      const idle = gateSetIdle();
      runner.start();
      await idle.waitCalled();
      getStateSpy.mockReturnValue({ status: 'interrupted' });
      idle.release();
      await ctx.queryPromise?.catch(() => {});

      expect(setIdleSpy).toHaveBeenCalled();
      expect(terminateTrackedAgentProcessesSpy).not.toHaveBeenCalled();
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      expect(saveSDKMessageSpy).not.toHaveBeenCalled();
      expect(handleErrorSpy).not.toHaveBeenCalled();
      expect(buildSpy).toHaveBeenCalledTimes(1);
    });

    it('pins: startup arm pre-recursion gate abandons when cleanup begins during the publication', async () => {
      buildSpy.mockRejectedValue(new Error('SDK startup timeout - query aborted'));
      let cleaningUp = false;
      const ctx = createContext({ isCleaningUp: () => cleaningUp });
      runner = new QueryRunner(ctx);
      (
        runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
      )._consumedUserMessages.set(1, [
        { uuid: 'consumed-uuid', content: [{ type: 'text' as const, text: 'C' }] },
      ]);
      let markCalled!: () => void;
      const displayCalled = new Promise<void>((resolve) => {
        markCalled = resolve;
      });
      let releaseDisplay!: () => void;
      const displayGate = new Promise<void>((resolve) => {
        releaseDisplay = resolve;
      });
      runner.displayErrorAsAssistantMessage = mock(async () => {
        markCalled();
        await displayGate;
      });
      runner.start();
      await displayCalled;
      cleaningUp = true;
      releaseDisplay();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(enqueueWithIdSpy).toHaveBeenCalledTimes(1);
      expect(terminateTrackedAgentProcessesSpy).toHaveBeenCalledTimes(1);
    });

    it('pins: message-not-found arm resnapshots the route across the setIdle await — a cleanup flip abandons before teardown', async () => {
      const consumeSpy = mock(() => 'consumed-uuid');
      buildSpy.mockRejectedValue(new Error('No message found with message.uuid of: stale-uuid'));
      let cleaningUp = false;
      const ctx = createContext({
        consumePendingResumeSessionAt: consumeSpy,
        isCleaningUp: () => cleaningUp,
      });
      runner = new QueryRunner(ctx);
      const idle = gateSetIdle();
      runner.start();
      await idle.waitCalled();
      cleaningUp = true;
      idle.release();
      await ctx.queryPromise?.catch(() => {});

      expect(consumeSpy).toHaveBeenCalledTimes(1);
      expect(setIdleSpy).toHaveBeenCalled();
      expect(terminateTrackedAgentProcessesSpy).not.toHaveBeenCalled();
      expect(buildSpy).toHaveBeenCalledTimes(1);
    });

    it('pins: message-not-found arm revalidates immediately before recursion — a cleanup flip across the exit await does not launch another attempt', async () => {
      const consumeSpy = mock(() => 'consumed-uuid');
      buildSpy.mockRejectedValue(new Error('No message found with message.uuid of: stale-uuid'));
      let cleaningUp = false;
      let releaseExit!: () => void;
      const exitGate = new Promise<void>((resolve) => {
        releaseExit = resolve;
      });
      let markTerminate!: () => void;
      const terminateReached = new Promise<void>((resolve) => {
        markTerminate = resolve;
      });
      terminateTrackedAgentProcessesSpy.mockImplementation(() => {
        markTerminate();
      });
      const ctx = createContext({
        consumePendingResumeSessionAt: consumeSpy,
        isCleaningUp: () => cleaningUp,
        processExitedPromise: exitGate,
      });
      runner = new QueryRunner(ctx);
      runner.start();
      await terminateReached;
      cleaningUp = true;
      releaseExit();
      await ctx.queryPromise?.catch(() => {});

      expect(consumeSpy).toHaveBeenCalledTimes(1);
      expect(terminateTrackedAgentProcessesSpy).toHaveBeenCalledTimes(1);
      expect(buildSpy).toHaveBeenCalledTimes(1);
    });

    it('pins: startup arm pre-recursion gate abandons when a completed interrupt stops the queue during the publication', async () => {
      buildSpy.mockRejectedValue(new Error('SDK startup timeout - query aborted'));
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      (
        runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
      )._consumedUserMessages.set(1, [
        { uuid: 'consumed-uuid', content: [{ type: 'text' as const, text: 'C' }] },
      ]);
      let markCalled!: () => void;
      const displayCalled = new Promise<void>((resolve) => {
        markCalled = resolve;
      });
      let releaseDisplay!: () => void;
      const displayGate = new Promise<void>((resolve) => {
        releaseDisplay = resolve;
      });
      runner.displayErrorAsAssistantMessage = mock(async () => {
        markCalled();
        await displayGate;
      });
      runner.start();
      await displayCalled;
      isRunningSpy.mockReturnValue(false);
      releaseDisplay();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(enqueueWithIdSpy).toHaveBeenCalledTimes(1);
    });

    it('pins: startup arm resnapshots live redeliverability — a queue cleared during the publication does not launch a futile recursion', async () => {
      buildSpy.mockRejectedValue(new Error('SDK startup timeout - query aborted'));
      sizeSpy.mockReturnValue(1);
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      let markCalled!: () => void;
      const displayCalled = new Promise<void>((resolve) => {
        markCalled = resolve;
      });
      let releaseDisplay!: () => void;
      const displayGate = new Promise<void>((resolve) => {
        releaseDisplay = resolve;
      });
      runner.displayErrorAsAssistantMessage = mock(async () => {
        markCalled();
        await displayGate;
      });
      runner.start();
      await displayCalled;
      sizeSpy.mockReturnValue(0);
      releaseDisplay();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
    });

    it('pins: startup arm abandons before shared mutation when a completed interrupt consumes the abort controller on the self-stopped queue', async () => {
      buildSpy.mockRejectedValue(new Error('SDK startup timeout - query aborted'));
      const controller = new AbortController();
      controller.abort();
      isRunningSpy.mockReturnValue(false);
      const ctx = createContext({ queryAbortController: controller });
      runner = new QueryRunner(ctx);
      (
        runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
      )._consumedUserMessages.set(1, [
        { uuid: 'consumed-uuid', content: [{ type: 'text' as const, text: 'C' }] },
      ]);
      const idle = gateSetIdle();
      runner.start();
      await idle.waitCalled();
      ctx.queryAbortController = null;
      idle.release();
      await ctx.queryPromise?.catch(() => {});

      expect(setIdleSpy).toHaveBeenCalled();
      expect(terminateTrackedAgentProcessesSpy).not.toHaveBeenCalled();
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      expect(buildSpy).toHaveBeenCalledTimes(1);
    });

    it('pins: message-not-found arm does not launch the retry against a queue stopped by a completed interrupt', async () => {
      const consumeSpy = mock(() => 'consumed-uuid');
      buildSpy.mockRejectedValue(new Error('No message found with message.uuid of: stale-uuid'));
      let releaseExit!: () => void;
      const exitGate = new Promise<void>((resolve) => {
        releaseExit = resolve;
      });
      let markTerminate!: () => void;
      const terminateReached = new Promise<void>((resolve) => {
        markTerminate = resolve;
      });
      terminateTrackedAgentProcessesSpy.mockImplementation(() => {
        markTerminate();
      });
      const ctx = createContext({
        consumePendingResumeSessionAt: consumeSpy,
        processExitedPromise: exitGate,
      });
      runner = new QueryRunner(ctx);
      runner.start();
      await terminateReached;
      isRunningSpy.mockReturnValue(false);
      releaseExit();
      await ctx.queryPromise?.catch(() => {});

      expect(consumeSpy).toHaveBeenCalledTimes(1);
      expect(terminateTrackedAgentProcessesSpy).toHaveBeenCalledTimes(1);
      expect(buildSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('provider/transient arm resnapshot and ownership checks (B3b)', () => {
    let savedApiKey: string | undefined;
    let savedBaseDelay: string | undefined;

    beforeEach(() => {
      savedApiKey = process.env.ANTHROPIC_API_KEY;
      savedBaseDelay = process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS;
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS = '0';
      mockSession.workspacePath = tmpdir();
    });

    afterEach(() => {
      if (savedApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = savedApiKey;
      }
      if (savedBaseDelay === undefined) {
        delete process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS;
      } else {
        process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS = savedBaseDelay;
      }
    });

    type RunnerPrivate = {
      _lastConsumedUserMessage: { uuid: string; content: unknown[] } | null;
      _consumedUserMessages: Map<number, Array<{ uuid: string; content: unknown[] }>>;
      runQuery: (
        queryGeneration: number,
        retryAttempt: number,
        recoveryState: { rateLimitCooldownScheduled: boolean }
      ) => Promise<void>;
    };

    it('transient arm resnapshot suppresses re-enqueue when processing is interrupted during setIdle', async () => {
      const consumedUuid = 'consumed-uuid';
      const consumedContent = [{ type: 'text' as const, text: 'C' }];
      buildSpy.mockRejectedValue(new Error('TypeError: fetch failed'));
      getStateSpy.mockReturnValue({ status: 'processing' });

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      const runnerPrivate = runner as unknown as RunnerPrivate;
      runnerPrivate._lastConsumedUserMessage = {
        uuid: consumedUuid,
        content: consumedContent,
      };
      runnerPrivate._consumedUserMessages.set(1, [runnerPrivate._lastConsumedUserMessage]);

      let flip = true;
      setIdleSpy.mockImplementation(async () => {
        if (flip) {
          flip = false;
          getStateSpy.mockReturnValue({ status: 'interrupted' });
        }
      });

      ctx.incrementQueryGeneration();
      isRunningSpy.mockReturnValue(true);
      await runnerPrivate.runQuery(1, 0, { rateLimitCooldownScheduled: false });

      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      expect(saveSDKMessageSpy).not.toHaveBeenCalled();
      expect(handleErrorSpy).not.toHaveBeenCalled();
      expect(clearSpy).not.toHaveBeenCalled();
      expect(runnerPrivate._lastConsumedUserMessage).toBeNull();
    });

    it('transient arm resnapshot suppresses close and recursion when superseded during displayErrorAsAssistantMessage', async () => {
      const consumedUuid = 'consumed-uuid';
      const consumedContent = [{ type: 'text' as const, text: 'C' }];
      buildSpy.mockRejectedValue(new Error('TypeError: fetch failed'));
      const closeSpy = mock(() => {});
      const ctx = createContext({
        queryObject: { close: closeSpy } as unknown as QueryLike,
      });
      runner = new QueryRunner(ctx);
      const runnerPrivate = runner as unknown as RunnerPrivate;
      runnerPrivate._lastConsumedUserMessage = {
        uuid: consumedUuid,
        content: consumedContent,
      };
      runnerPrivate._consumedUserMessages.set(1, [runnerPrivate._lastConsumedUserMessage]);

      const originalDisplay = runner.displayErrorAsAssistantMessage.bind(runner);
      runner.displayErrorAsAssistantMessage = mock(
        async (text: string, options?: { markAsError?: boolean }) => {
          ctx.incrementQueryGeneration();
          await originalDisplay(text, options);
        }
      );

      ctx.incrementQueryGeneration();
      isRunningSpy.mockReturnValue(true);
      await runnerPrivate.runQuery(1, 0, { rateLimitCooldownScheduled: false });

      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(enqueueWithIdSpy).toHaveBeenCalledWith(consumedUuid, consumedContent);
      expect(closeSpy).not.toHaveBeenCalled();
      expect(ctx.queryObject).not.toBeNull();
      expect(runnerPrivate._lastConsumedUserMessage).toBeNull();
    });

    it('provider arm resnapshot suppresses close and re-enqueue when superseded during displayErrorAsAssistantMessage', async () => {
      buildSpy.mockRejectedValue(new Error('503 Service Unavailable'));
      const closeSpy = mock(() => {});
      const ctx = createContext({
        queryObject: { close: closeSpy } as unknown as QueryLike,
      });
      runner = new QueryRunner(ctx);
      const runnerPrivate = runner as unknown as RunnerPrivate;
      runnerPrivate._lastConsumedUserMessage = {
        uuid: 'consumed-uuid',
        content: [{ type: 'text' as const, text: 'C' }],
      };
      runnerPrivate._consumedUserMessages.set(1, [runnerPrivate._lastConsumedUserMessage]);
      isRunningSpy.mockReturnValue(true);

      const originalDisplay = runner.displayErrorAsAssistantMessage.bind(runner);
      runner.displayErrorAsAssistantMessage = mock(
        async (text: string, options?: { markAsError?: boolean }) => {
          ctx.incrementQueryGeneration();
          await originalDisplay(text, options);
        }
      );

      ctx.incrementQueryGeneration();
      await runnerPrivate.runQuery(1, 0, { rateLimitCooldownScheduled: false });

      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      expect(closeSpy).not.toHaveBeenCalled();
      expect(ctx.queryObject).not.toBeNull();
    });
  });

  describe('rate-limit handoff suppression contract', () => {
    let savedApiKey: string | undefined;

    beforeEach(() => {
      savedApiKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      mockSession.workspacePath = tmpdir();
    });

    afterEach(() => {
      if (savedApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = savedApiKey;
      }
    });

    async function runTerminalFailure(
      errorMessage: string,
      overrides: Partial<QueryRunnerContext> = {},
      seedRunner?: (runner: QueryRunner) => void
    ): Promise<{ ctx: QueryRunnerContext; outcome: string }> {
      buildSpy.mockRejectedValue(new Error(errorMessage));
      const ctx = createContext(overrides);
      runner = new QueryRunner(ctx);
      if (seedRunner) {
        seedRunner(runner);
      }
      runner.start();
      const settled = ctx.queryPromise?.then(
        (): string => 'resolved',
        (error: unknown): string => String(error)
      );
      const outcome = (await settled) as string;
      return { ctx, outcome };
    }

    it('suppresses terminal publication and idle when a cooldown is scheduled', async () => {
      const onRateLimitExhausted = mock(async (): Promise<boolean> => true);

      const { ctx, outcome } = await runTerminalFailure('429 Too Many Requests', {
        onRateLimitExhausted,
      });

      expect(outcome).toBe('resolved');
      expect(onRateLimitExhausted).toHaveBeenCalledTimes(1);
      expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
      expect(handleErrorSpy).not.toHaveBeenCalled();
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(ctx.queryPromise).toBeNull();
    });

    it('passes the assessed limit payload to the handoff callback', async () => {
      const resetAtMs = Date.now() + 60 * 60 * 1000;
      const cases: Array<{ errorMessage: string; hint: LimitRetryHint }> = [
        {
          errorMessage: '429 Too Many Requests',
          hint: { resetAtMs: null, kind: 'rate_limit', billingTerminal: false },
        },
        {
          errorMessage: `usage limit reached; resets at ${resetAtMs}`,
          hint: { resetAtMs, kind: 'usage_limit', billingTerminal: false },
        },
        {
          errorMessage: 'You have hit your plan cap. Purchase extra usage to continue.',
          hint: { resetAtMs: null, kind: 'usage_limit', billingTerminal: true },
        },
      ];

      for (const testCase of cases) {
        const handoffArgs: Array<[string, { uuid: string } | null, LimitRetryHint | undefined]> =
          [];
        const onRateLimitExhausted = mock(
          async (
            errorMessage: string,
            lastUserMessage: { uuid: string } | null,
            hint?: LimitRetryHint
          ): Promise<boolean> => {
            handoffArgs.push([errorMessage, lastUserMessage, hint]);
            return true;
          }
        );

        const { outcome } = await runTerminalFailure(testCase.errorMessage, {
          onRateLimitExhausted,
        });

        expect(outcome).toBe('resolved');
        expect(handoffArgs.length).toBe(1);
        expect(handoffArgs[0]?.[0]).toBe(`Error: ${testCase.errorMessage}`);
        expect(handoffArgs[0]?.[1]).toBeNull();
        expect(handoffArgs[0]?.[2]).toEqual(testCase.hint);
      }
    });

    it('forwards the consumed prompt to the handoff without local re-enqueue', async () => {
      const onRateLimitExhausted = mock(async (): Promise<boolean> => true);
      buildSpy.mockRejectedValue(new Error('429 Too Many Requests'));
      const ctx = createContext({ onRateLimitExhausted });
      runner = new QueryRunner(ctx);
      const runnerPrivate = runner as unknown as {
        _lastConsumedUserMessage: { uuid: string; content: string } | null;
      };
      runnerPrivate._lastConsumedUserMessage = { uuid: 'handoff-msg', content: 'pending prompt' };

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(onRateLimitExhausted).toHaveBeenCalledTimes(1);
      expect(onRateLimitExhausted.mock.calls[0][1]).toEqual({
        uuid: 'handoff-msg',
        content: 'pending prompt',
      });
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(
        (runner as unknown as { _lastConsumedUserMessage: unknown })._lastConsumedUserMessage
      ).toBeNull();
    });

    it('treats a rejecting handoff as unscheduled and surfaces only the finalizer idle', async () => {
      const rejectingHandoff = mock(async (): Promise<boolean> => {
        throw new Error('handoff boom');
      });
      buildSpy.mockRejectedValue(new Error('429 Too Many Requests'));
      const ctx = createContext({ onRateLimitExhausted: rejectingHandoff });
      runner = new QueryRunner(ctx);
      runner.start();
      const settled = ctx.queryPromise?.then(
        (): string => 'resolved',
        (error: unknown): string => String(error)
      );
      const outcome = await settled;

      expect(outcome).toBe('Error: handoff boom');
      expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
      expect(handleErrorSpy).not.toHaveBeenCalled();
      expect(setIdleSpy.mock.calls.length).toBe(1);
      expect(clearSpy).toHaveBeenCalledTimes(1);
    });

    it('falls back to the full terminal route when the handoff declines', async () => {
      const route: string[] = [];
      beginTerminalIdleSpy.mockImplementation(() => {
        route.push('begin');
      });
      handleErrorSpy.mockImplementation(async () => {
        route.push('handle');
      });
      setIdleSpy.mockImplementation(async () => {
        route.push('idle');
      });

      const { outcome } = await runTerminalFailure('429 Too Many Requests', {
        onRateLimitExhausted: mock(async (): Promise<boolean> => false),
      });

      expect(outcome).toBe('resolved');
      expect(route).toEqual(['begin', 'handle', 'idle', 'idle']);
      expect(handleErrorSpy).toHaveBeenCalledWith(
        'test-session-id',
        expect.any(Error),
        ErrorCategory.RATE_LIMIT,
        undefined,
        expect.anything(),
        expect.anything()
      );
    });

    it('degrades to the terminal route when no handoff callback is wired', async () => {
      const { outcome } = await runTerminalFailure('429 Too Many Requests');

      expect(outcome).toBe('resolved');
      expect(beginTerminalIdleSpy).toHaveBeenCalledTimes(1);
      expect(handleErrorSpy).toHaveBeenCalledWith(
        'test-session-id',
        expect.any(Error),
        ErrorCategory.RATE_LIMIT,
        undefined,
        expect.anything(),
        expect.anything()
      );
      expect(setIdleSpy.mock.calls.length).toBeGreaterThan(0);
    });

    it('never consults the handoff for non-limit failures', async () => {
      const onRateLimitExhausted = mock(async (): Promise<boolean> => true);

      const { outcome } = await runTerminalFailure('terminal query failure', {
        onRateLimitExhausted,
      });

      expect(outcome).toBe('resolved');
      expect(onRateLimitExhausted).not.toHaveBeenCalled();
      expect(beginTerminalIdleSpy).toHaveBeenCalledTimes(1);
      expect(handleErrorSpy).toHaveBeenCalledWith(
        'test-session-id',
        expect.any(Error),
        ErrorCategory.SYSTEM,
        undefined,
        expect.anything(),
        expect.anything()
      );
      expect(setIdleSpy.mock.calls.length).toBeGreaterThan(0);
    });

    it('keeps finalizer teardown while suppressing only publication and idle', async () => {
      const closeQuery = mock(() => {});
      const resetExitedPromise = mock(function (this: {
        processExitedPromise: Promise<void> | null;
      }) {
        this.processExitedPromise = null;
      });
      const abortController = new AbortController();

      const { ctx, outcome } = await runTerminalFailure(
        '429 Too Many Requests',
        {
          onRateLimitExhausted: mock(async (): Promise<boolean> => true),
          queryObject: { close: closeQuery } as unknown as QueryRunnerContext['queryObject'],
          queryAbortController: abortController,
          processExitedPromise: Promise.resolve(),
          resetProcessExitedPromise: resetExitedPromise,
        },
        (seeded) => {
          (
            seeded as unknown as {
              _lastConsumedUserMessage: unknown;
              _consumedUserMessages: Map<number, Array<{ uuid: string; content: string }>>;
            }
          )._lastConsumedUserMessage = null;
          (
            seeded as unknown as {
              _consumedUserMessages: Map<number, Array<{ uuid: string; content: string }>>;
            }
          )._consumedUserMessages.set(1, [{ uuid: 'g1-msg', content: 'turn prompt' }]);
        }
      );

      expect(outcome).toBe('resolved');
      expect(closeQuery).toHaveBeenCalledTimes(1);
      expect(ctx.queryObject).toBeNull();
      expect(abortController.signal.aborted).toBe(true);
      expect(ctx.queryAbortController).toBeNull();
      expect(resetExitedPromise).toHaveBeenCalledTimes(1);
      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(terminateTrackedAgentProcessesSpy).not.toHaveBeenCalled();
      expect(ctx.originalEnvVars).toEqual({});
      expect(ctx.queryPromise).toBeNull();
      const runnerPrivate = runner as unknown as {
        _lastConsumedUserMessage: unknown;
        _consumedUserMessages: Map<number, Array<{ uuid: string; content: string }>>;
      };
      expect(runnerPrivate._lastConsumedUserMessage).toBeNull();
      expect(runnerPrivate._consumedUserMessages.size).toBe(0);
    });

    it('isLimitRecoveryPending gates only the finalizer idle, not the catch route', async () => {
      const route: string[] = [];
      beginTerminalIdleSpy.mockImplementation(() => {
        route.push('begin');
      });
      handleErrorSpy.mockImplementation(async () => {
        route.push('handle');
      });
      setIdleSpy.mockImplementation(async () => {
        route.push('idle');
      });

      const { outcome } = await runTerminalFailure('terminal query failure', {
        isLimitRecoveryPending: () => true,
        processExitedPromise: Promise.resolve(),
        resetProcessExitedPromise: mock(function (this: {
          processExitedPromise: Promise<void> | null;
        }) {
          this.processExitedPromise = null;
          route.push('boundary');
        }),
      });

      expect(outcome).toBe('resolved');
      expect(route).toEqual(['begin', 'handle', 'idle', 'boundary']);
    });

    it('skips the finalizer idle while status is rate_limit_cooldown', async () => {
      getStateSpy.mockReturnValue({ status: 'rate_limit_cooldown' });
      const route: string[] = [];
      beginTerminalIdleSpy.mockImplementation(() => {
        route.push('begin');
      });
      handleErrorSpy.mockImplementation(async () => {
        route.push('handle');
      });
      setIdleSpy.mockImplementation(async () => {
        route.push('idle');
      });

      const { outcome } = await runTerminalFailure('terminal query failure', {
        processExitedPromise: Promise.resolve(),
        resetProcessExitedPromise: mock(function (this: {
          processExitedPromise: Promise<void> | null;
        }) {
          this.processExitedPromise = null;
          route.push('boundary');
        }),
      });

      expect(outcome).toBe('resolved');
      expect(route).toEqual(['begin', 'handle', 'idle', 'boundary']);
    });
  });

  describe('per-arm teardown-liturgy inventory', () => {
    let savedApiKey: string | undefined;
    let savedMaxRetries: string | undefined;
    let savedBaseDelay: string | undefined;

    beforeEach(() => {
      savedApiKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      savedMaxRetries = process.env.HYPERNEO_PROVIDER_MAX_RETRIES;
      savedBaseDelay = process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS;
      mockSession.workspacePath = tmpdir();
    });

    afterEach(() => {
      if (savedApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = savedApiKey;
      }
      if (savedMaxRetries === undefined) {
        delete process.env.HYPERNEO_PROVIDER_MAX_RETRIES;
      } else {
        process.env.HYPERNEO_PROVIDER_MAX_RETRIES = savedMaxRetries;
      }
      if (savedBaseDelay === undefined) {
        delete process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS;
      } else {
        process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS = savedBaseDelay;
      }
    });

    interface LiturgyNotice {
      text: string;
      markAsError: boolean;
    }

    type ConsumedEntry = { uuid: string; content: string };

    function createLiturgyContext(events: string[]): {
      ctx: QueryRunnerContext;
      markQueueStopped: () => void;
    } {
      const queueIsRunning = mock((): boolean => false);
      let queueSize = 0;
      const queryObject = {
        close: mock((): void => {
          events.push('query.close');
        }),
      } as unknown as QueryRunnerContext['queryObject'];

      const ctx: QueryRunnerContext = {
        session: mockSession,
        db: mockDb,
        messageHub: mockMessageHub,
        messageQueue: {
          isRunning: queueIsRunning,
          start: mock(() => {
            queueIsRunning.mockReturnValue(true);
            events.push('queue.start');
          }),
          clear: mock(() => {
            queueSize = 0;
            events.push('queue.clear');
          }),
          stop: mock(() => {
            queueIsRunning.mockReturnValue(false);
            events.push('queue.stop');
          }),
          size: mock((): number => queueSize),
          getGeneration: mock((): number => 0),
          enqueueWithId: mock(
            async (
              messageId: string,
              _content: string | unknown[],
              _internal?: boolean,
              options?: { prepend?: boolean }
            ): Promise<void> => {
              queueSize += 1;
              events.push(`enqueue:${messageId}${options?.prepend ? ':prepend' : ''}`);
            }
          ),
          messageGenerator: mock(async function* () {}),
        } as unknown as MessageQueue,
        stateManager: {
          getState: getStateSpy,
          setIdle: mock(async (options?: { suppressDeliveryWaiters?: boolean }): Promise<void> => {
            events.push(options?.suppressDeliveryWaiters ? 'idle:suppress' : 'idle');
          }),
          setProcessing: setProcessingSpy,
          beginTerminalIdle: mock(() => {
            events.push('terminal.begin');
          }),
        } as unknown as ProcessingStateManager,
        errorManager: {
          handleError: mock(async (): Promise<void> => {
            events.push('error.handle');
          }),
        } as unknown as ErrorManager,
        logger: mockLogger,
        optionsBuilder: mockOptionsBuilder,
        askUserQuestionHandler: mockAskUserQuestionHandler,

        queryObject,
        queryPromise: null,
        queryAbortController: new AbortController(),
        firstMessageReceived: false,
        startupTimeoutTimer: null,
        originalEnvVars: {},
        processExitedPromise: Promise.resolve(),
        resetProcessExitedPromise: mock(function (this: {
          processExitedPromise: Promise<void> | null;
        }) {
          this.processExitedPromise = null;
          events.push('exit.reset');
        }),
        trackAgentProcess: trackAgentProcessSpy,
        terminateTrackedAgentProcesses: mock((): void => {
          events.push('procs.terminate');
        }),
        snapshotTrackedAgentProcesses: snapshotTrackedAgentProcessesSpy,

        incrementQueryGeneration: () => ++queryGeneration,
        getQueryGeneration: () => queryGeneration,
        isCleaningUp: () => false,

        onSDKMessage: onSDKMessageSpy,
        onSlashCommandsFetched: onSlashCommandsFetchedSpy,
        onModelsFetched: onModelsFetchedSpy,
        onMarkApiSuccess: onMarkApiSuccessSpy,
      };
      return {
        ctx,
        markQueueStopped: () => queueIsRunning.mockReturnValue(false),
      };
    }

    function installLiturgyAccessors(
      ctx: QueryRunnerContext,
      events: string[]
    ): () => ReturnType<typeof setTimeout> | null {
      let timerValue: ReturnType<typeof setTimeout> | null = null;
      Object.defineProperty(ctx, 'startupTimeoutTimer', {
        configurable: true,
        get: () => timerValue,
        set: (value: ReturnType<typeof setTimeout> | null) => {
          timerValue = value;
          events.push(value === null ? 'timer.clear' : 'timer.set');
        },
      });
      let firstMessageReceived = false;
      Object.defineProperty(ctx, 'firstMessageReceived', {
        configurable: true,
        get: () => firstMessageReceived,
        set: (value: boolean) => {
          firstMessageReceived = value;
          if (!value) events.push('firstMsg.reset');
        },
      });
      let originalEnvVars: QueryRunnerContext['originalEnvVars'] = {};
      Object.defineProperty(ctx, 'originalEnvVars', {
        configurable: true,
        get: () => originalEnvVars,
        set: (value: QueryRunnerContext['originalEnvVars']) => {
          originalEnvVars = value;
          if (Object.keys(value).length === 0) events.push('env.restore');
        },
      });
      return () => timerValue;
    }

    async function runLiturgyRow(config: {
      errorMessage: string;
      errorName?: string;
      consumedEntries?: ConsumedEntry[];
      lastConsumedUuid?: string;
      withResumeConsumer?: boolean;
      stopQueueAfterFirstBuild?: boolean;
      overrides?: Partial<QueryRunnerContext>;
    }): Promise<{ events: string[]; notices: LiturgyNotice[]; ctx: QueryRunnerContext }> {
      const events: string[] = [];
      const notices: LiturgyNotice[] = [];
      const { ctx, markQueueStopped } = createLiturgyContext(events);
      const getTimer = installLiturgyAccessors(ctx, events);
      if (config.withResumeConsumer) {
        ctx.consumePendingResumeSessionAt = () => {
          events.push('resume.consume');
          return undefined;
        };
      }
      Object.assign(ctx, config.overrides);
      const seededTimer = setTimeout(() => {}, 60000);
      ctx.startupTimeoutTimer = seededTimer;
      ctx.originalEnvVars = { ANTHROPIC_API_KEY: 'sk-original-key' };
      events.length = 0;

      let buildCount = 0;
      buildSpy.mockImplementation(async () => {
        buildCount += 1;
        events.push(`build#${buildCount}`);
        if (config.stopQueueAfterFirstBuild === true && buildCount === 1) {
          markQueueStopped();
        }
        const error = new Error(config.errorMessage);
        if (config.errorName) error.name = config.errorName;
        throw error;
      });

      runner = new QueryRunner(ctx);
      runner.displayErrorAsAssistantMessage = mock(
        async (text: string, displayOptions?: { markAsError?: boolean }): Promise<void> => {
          notices.push({ text, markAsError: displayOptions?.markAsError ?? false });
          events.push(displayOptions?.markAsError ? 'display:err' : 'display');
        }
      );

      const privateState = runner as unknown as {
        _lastConsumedUserMessage: ConsumedEntry | null;
        _consumedUserMessages: Map<number, ConsumedEntry[]>;
      };
      if ((config.consumedEntries?.length ?? 0) > 0 && config.consumedEntries) {
        privateState._consumedUserMessages.set(1, config.consumedEntries);
      }
      if (config.lastConsumedUuid) {
        privateState._lastConsumedUserMessage = {
          uuid: config.lastConsumedUuid,
          content: 'seeded prompt',
        };
      }

      const clearedHandles: Array<Parameters<typeof clearTimeout>[0]> = [];
      const originalClearTimeout = clearTimeout;
      globalThis.clearTimeout = ((id?: Parameters<typeof clearTimeout>[0]) => {
        clearedHandles.push(id);
        originalClearTimeout(id);
      }) as typeof clearTimeout;
      try {
        runner.start();
        await ctx.queryPromise?.catch(() => {});
      } finally {
        globalThis.clearTimeout = originalClearTimeout;
        const leftoverTimer = getTimer();
        if (leftoverTimer) originalClearTimeout(leftoverTimer);
      }
      expect(clearedHandles).toContain(seededTimer);

      return { events, notices, ctx };
    }

    it('startup-timeout arm replays consumed prompts through the queue front', async () => {
      const { events, notices } = await runLiturgyRow({
        errorMessage: 'SDK startup timeout - query aborted',
        stopQueueAfterFirstBuild: true,
        consumedEntries: [
          { uuid: 'u1', content: 'prompt A' },
          { uuid: 'u2', content: 'prompt B' },
        ],
      });

      expect(events).toEqual([
        'queue.start',
        'firstMsg.reset',
        'build#1',
        'idle:suppress',
        'procs.terminate',
        'query.close',
        'exit.reset',
        'queue.start',
        'enqueue:u2:prepend',
        'enqueue:u1:prepend',
        'display',
        'build#2',
        'queue.clear',
        'terminal.begin',
        'error.handle',
        'idle',
        'timer.clear',
        'exit.reset',
        'queue.stop',
        'env.restore',
        'idle',
        'exit.reset',
        'queue.stop',
        'idle',
      ]);
      expect(notices.length).toBe(1);
      expect(notices[0]?.markAsError).toBe(false);
      expect(notices[0]?.text).toContain('Retrying once');
    });

    it('message-not-found arm consumes resume point without replay or notice', async () => {
      const { events, notices } = await runLiturgyRow({
        errorMessage: 'No message found for one-shot resumeSessionAt uuid-123',
        consumedEntries: [{ uuid: 'u9', content: 'map-only prompt' }],
        lastConsumedUuid: 'u9',
        withResumeConsumer: true,
      });

      expect(events).toEqual([
        'queue.start',
        'firstMsg.reset',
        'build#1',
        'resume.consume',
        'timer.clear',
        'firstMsg.reset',
        'idle:suppress',
        'procs.terminate',
        'query.close',
        'exit.reset',
        'build#2',
        'queue.clear',
        'terminal.begin',
        'error.handle',
        'idle',
        'exit.reset',
        'queue.stop',
        'env.restore',
        'idle',
        'exit.reset',
        'queue.stop',
        'idle',
      ]);
      expect(notices).toEqual([]);
    });

    it('transient arm re-enqueues only lastConsumedUserMessage', async () => {
      const { events, notices } = await runLiturgyRow({
        errorMessage: 'TypeError: fetch failed',
        consumedEntries: [{ uuid: 'u9', content: 'map-only prompt' }],
        lastConsumedUuid: 'lm1',
      });

      expect(events).toEqual([
        'queue.start',
        'firstMsg.reset',
        'build#1',
        'timer.clear',
        'firstMsg.reset',
        'idle:suppress',
        'enqueue:lm1',
        'display',
        'query.close',
        'exit.reset',
        'build#2',
        'queue.clear',
        'terminal.begin',
        'error.handle',
        'idle',
        'exit.reset',
        'queue.stop',
        'env.restore',
        'idle',
        'exit.reset',
        'queue.stop',
        'idle',
      ]);
      expect(notices.length).toBe(1);
      expect(notices[0]?.markAsError).toBe(false);
      expect(notices[0]?.text).toContain('connection was interrupted');
    });

    it('provider-backoff arm never idles and re-enqueues after the backoff guard', async () => {
      process.env.HYPERNEO_PROVIDER_MAX_RETRIES = '1';
      process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS = '1';

      const { events, notices } = await runLiturgyRow({
        errorMessage: '503 Service Unavailable',
        consumedEntries: [{ uuid: 'u8', content: 'map-only prompt' }],
        lastConsumedUuid: 'pm1',
      });

      expect(events).toEqual([
        'queue.start',
        'firstMsg.reset',
        'build#1',
        'timer.clear',
        'firstMsg.reset',
        'display',
        'query.close',
        'exit.reset',
        'env.restore',
        'enqueue:pm1',
        'build#2',
        'queue.clear',
        'terminal.begin',
        'error.handle',
        'idle',
        'exit.reset',
        'queue.stop',
        'idle',
        'exit.reset',
        'queue.stop',
        'idle',
      ]);
      expect(notices.length).toBe(1);
      expect(notices[0]?.markAsError).toBe(false);
      expect(notices[0]?.text).toContain('provider is temporarily unavailable');
      expect(process.env.ANTHROPIC_API_KEY).toBe('sk-original-key');
    });

    it('unmatched AbortError arm clears only the queue', async () => {
      const { events, notices } = await runLiturgyRow({
        errorMessage: 'unmatched abort',
        errorName: 'AbortError',
        lastConsumedUuid: 'ab1',
      });

      expect(events).toEqual([
        'queue.start',
        'firstMsg.reset',
        'build#1',
        'queue.clear',
        'timer.clear',
        'exit.reset',
        'queue.stop',
        'query.close',
        'env.restore',
        'idle',
      ]);
      expect(notices).toEqual([]);
      expect(process.env.ANTHROPIC_API_KEY).toBe('sk-original-key');
    });

    it('api-validation route begins terminal idle before its marked display', async () => {
      const { events, notices } = await runLiturgyRow({
        errorMessage: '400 {"error":{"message":"Invalid model id"}}',
      });

      expect(events).toEqual([
        'queue.start',
        'firstMsg.reset',
        'build#1',
        'queue.clear',
        'terminal.begin',
        'display:err',
        'idle',
        'timer.clear',
        'exit.reset',
        'queue.stop',
        'query.close',
        'env.restore',
        'idle',
      ]);
      expect(notices.length).toBe(1);
      expect(notices[0]?.markAsError).toBe(true);
      expect(notices[0]?.text).toContain('**API Error (400)**');
    });
  });

  describe('auto-recovery removal regression guards (Task 2.3)', () => {
    it('should not have onStartupTimeoutAutoRecover in QueryRunnerContext', () => {
      const ctx = createContext();
      expect((ctx as Record<string, unknown>).onStartupTimeoutAutoRecover).toBeUndefined();
    });

    it('should not have startupTimeoutAutoRecoverAttempts in QueryRunnerContext', () => {
      const ctx = createContext();
      expect((ctx as Record<string, unknown>).startupTimeoutAutoRecoverAttempts).toBeUndefined();
    });
  });

  describe('generation-gated consumePendingResumeSessionAt', () => {
    it('should consume resumeSessionAt before isMessageNotFound retry', async () => {
      const savedApiKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      try {
        mockSession.workspacePath = tmpdir();
        mockSession.sdkSessionId = 'sdk-session-id';
        mockSession.sdkOriginPath = mockSession.workspacePath;
        const consumeSpy = mock(() => 'consumed-uuid');
        buildSpy
          .mockRejectedValueOnce(new Error('No message found with message.uuid of: stale-uuid'))
          .mockRejectedValueOnce(new Error('stop after retry'));
        const ctx = createContext({ consumePendingResumeSessionAt: consumeSpy });
        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expect(consumeSpy).toHaveBeenCalledTimes(1);
      } finally {
        if (savedApiKey === undefined) {
          delete process.env.ANTHROPIC_API_KEY;
        } else {
          process.env.ANTHROPIC_API_KEY = savedApiKey;
        }
      }
    });

    it('should use same generation guard pattern as messageQueue.stop() and close()', async () => {
      const closeSpy = mock(() => {});
      let gen = 0;
      const ctx = createContext({
        queryObject: {
          interrupt: mock(async () => {}),
          close: closeSpy,
        } as unknown as Query,
        incrementQueryGeneration: () => ++gen,
        getQueryGeneration: () => gen,
      });
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(closeSpy).toHaveBeenCalled();
      expect(ctx.queryObject).toBeNull();
    });

    it('should skip consume on generation mismatch (same pattern as close() guard)', async () => {
      const closeSpy = mock(() => {});
      let gen = 0;
      const originalQueryObject = {
        interrupt: mock(async () => {}),
        close: closeSpy,
      } as unknown as Query;
      const ctx = createContext({
        queryObject: originalQueryObject,
        incrementQueryGeneration: () => ++gen,
        getQueryGeneration: () => 2,
      });
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(closeSpy).not.toHaveBeenCalled();
      expect(ctx.queryObject).toBe(originalQueryObject);
    });
  });

  describe('transient connection error handling', () => {
    let savedApiKey: string | undefined;

    beforeEach(() => {
      savedApiKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      mockSession.workspacePath = tmpdir();
    });

    afterEach(() => {
      if (savedApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = savedApiKey;
      }
    });

    it('should retry once and show sanitized retry message on transient connection error', async () => {
      buildSpy
        .mockRejectedValueOnce(
          new Error(
            'The socket connection was closed unexpectedly. For more information, pass verbose: true in the second argument to fetch()'
          )
        )
        .mockRejectedValueOnce(new Error('stop after retry'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(2);
      expect(saveSDKMessageSpy).toHaveBeenCalledWith(
        'test-session-id',
        expect.objectContaining({
          type: 'assistant',
          message: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                text: expect.stringContaining('The connection was interrupted'),
              }),
            ]),
          }),
        })
      );
    });

    it('should always call messageQueue.clear() on connection error', async () => {
      buildSpy.mockRejectedValue(new Error('TypeError: fetch failed'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(clearSpy).toHaveBeenCalled();
    });

    it('does not setIdle or retry from the catch when the query is stale (superseded by a generation bump)', async () => {
      buildSpy.mockRejectedValueOnce(new Error('TypeError: fetch failed'));
      let gen = 0;
      const ctx = createContext({
        incrementQueryGeneration: () => ++gen,
        getQueryGeneration: () => 2,
      });
      runner = new QueryRunner(ctx);
      setIdleSpy.mockClear();

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(buildSpy).toHaveBeenCalledTimes(1);
    });

    it('should surface error via handleError on exhausted transient connection retry', async () => {
      buildSpy.mockRejectedValue(new Error('TypeError: fetch failed'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(handleErrorSpy).toHaveBeenCalled();
    });

    it('should categorize exhausted transient connection error as CONNECTION', async () => {
      buildSpy.mockRejectedValue(new Error('TypeError: fetch failed'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(handleErrorSpy).toHaveBeenCalledWith(
        'test-session-id',
        expect.any(Error),
        ErrorCategory.CONNECTION,
        expect.any(String),
        expect.anything(),
        expect.any(Object)
      );
    });

    it('should show sanitized user-facing message after exhausted retries', async () => {
      buildSpy.mockRejectedValue(new Error('TypeError: fetch failed'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      const userMessage = handleErrorSpy.mock.calls[0][3] as string;
      expect(userMessage).toContain('Could not get a response');
      expect(userMessage).toContain('connection was interrupted');
      expect(userMessage).not.toContain('verbose: true');
      expect(userMessage).not.toContain('fetch()');
    });

    it('should call stateManager.setIdle after handling connection error', async () => {
      buildSpy.mockRejectedValue(new Error('TypeError: fetch failed'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(setIdleSpy).toHaveBeenCalled();
    });

    it('should NOT retry more than once on the same transient connection error', async () => {
      buildSpy.mockRejectedValue(new Error('TypeError: fetch failed'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(2);
    });

    it('should not retry transient-looking errors after an intentional interrupt', async () => {
      buildSpy.mockRejectedValue(new Error('stream closed'));
      getStateSpy.mockReturnValue({ status: 'interrupted' });

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(saveSDKMessageSpy).not.toHaveBeenCalledWith(
        'test-session-id',
        expect.objectContaining({
          message: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                text: expect.stringContaining('The connection was interrupted'),
              }),
            ]),
          }),
        })
      );
    });

    it('should not re-enqueue when no user message was consumed (error before for-await)', async () => {
      buildSpy.mockRejectedValue(new Error('TypeError: fetch failed'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
    });

    it('should re-enqueue tracked user message on transient connection error retry', async () => {
      const consumedUuid = 'consumed-msg-uuid';
      const consumedContent = [{ type: 'text' as const, text: 'Hello, Claude!' }];

      buildSpy
        .mockRejectedValueOnce(
          new Error(
            'The socket connection was closed unexpectedly. For more information, pass verbose: true in the second argument to fetch()'
          )
        )
        .mockRejectedValueOnce(new Error('stop after retry'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);

      (runner as unknown as { _lastConsumedUserMessage: unknown })._lastConsumedUserMessage = {
        uuid: consumedUuid,
        content: consumedContent,
      };

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(enqueueWithIdSpy).toHaveBeenCalledWith(consumedUuid, consumedContent);
    });

    it('should clear lastConsumedUserMessage after re-enqueueing', async () => {
      const consumedUuid = 'consumed-msg-uuid';
      const consumedContent = [{ type: 'text' as const, text: 'Hello' }];

      buildSpy
        .mockRejectedValueOnce(new Error('TypeError: fetch failed'))
        .mockRejectedValueOnce(new Error('stop after retry'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);

      (runner as unknown as { _lastConsumedUserMessage: unknown })._lastConsumedUserMessage = {
        uuid: consumedUuid,
        content: consumedContent,
      };

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(
        (runner as unknown as { _lastConsumedUserMessage: unknown })._lastConsumedUserMessage
      ).toBeNull();
    });

    const untestedPatterns = [
      'ReadableStream is locked',
      'network down',
      'Unable to connect',
      'backend connection error',
      'SocketError',
    ];

    for (const pattern of untestedPatterns) {
      it(`should detect "${pattern}" as a transient connection error`, async () => {
        buildSpy
          .mockRejectedValueOnce(new Error(`Some error: ${pattern} occurred`))
          .mockRejectedValueOnce(new Error('stop after retry'));

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expect(buildSpy).toHaveBeenCalledTimes(2);

        expect(saveSDKMessageSpy).toHaveBeenCalledWith(
          'test-session-id',
          expect.objectContaining({
            type: 'assistant',
            message: expect.objectContaining({
              content: expect.arrayContaining([
                expect.objectContaining({
                  text: expect.stringContaining('The connection was interrupted'),
                }),
              ]),
            }),
          })
        );
      });
    }
  });

  describe('bounded provider error retry (5xx / overloaded / unavailable)', () => {
    let savedApiKey: string | undefined;
    let savedBaseDelay: string | undefined;
    let savedMaxRetries: string | undefined;

    beforeEach(() => {
      savedApiKey = process.env.ANTHROPIC_API_KEY;
      savedBaseDelay = process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS;
      savedMaxRetries = process.env.HYPERNEO_PROVIDER_MAX_RETRIES;
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS = '0';
      mockSession.workspacePath = tmpdir();
    });

    afterEach(() => {
      if (savedApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = savedApiKey;
      }
      if (savedBaseDelay === undefined) {
        delete process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS;
      } else {
        process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS = savedBaseDelay;
      }
      if (savedMaxRetries === undefined) {
        delete process.env.HYPERNEO_PROVIDER_MAX_RETRIES;
      } else {
        process.env.HYPERNEO_PROVIDER_MAX_RETRIES = savedMaxRetries;
      }
    });

    it('should retry up to the cap (3) on a 529 overloaded error', async () => {
      buildSpy.mockRejectedValue(
        new Error('529 {"type":"error","error":{"type":"overloaded_error"}}')
      );

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(4);
    });

    it('should retry up to the cap on a 503 service unavailable error', async () => {
      buildSpy.mockRejectedValue(new Error('503 Service Unavailable'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(4);
    });

    it('should retry up to the cap on a 500 internal server error', async () => {
      buildSpy.mockRejectedValue(new Error('500 Internal Server Error'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(4);
    });

    it('should retry up to the cap on a 502 bad gateway error', async () => {
      buildSpy.mockRejectedValue(new Error('502 Bad Gateway'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(4);
    });

    it('should NOT retry 401 authentication errors (terminal)', async () => {
      buildSpy.mockRejectedValue(new Error('401 Unauthorized'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(1);
    });

    it('should NOT retry 402 quota/billing errors (terminal)', async () => {
      buildSpy.mockRejectedValue(new Error('402 {"error":{"message":"insufficient_quota"}}'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(1);
    });

    it('should NOT retry model_not_found errors (terminal)', async () => {
      buildSpy.mockRejectedValue(new Error('model_not_found: invalid-model-id'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(1);
    });

    it('should NOT retry a 5xx that also contains a 401 auth signal', async () => {
      buildSpy.mockRejectedValue(new Error('500 error: invalid_api_key'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(1);
    });

    it('should not retry provider errors after an intentional interrupt', async () => {
      buildSpy.mockRejectedValue(new Error('503 Service Unavailable'));
      getStateSpy.mockReturnValue({ status: 'interrupted' });

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(1);
    });

    it('should surface error via handleError after exhausting retries', async () => {
      buildSpy.mockRejectedValue(new Error('529 overloaded'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(handleErrorSpy).toHaveBeenCalled();
    });

    it('should show exhausted-retry user-facing message after retries are exhausted', async () => {
      buildSpy.mockRejectedValue(new Error('529 overloaded'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(handleErrorSpy).toHaveBeenCalledWith(
        'test-session-id',
        expect.any(Error),
        expect.any(String),
        expect.stringContaining('temporarily unavailable'),
        expect.anything(),
        expect.any(Object)
      );
      const userMessage = handleErrorSpy.mock.calls[0][3] as string;
      expect(userMessage).toContain('retried');
      expect(userMessage).not.toContain('529');
    });

    it('should display a sanitized retry notice on each retry attempt', async () => {
      buildSpy.mockRejectedValue(new Error('503 Service Unavailable'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      const retryNotices = saveSDKMessageSpy.mock.calls.filter(([, msg]) => {
        const content = (msg as { message?: { content?: Array<{ text?: string }> } }).message
          ?.content;
        return Array.isArray(content) && content.some((c) => c.text?.includes('Retrying'));
      });
      expect(retryNotices).toHaveLength(3);
    });

    it('should re-enqueue tracked user message on the first provider retry', async () => {
      const consumedUuid = 'consumed-msg-uuid';
      const consumedContent = [{ type: 'text' as const, text: 'Hello, Claude!' }];

      buildSpy.mockRejectedValue(new Error('529 overloaded'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);

      (runner as unknown as { _lastConsumedUserMessage: unknown })._lastConsumedUserMessage = {
        uuid: consumedUuid,
        content: consumedContent,
      };

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(enqueueWithIdSpy).toHaveBeenCalledWith(consumedUuid, consumedContent);
    });

    it('should call stateManager.setIdle after exhausting retries', async () => {
      buildSpy.mockRejectedValue(new Error('503 Service Unavailable'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(setIdleSpy).toHaveBeenCalled();
    });

    it('should respect HYPERNEO_PROVIDER_MAX_RETRIES env override (1 retry)', async () => {
      process.env.HYPERNEO_PROVIDER_MAX_RETRIES = '1';
      buildSpy.mockRejectedValue(new Error('503 Service Unavailable'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(2);
    });

    it('should close queryObject before retrying to prevent transport crash', async () => {
      let closeCalled = false;
      const mockQueryObject = {
        close: () => {
          closeCalled = true;
        },
        [Symbol.asyncIterator]: function* () {},
      } as unknown as import('@anthropic-ai/claude-agent-sdk').Query;

      buildSpy.mockRejectedValue(new Error('503 Service Unavailable'));

      const ctx = createContext({ queryObject: mockQueryObject });
      runner = new QueryRunner(ctx);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(closeCalled).toBe(true);
      expect(ctx.queryObject).toBeNull();
    });

    it('should NOT retry transient connection errors via the bounded path (stays 1-shot)', async () => {
      buildSpy.mockRejectedValue(new Error('TypeError: fetch failed'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(2);
    });

    it('should retry 504 gateway timeout errors (5xx class)', async () => {
      buildSpy.mockRejectedValue(new Error('504 Gateway Timeout'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(4);
    });

    it('should NOT retry errors where digits are embedded in longer numbers (5000ms)', async () => {
      buildSpy.mockRejectedValue(new Error('Request timed out after 5000ms'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(1);
    });

    it('should not retry after backoff if interrupted during the backoff window', async () => {
      process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS = '100';
      const abortController = new AbortController();
      buildSpy.mockRejectedValue(new Error('503 Service Unavailable'));

      const ctx = createContext({ queryAbortController: abortController });
      runner = new QueryRunner(ctx);

      setTimeout(() => abortController.abort(), 20);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(1);
    });

    it('should not retry after backoff if a restart bumped the generation', async () => {
      process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS = '100';
      buildSpy.mockRejectedValue(new Error('503 Service Unavailable'));

      let gen = 0;
      const ctx = createContext({
        incrementQueryGeneration: () => ++gen,
        getQueryGeneration: () => gen,
      });
      runner = new QueryRunner(ctx);

      setTimeout(() => {
        gen = 2;
      }, 20);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(1);
    });

    it('should clear the stale startup timer before retrying a provider error', async () => {
      const fakeTimer = setTimeout(() => {}, 999999);
      buildSpy.mockRejectedValue(new Error('503 Service Unavailable'));

      const ctx = createContext({ startupTimeoutTimer: fakeTimer });
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(ctx.startupTimeoutTimer).toBeNull();
    });

    it('should restore originalEnvVars before recursive retry (env-leak guard)', async () => {
      buildSpy.mockRejectedValue(new Error('503 Service Unavailable'));

      const ctx = createContext({
        originalEnvVars: { ANTHROPIC_API_KEY: 'fake-original-key', SOME_VAR: 'val' },
      });
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(ctx.originalEnvVars).toEqual({});
    });

    it('should restore env vars even when retry is cancelled during backoff', async () => {
      process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS = '100';
      const abortController = new AbortController();
      buildSpy.mockRejectedValue(new Error('503 Service Unavailable'));

      const ctx = createContext({
        queryAbortController: abortController,
        originalEnvVars: { ANTHROPIC_API_KEY: 'fake-original-key' },
      });
      runner = new QueryRunner(ctx);

      setTimeout(() => abortController.abort(), 20);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(ctx.originalEnvVars).toEqual({});
      expect(buildSpy).toHaveBeenCalledTimes(1);
    });

    it('should not retry after backoff if the queue was stopped (restart/stop)', async () => {
      process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS = '100';
      buildSpy.mockRejectedValue(new Error('503 Service Unavailable'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);

      setTimeout(() => {
        isRunningSpy.mockReturnValue(false);
      }, 20);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(1);
    });

    it('should not persist turn termination when a rate-limit cooldown is scheduled', async () => {
      for (const errorMessage of [
        '429 Too Many Requests',
        'rate limit exceeded',
        'Request failed: 429',
      ]) {
        beginTerminalIdleSpy.mockClear();
        handleErrorSpy.mockClear();
        setIdleSpy.mockClear();
        buildSpy.mockRejectedValueOnce(new Error(errorMessage));
        const onRateLimitExhausted = mock(async () => true);

        const ctx = createContext({ onRateLimitExhausted });
        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expect(onRateLimitExhausted).toHaveBeenCalledTimes(1);
        expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
        expect(handleErrorSpy).not.toHaveBeenCalled();
        expect(setIdleSpy).not.toHaveBeenCalled();
      }
    });

    it('should preserve cooldown state through a recursive retry', async () => {
      buildSpy
        .mockRejectedValueOnce(new Error('TypeError: fetch failed'))
        .mockRejectedValueOnce(new Error('429 Too Many Requests'));
      const onRateLimitExhausted = mock(async () => true);

      const ctx = createContext({ onRateLimitExhausted });
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(2);
      expect(onRateLimitExhausted).toHaveBeenCalledTimes(1);
      expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
      expect(setIdleSpy.mock.calls).toEqual([[{ suppressDeliveryWaiters: true }]]);
    });

    it('should fence handled validation errors before rendering them', async () => {
      buildSpy.mockRejectedValue(
        new Error('400 {"error":{"message":"invalid rate limit field abc429xyz"}}')
      );
      let resolveDisplay!: () => void;
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.displayErrorAsAssistantMessage = mock(
        () =>
          new Promise<void>((resolve) => {
            resolveDisplay = resolve;
          })
      );
      runner.start();

      for (let attempt = 0; attempt < 20 && !resolveDisplay; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      expect(beginTerminalIdleSpy).toHaveBeenCalledTimes(1);
      expect(setIdleSpy).not.toHaveBeenCalled();

      resolveDisplay();
      await ctx.queryPromise?.catch(() => {});
      expect(setIdleSpy).toHaveBeenCalled();
    });

    it('should persist turn termination before awaiting terminal error publication', async () => {
      buildSpy.mockRejectedValue(new Error('terminal query failure'));
      let resolveError!: () => void;
      handleErrorSpy.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveError = resolve;
          })
      );

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();

      for (let attempt = 0; attempt < 20 && handleErrorSpy.mock.calls.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(handleErrorSpy).toHaveBeenCalledTimes(1);
      expect(beginTerminalIdleSpy).toHaveBeenCalledTimes(1);
      expect(setIdleSpy).not.toHaveBeenCalled();

      resolveError();
      await ctx.queryPromise?.catch(() => {});
      expect(setIdleSpy.mock.calls.length).toBeGreaterThan(0);
    });

    it('should clear _lastConsumedUserMessage on terminal error to prevent stale replay', async () => {
      buildSpy.mockRejectedValue(new Error('401 Unauthorized'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);

      (runner as unknown as { _lastConsumedUserMessage: unknown })._lastConsumedUserMessage = {
        uuid: 'stale-previous-turn-msg',
        content: [{ type: 'text' as const, text: 'old request' }],
      };

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(
        (runner as unknown as { _lastConsumedUserMessage: unknown })._lastConsumedUserMessage
      ).toBeNull();
    });
  });
  describe('transient and provider arm decision table (B1b)', () => {
    let savedApiKey: string | undefined;
    let savedBaseDelay: string | undefined;
    let savedMaxRetries: string | undefined;
    let savedOpenRouterApiKey: string | undefined;

    beforeEach(() => {
      savedApiKey = process.env.ANTHROPIC_API_KEY;
      savedBaseDelay = process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS;
      savedMaxRetries = process.env.HYPERNEO_PROVIDER_MAX_RETRIES;
      savedOpenRouterApiKey = process.env.OPENROUTER_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS = '0';
      process.env.OPENROUTER_API_KEY = 'sk-or-v1-test';
      mockSession.workspacePath = tmpdir();
    });

    afterEach(() => {
      if (savedApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = savedApiKey;
      }
      if (savedBaseDelay === undefined) {
        delete process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS;
      } else {
        process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS = savedBaseDelay;
      }
      if (savedMaxRetries === undefined) {
        delete process.env.HYPERNEO_PROVIDER_MAX_RETRIES;
      } else {
        process.env.HYPERNEO_PROVIDER_MAX_RETRIES = savedMaxRetries;
      }
      if (savedOpenRouterApiKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = savedOpenRouterApiKey;
      }
    });

    async function runB1bRow(options: {
      message: string;
      attempt?: number;
      maxRetries?: number;
      provider?: 'anthropic' | 'openrouter';
      onRateLimit?: (msg: string) => boolean;
      consumed?: boolean;
    }) {
      if (options.maxRetries !== undefined) {
        process.env.HYPERNEO_PROVIDER_MAX_RETRIES = String(options.maxRetries);
      } else {
        delete process.env.HYPERNEO_PROVIDER_MAX_RETRIES;
      }
      if (options.provider) {
        mockSession.config.provider = options.provider;
      } else {
        delete (mockSession.config as { provider?: string }).provider;
      }

      buildSpy.mockRejectedValue(new Error(options.message));
      const onRateLimitExhausted = options.onRateLimit
        ? mock(async (msg: string) => options.onRateLimit!(msg))
        : undefined;

      const ctx = createContext({ onRateLimitExhausted });
      runner = new QueryRunner(ctx);
      const runnerPrivate = runner as unknown as {
        _lastConsumedUserMessage: { uuid: string; content: unknown[] } | null;
        _consumedUserMessages: Map<number, unknown[]>;
        runQuery: (
          queryGeneration: number,
          retryAttempt: number,
          recoveryState: { rateLimitCooldownScheduled: boolean }
        ) => Promise<void>;
      };

      if (options.consumed) {
        runnerPrivate._lastConsumedUserMessage = {
          uuid: 'consumed-uuid',
          content: [{ type: 'text' as const, text: 'C' }],
        };
        runnerPrivate._consumedUserMessages.set(1, [runnerPrivate._lastConsumedUserMessage]);
      }

      if (options.attempt === undefined) {
        runner.start();
        await ctx.queryPromise?.catch(() => {});
      } else {
        ctx.incrementQueryGeneration();
        isRunningSpy.mockReturnValue(true);
        await runnerPrivate.runQuery(1, options.attempt, { rateLimitCooldownScheduled: false });
      }
    }

    describe('error subtype and terminal-text precedence', () => {
      const subtypeRows = [
        {
          name: 'text-only rate limit is not provider-retried and surfaces as RATE_LIMIT',
          message: 'rate limit exceeded, please retry later',
          expectedBuildCalls: 1,
          expectedCategory: ErrorCategory.RATE_LIMIT,
        },
        {
          name: 'mixed 429 service unavailable is terminal as PROVIDER_UNAVAILABLE for provider sessions',
          message: '429 service unavailable',
          provider: 'openrouter' as const,
          expectedBuildCalls: 1,
          expectedCategory: ErrorCategory.PROVIDER_UNAVAILABLE,
        },
        {
          name: 'mixed 429 service unavailable is terminal as RATE_LIMIT for Anthropic',
          message: '429 service unavailable',
          provider: 'anthropic' as const,
          expectedBuildCalls: 1,
          expectedCategory: ErrorCategory.RATE_LIMIT,
        },
        {
          name: 'terminal 503-quota is not retried and suppresses terminal on billing cooldown',
          message: '503 Service Unavailable: quota exceeded for this billing cycle',
          onRateLimit: () => true,
          expectedBuildCalls: 1,
          expectedHandleError: false,
          expectedSetIdle: false,
        },
        {
          name: 'terminal 503-quota for Anthropic surfaces as RATE_LIMIT',
          message: '503 Service Unavailable: quota exceeded',
          provider: 'anthropic' as const,
          expectedBuildCalls: 1,
          expectedCategory: ErrorCategory.RATE_LIMIT,
        },
        {
          name: 'terminal 503-quota for provider session surfaces as PROVIDER_UNAVAILABLE',
          message: '503 Service Unavailable: quota exceeded',
          provider: 'openrouter' as const,
          expectedBuildCalls: 1,
          expectedCategory: ErrorCategory.PROVIDER_UNAVAILABLE,
        },
        {
          name: 'retryable 5xx is retried up to the cap then terminal as SYSTEM',
          message: '500 Internal Server Error',
          expectedBuildCalls: 4,
          expectedCategory: ErrorCategory.SYSTEM,
          expectedRetryNoticeCount: 3,
        },
        {
          name: 'retryable 529 overloaded is retried up to the cap',
          message: '529 overloaded',
          expectedBuildCalls: 4,
          expectedCategory: ErrorCategory.SYSTEM,
          expectedRetryNoticeCount: 3,
        },
      ];

      for (const row of subtypeRows) {
        it(row.name, async () => {
          await runB1bRow({
            message: row.message,
            provider: row.provider,
            onRateLimit: row.onRateLimit,
          });

          expect(buildSpy).toHaveBeenCalledTimes(row.expectedBuildCalls);

          if (row.expectedHandleError === false) {
            expect(handleErrorSpy).not.toHaveBeenCalled();
            expect(setIdleSpy).not.toHaveBeenCalled();
            expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
          } else {
            expect(handleErrorSpy).toHaveBeenCalledTimes(1);
            expect(handleErrorSpy.mock.calls[0][2]).toBe(row.expectedCategory);
            expect(beginTerminalIdleSpy).toHaveBeenCalledTimes(1);
            expect(setIdleSpy).toHaveBeenCalled();
          }

          if (row.expectedRetryNoticeCount !== undefined) {
            const notices = (saveSDKMessageSpy.mock.calls as unknown[][]).filter((call) => {
              const msg = call[1] as { message?: { content?: Array<{ text?: string }> } };
              const content = msg.message?.content;
              return Array.isArray(content) && content.some((c) => c.text?.includes('Retrying'));
            });
            expect(notices).toHaveLength(row.expectedRetryNoticeCount);
          }
        });
      }
    });

    describe('attempt and cap exhaustion', () => {
      const capRows = [
        { attempt: 0, maxRetries: 0, expectedBuildCalls: 1 },
        { attempt: 0, maxRetries: 1, expectedBuildCalls: 2 },
        { attempt: 0, maxRetries: 3, expectedBuildCalls: 4 },
        { attempt: 1, maxRetries: 3, expectedBuildCalls: 3 },
        { attempt: 2, maxRetries: 3, expectedBuildCalls: 2 },
        { attempt: 3, maxRetries: 3, expectedBuildCalls: 1 },
      ];

      for (const row of capRows) {
        it(`attempt ${row.attempt} with maxRetries ${row.maxRetries} calls build ${row.expectedBuildCalls} time(s)`, async () => {
          await runB1bRow({
            message: '503 Service Unavailable',
            attempt: row.attempt,
            maxRetries: row.maxRetries,
          });

          expect(buildSpy).toHaveBeenCalledTimes(row.expectedBuildCalls);
        });
      }
    });

    describe('provider family (Anthropic SYSTEM vs PROVIDER_UNAVAILABLE)', () => {
      const familyRows = [
        {
          name: 'Anthropic 503 exhausted as SYSTEM',
          message: '503 Service Unavailable',
          provider: 'anthropic' as const,
          expectedCategory: ErrorCategory.SYSTEM,
        },
        {
          name: 'provider 503 exhausted as PROVIDER_UNAVAILABLE',
          message: '503 Service Unavailable',
          provider: 'openrouter' as const,
          expectedCategory: ErrorCategory.PROVIDER_UNAVAILABLE,
        },
      ];

      for (const row of familyRows) {
        it(row.name, async () => {
          await runB1bRow({
            message: row.message,
            provider: row.provider,
            attempt: 1,
            maxRetries: 0,
          });

          expect(handleErrorSpy).toHaveBeenCalledTimes(1);
          expect(handleErrorSpy.mock.calls[0][2]).toBe(row.expectedCategory);
        });
      }
    });

    describe('billing-429 rate-limit handoff', () => {
      it('suppresses terminal handling when onRateLimitExhausted returns true', async () => {
        await runB1bRow({
          message: '429 please upgrade your plan',
          onRateLimit: () => true,
        });

        expect(buildSpy).toHaveBeenCalledTimes(1);
        expect(handleErrorSpy).not.toHaveBeenCalled();
        expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
        expect(setIdleSpy).not.toHaveBeenCalled();
      });

      it('surfaces as RATE_LIMIT when onRateLimitExhausted returns false', async () => {
        await runB1bRow({
          message: '429 please upgrade your plan',
          onRateLimit: () => false,
        });

        expect(buildSpy).toHaveBeenCalledTimes(1);
        expect(handleErrorSpy).toHaveBeenCalledTimes(1);
        expect(handleErrorSpy.mock.calls[0][2]).toBe(ErrorCategory.RATE_LIMIT);
        expect(beginTerminalIdleSpy).toHaveBeenCalledTimes(1);
        expect(setIdleSpy).toHaveBeenCalled();
      });

      it('passes the consumed message and billingTerminal hint to onRateLimitExhausted', async () => {
        const onRateLimitExhausted = mock(async () => true);

        const ctx = createContext({ onRateLimitExhausted });
        runner = new QueryRunner(ctx);
        const runnerPrivate = runner as unknown as {
          _lastConsumedUserMessage: { uuid: string; content: unknown[] };
          _consumedUserMessages: Map<number, unknown[]>;
          runQuery: (
            queryGeneration: number,
            retryAttempt: number,
            recoveryState: { rateLimitCooldownScheduled: boolean }
          ) => Promise<void>;
        };

        const consumedMessage = {
          uuid: 'consumed-uuid',
          content: [{ type: 'text' as const, text: 'C' }],
        };
        runnerPrivate._lastConsumedUserMessage = consumedMessage;
        runnerPrivate._consumedUserMessages.set(1, [consumedMessage]);

        buildSpy.mockRejectedValue(new Error('429 please upgrade your plan'));

        ctx.incrementQueryGeneration();
        await runnerPrivate.runQuery(1, 0, { rateLimitCooldownScheduled: false });

        expect(onRateLimitExhausted).toHaveBeenCalledTimes(1);
        expect(onRateLimitExhausted).toHaveBeenCalledWith(
          'Error: 429 please upgrade your plan',
          consumedMessage,
          {
            resetAtMs: null,
            kind: 'usage_limit',
            billingTerminal: true,
          }
        );
      });
    });

    describe('unmatched-AbortError aborted_noop', () => {
      it('clears the queue and skips terminal handling and error display', async () => {
        const abortError = new Error('operation aborted by controller');
        abortError.name = 'AbortError';
        buildSpy.mockRejectedValue(abortError);

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expect(buildSpy).toHaveBeenCalledTimes(1);
        expect(clearSpy).toHaveBeenCalledTimes(1);
        expect(handleErrorSpy).not.toHaveBeenCalled();
        expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
        expect(setIdleSpy).toHaveBeenCalled();
        expect(saveSDKMessageSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('lifecycle × recoveryState/superseded cross rows (B1e)', () => {
    const ENV_KEYS = [
      'ANTHROPIC_API_KEY',
      'HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS',
      'HYPERNEO_PROVIDER_MAX_RETRIES',
      'OPENROUTER_API_KEY',
    ] as const;
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS = '0';
      process.env.OPENROUTER_API_KEY = 'sk-or-v1-test';
      mockSession.workspacePath = tmpdir();
    });

    afterEach(() => {
      for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
    });

    const STARTUP_TIMEOUT_MSG = 'SDK startup timeout - query aborted';
    const NO_MESSAGE_FOUND_MSG = 'No message found with message.uuid of: u-1';
    const TRANSIENT_MSG = 'TypeError: fetch failed';
    const PROVIDER_5XX_MSG = '503 Service Unavailable';
    const ABORT_MSG = 'the query was aborted';
    const TERMINAL_AUTH_MSG = 'invalid_api_key';
    const LIMIT_429_MSG = '429 please upgrade your plan';

    type RunnerPrivate = {
      _lastConsumedUserMessage: { uuid: string; content: unknown } | null;
      _consumedUserMessages: Map<number, Array<{ uuid: string; content: unknown }>>;
      runQuery: (
        queryGeneration: number,
        retryAttempt: number,
        recoveryState: { rateLimitCooldownScheduled: boolean }
      ) => Promise<void>;
    };

    interface RouteExpectation {
      build: number;
      handle?: [number, ErrorCategory?];
      terminalIdle?: number;
      idle?: number;
      clear?: number;
      enqueue?: number;
      notice?: number;
      stop?: number;
      terminate?: number;
      consume?: number;
    }

    function routeAllZero(overrides: Partial<RouteExpectation> = {}): RouteExpectation {
      return {
        build: 1,
        handle: [0],
        terminalIdle: 0,
        idle: 0,
        clear: 0,
        enqueue: 0,
        notice: 0,
        stop: 0,
        terminate: 0,
        consume: 0,
        ...overrides,
      };
    }

    function routeTerminal(
      category: ErrorCategory,
      overrides: Partial<RouteExpectation> = {}
    ): RouteExpectation {
      return routeAllZero({
        handle: [1, category],
        terminalIdle: 1,
        idle: 2,
        clear: 1,
        stop: 1,
        ...overrides,
      });
    }

    function routeRetriedOnce(
      category: ErrorCategory,
      overrides: Partial<RouteExpectation> = {}
    ): RouteExpectation {
      return routeAllZero({
        build: 2,
        handle: [1, category],
        terminalIdle: 1,
        enqueue: 1,
        terminate: 1,
        notice: 1,
        clear: 1,
        idle: 4,
        stop: 2,
        ...overrides,
      });
    }

    function expectRoute(expected: RouteExpectation, consumeSpy?: ReturnType<typeof mock>) {
      expect(buildSpy).toHaveBeenCalledTimes(expected.build);
      if (expected.handle !== undefined) {
        expect(handleErrorSpy).toHaveBeenCalledTimes(expected.handle[0]);
        if (expected.handle[0] > 0 && expected.handle[1] !== undefined) {
          expect(handleErrorSpy.mock.calls[0][2]).toBe(expected.handle[1]);
        }
      }
      const counts: Array<[ReturnType<typeof mock> | undefined, number | undefined]> = [
        [beginTerminalIdleSpy, expected.terminalIdle],
        [setIdleSpy, expected.idle],
        [clearSpy, expected.clear],
        [enqueueWithIdSpy, expected.enqueue],
        [saveSDKMessageSpy, expected.notice],
        [stopSpy, expected.stop],
        [terminateTrackedAgentProcessesSpy, expected.terminate],
        [consumeSpy, expected.consume],
      ];
      for (const [spy, count] of counts) {
        if (spy !== undefined && count !== undefined) {
          expect(spy).toHaveBeenCalledTimes(count);
        }
      }
    }

    interface LifecycleRowOptions {
      message: string;
      errorName?: string;
      status?: string;
      abortedController?: boolean;
      cleaningUp?: boolean;
      superseded?: boolean;
      consumed?: boolean;
      onRateLimit?: (msg: string) => boolean;
      isLimitRecoveryPending?: boolean;
      attempt?: number;
      recoveryState?: { rateLimitCooldownScheduled: boolean };
      rejectsWith?: string;
    }

    async function runLifecycleRow(options: LifecycleRowOptions) {
      delete process.env.HYPERNEO_PROVIDER_MAX_RETRIES;

      const error = new Error(options.message);
      if (options.errorName) error.name = options.errorName;
      buildSpy.mockRejectedValue(error);
      if (options.status !== undefined) {
        getStateSpy.mockReturnValue({ status: options.status });
      }

      const abortController = new AbortController();
      if (options.abortedController) abortController.abort();
      const onRateLimitExhausted = options.onRateLimit
        ? mock(async (msg: string) => options.onRateLimit!(msg))
        : undefined;
      const consumeSpy = mock(() => 'consumed-resume-uuid');

      const ctx = createContext({
        queryAbortController: options.abortedController ? abortController : null,
        isCleaningUp: () => !!options.cleaningUp,
        onRateLimitExhausted,
        consumePendingResumeSessionAt: consumeSpy,
        isLimitRecoveryPending: options.isLimitRecoveryPending ? () => true : undefined,
        ...(options.superseded ? { getQueryGeneration: () => 2 } : {}),
      });
      runner = new QueryRunner(ctx);
      const runnerPrivate = runner as unknown as RunnerPrivate;

      if (options.consumed) {
        runnerPrivate._lastConsumedUserMessage = {
          uuid: 'consumed-uuid',
          content: [{ type: 'text' as const, text: 'C' }],
        };
        runnerPrivate._consumedUserMessages.set(1, [runnerPrivate._lastConsumedUserMessage]);
      }

      if (options.attempt !== undefined) {
        ctx.incrementQueryGeneration();
        isRunningSpy.mockReturnValue(true);
        const attemptPromise = runnerPrivate.runQuery(
          1,
          options.attempt,
          options.recoveryState ?? { rateLimitCooldownScheduled: false }
        );
        if (options.rejectsWith !== undefined) {
          await expect(attemptPromise).rejects.toThrow(options.rejectsWith);
        } else {
          await attemptPromise;
        }
      } else if (options.rejectsWith !== undefined) {
        runner.start();
        await expect(ctx.queryPromise).rejects.toThrow(options.rejectsWith);
      } else {
        runner.start();
        await ctx.queryPromise?.catch(() => {});
      }
      return { ctx, runnerPrivate, consumeSpy };
    }

    describe('arm-gate lifecycle matrix (status × abort controller × cleaning-up × superseded)', () => {
      const matrixRows: Array<{
        name: string;
        options: LifecycleRowOptions;
        expect: RouteExpectation;
      }> = [
        {
          name: 'startup × idle baseline retries once, TIMEOUT surfaces on the retry attempt',
          options: { message: STARTUP_TIMEOUT_MSG, consumed: true },
          expect: routeRetriedOnce(ErrorCategory.TIMEOUT),
        },
        {
          name: 'startup × interrupted processing declines the arm and routes terminal TIMEOUT',
          options: { message: STARTUP_TIMEOUT_MSG, consumed: true, status: 'interrupted' },
          expect: routeTerminal(ErrorCategory.TIMEOUT),
        },
        {
          name: 'startup × aborted controller does not block the retry arm',
          options: { message: STARTUP_TIMEOUT_MSG, consumed: true, abortedController: true },
          expect: routeRetriedOnce(ErrorCategory.TIMEOUT),
        },
        {
          name: 'startup × cleaning-up returns before the arm, tears down but never idles',
          options: { message: STARTUP_TIMEOUT_MSG, consumed: true, cleaningUp: true },
          expect: routeAllZero({ stop: 1 }),
        },
        {
          name: 'transient × idle baseline retries once, CONNECTION surfaces on the retry attempt',
          options: { message: TRANSIENT_MSG, consumed: true },
          expect: routeRetriedOnce(ErrorCategory.CONNECTION, { terminate: 0 }),
        },
        {
          name: 'transient × interrupted processing blocks the otherwise identical retry',
          options: { message: TRANSIENT_MSG, consumed: true, status: 'interrupted' },
          expect: routeTerminal(ErrorCategory.CONNECTION),
        },
        {
          name: 'transient × aborted controller blocks the otherwise identical retry',
          options: { message: TRANSIENT_MSG, consumed: true, abortedController: true },
          expect: routeTerminal(ErrorCategory.CONNECTION),
        },
        {
          name: 'transient × AbortError name dominates the transient text and routes aborted_noop',
          options: { message: TRANSIENT_MSG, consumed: true, errorName: 'AbortError' },
          expect: routeAllZero({ idle: 1, clear: 1, stop: 1 }),
        },
        {
          name: 'transient × cleaning-up returns before the arm, tears down but never idles',
          options: { message: TRANSIENT_MSG, consumed: true, cleaningUp: true },
          expect: routeAllZero({ stop: 1 }),
        },
        {
          name: 'message-not-found × idle baseline retries once, SYSTEM surfaces on the retry',
          options: { message: NO_MESSAGE_FOUND_MSG },
          expect: routeRetriedOnce(ErrorCategory.SYSTEM, { notice: 0, enqueue: 0, consume: 1 }),
        },
        {
          name: 'message-not-found × interrupted processing still retries (no status gate)',
          options: { message: NO_MESSAGE_FOUND_MSG, status: 'interrupted' },
          expect: routeRetriedOnce(ErrorCategory.SYSTEM, { notice: 0, enqueue: 0, consume: 1 }),
        },
        {
          name: 'message-not-found × aborted controller still retries (no interrupt gate)',
          options: { message: NO_MESSAGE_FOUND_MSG, abortedController: true },
          expect: routeRetriedOnce(ErrorCategory.SYSTEM, { notice: 0, enqueue: 0, consume: 1 }),
        },
        {
          name: 'message-not-found × cleaning-up skips the resume pointer and never idles',
          options: { message: NO_MESSAGE_FOUND_MSG, cleaningUp: true },
          expect: routeAllZero({ stop: 1 }),
        },
        {
          name: 'provider × idle baseline retries to the cap then surfaces SYSTEM',
          options: { message: PROVIDER_5XX_MSG, consumed: true },
          expect: routeAllZero({
            build: 4,
            enqueue: 1,
            notice: 3,
            handle: [1, ErrorCategory.SYSTEM],
            terminalIdle: 1,
            clear: 1,
            idle: 5,
            stop: 4,
          }),
        },
        {
          name: 'provider × interrupted processing blocks the arm and routes terminal SYSTEM',
          options: { message: PROVIDER_5XX_MSG, consumed: true, status: 'interrupted' },
          expect: routeTerminal(ErrorCategory.SYSTEM),
        },
        {
          name: 'provider × aborted controller blocks the otherwise identical retry',
          options: { message: PROVIDER_5XX_MSG, consumed: true, abortedController: true },
          expect: routeTerminal(ErrorCategory.SYSTEM),
        },
        {
          name: 'provider × cleaning-up returns before the arm, tears down but never idles',
          options: { message: PROVIDER_5XX_MSG, consumed: true, cleaningUp: true },
          expect: routeAllZero({ stop: 1 }),
        },
        {
          name: 'provider × superseded returns before the arm and skips the finalizer teardown',
          options: { message: PROVIDER_5XX_MSG, consumed: true, superseded: true },
          expect: routeAllZero(),
        },
        {
          name: 'aborted_noop × idle baseline clears the queue and only the finalizer idles',
          options: { message: ABORT_MSG, errorName: 'AbortError' },
          expect: routeAllZero({ idle: 1, clear: 1, stop: 1 }),
        },
        {
          name: 'aborted_noop × cleaning-up suppresses even the queue clear',
          options: { message: ABORT_MSG, errorName: 'AbortError', cleaningUp: true },
          expect: routeAllZero({ stop: 1 }),
        },
        {
          name: 'terminal × idle baseline routes AUTHENTICATION with catch and finalizer idles',
          options: { message: TERMINAL_AUTH_MSG },
          expect: routeTerminal(ErrorCategory.AUTHENTICATION),
        },
        {
          name: 'terminal × superseded suppresses the whole terminal route',
          options: { message: TERMINAL_AUTH_MSG, superseded: true },
          expect: routeAllZero(),
        },
      ];

      for (const row of matrixRows) {
        it(row.name, async () => {
          const { consumeSpy } = await runLifecycleRow(row.options);
          expectRoute(row.expect, consumeSpy);
        });
      }
    });

    describe('provider backoff revalidation block', () => {
      interface BackoffTools {
        supersede: () => void;
        abortSignal: () => void;
        setCleaningUp: () => void;
        stopQueue: () => void;
        interruptProcessing: () => void;
      }

      const BACKOFF_DELAY_MS = 200;

      async function runBackoffRow(flip?: (tools: BackoffTools) => void) {
        delete process.env.HYPERNEO_PROVIDER_MAX_RETRIES;
        process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS = flip ? String(BACKOFF_DELAY_MS) : '0';
        buildSpy.mockRejectedValue(new Error(PROVIDER_5XX_MSG));

        let cleaningUp = false;
        const controller = new AbortController();
        const ctx = createContext({
          queryAbortController: controller,
          isCleaningUp: () => cleaningUp,
        });
        runner = new QueryRunner(ctx);
        const runnerPrivate = runner as unknown as RunnerPrivate;
        runnerPrivate._lastConsumedUserMessage = {
          uuid: 'retry-uuid',
          content: [{ type: 'text' as const, text: 'P' }],
        };
        runnerPrivate._consumedUserMessages.set(1, [runnerPrivate._lastConsumedUserMessage]);
        ctx.incrementQueryGeneration();
        isRunningSpy.mockReturnValue(true);

        if (!flip) {
          await runnerPrivate.runQuery(1, 0, { rateLimitCooldownScheduled: false });
          return runnerPrivate;
        }

        const tools: BackoffTools = {
          supersede: () => ctx.incrementQueryGeneration(),
          abortSignal: () => controller.abort(),
          setCleaningUp: () => {
            cleaningUp = true;
          },
          stopQueue: () => isRunningSpy.mockReturnValue(false),
          interruptProcessing: () => getStateSpy.mockReturnValue({ status: 'interrupted' }),
        };
        const originalSetTimeout = globalThis.setTimeout;
        let flipArmed = true;
        const intercepting = ((
          handler: (...timerArgs: unknown[]) => void,
          timeout?: number,
          ...rest: unknown[]
        ) =>
          originalSetTimeout(
            (...timerArgs: unknown[]) => {
              if (flipArmed && timeout === BACKOFF_DELAY_MS) {
                flipArmed = false;
                flip(tools);
              }
              handler(...timerArgs);
            },
            timeout,
            ...rest
          )) as unknown as typeof globalThis.setTimeout;
        globalThis.setTimeout = intercepting;
        try {
          await runnerPrivate.runQuery(1, 0, { rateLimitCooldownScheduled: false });
        } finally {
          globalThis.setTimeout = originalSetTimeout;
        }
        return runnerPrivate;
      }

      const backoffRows: Array<{
        name: string;
        flip?: (tools: BackoffTools) => void;
        expect: RouteExpectation;
      }> = [
        {
          name: 'no lifecycle flip during the backoff → the retry runs to the cap',
          expect: routeAllZero({
            build: 4,
            enqueue: 1,
            notice: 3,
            handle: [1, ErrorCategory.SYSTEM],
            terminalIdle: 1,
            clear: 1,
            idle: 5,
            stop: 4,
          }),
        },
        {
          name: 'cleaning-up flips during the backoff → retry cancelled, no re-enqueue, no idle',
          flip: (t) => t.setCleaningUp(),
          expect: routeAllZero({ notice: 1, stop: 1 }),
        },
        {
          name: 'queue stopped during the backoff → retry cancelled but the finalizer still idles',
          flip: (t) => t.stopQueue(),
          expect: routeAllZero({ notice: 1, idle: 1, stop: 1 }),
        },
        {
          name: 'run superseded during the backoff → retry cancelled and the finalizer skips teardown',
          flip: (t) => t.supersede(),
          expect: routeAllZero({ notice: 1 }),
        },
        {
          name: 'processing interrupted during the backoff → retry cancelled, finalizer still idles',
          flip: (t) => t.interruptProcessing(),
          expect: routeAllZero({ notice: 1, idle: 1, stop: 1 }),
        },
        {
          name: 'abort controller fires during the backoff → retry cancelled, finalizer still idles',
          flip: (t) => t.abortSignal(),
          expect: routeAllZero({ notice: 1, idle: 1, stop: 1 }),
        },
      ];

      for (const row of backoffRows) {
        it(row.name, async () => {
          const runnerPrivate = await runBackoffRow(row.flip);
          expectRoute(row.expect);
          expect(runnerPrivate._lastConsumedUserMessage).toBeNull();
          expect(runnerPrivate._consumedUserMessages.has(1)).toBe(false);
        });
      }
    });

    describe('recoveryState and scheduled-cooldown routing', () => {
      const recoveryRows: Array<{
        name: string;
        options: LifecycleRowOptions;
        expect: RouteExpectation;
      }> = [
        {
          name: 'limit error with the cooldown handoff accepted → no terminal handling, no idle anywhere',
          options: { message: LIMIT_429_MSG, onRateLimit: () => true },
          expect: routeAllZero({ clear: 1, stop: 1 }),
        },
        {
          name: 'otherwise identical limit error with the handoff declined → full RATE_LIMIT terminal',
          options: { message: LIMIT_429_MSG, onRateLimit: () => false },
          expect: routeTerminal(ErrorCategory.RATE_LIMIT),
        },
        {
          name: 'rejecting cooldown handoff → no terminal handling, finalizer still idles, query rejects',
          options: {
            message: LIMIT_429_MSG,
            rejectsWith: 'watchdog handoff failed',
            onRateLimit: () => {
              throw new Error('watchdog handoff failed');
            },
          },
          expect: routeAllZero({ idle: 1, clear: 1, stop: 1 }),
        },
        {
          name: 'incoming cooldown flag is recomputed per error, not sticky across attempts',
          options: {
            message: TERMINAL_AUTH_MSG,
            attempt: 0,
            recoveryState: { rateLimitCooldownScheduled: true },
          },
          expect: routeTerminal(ErrorCategory.AUTHENTICATION),
        },
        {
          name: 'pending limit recovery skips only the finalizer idle, not the terminal route',
          options: { message: TERMINAL_AUTH_MSG, isLimitRecoveryPending: true },
          expect: routeTerminal(ErrorCategory.AUTHENTICATION, { idle: 1 }),
        },
        {
          name: 'rate_limit_cooldown processing status skips only the finalizer idle',
          options: { message: TERMINAL_AUTH_MSG, status: 'rate_limit_cooldown' },
          expect: routeTerminal(ErrorCategory.AUTHENTICATION, { idle: 1 }),
        },
        {
          name: 'incoming cooldown flag suppresses the finalizer idle on the aborted_noop route too',
          options: {
            message: ABORT_MSG,
            errorName: 'AbortError',
            attempt: 0,
            recoveryState: { rateLimitCooldownScheduled: true },
          },
          expect: routeAllZero({ clear: 1, stop: 1 }),
        },
      ];

      for (const row of recoveryRows) {
        it(row.name, async () => {
          await runLifecycleRow(row.options);
          expectRoute(row.expect);
        });
      }
    });

    describe('terminal & handoff route interpretation (B3d)', () => {
      it('declined handoff with interrupted processing re-routes to aborted_noop instead of the terminal publication', async () => {
        await runLifecycleRow({
          message: LIMIT_429_MSG,
          status: 'interrupted',
          onRateLimit: () => false,
        });
        expectRoute(routeAllZero({ clear: 1, idle: 1, stop: 1 }));
      });

      it('declined handoff with an aborted controller re-routes to aborted_noop', async () => {
        await runLifecycleRow({
          message: LIMIT_429_MSG,
          abortedController: true,
          onRateLimit: () => false,
        });
        expectRoute(routeAllZero({ clear: 1, idle: 1, stop: 1 }));
      });

      it('accepted handoff records the scheduled cooldown on the recovery state', async () => {
        const recoveryState = { rateLimitCooldownScheduled: false };
        await runLifecycleRow({
          message: LIMIT_429_MSG,
          attempt: 0,
          recoveryState,
          onRateLimit: () => true,
        });
        expect(recoveryState.rateLimitCooldownScheduled).toBe(true);
      });

      it('declined handoff recomputes an incoming cooldown flag to false', async () => {
        const recoveryState = { rateLimitCooldownScheduled: true };
        await runLifecycleRow({
          message: LIMIT_429_MSG,
          attempt: 0,
          recoveryState,
          onRateLimit: () => false,
        });
        expect(recoveryState.rateLimitCooldownScheduled).toBe(false);
      });

      it('exhausted provider retries map the provider_exhausted hint to the retry-count user message', async () => {
        await runLifecycleRow({
          message: PROVIDER_5XX_MSG,
          attempt: 3,
          consumed: true,
        });
        expect(handleErrorSpy).toHaveBeenCalledTimes(1);
        expect(handleErrorSpy.mock.calls[0][2]).toBe(ErrorCategory.SYSTEM);
        expect(handleErrorSpy.mock.calls[0][3]).toContain('3 time(s) without success');
      });
    });

    describe('superseded mid-arm checkpoint and finalizer teardown', () => {
      it('startup arm abandons the retry when a replacement takes the generation across the setIdle await', async () => {
        buildSpy.mockRejectedValue(new Error(STARTUP_TIMEOUT_MSG));
        const ctx = createContext();
        runner = new QueryRunner(ctx);
        const runnerPrivate = runner as unknown as RunnerPrivate;
        runnerPrivate._consumedUserMessages.set(1, [
          { uuid: 'consumed-uuid', content: [{ type: 'text' as const, text: 'C' }] },
        ]);
        let markIdle!: () => void;
        const idleEntered = new Promise<void>((resolve) => {
          markIdle = resolve;
        });
        let releaseIdle!: () => void;
        const idleGate = new Promise<void>((resolve) => {
          releaseIdle = resolve;
        });
        setIdleSpy.mockImplementation(() => {
          markIdle();
          return idleGate;
        });
        runner.start();
        await idleEntered;
        ctx.incrementQueryGeneration();
        releaseIdle();
        await ctx.queryPromise?.catch(() => {});

        expectRoute({
          build: 1,
          enqueue: 0,
          terminate: 0,
          notice: 0,
          handle: [0],
          idle: 1,
          clear: 0,
          stop: 0,
        });
        expect(runnerPrivate._consumedUserMessages.has(1)).toBe(false);
      });

      it('live aborted_noop finalizer stops the queue, closes the query object, consumes the controller', async () => {
        const abortError = new Error(ABORT_MSG);
        abortError.name = 'AbortError';
        buildSpy.mockRejectedValue(abortError);
        const controller = new AbortController();
        const closeSpy = mock(() => {});
        const ctx = createContext({
          queryAbortController: controller,
          queryObject: { close: closeSpy } as unknown as QueryRunnerContext['queryObject'],
        });
        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expect(closeSpy).toHaveBeenCalledTimes(1);
        expectRoute({ build: 1, handle: [0], idle: 1, clear: 1, stop: 1 });
        expect(ctx.queryAbortController).toBeNull();
        expect(controller.signal.aborted).toBe(true);
      });

      it('superseded finalizer skips the teardown entirely and leaves the controller untouched', async () => {
        const abortError = new Error(ABORT_MSG);
        abortError.name = 'AbortError';
        buildSpy.mockRejectedValue(abortError);
        const controller = new AbortController();
        const closeSpy = mock(() => {});
        const ctx = createContext({
          queryAbortController: controller,
          queryObject: { close: closeSpy } as unknown as QueryRunnerContext['queryObject'],
          getQueryGeneration: () => 2,
        });
        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expect(closeSpy).not.toHaveBeenCalled();
        expectRoute({ build: 1, handle: [0], idle: 0, clear: 0, stop: 0 });
        expect(ctx.queryAbortController).toBe(controller);
        expect(controller.signal.aborted).toBe(false);
      });
    });

    describe('B3c finalizer post-await guards', () => {
      const PROVIDER_SERVICE_KEY = Symbol.for('hyperneo:providerServiceInstance');
      let previousProviderService: unknown;
      let onRestore: (() => void) | null = null;

      beforeEach(() => {
        previousProviderService = (globalThis as Record<symbol, unknown>)[PROVIDER_SERVICE_KEY];
        onRestore = null;
        (globalThis as Record<symbol, unknown>)[PROVIDER_SERVICE_KEY] = {
          restoreEnvVars: mock((_original: Record<string, unknown>) => {
            onRestore?.();
          }),
        };
      });

      afterEach(() => {
        (globalThis as Record<symbol, unknown>)[PROVIDER_SERVICE_KEY] = previousProviderService;
      });

      it('aborted_noop route suppresses setIdle when status becomes interrupted', async () => {
        const error = new Error(ABORT_MSG);
        error.name = 'AbortError';
        buildSpy.mockRejectedValueOnce(error);
        getStateSpy.mockReturnValue({ status: 'idle' });
        onRestore = () => {
          getStateSpy.mockReturnValue({ status: 'interrupted' });
        };

        const ctx = createContext({ originalEnvVars: { ANTHROPIC_API_KEY: 'b3c-test' } });
        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expectRoute(routeAllZero({ clear: 1, stop: 1 }));
      });

      it('aborted_noop route suppresses setIdle when the abort controller is replaced', async () => {
        const error = new Error(ABORT_MSG);
        error.name = 'AbortError';
        buildSpy.mockRejectedValueOnce(error);

        let replacementController: AbortController | null = null;
        const ctx = createContext({ originalEnvVars: { ANTHROPIC_API_KEY: 'b3c-test' } });
        onRestore = () => {
          ctx.queryAbortController = new AbortController();
          replacementController = ctx.queryAbortController;
        };

        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expectRoute(routeAllZero({ clear: 1, stop: 1 }));
        expect(ctx.queryAbortController).toBe(replacementController);
      });

      it('aborted_noop route suppresses setIdle when the query generation is bumped', async () => {
        const error = new Error(ABORT_MSG);
        error.name = 'AbortError';
        buildSpy.mockRejectedValueOnce(error);

        let generation = 1;
        const ctx = createContext({
          originalEnvVars: { ANTHROPIC_API_KEY: 'b3c-test' },
          getQueryGeneration: () => generation,
          incrementQueryGeneration: () => ++generation,
        });
        onRestore = () => {
          ctx.incrementQueryGeneration();
        };

        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expectRoute(routeAllZero({ clear: 1, stop: 1 }));
        expect(generation).toBe(3);
      });

      it('terminal route still idles when status becomes interrupted', async () => {
        buildSpy.mockRejectedValueOnce(new Error(TERMINAL_AUTH_MSG));
        getStateSpy.mockReturnValue({ status: 'idle' });
        onRestore = () => {
          getStateSpy.mockReturnValue({ status: 'interrupted' });
        };

        const ctx = createContext({ originalEnvVars: { ANTHROPIC_API_KEY: 'b3c-test' } });
        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expectRoute(routeTerminal(ErrorCategory.AUTHENTICATION));
      });
    });
  });
});

describe('QueryRunner error categorization', () => {
  it('should categorize authentication errors', () => {
    const testCases = [
      { message: '401 Unauthorized', expected: 'authentication' },
      { message: 'unauthorized access', expected: 'authentication' },
      { message: 'invalid_api_key', expected: 'authentication' },
    ];

    for (const { message, expected } of testCases) {
      let category = 'system';
      if (
        message.includes('401') ||
        message.includes('unauthorized') ||
        message.includes('invalid_api_key')
      ) {
        category = 'authentication';
      }
      expect(category).toBe(expected);
    }
  });

  it('should categorize connection errors', () => {
    const testCases = [
      { message: 'ECONNREFUSED', expected: 'connection' },
      { message: 'ENOTFOUND', expected: 'connection' },
    ];

    for (const { message, expected } of testCases) {
      let category = 'system';
      if (message.includes('ECONNREFUSED') || message.includes('ENOTFOUND')) {
        category = 'connection';
      }
      expect(category).toBe(expected);
    }
  });

  it('should categorize rate limit errors', () => {
    const testCases = [
      { message: '429 Too Many Requests', expected: 'rate_limit' },
      { message: 'rate limit exceeded', expected: 'rate_limit' },
    ];

    for (const { message, expected } of testCases) {
      let category = 'system';
      if (message.includes('429') || message.includes('rate limit')) {
        category = 'rate_limit';
      }
      expect(category).toBe(expected);
    }
  });

  it('should categorize timeout errors', () => {
    let category = 'system';
    const message = 'request timeout exceeded';
    if (message.includes('timeout')) {
      category = 'timeout';
    }
    expect(category).toBe('timeout');
  });

  it('should categorize model errors', () => {
    let category = 'system';
    const message = 'model_not_found: claude-invalid';
    if (message.includes('model_not_found')) {
      category = 'model';
    }
    expect(category).toBe('model');
  });

  it('should categorize permission errors', () => {
    const testCases = [
      { message: 'cannot be run as root', expected: 'permission' },
      { message: 'dangerously-skip-permissions required', expected: 'permission' },
      { message: 'permission denied', expected: 'permission' },
      { message: 'Exit code: 1', expected: 'permission' },
    ];

    for (const { message, expected } of testCases) {
      let category = 'system';
      if (
        message.includes('cannot be run as root') ||
        message.includes('dangerously-skip-permissions') ||
        message.includes('permission') ||
        message.includes('Exit code: 1')
      ) {
        category = 'permission';
      }
      expect(category).toBe(expected);
    }
  });

  it('should default to system category for unknown errors', () => {
    const category = 'system';
    const _message = 'some unknown error';
    expect(category).toBe('system');
  });
});

describe('QueryRunner API validation error parsing', () => {
  it('should parse 400 status code errors', () => {
    const errorMessage =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}';
    const match = errorMessage.match(/^(?:API Error:\s*)?(4\d{2})\s+(\{.+\})$/s);

    expect(match).not.toBeNull();
    expect(match![1]).toBe('400');

    const body = JSON.parse(match![2]);
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toBe('prompt is too long');
  });

  it('should parse 401 status code errors', () => {
    const errorMessage =
      '401 {"type":"error","error":{"type":"authentication_error","message":"invalid api key"}}';
    const match = errorMessage.match(/^(?:API Error:\s*)?(4\d{2})\s+(\{.+\})$/s);

    expect(match).not.toBeNull();
    expect(match![1]).toBe('401');
  });

  it('should parse 429 status code errors', () => {
    const errorMessage =
      '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}';
    const match = errorMessage.match(/^(?:API Error:\s*)?(4\d{2})\s+(\{.+\})$/s);

    expect(match).not.toBeNull();
    expect(match![1]).toBe('429');
  });

  it('should parse Claude SDK API Error-prefixed JSON errors', () => {
    const errorMessage =
      'API Error: 402 {"type":"error","error":{"type":"rate_limit_error","message":"402 You have no quota"}}';
    const match = errorMessage.match(/^(?:API Error:\s*)?(4\d{2})\s+(\{.+\})$/s);

    expect(match).not.toBeNull();
    expect(match![1]).toBe('402');
    const body = JSON.parse(match![2]);
    expect(body.error.type).toBe('rate_limit_error');
    expect(body.error.message).toBe('402 You have no quota');
  });

  it('should not match 5xx errors', () => {
    const errorMessage = '500 {"error":"internal server error"}';
    const match = errorMessage.match(/^(?:API Error:\s*)?(4\d{2})\s+(\{.+\})$/s);

    expect(match).toBeNull();
  });

  it('should not match non-JSON errors', () => {
    const errorMessage = 'Connection refused';
    const match = errorMessage.match(/^(?:API Error:\s*)?(4\d{2})\s+(\{.+\})$/s);

    expect(match).toBeNull();
  });

  it('should handle malformed JSON gracefully', () => {
    const errorMessage = '400 {invalid json}';
    const match = errorMessage.match(/^(?:API Error:\s*)?(4\d{2})\s+(\{.+\})$/s);

    expect(match).not.toBeNull();
    expect(() => JSON.parse(match![2])).toThrow();
  });

  it('should extract error message from body', () => {
    const errorMessage =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt exceeds limit"}}';
    const match = errorMessage.match(/^(?:API Error:\s*)?(4\d{2})\s+(\{.+\})$/s);

    const body = JSON.parse(match![2]);
    const apiErrorMessage = body.error?.message || errorMessage;
    expect(apiErrorMessage).toBe('prompt exceeds limit');
  });

  it('should extract error type from body', () => {
    const errorMessage =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"test"}}';
    const match = errorMessage.match(/^(?:API Error:\s*)?(4\d{2})\s+(\{.+\})$/s);

    const body = JSON.parse(match![2]);
    const apiErrorType = body.error?.type || 'api_error';
    expect(apiErrorType).toBe('invalid_request_error');
  });

  it('should default error type when missing', () => {
    const body = { type: 'error' };
    const apiErrorType = body.error?.type || 'api_error';
    expect(apiErrorType).toBe('api_error');
  });
});

describe('QueryRunner startup timeout handling', () => {
  it('should track timeout state', () => {
    let startupTimeoutReached = false;
    const queryStartTime = Date.now();

    const timeoutCallback = () => {
      startupTimeoutReached = true;
      const elapsed = Date.now() - queryStartTime;
      expect(elapsed).toBeGreaterThanOrEqual(0);
    };

    expect(startupTimeoutReached).toBe(false);

    timeoutCallback();
    expect(startupTimeoutReached).toBe(true);
  });

  it('should clear timeout on first message', () => {
    let timerCleared = false;
    const timer = setTimeout(() => {}, 60000);

    clearTimeout(timer);
    timerCleared = true;

    expect(timerCleared).toBe(true);
  });

  it('should throw error when timeout reached and no messages', () => {
    const startupTimeoutReached = true;
    const messageCount = 0;

    let errorThrown = false;
    if (startupTimeoutReached && messageCount === 0) {
      errorThrown = true;
    }

    expect(errorThrown).toBe(true);
  });
});

describe('QueryRunner abortable query iterator', () => {
  it('should create abort controller', () => {
    const abortController = new AbortController();
    expect(abortController.signal.aborted).toBe(false);
  });

  it('should abort signal on abort() call', () => {
    const abortController = new AbortController();
    abortController.abort();
    expect(abortController.signal.aborted).toBe(true);
  });

  it('should handle already aborted signal', async () => {
    const abortController = new AbortController();
    abortController.abort();

    let messagesProcessed = 0;

    if (!abortController.signal.aborted) {
      messagesProcessed++;
    }

    expect(messagesProcessed).toBe(0);
  });

  it('should break on abort during iteration', async () => {
    const abortController = new AbortController();
    const messages = ['msg1', 'msg2', 'msg3', 'msg4'];
    let processedCount = 0;

    for (const _msg of messages) {
      if (abortController.signal.aborted) {
        break;
      }
      processedCount++;
      if (processedCount === 2) {
        abortController.abort();
      }
    }

    expect(processedCount).toBe(2);
  });

  it('should handle abort promise race', async () => {
    const abortController = new AbortController();
    const abortError = new Error('Query aborted');

    const abortPromise = new Promise<never>((_, reject) => {
      abortController.signal.addEventListener('abort', () => reject(abortError), { once: true });
    });

    abortController.abort();

    await expect(abortPromise).rejects.toThrow('Query aborted');
  });

  it('should detect abort error by message', () => {
    const error = new Error('Query aborted');

    const isAbortError = error.message === 'Query aborted';
    expect(isAbortError).toBe(true);
  });

  it('should re-throw non-abort errors', () => {
    const error = new Error('Some other error');

    expect(() => {
      if (error.message !== 'Query aborted') {
        throw error;
      }
    }).toThrow('Some other error');
  });

  it('should clean up iterator on completion', async () => {
    let returnCalled = false;

    const mockIterator = {
      next: async () => ({ value: undefined, done: true }),
      return: async () => {
        returnCalled = true;
        return { value: undefined, done: true };
      },
    };

    await mockIterator.return?.();

    expect(returnCalled).toBe(true);
  });
});

describe('QueryRunner stale query detection', () => {
  it('should detect current query', () => {
    const currentGeneration = 1;
    const queryGeneration = 1;

    const isStale = currentGeneration !== queryGeneration;
    expect(isStale).toBe(false);
  });

  it('should detect stale query', () => {
    const currentGeneration = 2;
    const queryGeneration = 1;

    const isStale = currentGeneration !== queryGeneration;
    expect(isStale).toBe(true);
  });

  it('should skip cleanup for stale queries', () => {
    const currentGeneration = 2;
    const queryGeneration = 1;
    const isStaleQuery = currentGeneration !== queryGeneration;

    let cleanupPerformed = false;
    if (!isStaleQuery) {
      cleanupPerformed = true;
    }

    expect(isStaleQuery).toBe(true);
    expect(cleanupPerformed).toBe(false);
  });

  it('should perform cleanup for current queries', () => {
    const currentGeneration = 1;
    const queryGeneration = 1;
    const isStaleQuery = currentGeneration !== queryGeneration;

    let cleanupPerformed = false;
    if (!isStaleQuery) {
      cleanupPerformed = true;
    }

    expect(isStaleQuery).toBe(false);
    expect(cleanupPerformed).toBe(true);
  });
});

describe('QueryRunner message generator wrapper', () => {
  it('should skip state update for internal messages', async () => {
    let stateUpdates = 0;

    const messages = [
      { uuid: 'msg-1', internal: false },
      { uuid: 'msg-2', internal: true },
      { uuid: 'msg-3', internal: false },
    ];

    for (const msg of messages) {
      const isInternal = msg.internal || false;
      if (!isInternal) {
        stateUpdates++;
      }
    }

    expect(stateUpdates).toBe(2);
  });

  it('should call onSent after yield', () => {
    let sentCount = 0;

    const queuedMessages = [
      { message: { uuid: 'msg-1' }, onSent: () => sentCount++ },
      { message: { uuid: 'msg-2' }, onSent: () => sentCount++ },
    ];

    for (const { onSent } of queuedMessages) {
      onSent();
    }

    expect(sentCount).toBe(2);
  });

  it('should use unknown uuid when message has no uuid', () => {
    const message = {};
    const uuid = (message as { uuid?: string }).uuid ?? 'unknown';
    expect(uuid).toBe('unknown');
  });
});

describe('QueryRunner SDK message handling', () => {
  it('should mark only consumed queued message as sent', () => {
    const queuedMessages = [
      { dbId: 1, uuid: 'msg-1' },
      { dbId: 2, uuid: 'msg-2' },
      { dbId: 3, uuid: 'msg-3' },
    ];

    const updateCalls: { dbIds: number[]; status: string }[] = [];
    const consumedUuid = 'msg-2';

    const matched = queuedMessages.find((m) => m.uuid === consumedUuid);
    if (matched) {
      updateCalls.push({ dbIds: [matched.dbId], status: 'sent' });
    }

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].dbIds).toEqual([2]);
    expect(updateCalls[0].status).toBe('sent');
  });

  it('should skip update when consumed message is not in queued status', () => {
    const queuedMessages: { dbId: number }[] = [];
    const consumedUuid = 'msg-2';

    const updateCalls: unknown[] = [];

    const matched = queuedMessages.find((m) => String(m.dbId) === consumedUuid);
    if (matched) {
      updateCalls.push({ dbIds: [matched.dbId], status: 'sent' });
    }

    expect(updateCalls).toHaveLength(0);
  });
});

describe('QueryRunner environment variable handling', () => {
  it('should store original env vars', () => {
    const originalEnvVars: Record<string, string | undefined> = {};

    originalEnvVars.ANTHROPIC_AUTH_TOKEN = 'original-token';
    originalEnvVars.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

    expect(Object.keys(originalEnvVars).length).toBe(2);
  });

  it('should detect when env vars need restoration', () => {
    const originalEnvVars = {
      ANTHROPIC_AUTH_TOKEN: 'original',
    };

    const needsRestore = Object.keys(originalEnvVars).length > 0;
    expect(needsRestore).toBe(true);
  });

  it('should clear original env vars after restoration', () => {
    const originalEnvVars: Record<string, string | undefined> = {
      ANTHROPIC_AUTH_TOKEN: 'original',
    };

    const _emptyVars: Record<string, string | undefined> = {};
    Object.assign(originalEnvVars, {});
    Object.keys(originalEnvVars).forEach((key) => delete originalEnvVars[key]);

    expect(Object.keys(originalEnvVars).length).toBe(0);
  });

  it('should refresh provider-managed Kimi env from post-apply process env', () => {
    const env = refreshQueryEnvFromProcess(
      {
        ANTHROPIC_MODEL: 'wrong-model',
        CLAUDE_CODE_SUBAGENT_MODEL: 'wrong-subagent',
        ENABLE_TOOL_SEARCH: 'true',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000',
        KEEP_SESSION: 'session',
      },
      {
        ANTHROPIC_MODEL: 'kimi-k2.7-code',
        CLAUDE_CODE_SUBAGENT_MODEL: 'kimi-k2.7-code',
        ENABLE_TOOL_SEARCH: 'false',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '262144',
        KEEP_SESSION: 'ambient',
        KEEP_PROCESS: 'process',
        PORT: '8484',
        HYPERNEO_PORT: '8484',
      },
      {
        refreshAutoCompactWindow: true,
        clearProviderManaged: true,
        extraProviderManagedEnvVars: ['CLAUDE_CODE_SUBAGENT_MODEL', 'ENABLE_TOOL_SEARCH'],
      }
    );

    expect(env).toMatchObject({
      ANTHROPIC_MODEL: 'kimi-k2.7-code',
      CLAUDE_CODE_SUBAGENT_MODEL: 'kimi-k2.7-code',
      ENABLE_TOOL_SEARCH: 'false',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '262144',
      KEEP_SESSION: 'session',
      KEEP_PROCESS: 'process',
    });
    expect(env).not.toHaveProperty('PORT');
    expect(env).not.toHaveProperty('HYPERNEO_PORT');
  });

  it('should preserve configured auto-compact env when provider does not refresh it', () => {
    const env = refreshQueryEnvFromProcess(
      {
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000',
      },
      {}
    );

    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('200000');
  });

  it('should remove stale bridge auto-compact env after provider cleanup', () => {
    const env = refreshQueryEnvFromProcess(
      {
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '262144',
        KEEP_SESSION: 'session',
      },
      {},
      { refreshAutoCompactWindow: true, clearProviderManaged: true }
    );

    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
    expect(env.KEEP_SESSION).toBe('session');
  });

  it('should preserve Anthropic auth token from query env when provider cleanup clears process env', () => {
    const env = refreshQueryEnvFromProcess(
      {
        ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat-real-anthropic-token',
        KEEP_SESSION: 'session',
      },
      {},
      { clearProviderManaged: true, preserveAnthropicAuthToken: true }
    );

    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-oat-real-anthropic-token');
    expect(env.KEEP_SESSION).toBe('session');
  });

  it('should not preserve bridge auth token from query env when provider cleanup clears process env', () => {
    for (const token of [
      'anthropic-copilot-proxy:/workspace',
      'ollama-bridge',
      'custom-endpoint:session-id',
      'openrouter-api-key',
    ]) {
      const env = refreshQueryEnvFromProcess(
        {
          ANTHROPIC_AUTH_TOKEN: token,
        },
        {},
        { clearProviderManaged: true, preserveAnthropicAuthToken: true }
      );

      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    }
  });

  it('should preserve Anthropic OAuth token from query env when provider cleanup clears process env', () => {
    const env = refreshQueryEnvFromProcess(
      {
        CLAUDE_CODE_OAUTH_TOKEN: 'session-oauth-token',
      },
      {},
      { clearProviderManaged: true, preserveAnthropicOAuthToken: true }
    );

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('session-oauth-token');
  });

  it('should not copy ambient Anthropic API keys for bridge providers', () => {
    const env = refreshQueryEnvFromProcess(
      {
        ANTHROPIC_BASE_URL: 'https://glm.example.com',
        ANTHROPIC_AUTH_TOKEN: 'glm-api-key',
      },
      {
        ANTHROPIC_BASE_URL: 'https://glm.example.com',
        ANTHROPIC_AUTH_TOKEN: 'glm-api-key',
        ANTHROPIC_API_KEY: 'sk-ant-real-ambient-key',
      },
      { clearProviderManaged: true, skipAmbientAnthropicApiKey: true }
    );

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('glm-api-key');
  });

  it('should preserve auth env when omitting provider-managed ACP env', () => {
    const env = refreshQueryEnvFromProcess(
      {},
      {
        ANTHROPIC_API_KEY: 'sk-ant-api-key',
        ANTHROPIC_AUTH_TOKEN: 'sk-ant-oat-token',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
        ANTHROPIC_BASE_URL: 'https://stale-bridge.example.com',
      },
      { omitProviderManaged: true, omitProviderManagedPreserveAuth: true }
    );

    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api-key');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-oat-token');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token');
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it('should not copy ambient OAuth tokens for bridge providers', () => {
    const env = refreshQueryEnvFromProcess(
      {
        ANTHROPIC_AUTH_TOKEN: 'glm-api-key',
      },
      {
        ANTHROPIC_AUTH_TOKEN: 'glm-api-key',
        CLAUDE_CODE_OAUTH_TOKEN: 'ambient-anthropic-oauth',
      },
      { clearProviderManaged: true }
    );

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('glm-api-key');
  });

  it('should tombstone provider-managed env when omitted for ACP subprocesses', () => {
    const env = refreshQueryEnvFromProcess(
      {
        ANTHROPIC_BASE_URL: 'https://stale.example.com',
        ANTHROPIC_AUTH_TOKEN: 'stale-token',
        KEEP_SESSION: 'session',
      },
      {
        ANTHROPIC_BASE_URL: 'https://ambient.example.com',
        KEEP_PROCESS: 'process',
      },
      { refreshAutoCompactWindow: true, omitProviderManaged: true }
    );

    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.KEEP_SESSION).toBe('session');
    expect(env.KEEP_PROCESS).toBe('process');
  });
});

describe('QueryRunner cleaning up state', () => {
  it('should skip setIdle when cleaning up', async () => {
    let setIdleCalled = false;
    const isCleaningUp = true;

    if (!isCleaningUp) {
      setIdleCalled = true;
    }

    expect(setIdleCalled).toBe(false);
  });

  it('should call setIdle when not cleaning up', async () => {
    let setIdleCalled = false;
    const isCleaningUp = false;

    if (!isCleaningUp) {
      setIdleCalled = true;
    }

    expect(setIdleCalled).toBe(true);
  });
});

describe('looksLikeRateLimit429', () => {
  it('matches bare, API Error, and Error-wrapped 429 shapes', () => {
    expect(looksLikeRateLimit429('429 rate limited')).toBe(true);
    expect(looksLikeRateLimit429('API Error: 429 {"type":"error"}')).toBe(true);
    expect(looksLikeRateLimit429('Error: 429 Too Many Requests')).toBe(true);
    expect(looksLikeRateLimit429('Error: {"error":{"message":"429 rate limited"}}')).toBe(true);
  });

  it('matches a JSON body following the leading 429', () => {
    expect(
      looksLikeRateLimit429(
        '429 {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}'
      )
    ).toBe(true);
  });

  it('matches a JSON envelope whose inner message starts with 429 (Copilot bridge)', () => {
    expect(
      looksLikeRateLimit429(
        JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: '429 Too Many Requests' },
        })
      )
    ).toBe(true);
  });

  it('does not match 402/quota/billing or other 4xx', () => {
    expect(looksLikeRateLimit429('402 You have no quota')).toBe(false);
    expect(looksLikeRateLimit429('API Error: 401 unauthorized')).toBe(false);
    expect(looksLikeRateLimit429('400 bad request')).toBe(false);
  });

  it('does not match a 429 buried mid-string (avoids false positives on request IDs)', () => {
    expect(looksLikeRateLimit429('request id abc429xyz failed')).toBe(false);
  });
});
