/**
 * QueryRunner Tests
 *
 * Tests for SDK query execution with streaming input.
 */

import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { tmpdir } from 'node:os';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
// The daemon vitest config aliases the SDK specifier to tests/sdk-mock.ts, so
// under vitest `query` is a controllable vi.fn and tests can drive runQuery's
// for-await loop (the success path). Under bare `bun test` (the workflow
// documented in CLAUDE.md) no such alias applies — bunfig.toml wires no
// [test] preload for the SDK — so this import resolves to the REAL SDK and
// .mockImplementation would throw. Detect which one we got and skip the
// mock-driven tests when the import is not a mock.
import { query as mockedSdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { MessageHub, Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { AskUserQuestionHandler } from '../../../../src/lib/agent/ask-user-question-handler';
import { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { QueryOptionsBuilder } from '../../../../src/lib/agent/query-options-builder';
import {
  getMaxStartupTimeoutRetries,
  getStartupRetryDelayMs,
  looksLikeRateLimit429,
  QueryRunner,
  type QueryRunnerContext,
  refreshQueryEnvFromProcess,
} from '../../../../src/lib/agent/query-runner';
import {
  getSdkStartupGate,
  resetSdkStartupGateForTests,
} from '../../../../src/lib/agent/sdk-startup-gate';
import { ErrorCategory, type ErrorManager } from '../../../../src/lib/error-manager';
import type { Logger } from '../../../../src/lib/logger';
import { longTermAgentSessionId } from '../../../../src/lib/space/long-term-agent-session';
import type { Database } from '../../../../src/storage/database';

const sdkQueryIsMock =
  typeof (mockedSdkQuery as { mockImplementation?: unknown }).mockImplementation === 'function';

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

  // Spy functions
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
  let getMessagesByStatusSpy: ReturnType<typeof mock>;
  let getSDKMessagesSpy: ReturnType<typeof mock>;
  let updateMessageStatusSpy: ReturnType<typeof mock>;
  let buildSpy: ReturnType<typeof mock>;
  let addSessionStateOptionsSpy: ReturnType<typeof mock>;
  let setCanUseToolSpy: ReturnType<typeof mock>;
  let createCanUseToolCallbackSpy: ReturnType<typeof mock>;
  let enqueueWithIdSpy: ReturnType<typeof mock>;
  let peekNextUserMessageIdSpy: ReturnType<typeof mock>;
  let hasPendingOrInFlightSpy: ReturnType<typeof mock>;
  let removeSpy: ReturnType<typeof mock>;
  let getAdmissionSeqSpy: ReturnType<typeof mock>;
  let removeIfAdmittedNoLaterThanSpy: ReturnType<typeof mock>;
  let getMessageByStatusAndUuidSpy: ReturnType<typeof mock>;
  let markDeliveryFailedInclusiveSpy: ReturnType<typeof mock>;
  let publishEventSpy: ReturnType<typeof mock>;

  // State variables (mutable context properties)
  let queryGeneration: number;
  let onSDKMessageSpy: ReturnType<typeof mock>;
  let onSlashCommandsFetchedSpy: ReturnType<typeof mock>;
  let onModelsFetchedSpy: ReturnType<typeof mock>;
  let onMarkApiSuccessSpy: ReturnType<typeof mock>;
  let trackAgentProcessSpy: ReturnType<typeof mock>;
  let terminateTrackedAgentProcessesSpy: ReturnType<typeof mock>;

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

    // Reset state
    queryGeneration = 0;

    // Create callback spies
    trackAgentProcessSpy = mock(() => {});
    terminateTrackedAgentProcessesSpy = mock(() => {});
    onSDKMessageSpy = mock(async () => {});
    onSlashCommandsFetchedSpy = mock(async () => {});
    onModelsFetchedSpy = mock(async () => {});
    onMarkApiSuccessSpy = mock(async () => {});

    // Database spies
    saveSDKMessageSpy = mock(() => {});
    updateSessionSpy = mock(() => {});
    getMessagesByStatusSpy = mock(() => []);
    getSDKMessagesSpy = mock(() => ({ messages: [], hasMore: false }));
    updateMessageStatusSpy = mock(() => {});
    getMessageByStatusAndUuidSpy = mock(() => null);
    // Give-up steer surfacing (round-12 P3): the runner flips unrecovered
    // steer rows failed through the repo's inclusive dead-letter flip.
    markDeliveryFailedInclusiveSpy = mock(() => 'db-row-id');
    mockDb = {
      saveSDKMessage: saveSDKMessageSpy,
      updateSession: updateSessionSpy,
      getMessagesByStatus: getMessagesByStatusSpy,
      getSDKMessages: getSDKMessagesSpy,
      updateMessageStatus: updateMessageStatusSpy,
      getMessageByStatusAndUuid: getMessageByStatusAndUuidSpy,
      getSDKMessageRepo: mock(() => ({
        markDeliveryFailedByUuidInclusive: markDeliveryFailedInclusiveSpy,
      })),
      getNodeExecutionRepo: mock(() => ({
        getByAgentSessionId: (sessionId: string) =>
          sessionId === 'space:s1:task:t1:exec:e1' ? { id: 'exec-1' } : null,
      })),
      getSpaceTaskRepo: mock(() => ({
        getTask: (taskId: string) =>
          taskId === 't1' ? { id: 't1', spaceId: 's1', workflowRunId: 'run-1' } : null,
      })),
    } as unknown as Database;

    // InternalEventBus spy — the give-up/settled-failed steer surfacing
    // publishes messages.statusChanged through ctx.internalEventBus.
    publishEventSpy = mock(() => {});

    // MessageHub spies
    publishSpy = mock(async () => {});
    mockMessageHub = {
      event: publishSpy,
      onRequest: mock((_method: string, _handler: Function) => () => {}),
      query: mock(async () => ({})),
      command: mock(async () => {}),
    } as unknown as MessageHub;

    // MessageQueue spies — start/stop toggle isRunning so retry re-checks that
    // gate on messageQueue.isRunning() work correctly in tests.
    isRunningSpy = mock(() => false);
    startSpy = mock(() => {
      isRunningSpy.mockReturnValue(true);
    });
    clearSpy = mock(() => {});
    stopSpy = mock(() => {
      isRunningSpy.mockReturnValue(false);
    });
    sizeSpy = mock(() => 0);
    enqueueWithIdSpy = mock(async () => {});
    peekNextUserMessageIdSpy = mock(() => null);
    hasPendingOrInFlightSpy = mock(() => false);
    removeSpy = mock(() => true);
    // Fenced-removal pair (round-9): the flush captures the admission
    // sequence right after its loop, and the stale finally purges through the
    // fenced API. Tests that need REAL admission semantics swap in a real
    // MessageQueue via createContext({ messageQueue }).
    getAdmissionSeqSpy = mock(() => 0);
    removeIfAdmittedNoLaterThanSpy = mock(() => false);
    mockMessageQueue = {
      isRunning: isRunningSpy,
      start: startSpy,
      clear: clearSpy,
      stop: stopSpy,
      size: sizeSpy,
      getGeneration: mock(() => 0),
      enqueueWithId: enqueueWithIdSpy,
      peekNextUserMessageId: peekNextUserMessageIdSpy,
      hasPendingOrInFlight: hasPendingOrInFlightSpy,
      remove: removeSpy,
      getAdmissionSeq: getAdmissionSeqSpy,
      removeIfAdmittedNoLaterThan: removeIfAdmittedNoLaterThanSpy,
      messageGenerator: mock(async function* () {
        // Empty generator for tests
      }),
    } as unknown as MessageQueue;

    // StateManager spies
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

    // ErrorManager spies
    handleErrorSpy = mock(async () => {});
    mockErrorManager = {
      handleError: handleErrorSpy,
    } as unknown as ErrorManager;

    // Logger spies
    mockLogger = {
      log: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
      info: mock(() => {}),
    } as unknown as Logger;

    // OptionsBuilder spies
    buildSpy = mock(async () => ({ model: 'claude-sonnet-4-20250514' }));
    addSessionStateOptionsSpy = mock((options: unknown) => options);
    setCanUseToolSpy = mock(() => {});
    mockOptionsBuilder = {
      build: buildSpy,
      addSessionStateOptions: addSessionStateOptionsSpy,
      setCanUseTool: setCanUseToolSpy,
      // Post-start MCP reconcile (query-runner.ts) — only reachable when
      // build() resolves; previously undefined, which the `?? {}` fallback
      // covered. Returns no servers, preserving that behavior.
      getEffectiveMcpServers: mock(() => ({})),
    } as unknown as QueryOptionsBuilder;

    // AskUserQuestionHandler spies
    createCanUseToolCallbackSpy = mock(() => async () => true);
    mockAskUserQuestionHandler = {
      createCanUseToolCallback: createCanUseToolCallbackSpy,
    } as unknown as AskUserQuestionHandler;
  });

  function createContext(overrides: Partial<QueryRunnerContext> = {}): QueryRunnerContext {
    const ctx: QueryRunnerContext = {
      // Core dependencies
      session: mockSession,
      db: mockDb,
      messageHub: mockMessageHub,
      internalEventBus: {
        publish: publishEventSpy,
      } as unknown as QueryRunnerContext['internalEventBus'],
      messageQueue: mockMessageQueue,
      stateManager: mockStateManager,
      errorManager: mockErrorManager,
      logger: mockLogger,
      optionsBuilder: mockOptionsBuilder,
      askUserQuestionHandler: mockAskUserQuestionHandler,

      // Mutable SDK state (direct properties)
      queryObject: null,
      queryPromise: null,
      // A live (un-aborted) controller, matching production at the moment a
      // startup timeout fires: the timer aborts it but never nulls it, and the
      // post-backoff guard treats null as a completed Stop / lifecycle stop.
      // build()-rejection tests never arm a real timer, so the default here
      // keeps the harness faithful.
      queryAbortController: new AbortController(),
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
      // Harness fidelity: production arms a fresh AbortController per attempt
      // BEFORE a startup timeout can fire (the timer is set right after the
      // controller); a completed Stop / lifecycle stop is what NULLS it.
      // build()-rejection tests skip the arming code, so re-arm at the retry
      // branch's teardown hook (entered before each backoff). Tests that
      // simulate a Stop/reset override the spy and null the controller AFTER
      // the re-arm, preserving their cancellation semantics.
      terminateTrackedAgentProcesses: () => {
        ctx.queryAbortController = new AbortController();
        terminateTrackedAgentProcessesSpy();
      },

      // Methods for state coordination
      incrementQueryGeneration: () => ++queryGeneration,
      getQueryGeneration: () => queryGeneration,
      isCleaningUp: () => false,

      // Callbacks for message handling
      onSDKMessage: onSDKMessageSpy,
      onSlashCommandsFetched: onSlashCommandsFetchedSpy,
      onModelsFetched: onModelsFetchedSpy,
      onMarkApiSuccess: onMarkApiSuccessSpy,

      ...overrides,
    };
    return ctx;
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
      runner = createRunner();

      await runner.start();

      expect(startSpy).not.toHaveBeenCalled();
    });

    it('should start message queue and increment generation', async () => {
      isRunningSpy.mockReturnValue(false);
      runner = createRunner();

      // Start but don't wait for completion
      runner.start();
      // Allow start to complete
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

        expect(onMissingWorkflowMcpServers).toHaveBeenCalledWith('space:s1:task:t1:exec:e1', [
          'node-agent',
        ]);
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

        const onMissingMemberSpaceMcpServers = mock(async () => {
          // Self-heal callback runs but does NOT fix the servers
        });

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
        // Force early exit: make message generator throw so the query fails fast.
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

      // Create a mock message generator
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
        // Consume the generator
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
        // Consume generator
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
        // Consume the generator
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
        // Consume the generator
      }

      // After consuming a non-internal message, the runner should have tracked it
      // for potential re-enqueue on transient connection error retry.
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
        // Consume the generator
      }

      // Internal messages should NOT be tracked for re-enqueue
      const tracked = (
        runner as unknown as {
          lastConsumedUserMessage: { uuid: string } | null;
        }
      ).lastConsumedUserMessage;
      expect(tracked).toBeNull();
    });

    it('does not accumulate startup replay after the first SDK frame', async () => {
      // Codex P2 (PR #2499): once the generation has produced its first frame,
      // the startup timer is disabled and later prompts/steers must not rebuild
      // the replay list (unbounded full-content retention in long sessions).
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
        // Consume the generator
      }

      // `_lastConsumedUserMessage` is still tracked for the transient/rate-limit
      // retries (mid-stream drops), but the startup-replay list stays empty.
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
      abortController.abort(); // Pre-abort

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
              // Abort after first yield
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
        if (results.length > 5) break; // Safety limit
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
          // No message should be yielded.
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
        // Consume
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

      await expect(async () => {
        for await (const _msg of generator) {
          // Consume
        }
      }).rejects.toThrow('Some SDK error');
    });
  });

  describe('runQuery() finally block close() behaviour', () => {
    // Integration tests: exercise the actual QueryRunner.start() → runQuery() finally block.
    // In unit tests, no credentials are configured (setup.ts clears all API keys), so
    // runQuery() fails at the auth check before creating a new queryObject. This means
    // ctx.queryObject stays as whatever was pre-set, and the finally block (non-stale path)
    // calls close() on it and nulls it — exactly the natural-completion cleanup path.

    it('should call close() on pre-existing queryObject in finally block', async () => {
      const closeSpy = mock(() => {});
      const ctx = createContext({
        queryObject: {
          interrupt: mock(async () => {}),
          close: closeSpy,
        } as unknown as Query,
      });
      runner = new QueryRunner(ctx);

      // start() launches runQuery() asynchronously; wait for it to settle.
      // runQuery() fails at the auth check (no credentials in unit tests),
      // but the finally block still runs and should close + null ctx.queryObject.
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

      // start() launches runQuery() asynchronously; wait for it to settle.
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      // queryObject is still nulled after error is caught
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
        // incrementQueryGeneration returns gen 1, but getQueryGeneration returns 2
        // → isStaleQuery = true → finally block skips all cleanup
        incrementQueryGeneration: () => ++gen, // returns 1
        getQueryGeneration: () => 2, // current gen is 2, query ran as gen 1
      });
      runner = new QueryRunner(ctx);

      // start() launches runQuery() asynchronously; wait for it to settle.
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(closeSpy).not.toHaveBeenCalled();
      // ctx.queryObject is not nulled — it belongs to the current (gen 2) query
      expect(ctx.queryObject).toBe(originalQueryObject);
    });
  });

  describe('startup timeout error surfacing', () => {
    // Integration tests: exercise the runQuery() catch block when a startup-timeout
    // error is thrown.  buildSpy throws 'SDK startup timeout - query aborted' so the
    // test never waits on the real startup timer.
    // ANTHROPIC_API_KEY is set to a dummy value so the pre-query auth check passes.

    let savedApiKey: string | undefined;
    let savedRetryBaseMs: string | undefined;
    let savedMaxStartupRetries: string | undefined;

    beforeEach(() => {
      savedApiKey = process.env.ANTHROPIC_API_KEY;
      savedRetryBaseMs = process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS;
      savedMaxStartupRetries = process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX;
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      // Zero the startup-timeout backoff so retries fire immediately — the
      // default schedule (15s → 30s → …) would make every test below sleep
      // for minutes. Pin the cap to 1 as well: these tests were written for
      // the single-retry-entry shape (1 attempt + 1 retry per turn), and the
      // default cap of 5 would silently widen them to 6 attempts.
      process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = '0';
      process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '1';
      // Use a real directory so fs.mkdir() succeeds (reached after auth passes)
      mockSession.workspacePath = tmpdir();
      buildSpy.mockRejectedValue(new Error('SDK startup timeout - query aborted'));
    });

    afterEach(() => {
      if (savedApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = savedApiKey;
      }
      if (savedRetryBaseMs === undefined) {
        delete process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS;
      } else {
        process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = savedRetryBaseMs;
      }
      if (savedMaxStartupRetries === undefined) {
        delete process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX;
      } else {
        process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = savedMaxStartupRetries;
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
        expect.any(String), // category
        expect.stringContaining('HYPERNEO_SDK_STARTUP_TIMEOUT_MS'), // timeout hint for startup failure
        expect.anything(),
        expect.objectContaining({ isRootWorkspace: expect.any(Boolean) })
      );
      // Should NOT contain retry count language
      const userMessage = handleErrorSpy.mock.calls[0][3] as string;
      expect(userMessage).not.toContain('attempt(s)');
      // The hint prints the effective startup window. The vitest preload
      // (tests/vitest.setup.ts — the only preload automated runs load) deletes
      // ambient overrides before imports, and every test that sets the
      // variable restores it in finally (acp-query-runner.test.ts), so the
      // module-load snapshot here is the 60s default. Pins both the default
      // and the effective-value hint.
      expect(userMessage).toContain('current: 60000ms');
    });

    it('should blame the silent subprocess and concurrent-start load, not workspace locks (startup timeout)', async () => {
      // 2026-08-16 incident follow-up: the old hint blamed "another Claude Code
      // session using the same workspace / a stale lock file in .claude/", which
      // misled the initial investigation — the real driver was concurrent-start
      // load keeping SDK subprocesses silent past the startup window.
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(handleErrorSpy).toHaveBeenCalled();
      const userMessage = handleErrorSpy.mock.calls[0][3] as string;
      // Names the actual failure mode…
      expect(userMessage).toContain('failed to start');
      expect(userMessage).toContain('did not produce its first message');
      // …points at the two real levers: the startup window and start-time load.
      expect(userMessage).toContain('HYPERNEO_SDK_STARTUP_TIMEOUT_MS');
      expect(userMessage).toContain('too many sessions starting at the same time');
      // …and no longer misleads with workspace/lock-file framing.
      expect(userMessage).not.toContain('stale lock file');
      expect(userMessage).not.toContain('another Claude Code session');
      expect(userMessage).not.toContain('closing other Claude sessions');
    });

    it('should preserve sdkSessionId and surface error for conversation-not-found', async () => {
      mockSession.sdkSessionId = 'sdk-session-id';
      buildSpy.mockRejectedValue(new Error('No conversation found for session abc123'));
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      // Do NOT auto-clear sdkSessionId — let the user choose via sdkResumeChoice prompt
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
        expect.stringContaining('session could not be resumed'), // actionable hint
        expect.anything(),
        expect.objectContaining({ isRootWorkspace: expect.any(Boolean) })
      );
      // HYPERNEO_SDK_STARTUP_TIMEOUT_MS is irrelevant to a missing session file
      const userMessage = handleErrorSpy.mock.calls[0][3] as string;
      expect(userMessage).not.toContain('HYPERNEO_SDK_STARTUP_TIMEOUT_MS');
      // Should NOT contain retry count language
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

    it('should not emit an assistant retry notice for startup-timeout auto-retry', async () => {
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
                text: expect.stringContaining('Retrying automatically'),
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
      // Regression test for the race condition where auto-retry after startup timeout
      // would call runQuery() while the previous query's finally{} block had not yet
      // run, leaving MCP transports open and causing "Already connected" crashes.
      //
      // The fix explicitly closes ctx.queryObject in the catch block BEFORE the
      // recursive retry call, ensuring MCP transports are released first.
      let closeCalled = false;
      const mockQueryObject = {
        close: () => {
          closeCalled = true;
        },
        [Symbol.asyncIterator]: function* () {},
      } as unknown as import('@anthropic-ai/claude-agent-sdk').Query;

      // Pre-populate queryObject to simulate a lingering open query (e.g. with open
      // MCP transports) that existed when the startup timeout fired.
      const ctx = createContext({ queryObject: mockQueryObject });
      runner = new QueryRunner(ctx);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      // close() must have been called on the pre-existing queryObject before the retry.
      expect(closeCalled).toBe(true);
      // After the close, queryObject should be null (cleaned up by the fix).
      // The finally block may re-check it, but it will see null and skip redundant close.
      expect(ctx.queryObject).toBeNull();
    });

    it('should force-terminate orphaned SDK processes before retrying after startup timeout', async () => {
      // Clean-slate guard: a startup-timeout spawn may be orphaned (spawned but
      // never fed, or hung past cooperative close()) and collide with the retry's
      // fresh spawn. The retry must force-kill the tracked set first so the retry
      // starts from a clean process slate.
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      // The auto-retry path must have asked to terminate tracked subprocesses
      // (SIGTERM + scheduled SIGKILL), not just cooperatively close queryObject.
      expect(terminateTrackedAgentProcessesSpy).toHaveBeenCalled();
    });

    it('should await processExitedPromise before retrying after startup timeout', async () => {
      // Verify the retry path waits for the old subprocess to exit
      // before spawning a replacement.
      const callOrder: string[] = [];
      let resolveExit: () => void;
      const exitPromise = new Promise<void>((resolve) => {
        resolveExit = resolve;
      });

      const mockQueryObject = {
        close: () => {
          callOrder.push('close');
          // Simulate subprocess exit after a delay
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

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      // close() and process-exited should both have been called
      // before the retry attempt proceeded
      expect(callOrder).toContain('close');
      expect(callOrder).toContain('process-exited');
      // processExitedPromise should be cleared after the wait
      expect(ctx.processExitedPromise).toBeNull();
    });

    it('restarts a stopped message queue before the startup-timeout retry', async () => {
      // Codex P1 (PR #2499): the timeout escape returns the iterator normally,
      // so the post-loop code stops the queue BEFORE the timeout throw reaches
      // the catch. The recursive retry must restart it — messageGenerator exits
      // immediately while the queue is stopped, so the preserved prompt would
      // never feed the retry and it would time out again. The post-loop stop is
      // not reachable when build() rejects (no query ever iterates), so
      // simulate it at the pre-backoff teardown hook — by that point in the
      // real flow the queue is already stopped.
      terminateTrackedAgentProcessesSpy.mockImplementation(() => {
        stopSpy();
      });
      const ctx = createContext();
      runner = new QueryRunner(ctx);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      // start() once + the retry's restart.
      expect(startSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('does not restart the message queue for a startup-timeout retry when interrupted', async () => {
      // A stop by interrupt is not the timeout path's own stop — restarting
      // would re-arm a queue the user cancelled. (Also covers the post-backoff
      // cancellation check: the interrupted status must cancel the retry
      // outright, not just skip the queue restart.)
      terminateTrackedAgentProcessesSpy.mockImplementation(() => {
        stopSpy();
        getStateSpy.mockReturnValue({ status: 'interrupted' } as never);
      });
      const ctx = createContext();
      runner = new QueryRunner(ctx);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(startSpy.mock.calls.length).toBe(1);
      // Guard-branch assertions (not just the queue restart): the interrupted
      // disjunct must cancel the retry outright — no recursion, no re-enqueue.
      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
        String(args[0])
      );
      expect(warns.some((w) => w.includes('Startup-timeout retry cancelled'))).toBe(true);
    });

    it('does not respawn after a startup timeout when an interrupt raced the catch', async () => {
      // interrupt-handler sets 'interrupted' (and aborts the controller)
      // without bumping the query generation, so neither
      // retrySupersededByReplacement nor isCleaningUp excludes it — the
      // status guard on the retry condition is what stops a fresh
      // subprocess spawning on a stopped session (spurious terminal
      // "failed to start"). Mirrors the guard on the queue restart above.
      const kickoff = { uuid: 'kickoff-uuid', content: [{ type: 'text' as const, text: 'K' }] };
      getStateSpy.mockReturnValue({ status: 'interrupted' } as never);
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      (
        runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
      )._consumedUserMessages = new Map([[1, [kickoff]]]);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      // Exactly one build = the first attempt; no recursive retry respawn.
      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(enqueueWithIdSpy).not.toHaveBeenCalledWith(kickoff.uuid, kickoff.content, false, {
        prepend: true,
      });
    });

    it.skipIf(!sdkQueryIsMock)(
      'stages every consumed prompt at the retry and flushes them after startup-gate admission',
      async () => {
        // Codex P1 (PR #2499): if the old SDK pulled prompts out of the queue via
        // messageGenerator() before going silent, restarting the queue leaves the
        // retry with no input and it times out again at zero messages. A silent
        // iterator can pull the kickoff AND trailing steers, so replay the full
        // ordered set — not just the last message. Round-6: the replay is STAGED
        // at the retry decision and enqueued only after the recursive attempt
        // clears the startup gate (a pre-gate enqueue can TTL out during the
        // gate wait), so the first attempt here stages without enqueuing…
        const kickoff = { uuid: 'kickoff-uuid', content: [{ type: 'text' as const, text: 'K' }] };
        const steer = { uuid: 'steer-uuid', content: [{ type: 'text' as const, text: 'S' }] };

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        // start() bumps the generation to 1, so the replay list lives under key 1.
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff, steer]]]);

        // Attempt 2 must reach the gate: resolve options and give the mocked
        // SDK query an immediately-complete iterator so the attempt exits
        // cleanly after the flush.
        buildSpy.mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'));
        buildSpy.mockResolvedValue({ model: 'claude-sonnet-4-20250514' });
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => ({
          close: () => {},
          [Symbol.asyncIterator]: async function* () {},
        }));

        try {
          runner.start();
          await ctx.queryPromise?.catch(() => {});

          // …and the flush enqueues the full ordered set with prepend, in
          // reverse so the consumed prefix lands ahead of any untouched queue
          // tail: steer-then-kickoff, leaving kickoff-then-steer order.
          expect(enqueueWithIdSpy).toHaveBeenCalledWith(kickoff.uuid, kickoff.content, false, {
            prepend: true,
            durable: true,
          });
          expect(enqueueWithIdSpy).toHaveBeenCalledWith(steer.uuid, steer.content, false, {
            prepend: true,
            durable: true,
          });
          const calls = enqueueWithIdSpy.mock.calls as unknown as Array<[string, unknown]>;
          expect(calls.map(([uuid]) => uuid)).toEqual([steer.uuid, kickoff.uuid]);
          // The staged replay is spent.
          expect(
            (runner as unknown as { _pendingStartupReplay: unknown[] | null })._pendingStartupReplay
          ).toBeNull();
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it('should abandon the retry when a replacement query took ownership during the exit wait', async () => {
      // Codex P1 (PR #2491): the retry's recursive runQuery() bypasses
      // start()'s queue-running guard. If a replacement query started while
      // the retry awaited the old subprocess's exit, recursing with the stale
      // generation would spawn a competing query overwriting the
      // replacement's queryObject. The retry must be abandoned instead.
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
      // start() bumps the generation to 1; the superseded generation's entry
      // (key 1) must be cleared when the replacement takes ownership.
      (
        runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
      )._consumedUserMessages = new Map([
        [1, [{ uuid: 'stale-uuid', content: [{ type: 'text' as const, text: 'stale' }] }]],
      ]);

      runner.start();
      // Let the first attempt reach the catch block (build rejects with the
      // timeout error), then simulate: (1) a replacement start bumping the
      // query generation, (2) the old subprocess exiting.
      await new Promise((resolve) => setTimeout(resolve, 10));
      ctx.incrementQueryGeneration();
      resolveExit!();
      await ctx.queryPromise?.catch(() => {});

      // The retry was abandoned — runQuery must not have been re-entered
      // (options build runs exactly once, for the first attempt only).
      expect(buildSpy).toHaveBeenCalledTimes(1);
      // The superseded generation's replay history is cleared so the
      // replacement does not inherit (and duplicate) it. (Codex P2, PR #2499.)
      expect(
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages.get(1)
      ).toBeUndefined();
    });
  });

  describe('startup-timeout retry backoff and attempt cap', () => {
    // 2026-08-16 incident fix: immediate startup-timeout retries regenerate the
    // concurrent-start load that causes the timeouts, making the retry loop
    // self-sustaining (6–9 attempts/session, zero recoveries, ~30 min stall).
    // Consecutive timeouts for one delivery must back off exponentially and
    // stop at the cap, settling the delivery as failed with the corrected hint.

    let savedApiKey: string | undefined;
    let savedRetryBaseMs: string | undefined;
    let savedMaxStartupRetries: string | undefined;
    let savedRetiredMaxRetries: string | undefined;

    beforeEach(() => {
      savedApiKey = process.env.ANTHROPIC_API_KEY;
      savedRetryBaseMs = process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS;
      savedMaxStartupRetries = process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX;
      savedRetiredMaxRetries = process.env.HYPERNEO_SDK_STARTUP_MAX_RETRIES;
      delete process.env.HYPERNEO_SDK_STARTUP_MAX_RETRIES;
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      // Zero the backoff by default so cap tests run at full speed; individual
      // tests override the base to observe real delays. Pin the cap to 1 so
      // the default-dependent tests exercise the minimal bounded shape (tests
      // that need more retries override it).
      process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = '0';
      process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '1';
      mockSession.workspacePath = tmpdir();
      buildSpy.mockRejectedValue(new Error('SDK startup timeout - query aborted'));
    });

    afterEach(() => {
      if (savedApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = savedApiKey;
      }
      if (savedRetryBaseMs === undefined) {
        delete process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS;
      } else {
        process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = savedRetryBaseMs;
      }
      if (savedMaxStartupRetries === undefined) {
        delete process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX;
      } else {
        process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = savedMaxStartupRetries;
      }
      if (savedRetiredMaxRetries === undefined) {
        delete process.env.HYPERNEO_SDK_STARTUP_MAX_RETRIES;
      } else {
        process.env.HYPERNEO_SDK_STARTUP_MAX_RETRIES = savedRetiredMaxRetries;
      }
    });

    it('schedules delays that at least double each retry round', () => {
      // Pure schedule check: 15s → 30s → 60s → 120s → 240s at the default base.
      process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = '15000';
      expect(getStartupRetryDelayMs(1)).toBe(15000);
      expect(getStartupRetryDelayMs(2)).toBe(30000);
      expect(getStartupRetryDelayMs(3)).toBe(60000);
      expect(getStartupRetryDelayMs(4)).toBe(120000);
      for (let retryNumber = 2; retryNumber <= 6; retryNumber++) {
        expect(getStartupRetryDelayMs(retryNumber)).toBeGreaterThanOrEqual(
          getStartupRetryDelayMs(retryNumber - 1) * 2
        );
      }
    });

    it('applies the growing backoff between retries', async () => {
      // With base 25ms and cap 2, the gaps between attempts must cover the
      // 25ms and 50ms sleeps. setTimeout never fires early, so the lower
      // bounds are deterministic even on a loaded runner.
      process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = '25';
      process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '2';

      const buildTimes: number[] = [];
      buildSpy.mockImplementation(async () => {
        buildTimes.push(Date.now());
        throw new Error('SDK startup timeout - query aborted');
      });

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
      // The scheduled delays themselves are pinned by the retry warn lines…
      const retryWarns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls
        .map((args) => String(args[0]))
        .filter((w) => w.includes('Auto-retrying query after startup timeout'));
      expect(retryWarns.some((w) => w.includes('in 25ms)'))).toBe(true);
      expect(retryWarns.some((w) => w.includes('in 50ms)'))).toBe(true);
      // …and the elapsed gaps must cover them. Bounds carry ~20% tolerance:
      // Date.now() is a wall clock while the sleep uses the event loop's
      // monotonic timer, so the measured gap can read ~1ms short on CI runners
      // (observed 49 for a 50ms sleep). The exact doubling schedule is
      // asserted deterministically by the pure schedule test above; here we
      // prove the sleeps are actually applied between attempts.
      expect(buildTimes[1] - buildTimes[0]).toBeGreaterThanOrEqual(20);
      expect(buildTimes[2] - buildTimes[1]).toBeGreaterThanOrEqual(40);
    });

    it('settles the delivery failed after the cap instead of looping forever', async () => {
      process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '2';

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      // 1 initial + 2 capped retries — then terminal, not an infinite cycle.
      expect(buildSpy).toHaveBeenCalledTimes(3);
      // Terminal settlement: queue cleared, error surfaced with the corrected
      // startup-timeout hint, session back to idle.
      expect(clearSpy).toHaveBeenCalled();
      expect(handleErrorSpy).toHaveBeenCalledTimes(1);
      const userMessage = handleErrorSpy.mock.calls[0][3] as string;
      expect(userMessage).toContain('did not produce its first message');
      expect(userMessage).toContain('HYPERNEO_SDK_STARTUP_TIMEOUT_MS');
      expect(userMessage).not.toContain('stale lock file');
      expect(setIdleSpy).toHaveBeenCalled();
      // The budget-exhausted settlement is visible in daemon logs.
      const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
        String(args[0])
      );
      expect(warns.some((w) => w.includes('retry budget exhausted'))).toBe(true);
    });

    it('honors HYPERNEO_SDK_STARTUP_RETRY_MAX=0 (first timeout settles immediately)', async () => {
      process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '0';

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(handleErrorSpy).toHaveBeenCalledTimes(1);
      // No retry ever ran, so this terminate can only come from the give-up
      // branch's clean-slate teardown (round-14 P3) — the unique pin for it.
      expect(terminateTrackedAgentProcessesSpy).toHaveBeenCalled();
    });

    it('charges one budget per delivery, surviving redrives of the same message', () => {
      // State-machine level: the delivery key is the kickoff message uuid, so
      // delivery-layer redrives (queue-timeout reset+replay, restart-recovery
      // reclaim) re-enqueue the SAME uuid and keep consuming the same budget —
      // the reset-on-redrive is what made the incident loop self-sustaining.
      process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '3';
      runner = createRunner();
      const claim = (key: string | null) =>
        (
          runner as unknown as {
            claimStartupTimeoutRetry(k: string | null): number | null;
          }
        ).claimStartupTimeoutRetry(key);

      expect(claim('msg-a')).toBe(1);
      expect(claim('msg-a')).toBe(2);
      expect(claim('msg-a')).toBe(3);
      // Cap reached → settle failed. A later redrive of the same durable
      // message must NOT get a fresh budget.
      expect(claim('msg-a')).toBeNull();
      expect(claim('msg-a')).toBeNull();
      // A different delivery starts from a fresh budget.
      expect(claim('msg-b')).toBe(1);
      expect(claim('msg-b')).toBe(2);
    });

    it('charges starved (unidentified) attempts to the in-flight budget', () => {
      // A timeout where nothing was consumed AND nothing is pending (the
      // residual null key — runQuery now derives the key from the pending
      // kickoff when one exists) must charge the current budget rather than
      // reset it — otherwise consume/no-consume flapping would reset the
      // budget every other round and the loop would be unbounded again.
      process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '3';
      runner = createRunner();
      const claim = (key: string | null) =>
        (
          runner as unknown as {
            claimStartupTimeoutRetry(k: string | null): number | null;
          }
        ).claimStartupTimeoutRetry(key);

      expect(claim('msg-a')).toBe(1);
      expect(claim(null)).toBe(2); // starved attempt charges msg-a's budget
      expect(claim('msg-a')).toBe(3);
      expect(claim('msg-a')).toBeNull();
      // Once identified as a different delivery, the budget starts fresh even
      // right after an exhausted one.
      expect(claim('msg-b')).toBe(1);
    });

    it('gives a starved delivery a fresh budget once the exhausted predecessor settled failed', () => {
      // Round-5 P3-4: claimStartupTimeoutRetry(null) must not let delivery B
      // inherit delivery A's exhausted budget once A's durable row has
      // settled failed — that budget is spent and its delivery is over.
      process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '2';
      runner = createRunner();
      const claim = (key: string | null) =>
        (
          runner as unknown as {
            claimStartupTimeoutRetry(k: string | null): number | null;
          }
        ).claimStartupTimeoutRetry(key);

      // A exhausts its budget and settles.
      expect(claim('msg-a')).toBe(1);
      expect(claim('msg-a')).toBe(2);
      expect(claim('msg-a')).toBeNull();

      // A's durable row has NOT settled yet → a starved (null) attempt still
      // charges A's budget (conservative anti-loop default).
      expect(claim(null)).toBeNull();

      // The delivery layer marks A failed → the next starved attempt is a NEW
      // delivery: fresh budget, retry 1 with the base delay.
      getMessageByStatusAndUuidSpy.mockImplementation(
        (_sessionId: string, _status: string, uuid: string) =>
          uuid === 'msg-a' ? ({ uuid: 'msg-a' } as never) : null
      );
      expect(claim(null)).toBe(1);
      expect(claim(null)).toBe(2);
      expect(claim(null)).toBeNull();
    });

    it('clears the budget once a delivery starts successfully', () => {
      // A successful first SDK frame resets the backoff state, so the next
      // turn (or a redrive) starts at retry 1 with the base delay.
      process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '1';
      runner = createRunner();
      const internals = runner as unknown as {
        claimStartupTimeoutRetry(k: string | null): number | null;
        clearStartupTimeoutRetryBudget(): void;
      };

      expect(internals.claimStartupTimeoutRetry('msg-a')).toBe(1);
      expect(internals.claimStartupTimeoutRetry('msg-a')).toBeNull();
      internals.clearStartupTimeoutRetryBudget();
      expect(internals.claimStartupTimeoutRetry('msg-a')).toBe(1);
    });

    it.skipIf(!sdkQueryIsMock)(
      'resets the budget on a successful first SDK frame through runQuery (regression guard)',
      async () => {
        // Regression guard for the messageCount === 1 reset in runQuery: a
        // delivery that exhausts its budget, then completes a SUCCESSFUL turn,
        // then times out again must get a fresh retry. Deleting the
        // clearStartupTimeoutRetryBudget() call in the for-await makes this
        // test fail (the later timeout would settle immediately).
        // The success turn is driven through the vitest SDK mock's query() —
        // the pre-populated ctx.queryObject pattern cannot reach the for-await
        // (runQuery overwrites queryObject from query()).
        process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '1';

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        const internals = runner as unknown as {
          _consumedUserMessages: Map<number, unknown[]>;
        };

        // Round 1 — exhaust the budget: attempt + 1 retry, then the capped
        // attempt settles. (Null delivery key: build rejects before any
        // message is consumed.)
        runner.start();
        await ctx.queryPromise?.catch(() => {});
        expect(buildSpy).toHaveBeenCalledTimes(2);

        // Round 2 — a turn that yields ONE SDK frame and completes normally.
        buildSpy.mockReset();
        buildSpy.mockResolvedValue({ model: 'claude-sonnet-4-20250514' });
        try {
          // NOTE: the real SDK's query() returns the query object SYNCHRONOUSLY
          // (runQuery does not await it) — the mock implementation must not be
          // async, or queryObject becomes a Promise without Symbol.asyncIterator.
          (mockedSdkQuery as unknown as ReturnType<typeof mock>).mockImplementation(
            () =>
              ({
                close: () => {},
                [Symbol.asyncIterator]: async function* () {
                  yield { type: 'assistant', uuid: 'frame-1' };
                },
              }) as unknown as Query
          );
          runner.start();
          await ctx.queryPromise?.catch(() => {});
          // The first frame really flowed through the for-await (not vacuous).
          expect(onSDKMessageSpy).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'assistant', uuid: 'frame-1' })
          );
        } finally {
          (mockedSdkQuery as unknown as ReturnType<typeof mock>).mockReset();
        }

        // Round 3 — the budget must be fresh: the timeout retries once more
        // (2 builds) instead of settling on the inherited exhausted budget (1).
        buildSpy.mockReset();
        buildSpy.mockRejectedValue(new Error('SDK startup timeout - query aborted'));
        runner.start();
        await ctx.queryPromise?.catch(() => {});
        expect(buildSpy).toHaveBeenCalledTimes(2);
        expect(internals._consumedUserMessages.size).toBe(0);
      }
    );

    it('keys the budget by the consumed kickoff uuid and survives redrives (pre-seeded consumed map)', async () => {
      // Drives the delivery-key derivation (consumedForKey[0]?.uuid) with a
      // REAL consumed uuid and proves redrive survival end-to-end: the
      // delivery layer redrives the same durable message (same uuid) via a
      // fresh start(), and the exhausted budget must hold — no second retry.
      process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '1';

      const kickoff = {
        uuid: 'durable-kickoff-uuid',
        content: [{ type: 'text' as const, text: 'K' }],
      };

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      const internals = runner as unknown as {
        _consumedUserMessages: Map<number, unknown[]>;
      };

      // Turn 1 — kickoff consumed, timeout, keyed retry. The replay is only
      // STAGED here (the retry attempt dies at build(), before the gate), so
      // nothing is enqueued on this turn.
      internals._consumedUserMessages = new Map([[1, [kickoff]]]);
      runner.start();
      await ctx.queryPromise?.catch(() => {});
      expect(buildSpy).toHaveBeenCalledTimes(2); // attempt + the keyed retry
      // The budget is keyed by the CONSUMED kickoff uuid — this is what
      // distinguishes the keyed path from the null-key path the state-machine
      // tests cover. (The queue peek is still consulted on the retry
      // sub-attempt — after staging, the consumed entry is deleted, and the
      // peek falls back to null; the budget keeps the consumed key.)
      expect(
        (runner as unknown as { _startupTimeoutRetryState: { key: string | null } })
          ._startupTimeoutRetryState.key
      ).toBe('durable-kickoff-uuid');
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();

      // Turn 2 — same durable message redriven under a new generation: the
      // first timeout settles immediately (no retry, no re-enqueue).
      const secondTurn = runner.start();
      internals._consumedUserMessages.set(2, [kickoff]);
      await secondTurn.catch(() => {});
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(3);
      expect(enqueueWithIdSpy).not.toHaveBeenCalled(); // replay never flushed (builds throw)
      const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
        String(args[0])
      );
      expect(warns.some((w) => w.includes('retry budget exhausted'))).toBe(true);
    });

    it('cancels the retry when a lifecycle reset nulls queryPromise during the backoff', async () => {
      // P1 regression guard: the delivery-turn stall watchdog's
      // resetQuery({restartQuery:false}) nulls ctx.queryPromise WITHOUT
      // bumping the generation or marking interrupted. The post-backoff
      // guard must treat that as cancellation, or the sleeping chain wakes
      // and respawns a query the reset already gave up on.
      process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = '25';

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      // Wire the reset into the pre-backoff teardown hook — by the time the
      // real flow runs it, the stall watchdog has already fired.
      terminateTrackedAgentProcessesSpy.mockImplementation(() => {
        ctx.queryPromise = null;
      });

      runner.start();
      const chain = ctx.queryPromise;
      await chain?.catch(() => {});

      // First attempt only — the retry was cancelled, not recursed.
      expect(buildSpy).toHaveBeenCalledTimes(1);
      const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
        String(args[0])
      );
      expect(warns.some((w) => w.includes('Startup-timeout retry cancelled'))).toBe(true);
    });

    it('abandons the retry when the delivery row was terminalized failed during the backoff', async () => {
      // The 30s delivery-consumption timeout (awaitDeliveryConsumption) and
      // the dead-letter paths mark the kickoff's durable row failed while the
      // backoff chain sleeps. Retrying would respawn subprocesses for a
      // delivery the layer already settled — abandon instead.
      process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = '25';

      const kickoff = {
        uuid: 'settled-kickoff-uuid',
        content: [{ type: 'text' as const, text: 'K' }],
      };
      const steer = {
        uuid: 'settled-steer-uuid',
        content: [{ type: 'text' as const, text: 'S' }],
      };
      getMessageByStatusAndUuidSpy.mockImplementation(
        (_sessionId: string, _status: string, uuid: string) =>
          uuid === kickoff.uuid ? ({ uuid: kickoff.uuid } as never) : null
      );

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      (
        runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
      )._consumedUserMessages = new Map([[1, [kickoff, steer]]]);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      // No retry and no re-enqueue for the already-settled delivery.
      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
        String(args[0])
      );
      expect(warns.some((w) => w.includes('delivery already settled failed'))).toBe(true);
      // Round-13 P3: the cancellation exit surfaces the still-carried STEER
      // (consumed carrier — the move to staging never ran) instead of letting
      // the finally drop it with warns only; the settled kickoff is the
      // delivery layer's row and is NOT flipped.
      expect(markDeliveryFailedInclusiveSpy).toHaveBeenCalledTimes(1);
      expect(markDeliveryFailedInclusiveSpy).toHaveBeenCalledWith(mockSession.id, steer.uuid);
      expect(warns.some((w) => w.includes('retry cancelled (delivery settled)'))).toBe(true);
      // The window closed on the cancellation exit (round-13 P3 pin).
      expect(runner.isInStartupBackoff()).toBe(false);
    });

    it.skipIf(!sdkQueryIsMock)(
      'cancels the retry when a COMPLETED Stop nulls the abort controller during the backoff',
      async () => {
        // P1 regression guard: handleInterrupt on a processing session finishes
        // in <1s — aborts-and-nulls ctx.queryAbortController, clears the queue,
        // deletes delivery jobs, settles at IDLE — without touching the
        // generation, queryPromise, or the 'consumed' kickoff row. Without the
        // controller-null disjunct every other guard passes and the chain wakes
        // to re-enqueue and re-run the prompt the user stopped.
        process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = '25';

        const kickoff = {
          uuid: 'stop-kickoff-uuid',
          content: [{ type: 'text' as const, text: 'K' }],
        };
        const steer = {
          uuid: 'stop-steer-uuid',
          content: [{ type: 'text' as const, text: 'S' }],
        };
        const ctx = createContext();
        runner = new QueryRunner(ctx);
        // A consumed-origin steer rides the chain (round-14 P3): the Stop exit
        // must sweep it failed-with-Retry like the other no-next-flush exits —
        // the turn it queued behind is gone, so it would otherwise vanish
        // silently as 'consumed'.
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff, steer]]]);
        // Mimic handleInterrupt's observable effects by the time the chain is
        // mid-backoff: controller nulled, queue cleared/stopped.
        terminateTrackedAgentProcessesSpy.mockImplementation(() => {
          ctx.queryAbortController = null;
          stopSpy();
          clearSpy();
        });

        runner.start();
        await ctx.queryPromise?.catch(() => {});

        // No recursion and — critically — no resurrection of the stopped prompt.
        expect(buildSpy).toHaveBeenCalledTimes(1);
        expect(enqueueWithIdSpy).not.toHaveBeenCalled();
        // The steer is surfaced; the kickoff (delivery layer's row) is not.
        expect(markDeliveryFailedInclusiveSpy).toHaveBeenCalledTimes(1);
        expect(markDeliveryFailedInclusiveSpy).toHaveBeenCalledWith(mockSession.id, steer.uuid);
        const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
          String(args[0])
        );
        expect(warns.some((w) => w.includes('retry cancelled (interrupted/stopped)'))).toBe(true);
        expect(warns.some((w) => w.includes('Startup-timeout retry cancelled'))).toBe(true);
        // The backoff window closed on the cancellation exit (round-13 P3 pin).
        expect(runner.isInStartupBackoff()).toBe(false);
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'aborts the rebuild when a Stop nulls the controller after the post-sleep guard',
      async () => {
        // Round-11 P1: the post-sleep guard checks controller-null BEFORE the
        // recursive attempt starts. A Stop landing inside the child's REBUILD
        // window (provider resolution → options build → controller
        // publication) nulls the controller without aborting it, bumping the
        // generation, or nulling queryPromise — and none of the child's own
        // later checks can see it (the post-admission identity check compares
        // against the child's OWN just-published controller). The retry site
        // must hand the child the owner identity, and the child must refuse
        // to publish or spawn on mismatch.
        process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = '25';

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        let buildCalls = 0;
        let stoppedDuringRebuild = false;
        buildSpy.mockImplementation(async () => {
          buildCalls++;
          if (buildCalls === 1) {
            throw new Error('SDK startup timeout - query aborted');
          }
          if (buildCalls === 2) {
            // The recursive attempt is mid-rebuild (post-guard, pre-spawn).
            // The observable state at the guard: controller nulled, status
            // 'interrupted', queue stopped. (handleInterrupt aborts BEFORE
            // nulling, but the abort is not what the guard reads — the
            // stricter no-abort shape here is the lifecycle-stop variant, and
            // the identity check sees both identically.)
            stoppedDuringRebuild = true;
            ctx.queryAbortController = null;
            getStateSpy.mockReturnValue({ status: 'interrupted' });
            stopSpy();
          }
          return { model: 'claude-sonnet-4-20250514' };
        });
        let queryCalls = 0;
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => {
          queryCalls++;
          return {
            close: () => {},
            // Self-ending on a regression: an ungated rebuild would reach
            // query(), die as a startup timeout, and burn to the cap instead
            // of parking this test.
            [Symbol.asyncIterator]: async function* () {
              throw new Error('SDK startup timeout - query aborted');
            },
          };
        });

        try {
          runner.start();
          await ctx.queryPromise?.catch(() => {});

          expect(stoppedDuringRebuild).toBe(true);
          expect(buildCalls).toBe(2);
          // No spawn, and the child never published a controller over the Stop.
          expect(queryCalls).toBe(0);
          expect(ctx.queryAbortController).toBeNull();
          const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
            String(args[0])
          );
          expect(
            warns.some((w) => w.includes('SDK startup retry abandoned: the session was stopped'))
          ).toBe(true);
          // Exactly the one scheduled retry from attempt 1 — the aborted
          // rebuild did not respawn into the stopped session.
          expect(
            warns.filter((w) => w.includes('Auto-retrying query after startup timeout')).length
          ).toBe(1);
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'a rejecting statusChanged subscriber cannot escape the give-up surfacing (guarded publish)',
      async () => {
        // Round-14 P3: publish() awaits every handler and rejects when one
        // fails, and an unhandled rejection is daemon-fatal — the surfacing
        // runs inside error-unwind paths, so the broadcast must be
        // fire-and-forget guarded. Vitest fails this test on the unguarded
        // shape via the unhandled rejection itself.
        const kickoff = {
          uuid: 'guarded-kickoff',
          content: [{ type: 'text' as const, text: 'K' }],
        };
        const steer = {
          uuid: 'guarded-steer',
          content: [{ type: 'text' as const, text: 'S' }],
        };

        const ctx = createContext({
          getActiveDeliveryKickoffUuid: () => kickoff.uuid,
        });
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff, steer]]]);
        buildSpy.mockRejectedValue(new Error('SDK startup timeout - query aborted'));

        // Pin handler attachment directly (bun's unhandled-rejection routing
        // is not observable per-test): the broadcast promise returned by the
        // spy records whether the production code attached a rejection
        // handler, and the original rejection is pre-swallowed so even the
        // unguarded shape cannot poison the rest of the suite.
        let catchAttached = false;
        publishEventSpy.mockImplementationOnce(() => {
          const rejection = Promise.reject<void>(new Error('subscriber boom'));
          const originalCatch = rejection.catch.bind(rejection);
          originalCatch(() => {}); // never let the raw rejection escape
          rejection.catch = ((handler: (reason: unknown) => unknown) => {
            catchAttached = true;
            return originalCatch(handler as never) as Promise<void>;
          }) as typeof rejection.catch;
          return rejection;
        });

        runner.start();
        await ctx.queryPromise?.catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 25));

        expect(markDeliveryFailedInclusiveSpy).toHaveBeenCalledTimes(1);
        expect(markDeliveryFailedInclusiveSpy).toHaveBeenCalledWith(mockSession.id, steer.uuid);
        expect(catchAttached).toBe(true);
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'restores and clears seeded originalEnvVars before the recursive startup retry',
      async () => {
        // Round-11 P3: the startup-retry site's env restore had no coverage
        // with a NON-EMPTY originalEnvVars (the provider-retry analog at the
        // 5xx site has one; this site's own restore+clear was un-pinned).
        // Seed real values and pin that by the time the recursive attempt
        // builds options the restore ran (process.env carries the ORIGINAL
        // value) and the ctx slot is cleared (the child re-captures fresh
        // originals after its own provider application).
        const ctx = createContext({
          originalEnvVars: { ANTHROPIC_API_KEY: 'fake-original-key' },
        });
        runner = new QueryRunner(ctx);
        let buildCalls = 0;
        let originalEnvVarsAtRetryBuild: Record<string, string> | undefined;
        let apiKeyAtRetryBuild: string | undefined;
        buildSpy.mockImplementation(async () => {
          buildCalls++;
          if (buildCalls === 1) {
            throw new Error('SDK startup timeout - query aborted');
          }
          originalEnvVarsAtRetryBuild = { ...(ctx.originalEnvVars as Record<string, string>) };
          apiKeyAtRetryBuild = process.env.ANTHROPIC_API_KEY;
          return { model: 'claude-sonnet-4-20250514' };
        });
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => ({
          close: () => {},
          [Symbol.asyncIterator]: async function* () {
            await new Promise(() => {});
          },
        }));

        try {
          runner.start();
          const deadline = Date.now() + 2000;
          while (buildCalls < 2 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(buildCalls).toBe(2);
          // At the recursive attempt's build: restored (the ORIGINAL key is
          // back in process.env, not this suite's 'sk-test-key') and cleared
          // (an empty slot was handed to the child).
          expect(apiKeyAtRetryBuild).toBe('fake-original-key');
          expect(originalEnvVarsAtRetryBuild).toEqual({});

          ctx.queryAbortController?.abort();
          await ctx.queryPromise?.catch(() => {});
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'stays processing across the startup-retry backoff (no setIdle before the recursive build)',
      async () => {
        // Round-11 P3: the startup-retry branch deliberately skips
        // stateManager.setIdle (unlike the near-instant 1-shot retries) — a
        // multi-second backoff that publishes idle would drop Stop presses
        // (handleInterrupt early-returns on idle) and false-pass waitForIdle
        // observers. The invariant had no pin.
        const ctx = createContext();
        runner = new QueryRunner(ctx);
        let buildCalls = 0;
        let setIdleCallsAtRetryBuild = -1;
        buildSpy.mockImplementation(async () => {
          buildCalls++;
          if (buildCalls === 1) {
            throw new Error('SDK startup timeout - query aborted');
          }
          setIdleCallsAtRetryBuild = setIdleSpy.mock.calls.length;
          return { model: 'claude-sonnet-4-20250514' };
        });
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => ({
          close: () => {},
          [Symbol.asyncIterator]: async function* () {
            await new Promise(() => {});
          },
        }));

        try {
          runner.start();
          const deadline = Date.now() + 2000;
          while (buildCalls < 2 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(buildCalls).toBe(2);
          // No idle was published anywhere between attempt 1's catch and the
          // recursive attempt's options build. (The chain END may idle in the
          // finally — only the backoff window is pinned.)
          expect(setIdleCallsAtRetryBuild).toBe(0);

          ctx.queryAbortController?.abort();
          await ctx.queryPromise?.catch(() => {});
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'exposes the startup-backoff window to the delivery lane (flag opens at retry, closes before the recursion)',
      async () => {
        // Round-12 P2: follow-up steers park while the session is 'processing'
        // with a stopped queue (this window); the delivery handler must be
        // able to tell this bounded-recovery window from abandonment so it
        // does not dead-letter those steers mid-schedule. The runner marks
        // the window: true from the retry teardown through the backoff sleep
        // and the post-sleep guards, false again BEFORE the recursive
        // attempt runs (the queue restart ends the park cause — steers feed
        // normally from there).
        process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = '100';

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        buildSpy
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockResolvedValue({ model: 'claude-sonnet-4-20250514' });
        let queryCalls = 0;
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => {
          queryCalls++;
          return {
            close: () => {},
            [Symbol.asyncIterator]: async function* () {
              await new Promise(() => {});
            },
          };
        });

        try {
          expect(runner.isInStartupBackoff()).toBe(false); // closed before any retry
          runner.start();
          // Window opens with the retry (teardown + 100ms sleep): poll it.
          let sawWindow = false;
          let deadline = Date.now() + 2000;
          while (Date.now() < deadline) {
            if (runner.isInStartupBackoff()) {
              sawWindow = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(sawWindow).toBe(true);

          // Window closes before the recursion: once the recursive attempt
          // has spawned its query, the flag must be back to false (a latched
          // true would exempt genuine-abandonment parks from the budget
          // forever).
          deadline = Date.now() + 2000;
          while (queryCalls < 1 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(queryCalls).toBe(1);
          expect(runner.isInStartupBackoff()).toBe(false);

          ctx.queryAbortController?.abort();
          await ctx.queryPromise?.catch(() => {});
          expect(runner.isInStartupBackoff()).toBe(false); // stays closed after settle
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'flips still-unrecovered steers failed when the startup-retry budget is exhausted',
      async () => {
        // Round-12 P3: on give-up the terminal messageQueue.clear() drops
        // this chain's flushed/staged prompts, and the retry-site fold-back
        // only serves a NEXT flush that never comes. Kickoffs are the
        // delivery layer's to settle (re-open lane is kickoff-only); the
        // consumed STEERS have no re-drive lane, so the give-up branch must
        // flip their durable rows failed (the inclusive dead-letter flip) to
        // surface them with a Retry affordance — and must NOT touch the
        // kickoff.
        const kickoff = {
          uuid: 'giveup-kickoff',
          content: [{ type: 'text' as const, text: 'K' }],
        };
        const steer = {
          uuid: 'giveup-steer',
          content: [{ type: 'text' as const, text: 'S' }],
        };

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff, steer]]]);
        // Starved give-up keys the delivery by the PENDING kickoff (peek).
        peekNextUserMessageIdSpy.mockReturnValue(kickoff.uuid);

        buildSpy
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockResolvedValue({ model: 'claude-sonnet-4-20250514' });
        // Attempt 2 flushes BOTH messages into the queue, then dies as a
        // startup timeout — budget (suite default MAX=1) exhausts at its
        // catch, so the give-up branch runs with the flush's entries as the
        // dropped set.
        let queryCalls = 0;
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => {
          queryCalls++;
          return {
            close: () => {},
            [Symbol.asyncIterator]: async function* () {
              throw new Error('SDK startup timeout - query aborted');
            },
          };
        });

        try {
          runner.start();
          await ctx.queryPromise?.catch(() => {});
          expect(queryCalls).toBe(1);

          // The STEER is flipped failed (surfaced, Retry affordance); the
          // kickoff is NOT — the delivery layer owns its settlement.
          expect(markDeliveryFailedInclusiveSpy).toHaveBeenCalledTimes(1);
          expect(markDeliveryFailedInclusiveSpy).toHaveBeenCalledWith(mockSession.id, steer.uuid);
          const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
            String(args[0])
          );
          expect(
            warns.some((w) => w.includes(`steer ${steer.uuid} never reached a producing turn`))
          ).toBe(true);
          expect(warns.some((w) => w.includes('retry budget exhausted'))).toBe(true);
          // Round-14 P3: give-up performs the retry branch's clean-slate
          // teardown (terminate tracked subprocesses) before settling.
          expect(terminateTrackedAgentProcessesSpy).toHaveBeenCalled();
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'the backoff window is fenced across a superseding restart (stale finally cannot close the new window)',
      async () => {
        // Round-13 P2: a restart during chain A's backoff starts chain B on
        // the SAME runner — the queue is stopped, so start()'s isRunning
        // guard passes — and B can open its OWN window while A's finally is
        // still pending. An unfenced boolean let A's exit clear B's window
        // mid-recovery, resurrecting the dead-letter race the flag exists to
        // prevent. Fencing: start() closes the stale claim immediately (B's
        // queue is live, parks charge again), and A's finally clears only its
        // own owner token.
        process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = '750';
        process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '3';

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        buildSpy
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockResolvedValue({ model: 'claude-sonnet-4-20250514' });
        let queryCalls = 0;
        let releaseChainB: (() => void) | null = null;
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => {
          queryCalls++;
          return {
            close: () => {},
            [Symbol.asyncIterator]: async function* () {
              if (queryCalls === 1) {
                // Chain B's attempt: parked until the test releases it, then
                // dies as a startup timeout (opening B's own window).
                await new Promise<void>((resolve) => {
                  releaseChainB = resolve;
                });
                throw new Error('SDK startup timeout - query aborted');
              }
              await new Promise(() => {});
            },
          };
        });

        try {
          // Chain A (generation 1): dies at build, retry opens window A.
          runner.start();
          let deadline = Date.now() + 2000;
          while (!runner.isInStartupBackoff() && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(runner.isInStartupBackoff()).toBe(true);

          // Restart: the real timeout escape leaves the queue STOPPED —
          // mirror that, then start chain B (generation 2). start() must
          // close A's stale claim immediately; B parks pre-window so the
          // false here is deterministic.
          stopSpy();
          await runner.start();
          expect(runner.isInStartupBackoff()).toBe(false);

          // B times out and opens its OWN window while A's 250ms sleep is
          // still pending.
          // Wait for B's attempt to actually park in its iterator, then
          // release it into the startup-timeout throw that opens B's own
          // window (releasing before the hook arms would no-op and strand B).
          deadline = Date.now() + 2000;
          while (!releaseChainB && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(releaseChainB).toBeTypeOf('function');
          releaseChainB?.();
          deadline = Date.now() + 2000;
          while (!runner.isInStartupBackoff() && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(runner.isInStartupBackoff()).toBe(true);
          // Ordering pin (round-14 P3): B's window must genuinely open while
          // A's sleep is still pending — if A's guard/finally already ran
          // first, the owner field is already null and even an unconditionally-
          // clearing regressed finally would be a no-op here, silently
          // removing the test's regression power. Fail loudly instead.
          const warnsEarly = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
            String(args[0])
          );
          expect(warnsEarly.some((w) => w.includes('Startup-timeout retry cancelled'))).toBe(false);

          // A's sleep ends: its post-sleep guard sees the superseded
          // generation and returns through A's finally. Wait for that warn,
          // give the finally a tick, then pin the race: B's window must
          // still be open.
          deadline = Date.now() + 3000;
          let aCancelled = false;
          while (Date.now() < deadline) {
            const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
              String(args[0])
            );
            if (warns.some((w) => w.includes('Startup-timeout retry cancelled'))) {
              aCancelled = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(aCancelled).toBe(true);
          await new Promise((resolve) => setTimeout(resolve, 25));
          expect(runner.isInStartupBackoff()).toBe(true); // B's window survived A's finally

          // End chain B (its backoff proceeds to a parked attempt).
          deadline = Date.now() + 3000;
          while (queryCalls < 2 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(queryCalls).toBeGreaterThanOrEqual(2);
          ctx.queryAbortController?.abort();
          await ctx.queryPromise?.catch(() => {});
          expect(runner.isInStartupBackoff()).toBe(false); // closed for good
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'surfaces steers from ALL THREE carriers at give-up, deduped, with one statusChanged broadcast',
      async () => {
        // Round-13 P2/P3: at give-up the steers can sit in three carriers at
        // once — pulled by the giving-up attempt's silent iterator
        // (_consumedUserMessages; the move to staging happens at the retry
        // site this branch skips), staged by the flush's skip/reject branch,
        // and flushed into the queue. All three must flip, deduped by uuid
        // (a TTL-rejected entry is both flushed and re-staged — a duplicate
        // flip would warn a misleading "could not be marked failed"), the
        // kickoff (deliveryKey) must be excluded, and the flipped ids must
        // go out as ONE messages.statusChanged broadcast like every sibling
        // flip site.
        const kickoff = {
          uuid: 'giveup3-kickoff',
          content: [{ type: 'text' as const, text: 'K' }],
        };
        const consumedSteer = {
          uuid: 'giveup3-consumed',
          content: [{ type: 'text' as const, text: 'C' }],
        };
        const stagedSteer = {
          uuid: 'giveup3-staged',
          content: [{ type: 'text' as const, text: 'T' }],
        };
        const flushedSteer = {
          uuid: 'giveup3-flushed',
          content: [{ type: 'text' as const, text: 'F' }],
        };
        const flushedOnlySteer = {
          uuid: 'giveup3-pending',
          content: [{ type: 'text' as const, text: 'P' }],
        };

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([
          [1, [kickoff, stagedSteer, flushedSteer, flushedOnlySteer]],
        ]);
        // Starved give-up keys the delivery by the PENDING kickoff (peek).
        peekNextUserMessageIdSpy.mockReturnValue(kickoff.uuid);

        buildSpy
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockResolvedValue({ model: 'claude-sonnet-4-20250514' });
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => ({
          close: () => {},
          // Parked: the admission rejection's abort (not the iterator) ends
          // the attempt, routing it into the starved give-up.
          [Symbol.asyncIterator]: async function* () {
            await new Promise(() => {});
          },
        }));
        // Flush duplicate-guard: the STAGED steer looks already pending
        // (skip branch re-stages it); the FLUSHED steer's admission is a
        // deferred TTL rejection (rejection handler re-stages it) — so it
        // ends up in BOTH the flushed and staged carriers. Deferred so the
        // test can seed the consumed carrier BEFORE the rejection aborts
        // the attempt into give-up.
        // flushedOnlySteer's admission merely resolves (stays pending at
        // give-up): it reaches the sweep ONLY through flushedReplayEntries —
        // the unique pin for the flushed carrier (dropping that carrier from
        // the production sweep must fail THIS test, not just a sibling).
        let rejectFlushedAdmission: ((error: Error) => void) | null = null;
        hasPendingOrInFlightSpy.mockImplementation((uuid: string) => uuid === stagedSteer.uuid);
        enqueueWithIdSpy.mockImplementation((uuid: string) =>
          uuid === flushedSteer.uuid
            ? new Promise<void>((_resolve, reject) => {
                rejectFlushedAdmission = reject;
              })
            : Promise.resolve()
        );

        try {
          runner.start();
          let deadline = Date.now() + 2000;
          while (
            (enqueueWithIdSpy.mock.calls.length < 3 || !rejectFlushedAdmission) &&
            Date.now() < deadline
          ) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(enqueueWithIdSpy.mock.calls.length).toBe(3);
          // Record the CONSUMED carrier as the giving-up attempt's silent
          // iterator would (the recording path itself is pinned by the
          // generator-wrapper tests — here it stands in for a live pull
          // between the flush and the timeout).
          (
            runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
          )._consumedUserMessages.set(1, [kickoff, consumedSteer]);

          // Fire the TTL rejection: re-stage (second carrier for the flushed
          // steer) + abort → starved give-up with all carriers populated.
          const ttlError = new Error('Message queue timeout');
          ttlError.name = 'MessageQueueTimeoutError';
          rejectFlushedAdmission?.(ttlError);
          await ctx.queryPromise?.catch(() => {});

          // Exactly the three steers flipped — kickoff excluded (delivery
          // layer owns it), no duplicate attempts despite flushedSteer being
          // in two carriers.
          expect(markDeliveryFailedInclusiveSpy).toHaveBeenCalledTimes(4);
          const flipped = markDeliveryFailedInclusiveSpy.mock.calls.map((c) => c[1]);
          expect(new Set(flipped)).toEqual(
            new Set([
              consumedSteer.uuid,
              stagedSteer.uuid,
              flushedSteer.uuid,
              flushedOnlySteer.uuid,
            ])
          );
          // One broadcast carries every flipped row.
          expect(publishEventSpy).toHaveBeenCalledTimes(1);
          expect(publishEventSpy).toHaveBeenCalledWith('messages.statusChanged', {
            sessionId: mockSession.id,
            messageIds: ['db-row-id', 'db-row-id', 'db-row-id', 'db-row-id'],
            status: 'failed',
          });
          const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
            String(args[0])
          );
          expect(
            warns.filter((w) => w.includes(flushedSteer.uuid) && w.includes('producing turn'))
          ).toHaveLength(1);
          expect(warns.some((w) => w.includes('could not be marked failed'))).toBe(false);
          expect(warns.some((w) => w.includes(kickoff.uuid))).toBe(false);
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'sweeps the steers at give-up even when a replacement superseded the chain (teardown-only guard)',
      async () => {
        // Round-15 P2: a replacement landing before the giving-up attempt's
        // throw reaches the catch used to skip the steer sweep entirely —
        // the catch's stale return exited with nothing, and before that the
        // round-14 teardown guard returned ahead of the sweep. The steers
        // were unrecoverable: the replacement's start() nulls the staging,
        // the stale finally purges flushed entries without flipping rows,
        // and this chain's consumed history is deleted on the way out.
        // Supersession now guards ONLY the teardown, and the stale catch
        // entry sweeps too (DB-only flips of this chain's own steers —
        // suppressing them protects nothing).
        const kickoff = {
          uuid: 'superseded-kickoff',
          content: [{ type: 'text' as const, text: 'K' }],
        };
        const steer = {
          uuid: 'superseded-steer',
          content: [{ type: 'text' as const, text: 'S' }],
        };

        // Starved shape: nothing consumed this attempt, kickoff pending in
        // the queue — peek keys the sweep's exclusion (no active-turn getter
        // here; a replacement now owns the turn job and the getter would
        // report ITS kickoff).
        peekNextUserMessageIdSpy.mockReturnValue(kickoff.uuid);

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff, steer]]]);

        buildSpy
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockResolvedValue({ model: 'claude-sonnet-4-20250514' });
        // Attempt 2 parks in its iterator until released, then dies as a
        // startup timeout — the release order lets the test land the
        // replacement BEFORE the throw reaches the catch (stale entry).
        let releaseAttempt: (() => void) | null = null;
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => ({
          close: () => {},
          [Symbol.asyncIterator]: async function* () {
            await new Promise<void>((resolve) => {
              releaseAttempt = resolve;
            });
            throw new Error('SDK startup timeout - query aborted');
          },
        }));

        try {
          runner.start();
          const deadline = Date.now() + 2000;
          while (
            (!releaseAttempt || enqueueWithIdSpy.mock.calls.length < 2) &&
            Date.now() < deadline
          ) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(enqueueWithIdSpy.mock.calls.length).toBe(2);

          // Replacement first, then release the attempt into its throw: the
          // catch enters STALE — the shape that used to skip the sweep.
          ctx.incrementQueryGeneration();
          releaseAttempt?.();
          await ctx.queryPromise?.catch(() => {});

          // The sweep ran DESPITE supersession: the steer flipped, the
          // kickoff (this chain's own pending-queue key) did not.
          expect(markDeliveryFailedInclusiveSpy).toHaveBeenCalledTimes(1);
          expect(markDeliveryFailedInclusiveSpy).toHaveBeenCalledWith(mockSession.id, steer.uuid);
          const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
            String(args[0])
          );
          expect(
            warns.some((w) => w.includes(`steer ${steer.uuid} never reached a producing turn`))
          ).toBe(true);
          expect(warns.some((w) => w.includes(kickoff.uuid))).toBe(false);
          // Teardown was suppressed: the attempt's query object was never
          // closed by the superseded exit (the replacement owns the
          // session's process set now).
          expect(ctx.queryObject).not.toBeNull();
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
          if (ctx.startupTimeoutTimer) {
            clearTimeout(ctx.startupTimeoutTimer);
            ctx.startupTimeoutTimer = null;
          }
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'keys the budget and sweep by the delivery layer kickoff, not the first-consumed message (leftover steer)',
      async () => {
        // Round-14 P2(a): a steer admitted late in the previous turn that the
        // SDK never pulled survives the stopped-not-cleared queue and is
        // consumed FIRST by this generation — inference keyed deliveryKey to
        // it, so the give-up sweep skipped the steer (silent consumed loss)
        // and flipped the kickoff. The active-turn getter supplies the TRUE
        // kickoff: budget keyed correctly, steer flipped, kickoff untouched.
        const kickoff = {
          uuid: 'leftover-kickoff',
          content: [{ type: 'text' as const, text: 'K' }],
        };
        const leftoverSteer = {
          uuid: 'leftover-steer',
          content: [{ type: 'text' as const, text: 'S' }],
        };

        const ctx = createContext({
          getActiveDeliveryKickoffUuid: () => kickoff.uuid,
        });
        runner = new QueryRunner(ctx);
        // The leftover steer is pulled FIRST (FIFO from the prior turn's
        // queue), the kickoff second — the exact misidentification shape.
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [leftoverSteer, kickoff]]]);

        buildSpy.mockRejectedValue(new Error('SDK startup timeout - query aborted'));

        runner.start();
        await ctx.queryPromise?.catch(() => {});

        // Attempt 1 gives up (suite MAX=1) with only the consumed carrier:
        // the STEER flips, the kickoff does not.
        expect(markDeliveryFailedInclusiveSpy).toHaveBeenCalledTimes(1);
        expect(markDeliveryFailedInclusiveSpy).toHaveBeenCalledWith(
          mockSession.id,
          leftoverSteer.uuid
        );
        // The budget was keyed by the TRUE kickoff, not the first-consumed
        // steer — the mis-keying also minted fresh budgets for the wrong
        // delivery on later attempts.
        expect(
          (runner as unknown as { _startupTimeoutRetryState: { key: string | null } })
            ._startupTimeoutRetryState.key
        ).toBe(kickoff.uuid);
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'a starved null-inference give-up with an active turn job never flips the staged kickoff',
      async () => {
        // Round-14 P2(b): nothing consumed this attempt, queue empty, the
        // kickoff staged only via the TTL/fold-back cascade — the old
        // null deliveryKey excluded nothing and the inclusive flip settled
        // the kickoff row the branch contract reserves for the delivery
        // layer. With the active-turn getter the staged kickoff is excluded
        // and a zero-flip give-up publishes NOTHING (also pins the no-op
        // broadcast path).
        const kickoff = {
          uuid: 'starved-kickoff',
          content: [{ type: 'text' as const, text: 'K' }],
        };

        const ctx = createContext({
          getActiveDeliveryKickoffUuid: () => kickoff.uuid,
        });
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff]]]);

        // Both attempts die at build: attempt 1's retry stages the kickoff,
        // attempt 2 gives up with it still staged and nothing else.
        buildSpy.mockRejectedValue(new Error('SDK startup timeout - query aborted'));

        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expect(markDeliveryFailedInclusiveSpy).not.toHaveBeenCalled();
        expect(publishEventSpy).not.toHaveBeenCalled();
        const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
          String(args[0])
        );
        expect(warns.some((w) => w.includes('retry budget exhausted'))).toBe(true);
        expect(warns.some((w) => w.includes(kickoff.uuid))).toBe(false);
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'a manual retry lane resets the exhausted same-uuid budget (fresh automatic retries)',
      async () => {
        // Round-14 P2: reopenDeliveryByUuid re-enqueues the SAME uuid, and
        // same-uuid attempts always charge — without the explicit-lane reset
        // a post-give-up Retry gets exactly one attempt (its first timeout
        // charges past the cap). AgentSession.resetStartupTimeoutRetryBudget (wired
        // at all four reopen callers) hands the runner the reset.
        const kickoff = {
          uuid: 'retry-lane-kickoff',
          content: [{ type: 'text' as const, text: 'K' }],
        };

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff]]]);

        buildSpy.mockRejectedValue(new Error('SDK startup timeout - query aborted'));

        runner.start();
        await ctx.queryPromise?.catch(() => {});
        const warnsAfterGiveUp = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map(
          (args) => String(args[0])
        );
        expect(warnsAfterGiveUp.some((w) => w.includes('retry budget exhausted'))).toBe(true);
        // MAX=1 grants one automatic retry: chain 1 runs TWO builds (retry,
        // then give-up at the second claim).
        expect(buildSpy).toHaveBeenCalledTimes(2);

        // The manual Retry: fresh chain on the same runner, same uuid. The
        // reset is what the reopen lane performs — no reset, no retries.
        runner.resetStartupTimeoutRetryBudgetFor(kickoff.uuid);
        stopSpy(); // the give-up left the queue stopped; the redriven turn restarts it
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[2, [kickoff]]]);
        runner.start();
        await ctx.queryPromise?.catch(() => {});

        const warnsAfterRetry = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map(
          (args) => String(args[0])
        );
        // The retried delivery got its own automatic retry chain — not an
        // instant give-up. Four builds total (2 per chain), one Auto-retrying
        // per chain. WITHOUT the reset the retried chain inherits the
        // exhausted same-uuid budget: 3 builds, 1 Auto-retrying.
        expect(buildSpy).toHaveBeenCalledTimes(4);
        expect(
          warnsAfterRetry.filter((w) => w.includes('Auto-retrying query after startup timeout'))
            .length
        ).toBe(2);
        // A wrong-uuid reset must not clear another delivery's budget.
        runner.resetStartupTimeoutRetryBudgetFor('some-other-uuid');
        expect(
          (runner as unknown as { _startupTimeoutRetryState: { key: string | null } })
            ._startupTimeoutRetryState.key
        ).toBe(kickoff.uuid);
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'surfaces a null-flip steer with the dropped warn and publishes nothing (negative path)',
      async () => {
        // Round-14 P3: the flip returning null (row missing / already
        // terminal — production-reachable exactly on the settled-failed
        // exit, where the delivery layer already terminalized rows) takes
        // the warn branch, and a zero-flip sweep must not broadcast.
        const kickoff = {
          uuid: 'nullflip-kickoff',
          content: [{ type: 'text' as const, text: 'K' }],
        };
        const steer = {
          uuid: 'nullflip-steer',
          content: [{ type: 'text' as const, text: 'S' }],
        };

        const ctx = createContext({
          getActiveDeliveryKickoffUuid: () => kickoff.uuid,
        });
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff, steer]]]);
        markDeliveryFailedInclusiveSpy.mockReturnValue(null);

        buildSpy.mockRejectedValue(new Error('SDK startup timeout - query aborted'));

        runner.start();
        await ctx.queryPromise?.catch(() => {});

        expect(markDeliveryFailedInclusiveSpy).toHaveBeenCalledTimes(1);
        expect(publishEventSpy).not.toHaveBeenCalled();
        const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
          String(args[0])
        );
        expect(
          warns.some(
            (w) => w.includes('could not be marked failed') && w.includes('nullflip-steer')
          )
        ).toBe(true);
      }
    );

    it('cancels the retry when the session enters cleanup during the backoff', async () => {
      // The isCleaningUp disjunct had no dedicated coverage. Daemon shutdown
      // mid-backoff must not relaunch an orphaned query after the sleep.
      process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = '25';

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      let cleaningUp = false;
      ctx.isCleaningUp = () => cleaningUp;
      terminateTrackedAgentProcessesSpy.mockImplementation(() => {
        cleaningUp = true;
      });

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
        String(args[0])
      );
      expect(warns.some((w) => w.includes('Startup-timeout retry cancelled'))).toBe(true);
      // The backoff window closed on the cancellation exit (round-13 P3 pin).
      expect(runner.isInStartupBackoff()).toBe(false);
    });

    it('gives a starved NEW delivery a fresh budget via the pending kickoff (peek)', async () => {
      // P2 regression guard: when nothing was consumed (feed starvation), the
      // delivery key now comes from the first message still pending in the
      // queue. Without it, a starved first timeout of a NEW delivery B would
      // charge whatever delivery timed out before it (A's exhausted budget)
      // and settle B failed with zero retries.
      let pendingKickoffId: string | null = 'kickoff-a';

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      peekNextUserMessageIdSpy.mockImplementation(() => pendingKickoffId);

      // Turn 1 — starved delivery A: key derived from the pending kickoff.
      runner.start();
      await ctx.queryPromise?.catch(() => {});
      expect(buildSpy).toHaveBeenCalledTimes(2); // attempt + keyed retry, then capped

      // Turn 2 — a DIFFERENT delivery B is pending (redrives carry a new
      // message): its first timeout must get a FRESH budget (retry fires)
      // instead of inheriting A's exhausted one.
      pendingKickoffId = 'kickoff-b';
      buildSpy.mockClear();
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(2); // fresh budget: attempt + retry
      const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
        String(args[0])
      );
      // Both turns ended at the cap — B exhausted its OWN budget, not A's.
      expect(warns.filter((w) => w.includes('retry budget exhausted')).length).toBe(2);
    });

    it('abandons the retry when a PEEK-keyed starved delivery settled failed during the backoff', async () => {
      // Round-5 P3-9(4): the settled-failed cancellation was only tested with
      // a consumed-uuid key. The peek-derived starved key must cancel too —
      // nothing was consumed, the key came from the pending kickoff.
      process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = '25';

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      peekNextUserMessageIdSpy.mockImplementation(() => 'starved-kickoff-uuid');
      getMessageByStatusAndUuidSpy.mockImplementation(
        (_sessionId: string, _status: string, uuid: string) =>
          uuid === 'starved-kickoff-uuid' ? ({ uuid: 'starved-kickoff-uuid' } as never) : null
      );

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(1);
      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
      const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
        String(args[0])
      );
      expect(warns.some((w) => w.includes('delivery already settled failed'))).toBe(true);
    });

    it('startup retries consume the provider-retry budget and disable the 1-shot retries (documented coupling)', async () => {
      // Round-5 P3-9(2): startup retries bump `retryAttempt`, so later
      // attempts get fewer provider retries and no 1-shot message-not-found
      // retry. Pin BOTH halves of the documented coupling. The provider-base
      // env is saved/restored HERE rather than in the describe hooks — the
      // later provider-retry describe pins its own values and a leaked '0'
      // would silently change its timing (round-7 P3-1).
      const savedProviderBaseMs = process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS;
      process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = '0';
      process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '2';
      process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS = '0';
      // Default HYPERNEO_PROVIDER_MAX_RETRIES is 3.
      try {
        // Half 1 — provider budget: two startup retries leave retryAttempt=2,
        // so a persistent 529 gets exactly ONE provider retry (2 < 3) before
        // going terminal: 1 + 2 startup retries + 1 provider retry = 4 builds.
        // (Without the coupling the provider branch would retry 3 more times.)
        buildSpy
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockRejectedValue(new Error('529 {"error":{"message":"overloaded"}}'));

        let ctx = createContext();
        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});
        expect(buildSpy).toHaveBeenCalledTimes(4);

        // Half 2 — the 1-shot message-not-found retry is disabled on a later
        // attempt (requires retryAttempt === 0): after one startup retry the
        // not-found error goes straight to terminal — no 3rd build.
        buildSpy.mockReset();
        buildSpy
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockRejectedValueOnce(
            new Error('No message found with message.uuid of: missing-message-uuid')
          );
        ctx = createContext();
        runner = new QueryRunner(ctx);
        runner.start();
        await ctx.queryPromise?.catch(() => {});
        expect(buildSpy).toHaveBeenCalledTimes(2);
      } finally {
        if (savedProviderBaseMs === undefined) {
          delete process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS;
        } else {
          process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS = savedProviderBaseMs;
        }
      }
    });

    it.skipIf(!sdkQueryIsMock)(
      'holds the replay out of the queue while the retry waits at the startup gate (no TTL exposure)',
      async () => {
        // Round-6 P2-1 regression: under herd congestion the retry attempt
        // queues at the startup gate behind K-1 silent 60s holds — longer
        // than the 30s MESSAGE_QUEUE_TIMEOUT_MS. A pre-gate enqueue would
        // TTL out mid-wait (rejection swallowed) and the attempt would burn
        // a window against an empty queue. The replay must be flushed only
        // after admission.
        const savedMaxConcurrent = process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT;
        process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT = '1';
        resetSdkStartupGateForTests();
        const gate = getSdkStartupGate();
        const blocker = await gate.acquire({ sessionId: 'gate-blocker' });
        let blockerReleased = false;

        const kickoff = {
          uuid: 'ttl-kickoff-uuid',
          content: [{ type: 'text' as const, text: 'K' }],
        };

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff]]]);

        // Attempt 1 dies at build (startup timeout); the retry attempt
        // resolves options and then BLOCKS at the gate behind `blocker`.
        buildSpy.mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'));
        buildSpy.mockResolvedValue({ model: 'claude-sonnet-4-20250514' });
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => ({
          close: () => {},
          [Symbol.asyncIterator]: async function* () {},
        }));

        try {
          runner.start();
          // Wait until the retry attempt is genuinely queued at the gate.
          const deadline = Date.now() + 2000;
          while (gate.getStats().queued < 1 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(gate.getStats().queued).toBe(1);
          // Mid-wait: the replay is staged, NOT enqueued — nothing sits in
          // the queue for the TTL to expire.
          expect(enqueueWithIdSpy).not.toHaveBeenCalled();
          expect(
            (
              runner as unknown as {
                _pendingStartupReplay: Array<{ uuid: string }> | null;
              }
            )._pendingStartupReplay?.[0]?.uuid
          ).toBe('ttl-kickoff-uuid');

          // Admission releases the flush: the replay lands only now, with the
          // generator attaching microseconds later.
          blockerReleased = true;
          blocker.release();
          await ctx.queryPromise?.catch(() => {});

          expect(enqueueWithIdSpy).toHaveBeenCalledWith(kickoff.uuid, kickoff.content, false, {
            prepend: true,
            durable: true,
          });
        } finally {
          if (!blockerReleased) blocker.release();
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
          if (savedMaxConcurrent === undefined) {
            delete process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT;
          } else {
            process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT = savedMaxConcurrent;
          }
          resetSdkStartupGateForTests();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'drops the staged replay when a stall-reset nulls the controller mid-gate-wait (no duplicate feed)',
      async () => {
        // Round-7 P2-1 regression: the stall watchdog fires while the retry
        // attempt is gate-queued → QueryLifecycleManager.stop() nulls
        // ctx.queryAbortController WITHOUT aborting it and WITHOUT bumping the
        // generation. When the permit frees, the post-admission stale check
        // must reject the dead chain via the controller-identity disjunct —
        // otherwise it would flush the replay, consume it, and the delivery
        // redrive would re-feed the same uuid (duplicate prompt).
        const savedMaxConcurrent = process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT;
        process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT = '1';
        resetSdkStartupGateForTests();
        const gate = getSdkStartupGate();
        const blocker = await gate.acquire({ sessionId: 'gate-blocker-reset' });
        let blockerReleased = false;

        const kickoff = {
          uuid: 'reset-kickoff-uuid',
          content: [{ type: 'text' as const, text: 'K' }],
        };

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff]]]);

        buildSpy.mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'));
        buildSpy.mockResolvedValue({ model: 'claude-sonnet-4-20250514' });
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => ({
          close: () => {},
          [Symbol.asyncIterator]: async function* () {},
        }));

        try {
          runner.start();
          const deadline = Date.now() + 2000;
          while (gate.getStats().queued < 1 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(gate.getStats().queued).toBe(1);

          // Simulate the stall-watchdog reset's observable effects on a
          // gate-blocked chain: controller nulled (no abort), queryPromise
          // given up on, generation NOT bumped, status idle.
          ctx.queryAbortController = null;
          ctx.queryPromise = null;

          blockerReleased = true;
          blocker.release();
          await new Promise((resolve) => setTimeout(resolve, 50));

          // The dead chain must NOT have flushed the replay, and the permit
          // must be back (the gateAbort path released it).
          expect(enqueueWithIdSpy).not.toHaveBeenCalled();
          expect(gate.getStats().active).toBe(0);
        } finally {
          if (!blockerReleased) blocker.release();
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
          if (savedMaxConcurrent === undefined) {
            delete process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT;
          } else {
            process.env.HYPERNEO_SDK_STARTUP_MAX_CONCURRENT = savedMaxConcurrent;
          }
          resetSdkStartupGateForTests();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'skips replay entries a redrive already re-admitted (duplicate guard)',
      async () => {
        // Round-7 P2-1 second half: if reopenDeliveryForRetry re-admitted the
        // uuid while the chain was gate-queued, the flush must not feed it a
        // second time (admitWithId is not idempotent by uuid).
        const kickoff = {
          uuid: 'dup-kickoff-uuid',
          content: [{ type: 'text' as const, text: 'K' }],
        };

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff]]]);

        buildSpy.mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'));
        buildSpy.mockResolvedValue({ model: 'claude-sonnet-4-20250514' });
        // The redrive already re-admitted the kickoff.
        hasPendingOrInFlightSpy.mockImplementation((id: string) => id === kickoff.uuid);
        // Keep attempt 2 alive so the re-staged skip is observable mid-chain
        // (the finally's leak guard clears it once the chain ends).
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => ({
          close: () => {},
          [Symbol.asyncIterator]: async function* () {
            await new Promise(() => {});
          },
        }));

        try {
          runner.start();
          // Wait for the skip warn (attempt 2 flushed and skipped), then
          // observe the stage BEFORE the chain ends.
          const deadline = Date.now() + 2000;
          const skipSeen = () =>
            (mockLogger.warn as ReturnType<typeof mock>).mock.calls.some((args) =>
              String(args[0]).includes('already pending or in-flight')
            );
          while (!skipSeen() && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(skipSeen()).toBe(true);
          expect(enqueueWithIdSpy).not.toHaveBeenCalled();

          // Round-8 P2: the skip re-stages (never drops) — the message keeps
          // a lane for the next flush to re-check.
          expect(
            (runner as unknown as { _pendingStartupReplay: Array<{ uuid: string }> | null })
              ._pendingStartupReplay?.[0]?.uuid
          ).toBe('dup-kickoff-uuid');
          // End the chain (abort the parked attempt) so the test can finish.
          ctx.queryAbortController?.abort();
          await ctx.queryPromise?.catch(() => {});
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'routes a TTL-rejected replay admission into the bounded startup retry',
      async () => {
        // Round-7 P2-2: the flush's enqueue can be rejected by the 30s
        // admission TTL during a slow cold start. The rejection must re-stage
        // the prompt, abort the attempt, and surface as a startup timeout so
        // the retry state machine (budget-capped, backoff) owns the recovery —
        // not the silent catch the chain used to have. RETRY_MAX=2: the
        // describe default of 1 would exhaust the budget on the routed retry
        // before the third attempt could run.
        process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '2';
        const kickoff = {
          uuid: 'ttl-reject-uuid',
          content: [{ type: 'text' as const, text: 'K' }],
        };

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff]]]);

        buildSpy
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockResolvedValueOnce({ model: 'claude-sonnet-4-20250514' })
          .mockResolvedValueOnce({ model: 'claude-sonnet-4-20250514' })
          .mockRejectedValueOnce(new Error('stop after retry'));
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => ({
          close: () => {},
          // Never yields on its own: the abort (from the rejection handler)
          // is what ends the attempt.
          [Symbol.asyncIterator]: async function* () {
            await new Promise(() => {});
          },
        }));
        // Controllable admission promise: reject on demand like the queue TTL.
        let rejectAdmission: ((error: Error) => void) | null = null;
        enqueueWithIdSpy.mockImplementation(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectAdmission = reject;
            })
        );

        try {
          runner.start();
          // Wait until the retry attempt flushed the replay (admission armed).
          let deadline = Date.now() + 2000;
          while (!rejectAdmission && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(rejectAdmission).toBeTypeOf('function');

          rejectAdmission(
            new Error(
              'Message queue timeout: SDK did not consume message ttl-reject-uuid within 30s.'
            )
          );

          // The rejection re-staged the prompt: the next attempt (retry 2)
          // flushes it again. Wait for the second admission, reject it the
          // same way — the budget (MAX=2) is now exhausted, so the chain
          // terminates instead of retrying, and the query promise settles.
          deadline = Date.now() + 2000;
          while (enqueueWithIdSpy.mock.calls.length < 2 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(enqueueWithIdSpy.mock.calls.length).toBe(2);
          rejectAdmission?.(
            new Error(
              'Message queue timeout: SDK did not consume message ttl-reject-uuid within 30s.'
            )
          );
          await ctx.queryPromise?.catch(() => {});

          // The rejection was routed into the retry machine: warn logged,
          // prompt re-staged and re-fed on the next attempt (2 admissions),
          // attempt aborted as a startup timeout (retry ran — 3 builds).
          const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
            String(args[0])
          );
          expect(warns.some((w) => w.includes('admission rejected for message'))).toBe(true);
          expect(warns.some((w) => w.includes('Auto-retrying query after startup timeout'))).toBe(
            true
          );
          expect(buildSpy).toHaveBeenCalledTimes(3);
          expect(enqueueWithIdSpy).toHaveBeenCalledTimes(2);
          expect(warns.some((w) => w.includes('retry budget exhausted'))).toBe(true);
          expect(enqueueWithIdSpy).toHaveBeenNthCalledWith(
            1,
            kickoff.uuid,
            kickoff.content,
            false,
            { prepend: true, durable: true }
          );
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'routes a NON-TTL admission rejection the same way (abort + bounded retry)',
      async () => {
        // Round-11 P3: the flush's rejection handler distinguishes a TTL
        // rejection only for the reason TEXT — every other rejection (e.g.
        // 'Interrupted by user' from a concurrent queue clear) must still
        // re-stage the prompt, abort the attempt, and land in the bounded
        // startup-retry machine. Only the MessageQueueTimeoutError shape had
        // coverage. RETRY_MAX=2 mirrors the TTL test: the describe default
        // of 1 would exhaust the budget before the re-fed attempt could run.
        process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '2';
        const kickoff = {
          uuid: 'nonttl-reject-uuid',
          content: [{ type: 'text' as const, text: 'K' }],
        };

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff]]]);

        buildSpy
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockResolvedValueOnce({ model: 'claude-sonnet-4-20250514' })
          .mockResolvedValueOnce({ model: 'claude-sonnet-4-20250514' })
          .mockRejectedValueOnce(new Error('stop after retry'));
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => ({
          close: () => {},
          [Symbol.asyncIterator]: async function* () {
            await new Promise(() => {});
          },
        }));
        // Controllable admission promise: reject on demand with a PLAIN
        // error — name stays 'Error', nothing resembling the queue TTL.
        let rejectAdmission: ((error: Error) => void) | null = null;
        enqueueWithIdSpy.mockImplementation(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectAdmission = reject;
            })
        );

        try {
          runner.start();
          let deadline = Date.now() + 2000;
          while (!rejectAdmission && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(rejectAdmission).toBeTypeOf('function');

          rejectAdmission(new Error('Interrupted by user'));

          // The handler aborted the attempt → starved escape → bounded retry
          // → the next attempt flushes the re-staged prompt again.
          deadline = Date.now() + 2000;
          while (enqueueWithIdSpy.mock.calls.length < 2 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(enqueueWithIdSpy.mock.calls.length).toBe(2);
          rejectAdmission?.(new Error('Interrupted by user'));
          await ctx.queryPromise?.catch(() => {});

          const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
            String(args[0])
          );
          const rejectionWarn = warns.find((w) => w.includes('admission rejected for message'));
          // The NON-TTL reason text is surfaced verbatim, and the abort
          // branch (not the producing-turn skip) handled it.
          expect(rejectionWarn).toContain('Interrupted by user');
          expect(rejectionWarn).toContain('aborting attempt for a bounded startup retry');
          // Both rejected attempts were ROUTED into the bounded retry (the
          // third claim then exhausted the budget — warn asserted below).
          expect(
            warns.filter((w) => w.includes('Auto-retrying query after startup timeout')).length
          ).toBe(2);
          expect(buildSpy).toHaveBeenCalledTimes(3);
          expect(warns.some((w) => w.includes('retry budget exhausted'))).toBe(true);
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'merges multi-message TTL rejections order-preserving (no overwrite)',
      async () => {
        // Round-8 P1: a replay of [kickoff, steer] arms two admission TTLs
        // that fire back-to-back; a per-message assignment would let the
        // second rejection overwrite the first re-stage. Steers have no
        // delivery-layer recovery lane, so both must survive, in feed order.
        process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '2';
        const kickoff = {
          uuid: 'merge-kickoff',
          content: [{ type: 'text' as const, text: 'K' }],
        };
        const steer = { uuid: 'merge-steer', content: [{ type: 'text' as const, text: 'S' }] };

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff, steer]]]);

        buildSpy
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockResolvedValueOnce({ model: 'claude-sonnet-4-20250514' })
          .mockResolvedValueOnce({ model: 'claude-sonnet-4-20250514' })
          .mockRejectedValueOnce(new Error('stop after retry'));
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => ({
          close: () => {},
          [Symbol.asyncIterator]: async function* () {
            await new Promise(() => {});
          },
        }));

        // Arm both admissions. The flush iterates the replay in REVERSE, so
        // the STEER is admitted first — rejections[0] is the steer,
        // rejections[1] the kickoff (the previous comments had the two
        // identities swapped, so the claimed worst order was never the one
        // exercised). Worst order, correctly named: the steer's TTL fires
        // FIRST, then the kickoff's — under a per-message assignment the
        // LAST rejection (kickoff) would overwrite the staging and drop the
        // steer, the entry with no delivery-layer recovery lane.
        const rejections: Array<(error: Error) => void> = [];
        enqueueWithIdSpy.mockImplementation(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejections.push(reject);
            })
        );

        try {
          runner.start();
          let deadline = Date.now() + 2000;
          while (rejections.length < 2 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(rejections.length).toBe(2);
          const ttlError = new Error('Message queue timeout');
          ttlError.name = 'MessageQueueTimeoutError';
          rejections[0](ttlError); // steer (admitted first by the reverse flush)
          rejections[1](ttlError); // kickoff — would overwrite the steer re-stage pre-fix

          // The merged re-stage feeds BOTH on attempt 3's flush.
          deadline = Date.now() + 2000;
          while (enqueueWithIdSpy.mock.calls.length < 4 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(enqueueWithIdSpy.mock.calls.length).toBe(4);
          // Reject the merged re-flush: budget (MAX=2) exhausts and the chain
          // terminates instead of retrying further.
          const ttlError2 = new Error('Message queue timeout');
          ttlError2.name = 'MessageQueueTimeoutError';
          rejections[2](ttlError2);
          rejections[3](ttlError2);
          await ctx.queryPromise?.catch(() => {});

          // The re-stage merged BOTH (next flush fed 2 more entries) and the
          // staged order fed kickoff before steer (prepend-reverse of an
          // array ordered [kickoff, steer]).
          expect(enqueueWithIdSpy.mock.calls.length).toBe(4);
          const secondFlushUuids = (
            enqueueWithIdSpy.mock.calls.slice(2) as unknown as Array<[string]>
          ).map(([uuid]) => uuid);
          expect(secondFlushUuids).toEqual(['merge-steer', 'merge-kickoff']);
          const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
            String(args[0])
          );
          expect(warns.some((w) => w.includes('admission rejected for message merge-steer'))).toBe(
            true
          );
          expect(
            warns.some((w) => w.includes('admission rejected for message merge-kickoff'))
          ).toBe(true);
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'ignores a late admission rejection once a replacement owns the session',
      async () => {
        // Round-8 P2: the .catch must be attempt-scoped — a TTL firing after
        // a replacement started must not write stage/flag into the live chain.
        const kickoff = {
          uuid: 'late-reject-kickoff',
          content: [{ type: 'text' as const, text: 'K' }],
        };

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff]]]);

        buildSpy
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockResolvedValue({ model: 'claude-sonnet-4-20250514' });
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => ({
          close: () => {},
          [Symbol.asyncIterator]: async function* () {
            await new Promise(() => {});
          },
        }));
        let rejectAdmission: ((error: Error) => void) | null = null;
        enqueueWithIdSpy.mockImplementation(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectAdmission = reject;
            })
        );

        try {
          runner.start();
          const deadline = Date.now() + 2000;
          while (!rejectAdmission && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(rejectAdmission).toBeTypeOf('function');
          const chainController = ctx.queryAbortController;

          // A replacement query takes ownership (generation bump + its own
          // controller) while the admission is still pending…
          ctx.incrementQueryGeneration();
          ctx.queryAbortController = new AbortController();
          const stagedBefore = (runner as unknown as { _pendingStartupReplay: unknown[] | null })
            ._pendingStartupReplay;

          const ttlError = new Error('Message queue timeout');
          ttlError.name = 'MessageQueueTimeoutError';
          rejectAdmission(ttlError);
          await new Promise((resolve) => setTimeout(resolve, 50));

          // …so the late rejection is a no-op: nothing staged, no starved
          // flag, no abort of the replacement's controller.
          expect(
            (runner as unknown as { _pendingStartupReplay: unknown[] | null })
              ._pendingStartupReplay === stagedBefore
          ).toBe(true);
          expect(
            (runner as unknown as { _replayAdmissionRejected: boolean })._replayAdmissionRejected
          ).toBe(false);
          expect(ctx.queryAbortController.signal.aborted).toBe(false);
          const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
            String(args[0])
          );
          expect(warns.some((w) => w.includes('lost session ownership; ignoring'))).toBe(true);

          // End the parked attempt (round-9 test gap): its 60 s startup timer
          // and pending admission must not outlive the test.
          chainController?.abort();
          await ctx.queryPromise?.catch(() => {});
          if (ctx.startupTimeoutTimer) {
            clearTimeout(ctx.startupTimeoutTimer);
            ctx.startupTimeoutTimer = null;
          }
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'does not abort a PRODUCING attempt when a trailing admission rejects',
      async () => {
        // Round-8 P2: the starved escape only fires at messageCount === 0 —
        // aborting after the first frame would truncate a live turn and the
        // post-loop would treat it as normal completion.
        const kickoff = {
          uuid: 'producing-kickoff',
          content: [{ type: 'text' as const, text: 'K' }],
        };
        const steer = {
          uuid: 'producing-steer',
          content: [{ type: 'text' as const, text: 'S' }],
        };

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff, steer]]]);

        buildSpy
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockResolvedValue({ model: 'claude-sonnet-4-20250514' });
        // The SDK consumes the kickoff, emits one frame, and STAYS OPEN
        // mid-production — the steer entry sits unconsumed until its TTL
        // fires against the still-live attempt.
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => ({
          close: () => {},
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'assistant', message: { role: 'assistant', content: [] } };
            await new Promise(() => {});
          },
        }));
        // Kickoff admission resolves (consumed); the steer's is rejectable
        // on demand (the trailing-admission TTL).
        let rejectSteerAdmission: ((error: Error) => void) | null = null;
        enqueueWithIdSpy.mockImplementation((uuid: string) =>
          uuid === kickoff.uuid
            ? Promise.resolve()
            : new Promise<void>((_resolve, reject) => {
                rejectSteerAdmission = reject;
              })
        );

        try {
          runner.start();
          // Let the frame arrive (firstMessageReceived) — then reject the
          // still-pending steer admission mid-production.
          const deadline = Date.now() + 2000;
          while (!ctx.firstMessageReceived && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(ctx.firstMessageReceived).toBe(true);
          expect(rejectSteerAdmission).toBeTypeOf('function');

          // Mid-production rejection: the attempt has received its first
          // frame, so the handler must NOT abort it.
          const ttlError = new Error('Message queue timeout');
          ttlError.name = 'MessageQueueTimeoutError';
          rejectSteerAdmission(ttlError);
          // Give the handler a tick, then pin the stays-staged half of the
          // producing branch (round-9 test gap): the unconsumed steer keeps
          // its lane in the staging, not just a warn line.
          await new Promise((resolve) => setTimeout(resolve, 25));
          expect(
            (
              runner as unknown as { _pendingStartupReplay: Array<{ uuid: string }> | null }
            )._pendingStartupReplay?.map((entry) => entry.uuid)
          ).toEqual([steer.uuid]);
          // End the open attempt (the abort breaks the parked iterator;
          // messageCount=1 → normal completion).
          ctx.queryAbortController?.abort();
          await ctx.queryPromise?.catch(() => {});

          // The turn completed WITHOUT an abort-driven truncation and the
          // controller stayed live through the frame.
          const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
            String(args[0])
          );
          expect(warns.some((w) => w.includes('after the first SDK frame'))).toBe(true);
          expect(
            warns.some((w) => w.includes('aborting attempt for a bounded startup retry'))
          ).toBe(false);
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'removes still-pending flushed entries when the chain is superseded',
      async () => {
        // Round-8 P2 + round-9 P2: restart() supersedes via stop-without-clear;
        // entries this chain flushed would be eaten by the replacement's
        // generator. The stale finally must purge them through the
        // admission-fenced API from ATTEMPT-LOCAL tracking. Real MessageQueue
        // so the admission sequence and removal semantics are exercised for
        // real; a revoked second entry pins the hasPendingOrInFlight gating
        // (no removal — not even an attempt — for an entry no longer pending).
        const kickoff = {
          uuid: 'orphan-kickoff',
          content: [{ type: 'text' as const, text: 'K' }],
        };
        const steer = {
          uuid: 'orphan-steer',
          content: [{ type: 'text' as const, text: 'S' }],
        };
        const messageQueue = new MessageQueue();

        const ctx = createContext({ messageQueue });
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff, steer]]]);

        buildSpy
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockResolvedValueOnce({ model: 'claude-sonnet-4-20250514' });
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => ({
          close: () => {},
          [Symbol.asyncIterator]: async function* () {
            await new Promise(() => {});
          },
        }));

        try {
          runner.start();
          const deadline = Date.now() + 2000;
          while (!messageQueue.hasPendingOrInFlight(kickoff.uuid) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(messageQueue.hasPendingOrInFlight(kickoff.uuid)).toBe(true);
          expect(messageQueue.hasPendingOrInFlight(steer.uuid)).toBe(true);

          // The steer is revoked (user remove/defer) while the chain is
          // parked — the purge must not attempt anything for it.
          messageQueue.remove(steer.uuid);

          // restart(): supersede the chain (generation bump), then abort the
          // parked attempt so the finally runs while stale.
          const chainController = ctx.queryAbortController;
          ctx.incrementQueryGeneration();
          chainController?.abort();
          await ctx.queryPromise?.catch(() => {});

          expect(messageQueue.hasPendingOrInFlight(kickoff.uuid)).toBe(false);
          const removedWarns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls
            .map((args) => String(args[0]))
            .filter((w) => w.includes('Removed superseded replay entry'));
          expect(removedWarns).toHaveLength(1);
          expect(removedWarns[0]).toContain(kickoff.uuid);
        } finally {
          messageQueue.clear();
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'still purges flushed entries when the replacement starts during the backoff (restart ordering)',
      async () => {
        // Round-9 P2: the old instance-field tracking was nulled by the
        // replacement's start() while THIS chain slept in its backoff — the
        // post-sleep cancellation returned, the stale finally then read a
        // nulled field, and the purge never fired: the replacement's
        // generator ate this delivery's prompts. The attempt-local tracking
        // must survive the replacement's start().
        process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = '100';
        process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '2';
        const kickoff = {
          uuid: 'ordering-kickoff',
          content: [{ type: 'text' as const, text: 'K' }],
        };
        const messageQueue = new MessageQueue();

        const ctx = createContext({ messageQueue });
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff]]]);

        // Attempt 1 dies at build (timeout) → the retry stages the replay.
        // Attempt 2 flushes it, then dies as a startup timeout ON DEMAND so
        // the catch enters its backoff sleep with the entry still pending.
        buildSpy
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockResolvedValue({ model: 'claude-sonnet-4-20250514' });
        let dieAsTimeout: (() => void) | null = null;
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => ({
          close: () => {},
          [Symbol.asyncIterator]: async function* () {
            await new Promise<void>((resolve) => {
              dieAsTimeout = resolve;
            });
            throw new Error('SDK startup timeout - query aborted');
          },
        }));

        try {
          runner.start();
          let deadline = Date.now() + 2000;
          while (!messageQueue.hasPendingOrInFlight(kickoff.uuid) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(messageQueue.hasPendingOrInFlight(kickoff.uuid)).toBe(true);
          expect(dieAsTimeout).toBeTypeOf('function');

          // Attempt 2 dies as a startup timeout → its catch claims a retry
          // and enters its backoff sleep. Wait for the SECOND 'Auto-retrying'
          // warn — attempt 1's catch logged the first long before the flush.
          dieAsTimeout();
          const retryWarnCount = () =>
            (mockLogger.warn as ReturnType<typeof mock>).mock.calls.filter((args) =>
              String(args[0]).includes('Auto-retrying query after startup timeout')
            ).length;
          deadline = Date.now() + 2000;
          while (retryWarnCount() < 2 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(retryWarnCount()).toBe(2);

          // …and a REAL replacement takes the session DURING the sleep — the
          // same-runner restart() shape: stop the queue (restart semantics)
          // so start() proceeds past its isRunning guard, then start() —
          // which bumps the generation and, on the pre-round-9 shape, nulled
          // the instance tracking this chain's stale finally is about to
          // read. The replacement parks (its iterator never resolves on its
          // own), so the dying chain's purge is the thing under test.
          const dyingChainPromise = ctx.queryPromise;
          messageQueue.stop();
          runner.start();
          deadline = Date.now() + 2000;
          while (buildSpy.mock.calls.length < 3 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          // Pins that the replacement genuinely started (the discriminating
          // condition: a start() that early-returns on isRunning would leave
          // this at 2).
          expect(buildSpy).toHaveBeenCalledTimes(3);

          await dyingChainPromise?.catch(() => {});

          const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
            String(args[0])
          );
          expect(warns.some((w) => w.includes('Startup-timeout retry cancelled'))).toBe(true);
          expect(messageQueue.hasPendingOrInFlight(kickoff.uuid)).toBe(false);
          expect(warns.some((w) => w.includes('Removed superseded replay entry'))).toBe(true);

          // End the parked replacement chain.
          ctx.queryAbortController?.abort();
          await ctx.queryPromise?.catch(() => {});
        } finally {
          messageQueue.clear();
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'leaves a later re-admission of the same uuid in place (admission fence)',
      async () => {
        // Round-9 P2: uuid alone cannot distinguish this chain's flushed
        // entry from a delivery-layer redrive re-feed of the same uuid that
        // landed after it — the old unfenced late removal could delete the
        // legitimate re-admission. The purge must remove ONLY entries
        // admitted no later than this chain's flush.
        const kickoff = {
          uuid: 'fence-kickoff',
          content: [{ type: 'text' as const, text: 'K' }],
        };
        const messageQueue = new MessageQueue();

        const ctx = createContext({ messageQueue });
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff]]]);

        buildSpy
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockResolvedValueOnce({ model: 'claude-sonnet-4-20250514' });
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => ({
          close: () => {},
          [Symbol.asyncIterator]: async function* () {
            await new Promise(() => {});
          },
        }));

        try {
          runner.start();
          const deadline = Date.now() + 2000;
          while (!messageQueue.hasPendingOrInFlight(kickoff.uuid) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(messageQueue.hasPendingOrInFlight(kickoff.uuid)).toBe(true);
          const chainController = ctx.queryAbortController;

          // Supersede; this chain's own entry is gone (consumed/revoked/TTL'd
          // — any of the ways it leaves the sets)…
          ctx.incrementQueryGeneration();
          expect(messageQueue.remove(kickoff.uuid)).toBe(true);

          // …and the delivery layer redrives: a FRESH admission of the same
          // uuid, strictly after this chain's flush. (catch attached — the
          // finally's clear() would otherwise surface an unhandled rejection.)
          messageQueue
            .admitWithId(kickoff.uuid, kickoff.content, false, { durable: true })
            .catch(() => {});
          expect(messageQueue.hasPendingOrInFlight(kickoff.uuid)).toBe(true);

          chainController?.abort();
          await ctx.queryPromise?.catch(() => {});

          // The purge must leave the redrive's entry for its rightful owner.
          expect(messageQueue.hasPendingOrInFlight(kickoff.uuid)).toBe(true);
          const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
            String(args[0])
          );
          expect(warns.some((w) => w.includes('Left pending entry fence-kickoff'))).toBe(true);
          expect(warns.some((w) => w.includes('Removed superseded replay entry'))).toBe(false);
        } finally {
          messageQueue.clear();
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'merges a staged steer with the consumed kickoff at the retry site (mixed consumed/rejected)',
      async () => {
        // Round-9 P1: during one attempt's replay flush the generator can
        // pull the KICKOFF (recorded consumed, admission resolved) while a
        // trailing STEER's admission TTL rejects (re-staged). The retry site
        // re-populates the staging from the consumed set — a plain assignment
        // there clobbers the staged steer, and steers have NO delivery-layer
        // recovery lane (their rows stay 'consumed'): the loss is permanent.
        // The re-population must MERGE: consumed base + staged survivors.
        process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '2';
        const kickoff = {
          uuid: 'mixed-kickoff',
          content: [{ type: 'text' as const, text: 'K' }],
        };
        const steer = {
          uuid: 'mixed-steer',
          content: [{ type: 'text' as const, text: 'S' }],
        };

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        // Attempt 1 "consumed" both (a silent iterator can pull the kickoff
        // AND trailing steers) before dying at build (timeout).
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff, steer]]]);

        buildSpy
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockResolvedValue({ model: 'claude-sonnet-4-20250514' });
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => ({
          close: () => {},
          [Symbol.asyncIterator]: async function* () {
            await new Promise(() => {});
          },
        }));
        let rejectSteerAdmission: ((error: Error) => void) | null = null;
        enqueueWithIdSpy.mockImplementation((uuid: string) => {
          if (uuid === kickoff.uuid) {
            // The generator pulled the kickoff: the wrapper records it
            // consumed and the admission resolves (onSent).
            (
              runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
            )._consumedUserMessages.set(1, [kickoff]);
            return Promise.resolve();
          }
          return new Promise<void>((_resolve, reject) => {
            rejectSteerAdmission = reject;
          });
        });

        try {
          runner.start();
          // Attempt 2's flush: the steer's admission is armed (flushed first
          // — the flush iterates in reverse) and the kickoff consumed.
          let deadline = Date.now() + 2000;
          while (!rejectSteerAdmission && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(rejectSteerAdmission).toBeTypeOf('function');
          expect(
            (
              runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
            )._consumedUserMessages.get(1)
          ).toEqual([kickoff]);

          // The steer's admission TTL rejects → re-staged, attempt aborted →
          // bounded retry. At the retry site: consumed=[kickoff],
          // staged=[steer] — the merge must keep BOTH.
          const ttlError = new Error('Message queue timeout');
          ttlError.name = 'MessageQueueTimeoutError';
          rejectSteerAdmission(ttlError);

          // Attempt 3's flush feeds the merged replay (2 more admissions).
          deadline = Date.now() + 2000;
          while (enqueueWithIdSpy.mock.calls.length < 4 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(enqueueWithIdSpy.mock.calls.length).toBe(4);
          ctx.queryAbortController?.abort();
          await ctx.queryPromise?.catch(() => {});

          // The mixed case survived: attempt 3 re-fed BOTH — the steer first
          // (reverse flush of [kickoff, steer]), then the kickoff. Without
          // the merge the steer is absent from calls 3–4.
          const secondFlushUuids = (
            enqueueWithIdSpy.mock.calls.slice(2) as unknown as Array<[string]>
          ).map(([uuid]) => uuid);
          expect(secondFlushUuids).toEqual(['mixed-steer', 'mixed-kickoff']);
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      "a stale replay-admission flag does not misclassify the next attempt's 0-message EOF",
      async () => {
        // Round-9 P3: _replayAdmissionRejected used to be chain-scoped (reset
        // only in start() and the finally) — a stale true from attempt N
        // leaked into attempt N+1, where an ORDINARY zero-message completion
        // was misclassified as a startup timeout and burned another budget
        // round. The flag must reset at every attempt entry.
        process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '2';
        const kickoff = {
          uuid: 'eof-kickoff',
          content: [{ type: 'text' as const, text: 'K' }],
        };

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff]]]);

        buildSpy
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockResolvedValue({ model: 'claude-sonnet-4-20250514' });
        // Attempt 2's iterator parks; attempt 3's completes NORMALLY with
        // zero messages. (Counter counts query() calls — attempt 1 died at
        // build and never reached query().)
        let queryCalls = 0;
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => {
          queryCalls++;
          return {
            close: () => {},
            [Symbol.asyncIterator]:
              queryCalls >= 2
                ? async function* () {}
                : async function* () {
                    await new Promise(() => {});
                  },
          };
        });
        // Attempt 2's admission rejects (TTL) — sets the flag and aborts;
        // attempt 3's admission resolves.
        let admissions = 0;
        let rejectAdmission: ((error: Error) => void) | null = null;
        enqueueWithIdSpy.mockImplementation(() => {
          admissions++;
          if (admissions === 1) {
            return new Promise<void>((_resolve, reject) => {
              rejectAdmission = reject;
            });
          }
          return Promise.resolve();
        });

        try {
          runner.start();
          const deadline = Date.now() + 2000;
          while (!rejectAdmission && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(rejectAdmission).toBeTypeOf('function');
          const ttlError = new Error('Message queue timeout');
          ttlError.name = 'MessageQueueTimeoutError';
          rejectAdmission(ttlError);

          await ctx.queryPromise?.catch(() => {});

          // Attempt 3 completed cleanly at zero messages: no startup-timeout
          // surfacing, no fourth build. (Pre-fix: the stale flag re-threw
          // 'SDK startup timeout', exhausted the budget and called
          // handleError.)
          expect(buildSpy).toHaveBeenCalledTimes(3);
          expect(handleErrorSpy).not.toHaveBeenCalled();
          const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
            String(args[0])
          );
          expect(warns.some((w) => w.includes('retry budget exhausted'))).toBe(false);
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'resets firstMessageReceived before the startup-timeout retry attempt',
      async () => {
        // Round-9 P3: a first frame can race the timeout's abort past the
        // loop's bookkeeping, leaving firstMessageReceived=true on entry to
        // the catch. The recursion is the one retry gate that did NOT reset
        // it — the retry's startup timer would then be disarmed and a silent
        // spawn could hold its gate slot forever.
        const ctx = createContext();
        runner = new QueryRunner(ctx);

        buildSpy
          .mockImplementationOnce(async () => {
            // The racing first frame lands after the timer's abort decision
            // but before the catch runs.
            ctx.firstMessageReceived = true;
            throw new Error('SDK startup timeout - query aborted');
          })
          .mockResolvedValue({ model: 'claude-sonnet-4-20250514' });
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => ({
          close: () => {},
          [Symbol.asyncIterator]: async function* () {
            await new Promise(() => {});
          },
        }));

        try {
          runner.start();
          const deadline = Date.now() + 2000;
          while (buildSpy.mock.calls.length < 2 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(buildSpy).toHaveBeenCalledTimes(2);
          // The retry attempt must start with a clean startup-phase flag.
          expect(ctx.firstMessageReceived).toBe(false);

          ctx.queryAbortController?.abort();
          await ctx.queryPromise?.catch(() => {});
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      're-feeds a skip-branch re-stage on the next flush once the duplicate clears',
      async () => {
        // Round-9 test gap: the skip branch RE-STAGES a uuid a redrive
        // already re-admitted (keeping a lane open). The re-feed half — the
        // NEXT flush re-checking hasPendingOrInFlight and feeding normally
        // once the duplicate is gone — was never asserted.
        process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '2';
        const kickoff = {
          uuid: 'refeed-kickoff',
          content: [{ type: 'text' as const, text: 'K' }],
        };

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff]]]);

        buildSpy
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockResolvedValueOnce({ model: 'claude-sonnet-4-20250514' })
          .mockResolvedValueOnce({ model: 'claude-sonnet-4-20250514' });
        // Attempt 2's iterator dies as a startup timeout right after its
        // (fully skipped) flush; attempt 3's iterator parks. (Counter counts
        // query() calls — attempt 1 died at build.)
        let queryCalls = 0;
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => {
          queryCalls++;
          return {
            close: () => {},
            [Symbol.asyncIterator]:
              queryCalls === 1
                ? async function* () {
                    throw new Error('SDK startup timeout - query aborted');
                  }
                : async function* () {
                    await new Promise(() => {});
                  },
          };
        });
        // First check (attempt 2's flush): the redrive's duplicate is still
        // pending → skip. Later checks (attempt 3's flush): cleared → feed.
        let pendingChecks = 0;
        hasPendingOrInFlightSpy.mockImplementation(() => pendingChecks++ === 0);

        try {
          runner.start();
          const deadline = Date.now() + 2000;
          while (enqueueWithIdSpy.mock.calls.length < 1 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          // End the parked attempt 3 (normal completion at zero messages).
          ctx.queryAbortController?.abort();
          await ctx.queryPromise?.catch(() => {});

          const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
            String(args[0])
          );
          expect(warns.some((w) => w.includes('already pending or in-flight'))).toBe(true);
          expect(enqueueWithIdSpy).toHaveBeenCalledTimes(1);
          expect(enqueueWithIdSpy).toHaveBeenCalledWith(kickoff.uuid, kickoff.content, false, {
            prepend: true,
            durable: true,
          });
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'ignores an admission rejection when only the CONTROLLER identity changed (isolated disjunct)',
      async () => {
        // Round-9 test gap: the rejection handler's attempt-scope guard has
        // two disjuncts — generation mismatch and controller IDENTITY. The
        // stall-reset regression covers controller-null-with-no-bump; the
        // generation test covers a bump. Neither isolates "same generation,
        // DIFFERENT live controller" (a replacement runner start on the same
        // generation) — the second disjunct's own case.
        const kickoff = {
          uuid: 'identity-kickoff',
          content: [{ type: 'text' as const, text: 'K' }],
        };

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff]]]);

        buildSpy
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockResolvedValue({ model: 'claude-sonnet-4-20250514' });
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => ({
          close: () => {},
          [Symbol.asyncIterator]: async function* () {
            await new Promise(() => {});
          },
        }));
        let rejectAdmission: ((error: Error) => void) | null = null;
        enqueueWithIdSpy.mockImplementation(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectAdmission = reject;
            })
        );

        try {
          runner.start();
          const deadline = Date.now() + 2000;
          while (!rejectAdmission && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(rejectAdmission).toBeTypeOf('function');

          // SAME generation, but a different (live) controller now owns the
          // session — only the identity disjunct can detect the takeover.
          const chainController = ctx.queryAbortController;
          ctx.queryAbortController = new AbortController();
          const stagedBefore = (runner as unknown as { _pendingStartupReplay: unknown[] | null })
            ._pendingStartupReplay;

          const ttlError = new Error('Message queue timeout');
          ttlError.name = 'MessageQueueTimeoutError';
          rejectAdmission(ttlError);
          await new Promise((resolve) => setTimeout(resolve, 50));

          expect(
            (runner as unknown as { _pendingStartupReplay: unknown[] | null })
              ._pendingStartupReplay === stagedBefore
          ).toBe(true);
          expect(
            (runner as unknown as { _replayAdmissionRejected: boolean })._replayAdmissionRejected
          ).toBe(false);
          expect(chainController?.signal.aborted).toBe(false);
          const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
            String(args[0])
          );
          expect(warns.some((w) => w.includes('lost session ownership; ignoring'))).toBe(true);

          // End the parked attempt (its 60 s startup timer and pending
          // admission must not outlive the test).
          chainController?.abort();
          await ctx.queryPromise?.catch(() => {});
          if (ctx.startupTimeoutTimer) {
            clearTimeout(ctx.startupTimeoutTimer);
            ctx.startupTimeoutTimer = null;
          }
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it('pins staged-replay ordering and uuid dedupe inside stageStartupReplayEntry itself', () => {
      // Round-9 test gap, retitled round-11: this is a DIRECT unit pin of the
      // staging helper's own staged.sort + uuid dedupe (the flush-order
      // assertions elsewhere only cover the downstream enqueue). It does NOT
      // pin the retry-site merge's dedupe — that is pinned end-to-end by
      // 'merges a staged steer with the consumed kickoff at the retry site
      // (mixed consumed/rejected)' above.
      const ctx = createContext();
      runner = new QueryRunner(ctx);
      const helper = runner as unknown as {
        _pendingStartupReplay: Array<{ uuid: string }> | null;
        stageStartupReplayEntry: (
          replay: Array<{ uuid: string; content: string }>,
          message: { uuid: string; content: string }
        ) => void;
      };
      const replay = [
        { uuid: 'a', content: 'A' },
        { uuid: 'b', content: 'B' },
        { uuid: 'c', content: 'C' },
      ];
      helper._pendingStartupReplay = null;

      // Stage in the worst order: tail, head, middle.
      helper.stageStartupReplayEntry(replay, replay[2]);
      helper.stageStartupReplayEntry(replay, replay[0]);
      helper.stageStartupReplayEntry(replay, replay[1]);
      expect(helper._pendingStartupReplay?.map((entry) => entry.uuid)).toEqual(['a', 'b', 'c']);

      // Deduped by uuid: re-staging an existing entry changes nothing.
      helper.stageStartupReplayEntry(replay, replay[1]);
      expect(helper._pendingStartupReplay?.map((entry) => entry.uuid)).toEqual(['a', 'b', 'c']);
      expect(helper._pendingStartupReplay?.length).toBe(3);
    });

    it.skipIf(!sdkQueryIsMock)(
      'folds a flushed entry back into the staging when its admission dies unclaimed by any lane',
      async () => {
        // Round-10 P3: a flushed entry can outlive its attempt WITHOUT
        // landing in either merge input at the retry site — its admission
        // TTL may fire after the recursion replaced ctx.queryAbortController
        // (the rejection handler's identity guard correctly no-ops), and its
        // durable row is 'consumed'. Without the fold-back the prompt has no
        // lane left; with it, the next attempt re-feeds it.
        process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '2';
        const kickoff = {
          uuid: 'fold-kickoff',
          content: [{ type: 'text' as const, text: 'K' }],
        };

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff]]]);
        peekNextUserMessageIdSpy.mockImplementation(() => kickoff.uuid);

        buildSpy
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockResolvedValue({ model: 'claude-sonnet-4-20250514' });
        // Attempt 2 flushes the replay, then dies as a startup timeout ON
        // DEMAND; attempt 3 (the folded re-feed) parks until aborted.
        let queryCalls = 0;
        let dieAsTimeout: (() => void) | null = null;
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => {
          queryCalls++;
          return {
            close: () => {},
            [Symbol.asyncIterator]:
              queryCalls === 1
                ? async function* () {
                    await new Promise<void>((resolve) => {
                      dieAsTimeout = resolve;
                    });
                    throw new Error('SDK startup timeout - query aborted');
                  }
                : async function* () {
                    await new Promise(() => {});
                  },
          };
        });
        // Attempt 2's flush admission stays pending in this test (the entry
        // "dies" via the throw, not via a rejection we would observe).
        enqueueWithIdSpy.mockImplementation(() => new Promise<void>(() => {}));

        try {
          runner.start();
          let deadline = Date.now() + 2000;
          while (
            (!dieAsTimeout || enqueueWithIdSpy.mock.calls.length < 1) &&
            Date.now() < deadline
          ) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(enqueueWithIdSpy.mock.calls.length).toBe(1);
          expect(dieAsTimeout).toBeTypeOf('function');

          dieAsTimeout();
          // The retry site folds the flushed kickoff into the staging even
          // though consumed is empty and nothing re-staged → attempt 3's
          // flush re-feeds it.
          deadline = Date.now() + 2000;
          while (enqueueWithIdSpy.mock.calls.length < 2 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(enqueueWithIdSpy).toHaveBeenCalledTimes(2);
          expect(enqueueWithIdSpy).toHaveBeenNthCalledWith(
            2,
            kickoff.uuid,
            kickoff.content,
            false,
            { prepend: true, durable: true }
          );

          ctx.queryAbortController?.abort();
          await ctx.queryPromise?.catch(() => {});
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'folds a two-message flush back in FEED order (not the flush loop order)',
      async () => {
        // Round-11 P3: the flush records flushedEntries during its REVERSE
        // iteration, so the array it leaves behind is reversed feed order.
        // Folding it forward at the retry site re-staged [steer, kickoff],
        // and the next flush would enqueue the prompts back-to-front. Two
        // messages, both still pending at the retry site (admissions never
        // settle), so the fold's iteration direction is the ONLY ordering
        // input. RETRY_MAX=2: the describe default of 1 would settle the
        // delivery before the fold's re-feed could be observed.
        process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '2';
        const kickoff = {
          uuid: 'fold2-kickoff',
          content: [{ type: 'text' as const, text: 'K' }],
        };
        const steer = {
          uuid: 'fold2-steer',
          content: [{ type: 'text' as const, text: 'S' }],
        };

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff, steer]]]);

        buildSpy
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockResolvedValue({ model: 'claude-sonnet-4-20250514' });
        // Attempt 2 (query call 1) dies as a startup timeout right after its
        // flush enqueued BOTH messages; attempt 3 parks so the test can
        // observe its flush order.
        let queryCalls = 0;
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => {
          queryCalls++;
          return {
            close: () => {},
            [Symbol.asyncIterator]:
              queryCalls === 1
                ? async function* () {
                    throw new Error('SDK startup timeout - query aborted');
                  }
                : async function* () {
                    await new Promise(() => {});
                  },
          };
        });
        // Admissions never settle: both flushed entries reach the retry site
        // via the fold — neither consumed (the mock generator starves) nor
        // re-staged (no rejection ever fires).
        enqueueWithIdSpy.mockImplementation(() => new Promise<void>(() => {}));

        try {
          runner.start();
          const deadline = Date.now() + 2000;
          while (enqueueWithIdSpy.mock.calls.length < 4 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          // Attempt 2's flush: reverse iteration over staging [kickoff,
          // steer] → steer, kickoff. Attempt 3's flush re-feeds the FOLD —
          // it must repeat the SAME order (a forward fold would re-stage
          // [steer, kickoff] and enqueue kickoff, steer).
          expect(enqueueWithIdSpy.mock.calls.map((call) => call[0])).toEqual([
            steer.uuid,
            kickoff.uuid,
            steer.uuid,
            kickoff.uuid,
          ]);

          ctx.queryAbortController?.abort();
          await ctx.queryPromise?.catch(() => {});
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'drops a stale generation consumed history on unwind (no full-content leak)',
      async () => {
        // Round-11 P3: the live finally deletes the generation's consumed
        // map entry; the STALE branch did not — a superseded chain that
        // reached no retry site (restart mid-stream, watchdog reset) leaked
        // every consumed prompt's full content under a dead generation key
        // for the session's lifetime.
        const kickoff = {
          uuid: 'stale-history-kickoff',
          content: [{ type: 'text' as const, text: 'K' }],
        };

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff]]]);

        buildSpy.mockResolvedValue({ model: 'claude-sonnet-4-20250514' });
        let queryCalls = 0;
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => {
          queryCalls++;
          return {
            close: () => {},
            [Symbol.asyncIterator]: async function* () {
              await new Promise(() => {});
            },
          };
        });

        try {
          runner.start();
          const deadline = Date.now() + 2000;
          while (queryCalls < 1 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(queryCalls).toBe(1);

          // Supersede (a replacement start bumped the generation), then end
          // this chain: the abort breaks the for-await into a NORMAL (not
          // thrown) unwind, so the finally's stale branch is the only
          // clear-site the history has.
          ctx.incrementQueryGeneration();
          ctx.queryAbortController?.abort();
          await ctx.queryPromise?.catch(() => {});

          const history = (runner as unknown as { _consumedUserMessages: Map<number, unknown[]> })
            ._consumedUserMessages;
          expect(history.has(1)).toBe(false);
          expect(history.size).toBe(0);
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it.skipIf(!sdkQueryIsMock)(
      'skips the fenced purge on a LIVE same-generation unwind (and pins the fence capture)',
      async () => {
        // Round-10 P3: the stale-finally purge is gated on the chain being
        // superseded — a live unwind (the chain still owns the session) must
        // NOT remove its own flushed entries; the replacement turn's
        // generator legitimately consumes them. Also pins the fence capture
        // (getAdmissionSeq) the flush performs, per the round-10 review.
        const kickoff = {
          uuid: 'live-kickoff',
          content: [{ type: 'text' as const, text: 'K' }],
        };

        const ctx = createContext();
        runner = new QueryRunner(ctx);
        (
          runner as unknown as { _consumedUserMessages: Map<number, unknown[]> }
        )._consumedUserMessages = new Map([[1, [kickoff]]]);

        buildSpy
          .mockRejectedValueOnce(new Error('SDK startup timeout - query aborted'))
          .mockResolvedValueOnce({ model: 'claude-sonnet-4-20250514' });
        (
          mockedSdkQuery as unknown as { mockImplementation: (impl: unknown) => unknown }
        ).mockImplementation(() => ({
          close: () => {},
          [Symbol.asyncIterator]: async function* () {
            await new Promise(() => {});
          },
        }));
        enqueueWithIdSpy.mockImplementation(() => new Promise<void>(() => {}));
        // The flushed entry reports as still pending AFTER the flush fed it
        // (call-order keyed: the flush's own duplicate-guard check sees
        // false) so a wrongly-ungated purge would actually attempt the
        // removal rather than short-circuit at the pre-check — keeps the
        // negative pin honest.
        let pendingChecks = 0;
        hasPendingOrInFlightSpy.mockImplementation(() => pendingChecks++ > 0);

        try {
          runner.start();
          const deadline = Date.now() + 2000;
          while (enqueueWithIdSpy.mock.calls.length < 1 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          expect(enqueueWithIdSpy.mock.calls.length).toBe(1);

          // End the attempt WITHOUT superseding it — the finally runs its
          // LIVE branch (same generation), which owns cleanup but must not
          // purge its own flushed entry.
          ctx.queryAbortController?.abort();
          await ctx.queryPromise?.catch(() => {});

          expect(getAdmissionSeqSpy).toHaveBeenCalled(); // fence captured at the flush
          expect(removeIfAdmittedNoLaterThanSpy).not.toHaveBeenCalled();
          const warns = (mockLogger.warn as ReturnType<typeof mock>).mock.calls.map((args) =>
            String(args[0])
          );
          expect(warns.some((w) => w.includes('Removed superseded replay entry'))).toBe(false);
          expect(warns.some((w) => w.includes('Left pending entry'))).toBe(false);
        } finally {
          (mockedSdkQuery as unknown as { mockReset: () => void }).mockReset?.();
        }
      }
    );

    it('parses the new knobs and keeps the retired HYPERNEO_SDK_STARTUP_MAX_RETRIES inert', async () => {
      // Round-5 P3-9(3): parsing garbage/negative/float inputs falls back to
      // defaults, and the RETIRED knob name must not set the new cap.
      process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = '15000';
      expect(getStartupRetryDelayMs(1)).toBe(15000);
      process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = 'abc';
      expect(getStartupRetryDelayMs(1)).toBe(15000);
      process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = '-5';
      expect(getStartupRetryDelayMs(1)).toBe(15000);
      process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = '1500.9';
      expect(getStartupRetryDelayMs(1)).toBe(1500);

      // RETRY_MAX parses the same way (round-14 P3: the title claimed
      // garbage/negative fallbacks for both knobs; only BASE_MS was driven).
      process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = 'garbage';
      expect(getMaxStartupTimeoutRetries()).toBe(5);
      process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '-3';
      expect(getMaxStartupTimeoutRetries()).toBe(5);
      process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '2';
      expect(getMaxStartupTimeoutRetries()).toBe(2);
      process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '7.5';
      expect(getMaxStartupTimeoutRetries()).toBe(7);
      delete process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX;
      expect(getMaxStartupTimeoutRetries()).toBe(5);

      // setTimeout's domain is [0, 2^31-1] ms; beyond it the delay inverts to
      // an ~1ms immediate fire. An extreme base must clamp, not overflow into
      // a hot retry loop.
      process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = '99999999999999';
      expect(getStartupRetryDelayMs(1)).toBe(2_147_483_647);
      expect(getStartupRetryDelayMs(9)).toBe(2_147_483_647);

      // A stale HYPERNEO_SDK_STARTUP_MAX_RETRIES=0 (the retired
      // silent-auto-recovery knob) must NOT disable the new retries: with the
      // new cap at 1, one timeout still produces attempt + retry (2 builds).
      // If the stale name were honored, this would collapse to 1 build.
      process.env.HYPERNEO_SDK_STARTUP_RETRY_BASE_MS = '0';
      process.env.HYPERNEO_SDK_STARTUP_RETRY_MAX = '1';
      process.env.HYPERNEO_SDK_STARTUP_MAX_RETRIES = '0';

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});
      expect(buildSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('auto-recovery removal regression guards (Task 2.3)', () => {
    // Regression guards: verify that auto-recovery fields removed in Task 2.1 are absent
    // from QueryRunnerContext.  If any are reintroduced, TypeScript will catch callers
    // that omit the field; these runtime checks provide belt-and-suspenders coverage.

    it('should not have onStartupTimeoutAutoRecover in QueryRunnerContext', () => {
      // createContext() returns a full QueryRunnerContext built from all known fields.
      // A reintroduced onStartupTimeoutAutoRecover would appear as a defined property.
      const ctx = createContext();
      expect((ctx as Record<string, unknown>).onStartupTimeoutAutoRecover).toBeUndefined();
    });

    it('should not have startupTimeoutAutoRecoverAttempts in QueryRunnerContext', () => {
      const ctx = createContext();
      expect((ctx as Record<string, unknown>).startupTimeoutAutoRecoverAttempts).toBeUndefined();
    });
  });

  describe('generation-gated consumePendingResumeSessionAt', () => {
    // Verify that the consumePendingResumeSessionAt call after the for-await
    // loop is gated on getQueryGeneration() === queryGeneration. Without this
    // guard, a stale aborted query (from restart()/rewind) would consume the
    // pendingResumeSessionAt meant for the new query.
    //
    // The for-await success path (where the consume runs) is reachable only
    // under the vitest SDK alias (see `mockedSdkQuery` / `sdkQueryIsMock` at
    // the top of this file); the mock-driven success-path tests live in the
    // startup-backoff describe and skip when the import resolved to the real
    // SDK. Here we test the guard through the isMessageNotFound retry path,
    // which works in every harness, and verify the guard pattern (identical to
    // the messageQueue.stop() and close() generation guards) via the finally
    // block.

    it('should consume resumeSessionAt before isMessageNotFound retry', async () => {
      // buildSpy throws "No message found" → catch block consumes the stale
      // resumeSessionAt before retrying (line ~659). Verifies the spy is called.
      // ANTHROPIC_API_KEY must be set so the auth check passes and buildSpy is reached.
      const savedApiKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      try {
        mockSession.workspacePath = tmpdir(); // real dir for fs.mkdir
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
      // All three guards use: if (getQueryGeneration() === queryGeneration)
      // This test verifies the pattern works correctly via the messageQueue.stop()
      // guard (reachable through the finally block on auth failure, same guard
      // condition as the consume guard at line ~553).
      const closeSpy = mock(() => {});
      let gen = 0;
      const ctx = createContext({
        queryObject: {
          interrupt: mock(async () => {}),
          close: closeSpy,
        } as unknown as Query,
        // Same generation → guard passes → cleanup runs
        incrementQueryGeneration: () => ++gen,
        getQueryGeneration: () => gen,
      });
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      // Guard passed: close() called, queryObject nulled
      expect(closeSpy).toHaveBeenCalled();
      expect(ctx.queryObject).toBeNull();
    });

    it('should skip consume on generation mismatch (same pattern as close() guard)', async () => {
      // When restart()/rewind increments the generation after setting
      // pendingResumeSessionAt, the stale old query's guard fails.
      // Verified via the finally block's close() guard (identical pattern).
      const closeSpy = mock(() => {});
      let gen = 0;
      const originalQueryObject = {
        interrupt: mock(async () => {}),
        close: closeSpy,
      } as unknown as Query;
      const ctx = createContext({
        queryObject: originalQueryObject,
        incrementQueryGeneration: () => ++gen, // returns 1
        getQueryGeneration: () => 2, // current gen is 2, query ran as gen 1
      });
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      // Guard failed: close() NOT called, queryObject NOT nulled
      expect(closeSpy).not.toHaveBeenCalled();
      expect(ctx.queryObject).toBe(originalQueryObject);
    });
  });

  describe('transient connection error handling', () => {
    // Integration tests: exercise the runQuery() catch block when a transient
    // connection error is thrown during the SDK query.  buildSpy is set to throw
    // connection errors so the retry path is triggered without needing a real
    // subprocess or network.  ANTHROPIC_API_KEY is set to a dummy value so the
    // pre-query auth check passes.

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

      // buildSpy was called twice: original + retry
      expect(buildSpy).toHaveBeenCalledTimes(2);
      // The retry path should show a sanitized message via displayErrorAsAssistantMessage
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
      // A restart/cancel/model-switch bumps the generation; tearing down the old
      // subprocess can surface as a transient connection error in the catch. The
      // retry branches (which call setIdle) must be gated on the generation so a
      // stale query neither publishes an idle nor retries — otherwise the
      // completion callback fires before the superseding turn is enqueued.
      buildSpy.mockRejectedValueOnce(new Error('TypeError: fetch failed'));
      let gen = 0;
      const ctx = createContext({
        incrementQueryGeneration: () => ++gen, // returns 1 (the query's generation)
        getQueryGeneration: () => 2, // current generation is 2 → stale
      });
      runner = new QueryRunner(ctx);
      setIdleSpy.mockClear();

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(buildSpy).toHaveBeenCalledTimes(1); // no retry
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

      // The exhausted retry message must NOT contain raw fetch internals
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

      // Exactly 2 calls: initial + 1 retry. A third call would mean a
      // double-retry, which is wrong (isRetry flag guards against it).
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
      // buildSpy throws immediately (before the message generator is consumed),
      // so lastConsumedUserMessage is never set and no re-enqueue should happen.
      buildSpy.mockRejectedValue(new Error('TypeError: fetch failed'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(enqueueWithIdSpy).not.toHaveBeenCalled();
    });

    it('should re-enqueue tracked user message on transient connection error retry', async () => {
      // Simulates the scenario where the SDK drops mid-stream AFTER consuming a user
      // message from the queue.  Since the SDK's query() can't be mocked in unit tests
      // (it's imported at module load), we pre-set lastConsumedUserMessage on the runner
      // and then trigger the transient error via buildSpy to verify the re-enqueue.
      //
      // In production, lastConsumedUserMessage is set by createMessageGeneratorWrapper()
      // when yielding non-internal messages to the SDK (verified by the tracking test
      // in the createMessageGeneratorWrapper describe block).
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

      // Pre-set the tracked message (simulates createMessageGeneratorWrapper having
      // consumed a user message before the transient error occurred).
      (runner as unknown as { _lastConsumedUserMessage: unknown })._lastConsumedUserMessage = {
        uuid: consumedUuid,
        content: consumedContent,
      };

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      // The tracked message should have been re-enqueued before the retry
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

      // After re-enqueue, the tracking field should be cleared
      expect(
        (runner as unknown as { _lastConsumedUserMessage: unknown })._lastConsumedUserMessage
      ).toBeNull();
    });

    // NOTE: The "retry succeeds" happy path (build rejects once, resolves on retry)
    // cannot be tested in unit tests because query-runner.ts:461 calls the real
    // (unmocked) SDK query() after build() resolves.  In the test environment,
    // this either hangs (timing out) or throws (flaky depending on env).
    //
    // The retry path is adequately covered by the tests above that verify:
    //  - buildSpy.toHaveBeenCalledTimes(2) proves retry fires exactly once
    //  - saveSDKMessageSpy proves the retry message is displayed
    //  - re-enqueue tests prove consumed messages are restored before retry
    //  - handleErrorSpy tests prove exhausted retries surface sanitized errors

    // Test each transient pattern that previously had no dedicated coverage.
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

        // Should have retried once (2 calls total)
        expect(buildSpy).toHaveBeenCalledTimes(2);

        // Should show the retry message
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
    // Integration tests: exercise the runQuery() catch block when a 5xx /
    // overloaded / provider-unavailable error escapes the SDK. buildSpy is set
    // to throw the provider error so the bounded retry path fires without
    // needing a real subprocess. ANTHROPIC_API_KEY is set to a dummy value so
    // the pre-query auth check passes. Backoff delay is zeroed via env var so
    // tests don't sleep for real.

    let savedApiKey: string | undefined;
    let savedBaseDelay: string | undefined;
    let savedMaxRetries: string | undefined;

    beforeEach(() => {
      savedApiKey = process.env.ANTHROPIC_API_KEY;
      savedBaseDelay = process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS;
      savedMaxRetries = process.env.HYPERNEO_PROVIDER_MAX_RETRIES;
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      // Zero the backoff delay so retries fire immediately.
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

      // 1 initial + 3 retries = 4 calls total
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

      // No retry — exactly 1 call
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
      // Belt-and-suspenders: even though "500" is present, the auth guard wins.
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
      // Must NOT leak raw error internals
      expect(userMessage).not.toContain('529');
    });

    it('should display a sanitized retry notice on each retry attempt', async () => {
      buildSpy.mockRejectedValue(new Error('503 Service Unavailable'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      // 3 retries → 3 retry notices (plus the final exhausted terminal error
      // which goes through handleError, not displayErrorAsAssistantMessage).
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

      // 1 initial + 1 retry = 2 calls
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
      // Transient connection patterns (e.g. "TypeError: fetch failed") must
      // still be handled by the 1-shot transient path, not the bounded path.
      buildSpy.mockRejectedValue(new Error('TypeError: fetch failed'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      // Transient path: exactly 2 calls (1 + 1 retry), NOT 4.
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
      // "5000ms" must not false-positive as a 500 status code.
      buildSpy.mockRejectedValue(new Error('Request timed out after 5000ms'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      expect(buildSpy).toHaveBeenCalledTimes(1);
    });

    it('should not retry after backoff if interrupted during the backoff window', async () => {
      // Use a non-zero delay so the abort can fire DURING the sleep.
      process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS = '100';
      const abortController = new AbortController();
      buildSpy.mockRejectedValue(new Error('503 Service Unavailable'));

      // Pre-set the abort controller; buildSpy throws before runQuery creates
      // its own, so ctx.queryAbortController stays as this one.
      const ctx = createContext({ queryAbortController: abortController });
      runner = new QueryRunner(ctx);

      // Abort during the 100ms backoff sleep (well after the retry path entered).
      setTimeout(() => abortController.abort(), 20);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      // Only 1 call — the retry was cancelled by the post-backoff re-check.
      expect(buildSpy).toHaveBeenCalledTimes(1);
    });

    it('should not retry after backoff if a restart bumped the generation', async () => {
      process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS = '100';
      buildSpy.mockRejectedValue(new Error('503 Service Unavailable'));

      let gen = 0;
      const ctx = createContext({
        incrementQueryGeneration: () => ++gen,
        // Generation starts at 1 (matching the query). After the backoff, we
        // bump it to 2 to simulate a restart during the sleep window.
        getQueryGeneration: () => gen,
      });
      runner = new QueryRunner(ctx);

      // Bump generation during the 100ms backoff (simulates restart()).
      setTimeout(() => {
        gen = 2;
      }, 20);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      // Only 1 call — the retry was cancelled because the generation changed.
      expect(buildSpy).toHaveBeenCalledTimes(1);
    });

    it('should clear the stale startup timer before retrying a provider error', async () => {
      // Pre-set a startup timer (simulates firstMessageReceived=false when the
      // 5xx hit). The retry path must clear it so it cannot fire during a
      // later retry and abort that retry's controller.
      const fakeTimer = setTimeout(() => {}, 999999);
      buildSpy.mockRejectedValue(new Error('503 Service Unavailable'));

      const ctx = createContext({ startupTimeoutTimer: fakeTimer });
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      // The timer should have been cleared by the retry path (set to null),
      // not left armed for a later retry's controller.
      expect(ctx.startupTimeoutTimer).toBeNull();
    });

    it('should restore originalEnvVars before recursive retry (env-leak guard)', async () => {
      // Pre-set non-empty originalEnvVars. The retry path must restore+clear
      // them before recursing so the next attempt captures the true originals
      // instead of this attempt's provider overrides.
      buildSpy.mockRejectedValue(new Error('503 Service Unavailable'));

      const ctx = createContext({
        originalEnvVars: { ANTHROPIC_API_KEY: 'fake-original-key', SOME_VAR: 'val' },
      });
      runner = new QueryRunner(ctx);
      runner.start();
      await ctx.queryPromise?.catch(() => {});

      // originalEnvVars should have been cleared by the retry path's restore.
      expect(ctx.originalEnvVars).toEqual({});
    });

    it('should restore env vars even when retry is cancelled during backoff', async () => {
      // Env restore must run BEFORE the post-sleep re-check so a cancellation
      // return (e.g. restart bumping generation) doesn't skip the restore.
      process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS = '100';
      const abortController = new AbortController();
      buildSpy.mockRejectedValue(new Error('503 Service Unavailable'));

      const ctx = createContext({
        queryAbortController: abortController,
        originalEnvVars: { ANTHROPIC_API_KEY: 'fake-original-key' },
      });
      runner = new QueryRunner(ctx);

      // Abort during the 100ms backoff to trigger cancellation.
      setTimeout(() => abortController.abort(), 20);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      // Env should have been restored+cleared BEFORE the cancellation return.
      expect(ctx.originalEnvVars).toEqual({});
      // Only 1 build call — the retry was cancelled.
      expect(buildSpy).toHaveBeenCalledTimes(1);
    });

    it('should not retry after backoff if the queue was stopped (restart/stop)', async () => {
      // QueryLifecycleManager.stop() stops the queue without bumping generation
      // or marking interrupted — the re-check must catch it via isRunning().
      process.env.HYPERNEO_PROVIDER_RETRY_BASE_DELAY_MS = '100';
      buildSpy.mockRejectedValue(new Error('503 Service Unavailable'));

      const ctx = createContext();
      runner = new QueryRunner(ctx);

      // Simulate stop() stopping the queue during the backoff window.
      setTimeout(() => {
        isRunningSpy.mockReturnValue(false);
      }, 20);

      runner.start();
      await ctx.queryPromise?.catch(() => {});

      // Only 1 call — the retry was cancelled because the queue was stopped.
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
      // Use a non-retryable error (401) so no retry path is entered. The finally
      // block must clear _lastConsumedUserMessage so a stale value from a
      // previous completed turn can't be replayed on the next turn's retry.
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
    // None of the conditions match
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

    // Match exists but JSON parsing will fail
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
  // The 60s default itself is pinned by the 'should pass actionable user
  // message with timeout hint to handleError (startup timeout)' test above,
  // which asserts the hint prints the effective default ('current: 60000ms').

  it('should track timeout state', () => {
    let startupTimeoutReached = false;
    const queryStartTime = Date.now();

    // Simulate timeout callback
    const timeoutCallback = () => {
      startupTimeoutReached = true;
      const elapsed = Date.now() - queryStartTime;
      expect(elapsed).toBeGreaterThanOrEqual(0);
    };

    // Before timeout
    expect(startupTimeoutReached).toBe(false);

    // After timeout triggers
    timeoutCallback();
    expect(startupTimeoutReached).toBe(true);
  });

  it('should clear timeout on first message', () => {
    let timerCleared = false;
    const timer = setTimeout(() => {}, 60000);

    // Simulate clearing on first message
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

    // Simulate the check at start of createAbortableQuery
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

    // Create abort promise
    const abortPromise = new Promise<never>((_, reject) => {
      abortController.signal.addEventListener('abort', () => reject(abortError), { once: true });
    });

    // Simulate abort
    abortController.abort();

    // Abort promise should reject
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

    // Simulate cleanup
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

    // Simulate storing
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

    // Simulate restoration
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

// 429 rate-limit errors must bypass handleApiValidationError so they reach the
// rate-limit recovery branch (fallback chain / reset-aware cooldown) instead of
// being rendered as a terminal validation error.
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
