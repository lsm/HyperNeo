import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type {
  AgentProcessingState,
  ContextInfo,
  McpServerConfig,
  MessageHub,
  Provider,
  RewindMode,
  SelectiveRewindResult,
  Session,
  SessionConfig,
} from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { AgentSession } from '../../../../src/lib/agent/agent-session';
import {
  ACP_DELIVERY_CONSUMPTION_TIMEOUT_MS,
  clearContextClearBoundariesForTest,
  deliverMessage,
  MessageDeliveryRecoverableTurnError,
  MessageDeliveryTerminalTurnError,
  signalDeliveryConsumed,
  waitForDeliveryConsumption,
  withContextClearBoundary,
  withSessionLock,
} from '../../../../src/lib/agent/message-delivery';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import { getModelsCache, setModelsCache } from '../../../../src/lib/model-service';
import type { Database } from '../../../../src/storage/database';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database';

describe('AgentSession', () => {
  describe('session data structure', () => {
    it('should have required session fields', () => {
      const mockSession: Session = {
        id: 'test-session-id',
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
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

      expect(mockSession.id).toBe('test-session-id');
      expect(mockSession.title).toBe('Test Session');
      expect(mockSession.status).toBe('active');
      expect(mockSession.config.model).toBe('claude-sonnet-4-20250514');
      expect(mockSession.metadata.messageCount).toBe(0);
    });

    it('should support optional worktree fields', () => {
      const mockSession: Session = {
        id: 'test-session-id',
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
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
        worktree: {
          worktreePath: '/test/worktree',
          mainRepoPath: '/test/repo',
          branch: 'session/test',
        },
      };

      expect(mockSession.worktree).toBeDefined();
      expect(mockSession.worktree?.worktreePath).toBe('/test/worktree');
      expect(mockSession.worktree?.branch).toBe('session/test');
    });
  });

  describe('processing state structure', () => {
    it('should have idle state', () => {
      const state: AgentProcessingState = {
        status: 'idle',
        phase: null,
      };

      expect(state.status).toBe('idle');
      expect(state.phase).toBeNull();
    });

    it('should have processing state with phase', () => {
      const state: AgentProcessingState = {
        status: 'processing',
        phase: 'thinking',
      };

      expect(state.status).toBe('processing');
      expect(state.phase).toBe('thinking');
    });

    it('should have waiting_for_input state', () => {
      const state: AgentProcessingState = {
        status: 'waiting_for_input',
        phase: null,
        pendingQuestion: {
          toolUseId: 'test-tool-id',
          questions: [],
        },
      };

      expect(state.status).toBe('waiting_for_input');
      expect(state.pendingQuestion?.toolUseId).toBe('test-tool-id');
    });
  });

  describe('context info structure', () => {
    it('should have required context fields', () => {
      const contextInfo: ContextInfo = {
        currentTokens: 1000,
        maxTokens: 200000,
        usagePercentage: 0.5,
        modelName: 'claude-sonnet-4',
        breakdown: {
          systemPrompt: 500,
          conversation: 400,
          tools: 100,
        },
      };

      expect(contextInfo.currentTokens).toBe(1000);
      expect(contextInfo.maxTokens).toBe(200000);
      expect(contextInfo.usagePercentage).toBe(0.5);
      expect(contextInfo.breakdown.systemPrompt).toBe(500);
    });
  });

  describe('metadata updates', () => {
    it('should support partial metadata updates', () => {
      const metadata = {
        messageCount: 5,
        totalTokens: 1000,
        inputTokens: 600,
        outputTokens: 400,
        totalCost: 0.01,
        toolCallCount: 3,
      };

      const updates = { toolCallCount: 10 };
      const merged = { ...metadata, ...updates };

      expect(merged.messageCount).toBe(5);
      expect(merged.toolCallCount).toBe(10);
    });

    it('should support config updates', () => {
      const config = {
        model: 'claude-sonnet-4-20250514',
        maxTokens: 8192,
        temperature: 1.0,
      };

      const updates = { model: 'claude-opus-4-20250514' };
      const merged = { ...config, ...updates };

      expect(merged.model).toBe('claude-opus-4-20250514');
      expect(merged.maxTokens).toBe(8192);
    });
  });

  describe('model switching interface', () => {
    it('should have correct model switch result structure', () => {
      const successResult = {
        success: true,
        model: 'claude-opus-4-20250514',
      };

      expect(successResult.success).toBe(true);
      expect(successResult.model).toBe('claude-opus-4-20250514');
    });

    it('should have correct model switch error structure', () => {
      const errorResult = {
        success: false,
        model: 'claude-opus-4-20250514',
        error: 'Model not available',
      };

      expect(errorResult.success).toBe(false);
      expect(errorResult.error).toBe('Model not available');
    });
  });

  describe('checkpoint structure', () => {
    it('should have correct checkpoint fields', () => {
      const checkpoint = {
        id: 'checkpoint-123',
        messageId: 'msg-123',
        timestamp: Date.now(),
        userMessagePreview: 'Help me with...',
        sdkMessageIndex: 5,
      };

      expect(checkpoint.id).toBe('checkpoint-123');
      expect(checkpoint.messageId).toBe('msg-123');
      expect(checkpoint.userMessagePreview).toBe('Help me with...');
    });
  });

  describe('question response structure', () => {
    it('should have correct question response fields', () => {
      const response = {
        questionIndex: 0,
        selectedOptionIndices: [0, 2],
        customText: 'custom input',
      };

      expect(response.questionIndex).toBe(0);
      expect(response.selectedOptionIndices).toEqual([0, 2]);
      expect(response.customText).toBe('custom input');
    });
  });

  describe('process tracking cleanup', () => {
    let processKillSpy: ReturnType<typeof spyOn> | null = null;

    afterEach(() => {
      processKillSpy?.mockRestore();
      processKillSpy = null;
    });

    function createAgentSession(): AgentSession {
      const mockSession: Session = {
        id: `test-session-${Math.random()}`,
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
          maxTokens: 8192,
          temperature: 1.0,
        },
        metadata: {},
      } as Session;

      const mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getUserMessages: mock(() => []),
        getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
        deleteMessagesAfter: mock(() => 0),
        deleteMessagesAtAndAfter: mock(() => 0),
        getUserMessageByUuid: mock(() => undefined),
        countMessagesAfter: mock(() => 0),
        updateMessage: mock(() => {}),
        getSDKMessageCount: mock(() => 0),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      return new AgentSession(
        mockSession,
        mockDb,
        {} as MessageHub,
        {
          publish: mock(async () => {}),
          publishAsync: mock(() => {}),
          subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
        } as unknown as InternalEventBus<any>,
        mock(async () => 'test-api-key')
      );
    }

    it('exposes tracked root pids for daemon-owned watchdog scoping', () => {
      const agentSession = createAgentSession();
      const proc = {
        pid: 12345,
        once: mock((_event: string, _handler: () => void) => proc),
        kill: mock(() => true),
      };

      agentSession.trackAgentProcess(proc as never);

      expect([...agentSession.getTrackedAgentRootPids()]).toEqual([12345]);
    });

    it('terminates no-PID tracked handles via their kill() (Codex P2, PR #2491)', async () => {
      const agentSession = createAgentSession();
      let fireExit: (() => void) | null = null;
      const noPidProc = {
        once: mock((_event: string, handler: () => void) => {
          if (_event === 'exit') fireExit = handler;
          return noPidProc;
        }),
        kill: mock(() => true),
      };

      agentSession.trackAgentProcess(noPidProc as never);
      agentSession.terminateTrackedAgentProcesses({ forceDelayMs: 10 });

      expect(noPidProc.kill).toHaveBeenCalledWith('SIGTERM');

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(noPidProc.kill).toHaveBeenCalledWith('SIGKILL');

      fireExit?.();
      agentSession.terminateTrackedAgentProcesses({ forceDelayMs: 5 });
      await new Promise((resolve) => setTimeout(resolve, 15));
      const sigtermCalls = (noPidProc.kill as ReturnType<typeof mock>).mock.calls.filter(
        (args) => args[0] === 'SIGTERM'
      ).length;
      expect(sigtermCalls).toBe(1);
    });

    it('scopes no-PID termination to the supplied snapshot, sparing a replacement handle', async () => {
      const agentSession = createAgentSession();
      const mkProc = () => {
        const p = {
          once: mock((_event: string, _handler: () => void) => p),
          kill: mock(() => true),
        };
        return p;
      };
      const oldProc = mkProc();
      const replacementProc = mkProc();

      agentSession.trackAgentProcess(oldProc as never);
      const snapshot = agentSession.snapshotNoPidTrackedProcesses();
      agentSession.trackAgentProcess(replacementProc as never);

      agentSession.terminateTrackedAgentProcesses({ forceDelayMs: 10, noPidProcesses: snapshot });
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(oldProc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(oldProc.kill).toHaveBeenCalledWith('SIGKILL');
      expect(replacementProc.kill).not.toHaveBeenCalled();
    });

    it('keeps a retained no-PID orphan in the exit aggregate after reset (Codex P2, PR #2491)', async () => {
      const agentSession = createAgentSession();
      let fireExitA: (() => void) | null = null;
      const procA = {
        once: mock((_event: string, handler: () => void) => {
          if (_event === 'exit') fireExitA = handler;
          return procA;
        }),
        kill: mock(() => true),
      };
      const procB = {
        pid: 999,
        once: mock((_event: string, handler: () => void) => {
          if (_event === 'exit') setTimeout(handler, 10);
          return procB;
        }),
        kill: mock(() => true),
      };

      agentSession.trackAgentProcess(procA as never);
      agentSession.resetProcessExitedPromise();
      agentSession.trackAgentProcess(procB as never);
      const aggregate = agentSession.processExitedPromise;
      expect(aggregate).not.toBeNull();

      let resolved = false;
      void aggregate!.then(() => {
        resolved = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(resolved).toBe(false);
      fireExitA?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(resolved).toBe(true);
    });

    it('binds deferred SIGKILL to the process snapshot being terminated', async () => {
      const agentSession = createAgentSession();
      processKillSpy = spyOn(process, 'kill').mockImplementation(() => true);
      const firstProc = {
        pid: 111,
        once: mock((_event: string, _handler: () => void) => firstProc),
        kill: mock(() => true),
      };
      const secondProc = {
        pid: 222,
        once: mock((_event: string, _handler: () => void) => secondProc),
        kill: mock(() => true),
      };

      agentSession.trackAgentProcess(firstProc as never);
      agentSession.terminateTrackedAgentProcesses({ forceDelayMs: 10 });
      agentSession.trackAgentProcess(secondProc as never);

      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(firstProc.kill).toHaveBeenCalledWith('SIGKILL');
      expect(secondProc.kill).not.toHaveBeenCalledWith('SIGKILL');
      expect([...agentSession.getTrackedAgentRootPids()]).toEqual([222, 111]);
    });

    it('keeps SIGKILL escalation for remaining processes when one exits', async () => {
      const agentSession = createAgentSession();
      processKillSpy = spyOn(process, 'kill').mockImplementation(() => true);
      let firstExitHandler: (() => void) | null = null;
      const firstProc = {
        pid: 111,
        once: mock((_event: string, handler: () => void) => {
          firstExitHandler = handler;
          return firstProc;
        }),
        kill: mock(() => true),
      };
      const secondProc = {
        pid: 222,
        once: mock((_event: string, _handler: () => void) => secondProc),
        kill: mock(() => true),
      };

      agentSession.trackAgentProcess(firstProc as never);
      agentSession.trackAgentProcess(secondProc as never);
      agentSession.terminateTrackedAgentProcesses({ forceDelayMs: 15 });
      firstExitHandler?.();

      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(secondProc.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('signals each tracked process group in the stop snapshot', () => {
      const agentSession = createAgentSession();
      processKillSpy = spyOn(process, 'kill').mockImplementation(() => true);
      const firstProc = {
        pid: 111,
        once: mock((_event: string, _handler: () => void) => firstProc),
        kill: mock(() => true),
      };
      const secondProc = {
        pid: 222,
        once: mock((_event: string, _handler: () => void) => secondProc),
        kill: mock(() => true),
      };

      agentSession.trackAgentProcess(firstProc as never);
      agentSession.trackAgentProcess(secondProc as never);
      agentSession.terminateTrackedAgentProcesses({ forceDelayMs: 50 });

      expect(processKillSpy).toHaveBeenCalledWith(-111, 'SIGTERM');
      expect(processKillSpy).toHaveBeenCalledWith(-222, 'SIGTERM');
    });

    it('keeps failed SIGKILL deliveries tracked for later cleanup', async () => {
      const agentSession = createAgentSession();
      processKillSpy = spyOn(process, 'kill').mockImplementation(() => true);
      const proc = {
        pid: 333,
        once: mock((_event: string, _handler: () => void) => proc),
        kill: mock((signal: NodeJS.Signals) => signal !== 'SIGKILL'),
      };

      agentSession.trackAgentProcess(proc as never);
      agentSession.terminateTrackedAgentProcesses({ forceDelayMs: 10 });

      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
      expect([...agentSession.getTrackedAgentRootPids()]).toEqual([333]);
    });
  });

  describe('no-PID process tracking', () => {
    function createAgentSession(): AgentSession {
      const mockSession: Session = {
        id: `test-session-nopid-${Math.random()}`,
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
          maxTokens: 8192,
          temperature: 1.0,
        },
        metadata: {},
      } as Session;

      const mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getUserMessages: mock(() => []),
        getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
        deleteMessagesAfter: mock(() => 0),
        deleteMessagesAtAndAfter: mock(() => 0),
        getUserMessageByUuid: mock(() => undefined),
        countMessagesAfter: mock(() => 0),
        updateMessage: mock(() => {}),
        getSDKMessageCount: mock(() => 0),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      return new AgentSession(
        mockSession,
        mockDb,
        {} as MessageHub,
        {
          publish: mock(async () => {}),
          publishAsync: mock(() => {}),
          subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
        } as unknown as InternalEventBus<any>,
        mock(async () => 'test-api-key')
      );
    }

    it('preserves existing processExitedPromise when tracking a no-PID process', async () => {
      const agentSession = createAgentSession();

      const numericProc = {
        pid: 500,
        once: mock((_event: string, _handler: () => void) => numericProc),
        kill: mock(() => true),
      };
      agentSession.trackAgentProcess(numericProc as never);
      const existingPromise = agentSession.processExitedPromise;
      expect(existingPromise).not.toBeNull();

      const noPidProc = {
        once: mock((_event: string, _handler: () => void) => noPidProc),
        kill: mock(() => true),
      };
      agentSession.trackAgentProcess(noPidProc as never);
      const updatedPromise = agentSession.processExitedPromise;

      expect(updatedPromise).not.toBeNull();
      expect(updatedPromise).not.toBe(existingPromise);
    });

    it('aggregates no-PID exit promise with existing numeric-PID promises', async () => {
      const agentSession = createAgentSession();

      let exitHandler1: (() => void) | null = null;
      const proc1 = {
        pid: 600,
        once: mock((_event: string, handler: () => void) => {
          exitHandler1 = handler;
          return proc1;
        }),
        kill: mock(() => true),
      };
      agentSession.trackAgentProcess(proc1 as never);

      let exitHandlerNoPid: (() => void) | null = null;
      const noPidProc = {
        once: mock((_event: string, handler: () => void) => {
          exitHandlerNoPid = handler;
          return noPidProc;
        }),
        kill: mock(() => true),
      };
      agentSession.trackAgentProcess(noPidProc as never);

      const promise = agentSession.processExitedPromise;
      expect(promise).not.toBeNull();

      exitHandler1?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
      exitHandlerNoPid?.();
      await expect(promise).resolves.toBeUndefined();
    });

    it('no-PID-first then numeric-PID keeps no-PID promise in aggregation', async () => {
      const agentSession = createAgentSession();

      let noPidExitHandler: (() => void) | null = null;
      const noPidProc = {
        once: mock((_event: string, handler: () => void) => {
          noPidExitHandler = handler;
          return noPidProc;
        }),
        kill: mock(() => true),
      };
      agentSession.trackAgentProcess(noPidProc as never);

      let numericExitHandler: (() => void) | null = null;
      const numericProc = {
        pid: 700,
        once: mock((_event: string, handler: () => void) => {
          numericExitHandler = handler;
          return numericProc;
        }),
        kill: mock(() => true),
      };
      agentSession.trackAgentProcess(numericProc as never);

      const promise = agentSession.processExitedPromise;
      expect(promise).not.toBeNull();

      numericExitHandler?.();
      await new Promise((resolve) => setTimeout(resolve, 5));

      noPidExitHandler?.();
      await expect(promise).resolves.toBeUndefined();
    });

    it('multiple no-PID processes are all aggregated', async () => {
      const agentSession = createAgentSession();

      const exitHandlers: (() => void)[] = [];
      const createNoPidProc = () => {
        const proc = {
          once: mock((_event: string, handler: () => void) => {
            exitHandlers.push(handler);
            return proc;
          }),
          kill: mock(() => true),
        };
        return proc;
      };

      agentSession.trackAgentProcess(createNoPidProc() as never);
      agentSession.trackAgentProcess(createNoPidProc() as never);
      agentSession.trackAgentProcess(createNoPidProc() as never);

      const promise = agentSession.processExitedPromise;
      expect(promise).not.toBeNull();

      exitHandlers[0]();
      exitHandlers[1]();
      await new Promise((resolve) => setTimeout(resolve, 5));

      exitHandlers[2]();
      await expect(promise).resolves.toBeUndefined();
    });
  });

  describe('component initialization', () => {
    let mockSession: Session;
    let mockDb: Database;
    let mockMessageHub: MessageHub;
    let mockInternalEventBus: InternalEventBus<any>;
    let mockGetApiKey: () => Promise<string | null>;
    let agentSession: AgentSession;

    beforeEach(() => {
      mockSession = {
        id: 'test-session-id',
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
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
      } as Session;

      mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getUserMessages: mock(() => []),
        getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
        deleteMessagesAfter: mock(() => 0),
        deleteMessagesAtAndAfter: mock(() => 0),
        getUserMessageByUuid: mock(() => undefined),
        countMessagesAfter: mock(() => 0),
        updateMessage: mock(() => {}),
        getSDKMessageCount: mock(() => 0),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      mockMessageHub = {
        sendMessage: mock(() => {}),
      } as unknown as MessageHub;

      mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
      } as unknown as InternalEventBus<any>;

      mockGetApiKey = mock(async () => 'test-api-key');

      agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
    });

    it('should initialize messageQueue component', () => {
      expect(agentSession.messageQueue).toBeDefined();
      expect(agentSession.messageQueue.isRunning()).toBe(false);
    });

    it('should initialize stateManager component', () => {
      expect(agentSession.stateManager).toBeDefined();
      expect(agentSession.stateManager.getState().status).toBe('idle');
    });

    it('should initialize contextTracker component', () => {
      expect(agentSession.contextTracker).toBeDefined();
    });

    it('should initialize messageHandler component', () => {
      expect(agentSession.messageHandler).toBeDefined();
    });

    it('should initialize lifecycleManager component', () => {
      expect(agentSession.lifecycleManager).toBeDefined();
    });

    it('should initialize modelSwitchHandler component', () => {
      expect(agentSession.modelSwitchHandler).toBeDefined();
    });

    it('should initialize askUserQuestionHandler component', () => {
      expect(agentSession.askUserQuestionHandler).toBeDefined();
    });

    it('should initialize optionsBuilder component', () => {
      expect(agentSession.optionsBuilder).toBeDefined();
    });

    it('should initialize interruptHandler component', () => {
      expect(agentSession.interruptHandler).toBeDefined();
    });

    it('should initialize queryModeHandler component', () => {
      expect(agentSession.queryModeHandler).toBeDefined();
    });

    it('should initialize with null query state', () => {
      expect(agentSession.queryObject).toBeNull();
      expect(agentSession.queryPromise).toBeNull();
      expect(agentSession.queryAbortController).toBeNull();
    });

    it('should initialize with false firstMessageReceived', () => {
      expect(agentSession.firstMessageReceived).toBe(false);
    });

    it('should initialize with false cleaningUp state', () => {
      expect(agentSession.isCleaningUp()).toBe(false);
    });

    it('should NOT have startupTimeoutAutoRecoverAttempts field (Task 2.2)', () => {
      expect(
        'startupTimeoutAutoRecoverAttempts' in (agentSession as unknown as Record<string, unknown>)
      ).toBe(false);
    });

    it('should NOT have onStartupTimeoutAutoRecover method (Task 2.2)', () => {
      expect(
        typeof (agentSession as unknown as Record<string, unknown>).onStartupTimeoutAutoRecover
      ).toBe('undefined');
    });
  });

  describe('getter methods', () => {
    let mockSession: Session;
    let mockDb: Database;
    let mockMessageHub: MessageHub;
    let mockInternalEventBus: InternalEventBus<any>;
    let mockGetApiKey: () => Promise<string | null>;
    let agentSession: AgentSession;

    beforeEach(() => {
      mockSession = {
        id: 'test-session-id',
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
          maxTokens: 8192,
          temperature: 1.0,
        },
        metadata: {
          messageCount: 5,
          totalTokens: 100,
          inputTokens: 50,
          outputTokens: 50,
          totalCost: 0.01,
          toolCallCount: 2,
        },
      } as Session;

      mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getSDKMessages: mock(() => ({ messages: [{ id: 'msg1' }], hasMore: false })),
        getSDKMessageCount: mock(() => 10),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      mockMessageHub = {
        sendMessage: mock(() => {}),
      } as unknown as MessageHub;

      mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock(
          (_event: string, handler: (payload: Record<string, unknown>) => void, _opts: object) => {
            if (_event === 'session.updated') {
              captured = onListener(handler);
              return captured.unsubscribe;
            }
            return () => {};
          }
        ),
      } as unknown as InternalEventBus<any>;

      mockGetApiKey = mock(async () => 'test-api-key');

      agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
    });

    it('getProcessingState should delegate to stateManager', () => {
      const state = agentSession.getProcessingState();
      expect(state.status).toBe('idle');
    });

    it('getContextInfo should delegate to contextTracker', () => {
      const info = agentSession.getContextInfo();
      expect(info).toBeNull();
    });

    it('getQueryObject should return query object', () => {
      expect(agentSession.getQueryObject()).toBeNull();
    });

    it('getFirstMessageReceived should return firstMessageReceived flag', () => {
      expect(agentSession.getFirstMessageReceived()).toBe(false);
    });

    it('getSessionData should return session data', () => {
      const data = agentSession.getSessionData();
      expect(data.id).toBe('test-session-id');
      expect(data.title).toBe('Test Session');
    });

    it('getSDKMessages should delegate to database', () => {
      const { messages, hasMore } = agentSession.getSDKMessages(10);
      expect(messages).toEqual([{ id: 'msg1' }]);
      expect(hasMore).toBe(false);
    });

    it('getSDKMessageCount should delegate to database', () => {
      const count = agentSession.getSDKMessageCount();
      expect(count).toBe(10);
    });

    it('getSDKSessionId should return null when no query object', () => {
      expect(agentSession.getSDKSessionId()).toBeNull();
    });

    it('getSDKSessionId should return sessionId when query object has it', () => {
      agentSession.queryObject = {
        sessionId: 'sdk-session-123',
      } as unknown as AgentSession['queryObject'];
      expect(agentSession.getSDKSessionId()).toBe('sdk-session-123');
    });

    it('getCurrentModel should delegate to modelSwitchHandler', () => {
      const model = agentSession.getCurrentModel();
      expect(model.id).toBe('claude-sonnet-4-20250514');
    });
  });

  describe('delegation methods', () => {
    let mockSession: Session;
    let mockDb: Database;
    let mockMessageHub: MessageHub;
    let mockInternalEventBus: InternalEventBus<any>;
    let mockGetApiKey: () => Promise<string | null>;
    let agentSession: AgentSession;

    beforeEach(() => {
      mockSession = {
        id: 'test-session-id',
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
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
      } as Session;

      mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getUserMessages: mock(() => []),
        getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
        deleteMessagesAfter: mock(() => 0),
        deleteMessagesAtAndAfter: mock(() => 0),
        getUserMessageByUuid: mock(() => undefined),
        countMessagesAfter: mock(() => 0),
        updateMessage: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
        updateMessageTimestamp: mock(() => {}),
      } as unknown as Database;

      mockMessageHub = {
        sendMessage: mock(() => {}),
      } as unknown as MessageHub;

      mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock(
          (event: string, handler: (payload: Record<string, unknown>) => void, _opts: object) => {
            if (event === 'session.updated') {
              captured = onListener(handler);
              return captured.unsubscribe;
            }
            return () => {};
          }
        ),
      } as unknown as InternalEventBus<any>;

      mockGetApiKey = mock(async () => 'test-api-key');

      agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey,
        undefined,
        undefined,
        undefined,
        undefined,
        { autoReplayPendingMessages: false }
      );
    });

    it('driveDeliveryTurn parks behind a held context-clear boundary instead of racing the context clear', async () => {
      const previous = process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS;
      process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS = '50';
      let releaseHolder!: () => void;
      const holderGate = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      try {
        const holder = withContextClearBoundary('test-session-id', () => holderGate);
        const outcome = await agentSession.driveDeliveryTurn('uuid-gate', 'hello');
        expect(outcome).toMatchObject({
          outcome: 'blocked',
          reason: 'context_clear_boundary',
        });
        expect(typeof (outcome as { retryAt?: number }).retryAt).toBe('number');

        releaseHolder();
        await holder;
      } finally {
        if (previous === undefined)
          delete process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS;
        else process.env.HYPERNEO_DELIVERY_COORDINATION_ACQUIRE_TIMEOUT_MS = previous;
        clearContextClearBoundariesForTest();
      }
    });

    it('an aborted delivery admission leaves the idle owner untouched (no phantom turn)', async () => {
      const admitSpy = mock(() => ({}));
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock(() => ({ content: 'x', sendStatus: 'enqueued' })),
      }));
      (agentSession as unknown as { messageQueue: unknown }).messageQueue = {
        admitWithId: admitSpy,
        waitForPendingOrInFlight: mock(() => null),
        isRunning: mock(() => false),
        size: mock(() => 0),
      };
      agentSession.lifecycleManager.ensureQueryStarted = mock(async () => 'ok' as never);
      (agentSession as unknown as { queryPromise: Promise<unknown> }).queryPromise = new Promise(
        () => {}
      );

      const before = agentSession.stateManager.getCurrentIdleOwner();
      const outcome = await agentSession.driveDeliveryTurn(
        'kick-aborted',
        'hello',
        null,
        false,
        () => false
      );

      expect(outcome).toEqual({ outcome: 'aborted' });
      expect(agentSession.stateManager.getCurrentIdleOwner()).toEqual(before);
      expect(admitSpy).not.toHaveBeenCalled();
    });

    it('driveDeliveryTurn parks instead of reopening while limit recovery is pending', async () => {
      const retrySpy = mock(() => 'db-1');
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock(() => ({ content: 'x', sendStatus: 'consumed' })),
        hasTerminalResultAfter: mock(() => false),
        hasDeliveryTurnEnd: mock(() => false),
        clearDeliveryTurnEnd: mock(() => {}),
        getErrorTerminalResultSubtypeAfter: mock(() => null),
        recordDeliveryTurnEnd: mock(() => {}),
        markDeliveryRetryableByUuid: retrySpy,
      }));
      mockDb.getJobQueueRepo = mock(() => ({
        isProcessingDelivery: mock(() => true),
      }));
      agentSession.lifecycleManager.ensureQueryStarted = mock(async () => 'ok' as never);
      (agentSession as unknown as { queryPromise: Promise<unknown> }).queryPromise = new Promise(
        () => {}
      );
      const cooldownRetryAt = Date.now() + 60 * 60 * 1000;
      const watchdog = (agentSession as unknown as { rateLimitWatchdog: unknown })
        .rateLimitWatchdog as {
        isRecoveryPending: () => boolean;
        getState: () => { retryAt: number | null };
      };
      watchdog.isRecoveryPending = () => true;
      watchdog.getState = mock(() => ({ retryAt: cooldownRetryAt })) as never;

      await agentSession.stateManager.setProcessing('uuid-park');
      const drive = agentSession.driveDeliveryTurn('uuid-park', 'hello', null, true, () => true);
      await agentSession.stateManager.setIdle();
      const result = await drive;

      expect(result).toEqual({
        outcome: 'blocked',
        retryAt: cooldownRetryAt,
        reason: 'limit_recovery',
      });
      expect(retrySpy).not.toHaveBeenCalled();
    });

    it('driveDeliveryTurn parks a manual-only pause on a long horizon without short polling', async () => {
      const retrySpy = mock(() => 'db-1');
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock(() => ({ content: 'x', sendStatus: 'consumed' })),
        hasTerminalResultAfter: mock(() => false),
        hasDeliveryTurnEnd: mock(() => false),
        clearDeliveryTurnEnd: mock(() => {}),
        getErrorTerminalResultSubtypeAfter: mock(() => null),
        recordDeliveryTurnEnd: mock(() => {}),
        markDeliveryRetryableByUuid: retrySpy,
      }));
      mockDb.getJobQueueRepo = mock(() => ({
        isProcessingDelivery: mock(() => true),
      }));
      agentSession.lifecycleManager.ensureQueryStarted = mock(async () => 'ok' as never);
      (agentSession as unknown as { queryPromise: Promise<unknown> }).queryPromise = new Promise(
        () => {}
      );
      const before = Date.now();
      const watchdog = (agentSession as unknown as { rateLimitWatchdog: unknown })
        .rateLimitWatchdog as {
        isRecoveryPending: () => boolean;
        isManualRecoveryPause: () => boolean;
        getState: () => { retryAt: number | null };
      };
      watchdog.isRecoveryPending = () => true;
      watchdog.isManualRecoveryPause = () => true;
      watchdog.getState = mock(() => ({ retryAt: null })) as never;

      await agentSession.stateManager.setProcessing('uuid-manual-park');
      const drive = agentSession.driveDeliveryTurn(
        'uuid-manual-park',
        'hello',
        null,
        true,
        () => true
      );
      await agentSession.stateManager.setIdle();
      const result = (await drive) as { outcome: string; retryAt: number };

      expect(result.outcome).toBe('blocked');
      expect(result.retryAt).toBeGreaterThanOrEqual(before + 4 * 60_000);
      expect(result).toMatchObject({ reason: 'limit_recovery' });
      expect(retrySpy).not.toHaveBeenCalled();
    });

    it('cancelRateLimitRetry cancels the parked delivery for the episode message', async () => {
      const cancelDelivery = mock(() => true);
      mockDb.getJobQueueRepo = mock(() => ({ cancelDelivery }) as never);
      (agentSession as unknown as { rateLimitWatchdog: unknown }).rateLimitWatchdog = {
        cancel: mock(() => {}),
        getState: mock(() => ({
          lastUserMessage: { uuid: 'msg-episode', content: 'hi' },
        })),
      } as never;

      agentSession.cancelRateLimitRetry();

      expect(cancelDelivery).toHaveBeenCalledWith('test-session-id', 'msg-episode');
    });

    it('projects a restored persisted cooldown into the processing state', async () => {
      mockDb.getSession = mock(
        () =>
          ({
            id: 'test-session-id',
            processingState: JSON.stringify({
              status: 'rate_limit_cooldown',
              retryAt: Date.now() + 60_000,
              retryCount: 1,
              maxRetries: 3,
              messageId: 'msg-persisted-episode',
            }),
          }) as never
      );
      const arm = (
        agentSession as unknown as { armPersistedRateLimitCooldown: () => void }
      ).armPersistedRateLimitCooldown.bind(agentSession);

      arm();
      await new Promise((resolve) => setTimeout(resolve, 10));

      const state = agentSession.stateManager.getState();
      expect(state.status).toBe('rate_limit_cooldown');
      if (state.status === 'rate_limit_cooldown') {
        expect(state.retryAt).toBeGreaterThan(Date.now());
        expect(state.messageId).toBe('msg-persisted-episode');
      }
      (
        agentSession as unknown as { rateLimitWatchdog: { cancel: () => void } }
      ).rateLimitWatchdog.cancel();
      await agentSession.stateManager.setIdle();
    });

    it('retryNowAfterRateLimit releases the parked delivery for a persisted episode', async () => {
      const rescheduleDelivery = mock(() => true);
      mockDb.getJobQueueRepo = mock(() => ({ rescheduleDelivery }) as never);
      const cancel = mock(() => {});
      const retryNow = mock(() => true);
      const capturedUuids: Array<string | null> = [];
      (agentSession as unknown as { rateLimitWatchdog: unknown }).rateLimitWatchdog = {
        cancel,
        retryNow,
        isPersistedCooldownArmed: () => true,
        getPersistedEpisodeMessageUuid: () => {
          capturedUuids.push(cancel.mock.calls.length === 0 ? 'msg-persisted-episode' : null);
          return capturedUuids[capturedUuids.length - 1] ?? null;
        },
      } as never;

      const resumed = await agentSession.retryNowAfterRateLimit();

      expect(resumed).toBe(true);
      expect(retryNow).not.toHaveBeenCalled();
      expect(capturedUuids[0]).toBe('msg-persisted-episode');
      expect(rescheduleDelivery).toHaveBeenCalledWith(
        'test-session-id',
        'msg-persisted-episode',
        expect.any(Number)
      );
    });

    it('retryNowAfterRateLimit releases the episode delivery directly', async () => {
      const rescheduleDelivery = mock(() => true);
      mockDb.getJobQueueRepo = mock(() => ({ rescheduleDelivery }) as never);
      (agentSession as unknown as { rateLimitWatchdog: unknown }).rateLimitWatchdog = {
        cancel: mock(() => {}),
        retryNow: mock(() => true),
        isPersistedCooldownArmed: () => true,
        getPersistedEpisodeMessageUuid: () => 'msg-episode',
      } as never;

      const resumed = await agentSession.retryNowAfterRateLimit();

      expect(resumed).toBe(true);
      expect(rescheduleDelivery).toHaveBeenCalledWith(
        'test-session-id',
        'msg-episode',
        expect.any(Number)
      );
    });

    it('retryNowAfterRateLimit clears the persisted cooldown before releasing', async () => {
      const order: string[] = [];
      const rescheduleDelivery = mock(() => {
        order.push('reschedule');
        return true;
      });
      mockDb.getJobQueueRepo = mock(() => ({ rescheduleDelivery }) as never);
      let processingState = JSON.stringify({
        status: 'rate_limit_cooldown',
        retryAt: Date.now() + 60_000,
        messageId: 'msg-persisted-episode',
      });
      mockDb.getSession = mock(
        () =>
          ({
            id: 'test-session-id',
            get processingState() {
              return processingState;
            },
          }) as never
      );
      const originalUpdateSession = mockDb.updateSession as ReturnType<typeof mock>;
      (mockDb.updateSession as ReturnType<typeof mock>) = mock((...args: unknown[]) => {
        order.push('persist-idle');
        const result = originalUpdateSession(...args);
        processingState = JSON.stringify({ status: 'idle' });
        return result;
      });
      (agentSession as unknown as { rateLimitWatchdog: unknown }).rateLimitWatchdog = {
        cancel: mock(() => {}),
        retryNow: mock(() => true),
        isPersistedCooldownArmed: () => true,
        getPersistedEpisodeMessageUuid: () => 'msg-persisted-episode',
      } as never;

      const resumed = await agentSession.retryNowAfterRateLimit();

      expect(resumed).toBe(true);
      expect(mockDb.updateSession).toHaveBeenCalledWith('test-session-id', {
        processingState: JSON.stringify({ status: 'idle' }),
      });
      expect(order).toEqual(['persist-idle', 'reschedule']);
    });

    it('retryNowAfterRateLimit releases the active delivery for a legacy persisted cooldown', async () => {
      const rescheduleDelivery = mock(() => true);
      mockDb.getJobQueueRepo = mock(
        () =>
          ({
            rescheduleDelivery,
            getActiveDeliveryMessageUuid: mock(() => 'msg-active'),
          }) as never
      );
      (agentSession as unknown as { rateLimitWatchdog: unknown }).rateLimitWatchdog = {
        cancel: mock(() => {}),
        retryNow: mock(() => true),
        isPersistedCooldownArmed: () => true,
        getPersistedEpisodeMessageUuid: () => null,
      } as never;

      const resumed = await agentSession.retryNowAfterRateLimit();

      expect(resumed).toBe(true);
      expect(rescheduleDelivery).toHaveBeenCalledWith(
        'test-session-id',
        'msg-active',
        expect.any(Number)
      );
    });

    it('retryNowAfterRateLimit refuses to release when the cooldown row survives', async () => {
      const rescheduleDelivery = mock(() => true);
      mockDb.getJobQueueRepo = mock(() => ({ rescheduleDelivery }) as never);
      mockDb.getSession = mock(
        () =>
          ({
            id: 'test-session-id',
            processingState: JSON.stringify({
              status: 'rate_limit_cooldown',
              retryAt: Date.now() + 60_000,
              messageId: 'msg-persisted-episode',
            }),
          }) as never
      );
      (agentSession as unknown as { rateLimitWatchdog: unknown }).rateLimitWatchdog = {
        cancel: mock(() => {}),
        retryNow: mock(() => true),
        isPersistedCooldownArmed: () => true,
        getPersistedEpisodeMessageUuid: () => 'msg-persisted-episode',
      } as never;

      const resumed = await agentSession.retryNowAfterRateLimit();

      expect(resumed).toBe(false);
      expect(rescheduleDelivery).not.toHaveBeenCalled();
    });

    it('retryNowAfterRateLimit reports failure when the parked delivery is gone', async () => {
      const rescheduleDelivery = mock(() => false);
      mockDb.getJobQueueRepo = mock(() => ({ rescheduleDelivery }) as never);
      (agentSession as unknown as { rateLimitWatchdog: unknown }).rateLimitWatchdog = {
        cancel: mock(() => {}),
        retryNow: mock(() => true),
        isPersistedCooldownArmed: () => true,
        getPersistedEpisodeMessageUuid: () => 'msg-persisted-episode',
      } as never;

      const resumed = await agentSession.retryNowAfterRateLimit();

      expect(resumed).toBe(false);
    });

    it('startStreamingQuery refuses to start an archived session', async () => {
      const start = mock(async () => {});
      (agentSession as unknown as { queryRunner: unknown }).queryRunner = { start } as never;
      (agentSession as unknown as { session: { status: string } }).session.status = 'archived';

      await expect(agentSession.startStreamingQuery()).rejects.toThrow('archived');
      expect(start).not.toHaveBeenCalled();
    });

    it('startStreamingQuery refuses to start an ended session', async () => {
      const start = mock(async () => {});
      (agentSession as unknown as { queryRunner: unknown }).queryRunner = { start } as never;
      (agentSession as unknown as { session: { status: string } }).session.status = 'ended';

      await expect(agentSession.startStreamingQuery()).rejects.toThrow('ended');
      expect(start).not.toHaveBeenCalled();
    });

    it('cancelRateLimitRetry uses the restored episode id from the persisted arm', async () => {
      const cancelDelivery = mock(() => true);
      mockDb.getJobQueueRepo = mock(() => ({ cancelDelivery }) as never);
      (agentSession as unknown as { rateLimitWatchdog: unknown }).rateLimitWatchdog = {
        cancel: mock(() => {}),
        getState: mock(() => ({ lastUserMessage: null })),
        getPersistedEpisodeMessageUuid: () => 'msg-arm-episode',
      } as never;
      await agentSession.stateManager.setRateLimitCooldown({
        retryCount: 0,
        maxRetries: 3,
        retryAt: Date.now() + 60_000,
        messageId: 'msg-arm-episode',
      });

      agentSession.cancelRateLimitRetry();

      expect(cancelDelivery).toHaveBeenCalledWith('test-session-id', 'msg-arm-episode');
      await agentSession.stateManager.setIdle();
    });

    it('cancelRateLimitRetry clears a persisted cooldown left by a restart', async () => {
      const cancelDelivery = mock(() => true);
      mockDb.getJobQueueRepo = mock(() => ({ cancelDelivery }) as never);
      mockDb.getSession = mock(
        () =>
          ({
            id: 'test-session-id',
            processingState: JSON.stringify({
              status: 'rate_limit_cooldown',
              retryAt: Date.now() + 60_000,
              messageId: 'msg-persisted-episode',
            }),
          }) as never
      );
      (agentSession as unknown as { rateLimitWatchdog: unknown }).rateLimitWatchdog = {
        cancel: mock(() => {}),
        getState: mock(() => ({ lastUserMessage: null })),
      } as never;

      agentSession.cancelRateLimitRetry();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockDb.updateSession).toHaveBeenCalledWith('test-session-id', {
        processingState: JSON.stringify({ status: 'idle' }),
      });
      expect(cancelDelivery).toHaveBeenCalledWith('test-session-id', 'msg-persisted-episode');
    });

    it('cancelRateLimitRetry cancels the episode delivery behind a persisted cooldown', async () => {
      const cancelDelivery = mock(() => true);
      const markDeliveryFailedByUuid = mock(() => 'db-episode');
      mockDb.getJobQueueRepo = mock(() => ({ cancelDelivery }) as never);
      mockDb.getSDKMessageRepo = mock(() => ({ markDeliveryFailedByUuid }) as never);
      mockDb.getSession = mock(
        () =>
          ({
            id: 'test-session-id',
            processingState: JSON.stringify({
              status: 'rate_limit_cooldown',
              retryAt: Date.now() + 60_000,
              messageId: 'msg-episode',
            }),
          }) as never
      );
      (agentSession as unknown as { rateLimitWatchdog: unknown }).rateLimitWatchdog = {
        cancel: mock(() => {}),
        getState: mock(() => ({ lastUserMessage: null })),
      } as never;

      agentSession.cancelRateLimitRetry();
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockDb.updateSession).toHaveBeenCalledWith('test-session-id', {
        processingState: JSON.stringify({ status: 'idle' }),
      });
      expect(cancelDelivery).toHaveBeenCalledWith('test-session-id', 'msg-episode');
      expect(markDeliveryFailedByUuid).toHaveBeenCalledWith('test-session-id', 'msg-episode');
    });

    it('cancelRateLimitRetry settles the episode message and reschedules the session', async () => {
      const cancelDelivery = mock(() => true);
      const rescheduleSessionDeliveries = mock(() => true);
      const markDeliveryFailedByUuid = mock((uuid: string) => `db-${uuid}`);
      mockDb.getJobQueueRepo = mock(
        () =>
          ({
            cancelDelivery,
            rescheduleSessionDeliveries,
          }) as never
      );
      mockDb.getSDKMessageRepo = mock(() => ({ markDeliveryFailedByUuid }) as never);
      (agentSession as unknown as { rateLimitWatchdog: unknown }).rateLimitWatchdog = {
        cancel: mock(() => {}),
        getState: mock(() => ({
          lastUserMessage: { uuid: 'msg-episode', content: 'hi' },
        })),
      } as never;

      agentSession.cancelRateLimitRetry();

      expect(cancelDelivery).toHaveBeenCalledWith('test-session-id', 'msg-episode');
      expect(markDeliveryFailedByUuid).toHaveBeenCalledTimes(1);
      expect(markDeliveryFailedByUuid).toHaveBeenCalledWith('test-session-id', 'msg-episode');
      expect(rescheduleSessionDeliveries).toHaveBeenCalledWith(
        'test-session-id',
        expect.any(Number)
      );
    });

    it('retryNowAfterRateLimit reports failure when the session-wide release misses', async () => {
      const rescheduleSessionDeliveries = mock(() => false);
      mockDb.getJobQueueRepo = mock(
        () =>
          ({
            rescheduleSessionDeliveries,
          }) as never
      );
      (agentSession as unknown as { rateLimitWatchdog: unknown }).rateLimitWatchdog = {
        cancel: mock(() => {}),
        retryNow: mock(() => true),
        isPersistedCooldownArmed: () => true,
        getPersistedEpisodeMessageUuid: () => 'msg-persisted-episode',
      } as never;

      const resumed = await agentSession.retryNowAfterRateLimit();

      expect(resumed).toBe(false);
    });

    it('retryNowAfterRateLimit releases every parked delivery for the session', async () => {
      const rescheduleSessionDeliveries = mock(() => true);
      mockDb.getJobQueueRepo = mock(
        () =>
          ({
            rescheduleSessionDeliveries,
          }) as never
      );
      (agentSession as unknown as { rateLimitWatchdog: unknown }).rateLimitWatchdog = {
        cancel: mock(() => {}),
        retryNow: mock(() => true),
        isPersistedCooldownArmed: () => true,
        getPersistedEpisodeMessageUuid: () => 'msg-persisted-episode',
      } as never;

      const resumed = await agentSession.retryNowAfterRateLimit();

      expect(resumed).toBe(true);
      expect(rescheduleSessionDeliveries).toHaveBeenCalledWith(
        'test-session-id',
        expect.any(Number)
      );
    });

    it('driveDeliveryTurn completes once a fresh admission acknowledgment resolves', async () => {
      let resultLanded = false;
      let sendStatus = 'enqueued';
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock(() => ({ content: 'x', sendStatus })),
        hasTerminalResultAfter: mock(() => resultLanded),
        hasDeliveryTurnEnd: mock(() => false),
        clearDeliveryTurnEnd: mock(() => {}),
        getErrorTerminalResultSubtypeAfter: mock(() => null),
        recordDeliveryTurnEnd: mock(() => {}),
        markDeliveryConsumedByUuids: mock(() => {
          sendStatus = 'consumed';
          return [];
        }),
        markDeliveryRetryableByUuid: mock(() => 'db-1'),
      }));
      mockDb.getJobQueueRepo = mock(() => ({
        isProcessingDelivery: mock(() => true),
      }));
      agentSession.lifecycleManager.ensureQueryStarted = mock(async () => 'ok' as never);
      (agentSession as unknown as { queryPromise: Promise<unknown> }).queryPromise = new Promise(
        () => {}
      );
      (agentSession as unknown as { messageQueue: unknown }).messageQueue = {
        admitWithId: mock(() => Promise.resolve()),
        waitForPendingOrInFlight: mock(() => null),
        isRunning: mock(() => false),
        size: mock(() => 0),
      };

      await agentSession.stateManager.setProcessing('uuid-spurious');
      const drive = agentSession.driveDeliveryTurn(
        'uuid-spurious',
        'hello',
        null,
        false,
        () => true
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      await agentSession.stateManager.setIdle();
      await new Promise((resolve) => setTimeout(resolve, 20));
      resultLanded = true;
      await agentSession.stateManager.setProcessing('uuid-spurious');
      await agentSession.stateManager.setIdle();
      await expect(drive).resolves.toEqual({ outcome: 'completed' });
    });

    it('driveDeliveryTurn completes once a reused admission acknowledgment resolves', async () => {
      let resultLanded = false;
      let sendStatus = 'enqueued';
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock(() => ({ content: 'x', sendStatus })),
        hasTerminalResultAfter: mock(() => resultLanded),
        hasDeliveryTurnEnd: mock(() => false),
        clearDeliveryTurnEnd: mock(() => {}),
        getErrorTerminalResultSubtypeAfter: mock(() => null),
        recordDeliveryTurnEnd: mock(() => {}),
        markDeliveryConsumedByUuids: mock(() => {
          sendStatus = 'consumed';
          return [];
        }),
        markDeliveryRetryableByUuid: mock(() => 'db-1'),
      }));
      mockDb.getJobQueueRepo = mock(() => ({
        isProcessingDelivery: mock(() => true),
      }));
      agentSession.lifecycleManager.ensureQueryStarted = mock(async () => 'ok' as never);
      (agentSession as unknown as { queryPromise: Promise<unknown> }).queryPromise = new Promise(
        () => {}
      );
      (agentSession as unknown as { messageQueue: unknown }).messageQueue = {
        admitWithId: mock(() => Promise.resolve()),
        waitForPendingOrInFlight: mock(() => ({
          acknowledgment: Promise.resolve(),
          content: 'hello',
        })),
        isRunning: mock(() => false),
        size: mock(() => 1),
      };

      await agentSession.stateManager.setProcessing('uuid-spurious-reused');
      const drive = agentSession.driveDeliveryTurn(
        'uuid-spurious-reused',
        'hello',
        null,
        false,
        () => true
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      await agentSession.stateManager.setIdle();
      await new Promise((resolve) => setTimeout(resolve, 20));
      resultLanded = true;
      await agentSession.stateManager.setProcessing('uuid-spurious-reused');
      await agentSession.stateManager.setIdle();
      await expect(drive).resolves.toEqual({ outcome: 'completed' });
    });

    it('driveDeliveryTurn reuses a pending admission acknowledgment on retry', async () => {
      const markConsumedSpy = mock(() => ['db-pending']);
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock(() => ({ content: 'hello', sendStatus: 'enqueued' })),
        markDeliveryConsumedByUuids: markConsumedSpy,
      }));
      mockDb.getJobQueueRepo = mock(() => ({
        isProcessingDelivery: mock(() => true),
      }));
      agentSession.lifecycleManager.ensureQueryStarted = mock(async () => 'ok' as never);
      (agentSession as unknown as { queryPromise: Promise<unknown> }).queryPromise = new Promise(
        () => {}
      );
      const admitSpy = mock(() => Promise.resolve());
      const existing = Promise.withResolvers<void>();
      (agentSession as unknown as { messageQueue: unknown }).messageQueue = {
        admitWithId: admitSpy,
        waitForPendingOrInFlight: mock(() => ({
          acknowledgment: existing.promise,
          content: 'hello',
        })),
        isRunning: mock(() => false),
        size: mock(() => 1),
      };

      await agentSession.stateManager.setProcessing('uuid-pending');
      const kickoffConsumed = waitForDeliveryConsumption('test-session-id', 'uuid-pending');
      const drive = agentSession.driveDeliveryTurn(
        'uuid-pending',
        'hello',
        null,
        false,
        () => true
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(admitSpy).not.toHaveBeenCalled();
      expect(markConsumedSpy).not.toHaveBeenCalled();

      existing.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(markConsumedSpy).toHaveBeenCalledWith('test-session-id', ['uuid-pending']);
      await expect(kickoffConsumed.promise).resolves.toBeUndefined();
      await expect(drive).resolves.toEqual({ outcome: 'completed' });
      kickoffConsumed.cancel();
    });

    it('driveDeliveryTurn replaces mismatched pending content with the fresh content', async () => {
      const markSubmittedSpy = mock(() => ['db-pending']);
      const markConsumedSpy = mock(() => ['db-pending']);
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock(() => ({ content: 'hello', sendStatus: 'enqueued' })),
        hasTerminalResultAfter: mock(() => false),
        getErrorTerminalResultSubtypeAfter: mock(() => null),
        recordDeliveryTurnEnd: mock(() => {}),
        markDeliverySubmittedByUuids: markSubmittedSpy,
        markDeliveryConsumedByUuids: markConsumedSpy,
      }));
      mockDb.getJobQueueRepo = mock(() => ({
        isProcessingDelivery: mock(() => true),
      }));
      agentSession.lifecycleManager.ensureQueryStarted = mock(async () => 'ok' as never);
      (agentSession as unknown as { queryPromise: Promise<unknown> }).queryPromise = new Promise(
        () => {}
      );
      const removeSpy = mock(() => true);
      const acknowledgeYieldedSpy = mock(() => false);
      const admitPromise = Promise.withResolvers<void>();
      const admitSpy = mock(() => admitPromise.promise);
      (agentSession as unknown as { messageQueue: unknown }).messageQueue = {
        admitWithId: admitSpy,
        waitForPendingOrInFlight: mock(() => ({
          acknowledgment: new Promise<void>(() => {}),
          content: 'stale pending content',
        })),
        hasYielded: mock(() => false),
        remove: removeSpy,
        acknowledgeYielded: acknowledgeYieldedSpy,
        isRunning: mock(() => false),
        size: mock(() => 1),
      };

      await agentSession.stateManager.setProcessing('uuid-pending');
      const drive = agentSession.driveDeliveryTurn(
        'uuid-pending',
        'hello',
        null,
        false,
        () => true
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(removeSpy).toHaveBeenCalledWith('uuid-pending');
      expect(acknowledgeYieldedSpy).toHaveBeenCalledWith('uuid-pending', expect.any(Number));
      expect(admitSpy).toHaveBeenCalledWith('uuid-pending', 'hello', false, { durable: true });
      expect(markSubmittedSpy).not.toHaveBeenCalled();
      expect(markConsumedSpy).not.toHaveBeenCalled();

      admitPromise.resolve();
      await expect(drive).resolves.toEqual({ outcome: 'completed' });
      expect(markConsumedSpy).toHaveBeenCalledWith('test-session-id', ['uuid-pending']);
    });

    it('driveDeliveryTurn preserves yielded content that does not match the fresh content', async () => {
      const removeSpy = mock(() => true);
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock(() => ({ content: 'hello', sendStatus: 'enqueued' })),
      }));
      mockDb.getJobQueueRepo = mock(() => ({}));
      agentSession.lifecycleManager.ensureQueryStarted = mock(async () => 'ok' as never);
      (agentSession as unknown as { queryPromise: Promise<unknown> }).queryPromise = new Promise(
        () => {}
      );
      (agentSession as unknown as { messageQueue: unknown }).messageQueue = {
        waitForPendingOrInFlight: mock(() => ({
          acknowledgment: new Promise<void>(() => {}),
          content: 'kickoff',
        })),
        hasYielded: mock(() => true),
        remove: removeSpy,
        isRunning: mock(() => false),
        size: mock(() => 1),
      };

      const result = await agentSession.driveDeliveryTurn(
        'uuid-yielded',
        'replacing content',
        null,
        false,
        () => true
      );

      expect(result).toEqual({ outcome: 'aborted' });
      expect(removeSpy).not.toHaveBeenCalled();
    });

    it('driveDeliveryTurn abort leaves a reused pending message intact', async () => {
      const markConsumedSpy = mock(() => ['db-pending']);
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock(() => ({ content: 'x', sendStatus: 'enqueued' })),
        hasTerminalResultAfter: mock(() => false),
        getErrorTerminalResultSubtypeAfter: mock(() => null),
        recordDeliveryTurnEnd: mock(() => {}),
        markDeliveryConsumedByUuids: markConsumedSpy,
      }));
      mockDb.getJobQueueRepo = mock(() => ({
        isProcessingDelivery: mock(() => true),
      }));
      agentSession.lifecycleManager.ensureQueryStarted = mock(async () => 'ok' as never);
      (agentSession as unknown as { queryPromise: Promise<unknown> }).queryPromise = new Promise(
        () => {}
      );
      const existing = Promise.withResolvers<void>();
      const removeSpy = mock(() => true);
      (agentSession as unknown as { messageQueue: unknown }).messageQueue = {
        admitWithId: mock(() => Promise.resolve()),
        waitForPendingOrInFlight: mock(() => ({
          acknowledgment: existing.promise,
          content: 'hello',
        })),
        remove: removeSpy,
        isRunning: mock(() => false),
        size: mock(() => 1),
      };
      const controller = new AbortController();

      await agentSession.stateManager.setProcessing('uuid-pending');
      const drive = agentSession.driveDeliveryTurn(
        'uuid-pending',
        'hello',
        null,
        false,
        () => true,
        controller.signal
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();

      await expect(drive).rejects.toThrow();
      expect(removeSpy).not.toHaveBeenCalled();
      expect(markConsumedSpy).not.toHaveBeenCalled();
    });

    it('driveDeliveryTurn rejects when a reused pending message fails', async () => {
      const markConsumedSpy = mock(() => ['db-pending']);
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock(() => ({ content: 'x', sendStatus: 'enqueued' })),
        hasTerminalResultAfter: mock(() => false),
        getErrorTerminalResultSubtypeAfter: mock(() => null),
        recordDeliveryTurnEnd: mock(() => {}),
        markDeliveryConsumedByUuids: markConsumedSpy,
      }));
      mockDb.getJobQueueRepo = mock(() => ({
        isProcessingDelivery: mock(() => true),
      }));
      agentSession.lifecycleManager.ensureQueryStarted = mock(async () => 'ok' as never);
      (agentSession as unknown as { queryPromise: Promise<unknown> }).queryPromise = new Promise(
        () => {}
      );
      const existing = Promise.withResolvers<void>();
      (agentSession as unknown as { messageQueue: unknown }).messageQueue = {
        admitWithId: mock(() => Promise.resolve()),
        waitForPendingOrInFlight: mock(() => ({
          acknowledgment: existing.promise,
          content: 'hello',
        })),
        isRunning: mock(() => false),
        size: mock(() => 1),
      };

      await agentSession.stateManager.setProcessing('uuid-pending');
      const drive = agentSession.driveDeliveryTurn(
        'uuid-pending',
        'hello',
        null,
        false,
        () => true
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      existing.reject(new Error('Interrupted by user'));

      await expect(drive).rejects.toThrow('Interrupted by user');
      expect(markConsumedSpy).not.toHaveBeenCalled();
    });

    it('isWaitingForInput sees an unresolved sdk_resume_choice even while parked as queued', async () => {
      let unresolved = true;
      mockDb.getSDKMessageRepo = mock(() => ({
        hasUnresolvedHyperNeoAction: mock(() => unresolved),
      }));
      await agentSession.stateManager.setQueued('msg-gate');
      expect(agentSession.isWaitingForInput()).toBe(true);
      unresolved = false;
      expect(agentSession.isWaitingForInput()).toBe(false);
    });

    it('reconcileStrandedDeliveries skips processing, queued, and waiting_for_input', async () => {
      const activeDeliveryMessageUuids = mock(() => new Set<string>());
      mockDb.getJobQueueRepo = mock(() => ({ activeDeliveryMessageUuids }));

      await agentSession.stateManager.setProcessing('msg-processing');
      expect(await agentSession.reconcileStrandedDeliveries()).toBe(0);
      await agentSession.stateManager.setQueued('msg-queued');
      expect(await agentSession.reconcileStrandedDeliveries()).toBe(0);
      await agentSession.stateManager.setWaitingForInput({
        toolUseId: 'tool-waiting',
        questions: [],
      });
      expect(await agentSession.reconcileStrandedDeliveries()).toBe(0);

      expect(activeDeliveryMessageUuids).not.toHaveBeenCalled();
    });

    it('reconcileStrandedDeliveries skips both locked mutations when the idle owner goes stale while waiting for the lock', async () => {
      const enqueue = mock(() => ({}));
      const markDeliveryFailedByUuid = mock(() => null);
      mockDb.getJobQueueRepo = mock(() => ({
        activeDeliveryMessageUuids: mock(() => new Set<string>()),
        enqueue,
      }));
      mockDb.getUserMessageIdsByStatus = mock((_sessionId: string, status: string) =>
        status === 'enqueued'
          ? [{ dbId: 'db-1', uuid: 'uuid-1', timestamp: 1 }]
          : [{ dbId: 'db-2', uuid: 'uuid-2', timestamp: 2 }]
      );
      mockDb.getSDKMessageRepo = mock(() => ({ markDeliveryFailedByUuid }));

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = withSessionLock('test-session-id', async () => {
        await gate;
      });
      const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

      const owner = agentSession.stateManager.getCurrentIdleOwner();
      const reconcilePromise = agentSession.reconcileStrandedDeliveries(owner);
      await settle();
      await settle();
      expect(enqueue).not.toHaveBeenCalled();

      agentSession.incrementQueryGeneration();
      release();
      await holder;
      await reconcilePromise;

      expect(enqueue).not.toHaveBeenCalled();
      expect(markDeliveryFailedByUuid).not.toHaveBeenCalled();
    });

    it('reconcileStrandedDeliveries fences on the turn owner too — a successor delivery admission invalidates it', async () => {
      const enqueue = mock(() => ({}));
      const markDeliveryFailedByUuid = mock(() => null);
      mockDb.getJobQueueRepo = mock(() => ({
        activeDeliveryMessageUuids: mock(() => new Set<string>()),
        enqueue,
      }));
      mockDb.getUserMessageIdsByStatus = mock((_sessionId: string, status: string) =>
        status === 'enqueued'
          ? [{ dbId: 'db-1', uuid: 'uuid-1', timestamp: 1 }]
          : [{ dbId: 'db-2', uuid: 'uuid-2', timestamp: 2 }]
      );
      mockDb.getSDKMessageRepo = mock(() => ({ markDeliveryFailedByUuid }));

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = withSessionLock('test-session-id', async () => {
        await gate;
      });
      const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

      const owner = agentSession.stateManager.getCurrentIdleOwner();
      const reconcilePromise = agentSession.reconcileStrandedDeliveries(owner);
      await settle();
      await settle();

      agentSession.stateManager.admitDeliveryTurn();
      release();
      await holder;
      await reconcilePromise;

      expect(enqueue).not.toHaveBeenCalled();
      expect(markDeliveryFailedByUuid).not.toHaveBeenCalled();
    });

    it('reconcileStrandedDeliveries with a still-current owner re-enqueues and settles as before', async () => {
      const enqueue = mock(() => ({}));
      const markDeliveryFailedByUuid = mock(() => 'db-2');
      mockDb.getJobQueueRepo = mock(() => ({
        activeDeliveryMessageUuids: mock(() => new Set<string>()),
        enqueue,
      }));
      mockDb.getUserMessageIdsByStatus = mock((_sessionId: string, status: string) =>
        status === 'enqueued'
          ? [{ dbId: 'db-1', uuid: 'uuid-1', timestamp: 1 }]
          : [{ dbId: 'db-2', uuid: 'uuid-2', timestamp: 2 }]
      );
      mockDb.getSDKMessageRepo = mock(() => ({ markDeliveryFailedByUuid }));

      const owner = agentSession.stateManager.getCurrentIdleOwner();
      const settledCount = await agentSession.reconcileStrandedDeliveries(owner);

      expect(settledCount).toBe(2);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(markDeliveryFailedByUuid).toHaveBeenCalledTimes(1);
    });

    it('replayAllPendingMessages bypasses the manual-mode guard that stops immediate-mode replay', async () => {
      agentSession.session.config.queryMode = 'manual';
      const inner = agentSession.queryModeHandler as unknown as {
        replayPendingMessagesForImmediateMode: ReturnType<typeof mock>;
      };
      const innerSpy = spyOn(inner, 'replayPendingMessagesForImmediateMode').mockResolvedValue(
        undefined
      );

      await agentSession.replayPendingMessagesForImmediateMode();
      expect(innerSpy).not.toHaveBeenCalled();

      await agentSession.replayAllPendingMessages();
      expect(innerSpy).toHaveBeenCalledTimes(1);
    });

    it('handleModelSwitch should delegate to modelSwitchHandler', async () => {
      const mockResult = { success: true, model: 'claude-opus-4-20250514' };
      const switchModelSpy = mock(() => mockResult);
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).modelSwitchHandler = {
        switchModel: switchModelSpy,
      };

      const result = await agentSession.handleModelSwitch('claude-opus-4-20250514', 'anthropic');

      expect(switchModelSpy).toHaveBeenCalledWith('claude-opus-4-20250514', 'anthropic');
      expect(result).toEqual(mockResult);
    });

    it('handleQuestionResponse should delegate to askUserQuestionHandler', async () => {
      const handleQuestionResponseSpy = mock(async () => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).askUserQuestionHandler = {
        handleQuestionResponse: handleQuestionResponseSpy,
      };

      await agentSession.handleQuestionResponse('tool-123', []);

      expect(handleQuestionResponseSpy).toHaveBeenCalledWith('tool-123', []);
    });

    it('updateQuestionDraft should delegate to askUserQuestionHandler', async () => {
      const updateQuestionDraftSpy = mock(async () => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).askUserQuestionHandler = {
        updateQuestionDraft: updateQuestionDraftSpy,
      };

      await agentSession.updateQuestionDraft([]);

      expect(updateQuestionDraftSpy).toHaveBeenCalledWith([]);
    });

    it('handleQuestionCancel should delegate to askUserQuestionHandler', async () => {
      const handleQuestionCancelSpy = mock(async () => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).askUserQuestionHandler = {
        handleQuestionCancel: handleQuestionCancelSpy,
      };

      await agentSession.handleQuestionCancel('tool-456');

      expect(handleQuestionCancelSpy).toHaveBeenCalledWith('tool-456');
    });

    it('handleInterrupt should delegate to interruptHandler', async () => {
      const handleInterruptSpy = mock(async () => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).interruptHandler = {
        handleInterrupt: handleInterruptSpy,
      };

      await agentSession.handleInterrupt();

      expect(handleInterruptSpy).toHaveBeenCalled();
    });

    it('handleInterrupt reports in-progress from entry until the handler completes', async () => {
      let releaseHandler!: () => void;
      const handlerGate = new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      const handleInterruptSpy = mock(() => handlerGate);
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).interruptHandler = {
        handleInterrupt: handleInterruptSpy,
        isInterruptRequested: () => false,
        getInterruptPromise: () => null,
      };

      const pending = agentSession.handleInterrupt();
      expect(agentSession.isInterruptInProgress()).toBe(true);

      releaseHandler();
      await pending;
      expect(agentSession.isInterruptInProgress()).toBe(false);
      expect(handleInterruptSpy).toHaveBeenCalled();
    });

    it('revokePendingDelivery remove accepts deferred (next-turn) rows too (#3744105283)', async () => {
      const deletePendingSpy = mock(() => ({
        dbId: 'db-1',
        uuid: 'uuid-1',
        status: 'deferred' as const,
      }));
      const cancelDeliverySpy = mock(() => false);
      mockDb.deletePendingUserMessage = deletePendingSpy;
      mockDb.getJobQueueRepo = mock(() => ({ cancelDelivery: cancelDeliverySpy }));

      const result = await agentSession.revokePendingDelivery('db-1', 'remove');

      expect(result.changed).toBe(true);
      expect(deletePendingSpy).toHaveBeenCalledWith(mockSession.id, 'db-1');
      expect(cancelDeliverySpy).toHaveBeenCalledWith(mockSession.id, 'uuid-1');
    });

    it('revokePendingDelivery notifies the delivery feeds after defer+cancel (#862 review P2)', async () => {
      const deferSpy = mock(() => ({ dbId: 'db-1', uuid: 'uuid-1' }));
      const cancelDeliverySpy = mock(() => true);
      const notifySpy = mock(() => {});
      mockDb.deferEnqueuedUserMessage = deferSpy;
      mockDb.getJobQueueRepo = mock(() => ({ cancelDelivery: cancelDeliverySpy }));
      mockDb.notifyChange = notifySpy;

      await agentSession.revokePendingDelivery('db-1', 'defer');

      expect(notifySpy).toHaveBeenCalledWith('sdk_messages', { sessionId: mockSession.id });
      expect(notifySpy).toHaveBeenCalledWith('job_queue', { sessionId: mockSession.id });
    });

    it('deliverChatMessage preserves a legacy-owned processing turn', async () => {
      const jobQueue = {
        enqueue: mock(() => ({ id: 'job' })),
      };
      mockDb.getJobQueueRepo = mock(() => jobQueue);
      const setQueuedIfIdle = mock(async () => false);
      agentSession.stateManager.setQueuedIfIdle = setQueuedIfIdle;

      await agentSession.deliverChatMessage('legacy-overlap');

      expect(setQueuedIfIdle).toHaveBeenCalledWith('legacy-overlap');
      expect(agentSession.getProcessingState().status).not.toBe('queued');
    });

    it('deliverChatMessage treats queued publication failure as non-fatal after insertion', async () => {
      const jobQueue = {
        enqueue: mock(() => ({ id: 'job' })),
      };
      mockDb.getJobQueueRepo = mock(() => jobQueue);
      agentSession.stateManager.setQueuedIfIdle = mock(async () => {
        throw new Error('subscriber failed');
      });

      await expect(agentSession.deliverChatMessage('publish-failure')).resolves.toBeUndefined();
      expect(jobQueue.enqueue).toHaveBeenCalled();
    });

    it('deliverChatMessage cancels a pending rate-limit cooldown for a replacement chat', async () => {
      const jobQueue = {
        enqueue: mock(() => ({ id: 'job' })),
      };
      mockDb.getJobQueueRepo = mock(() => jobQueue);
      const cancelSpy = mock(() => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).rateLimitWatchdog = {
        cancel: cancelSpy,
      };
      agentSession.stateManager.setQueuedIfIdle = mock(async () => false);
      await agentSession.stateManager.setRateLimitCooldown({
        retryCount: 0,
        maxRetries: 5,
        retryAt: Date.now() + 60_000,
      });

      await agentSession.deliverChatMessage('cooldown-replacement');

      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(agentSession.stateManager.setQueuedIfIdle).toHaveBeenCalledWith(
        'cooldown-replacement'
      );
    });

    it('deliverChatMessage preserves the watchdog when the message queues behind an active delivery', async () => {
      const jobQueue = {
        enqueue: mock(() => ({ id: 'job' })),
        activeDeliveryMessageUuids: mock(() => new Set(['predecessor-msg'])),
      };
      mockDb.getJobQueueRepo = mock(() => jobQueue);
      const cancelSpy = mock(() => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).rateLimitWatchdog = {
        cancel: cancelSpy,
      };
      agentSession.stateManager.setQueuedIfIdle = mock(async () => false);

      await agentSession.deliverChatMessage('successor-msg');

      expect(cancelSpy).not.toHaveBeenCalled();
      expect(jobQueue.enqueue).toHaveBeenCalled();
      expect(agentSession.stateManager.setQueuedIfIdle).toHaveBeenCalledWith('successor-msg');
    });

    it('deliverChatMessage publishes failed status when the session is archived', async () => {
      (mockDb.getSession as ReturnType<typeof mock>).mockReturnValue({
        ...mockSession,
        status: 'archived',
      });
      mockDb.getSDKMessageRepo = mock(() => ({
        markDeliveryFailedByUuid: mock(() => 'db-1'),
      }));

      await expect(agentSession.deliverChatMessage('archived-msg')).rejects.toThrow(
        'Session test-session-id is archived'
      );

      expect(mockInternalEventBus.publish).toHaveBeenCalledWith('messages.statusChanged', {
        sessionId: 'test-session-id',
        messageIds: ['db-1'],
        status: 'failed',
      });
    });

    it('deliverChatMessage publishes failed status when durable enqueue fails', async () => {
      mockDb.getJobQueueRepo = mock(() => ({
        enqueue: mock(() => {
          throw new Error('delivery enqueue failure');
        }),
      }));
      mockDb.getSDKMessageRepo = mock(() => ({
        markDeliveryFailedByUuid: mock(() => 'db-2'),
      }));

      await expect(agentSession.deliverChatMessage('enqueue-fail')).rejects.toThrow(
        'delivery enqueue failure'
      );

      expect(mockInternalEventBus.publish).toHaveBeenCalledWith('messages.statusChanged', {
        sessionId: 'test-session-id',
        messageIds: ['db-2'],
        status: 'failed',
      });
    });

    it('resetQuery should delegate to lifecycleManager', async () => {
      const resetSpy = mock(async () => ({ success: true }));
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
        reset: resetSpy,
      };

      const result = await agentSession.resetQuery({ restartQuery: true });

      expect(resetSpy).toHaveBeenCalledWith({ restartAfter: true });
      expect(result).toEqual({ success: true });
    });

    it('resetQuery should keep lifecycle reset behavior unless hardReset is requested', async () => {
      const resetSpy = mock(async () => ({ success: true }));
      const hardResetSpy = mock(async () => ({ success: true }));
      const sessionWithHardReset = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey,
        undefined,
        undefined,
        undefined,
        undefined,
        { hardReset: hardResetSpy }
      );
      // biome-ignore lint: test mock access
      (sessionWithHardReset as unknown as Record<string, unknown>).lifecycleManager = {
        reset: resetSpy,
      };

      const result = await sessionWithHardReset.resetQuery({ restartQuery: true });

      expect(hardResetSpy).not.toHaveBeenCalled();
      expect(resetSpy).toHaveBeenCalledWith({ restartAfter: true });
      expect(result).toEqual({ success: true });
    });

    it('resetQuery should use hard reset runtime hook when explicitly requested', async () => {
      const hardResetSpy = mock(async () => ({ success: true }));
      const sessionWithHardReset = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey,
        undefined,
        undefined,
        undefined,
        undefined,
        { hardReset: hardResetSpy }
      );

      const result = await sessionWithHardReset.resetQuery({
        restartQuery: true,
        hardReset: true,
      });

      expect(hardResetSpy).toHaveBeenCalledWith(sessionWithHardReset, { restartQuery: true });
      expect(result).toEqual({ success: true });
    });

    it('updateConfig should delegate to sessionConfigHandler', async () => {
      const updateConfigSpy = mock(async () => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).sessionConfigHandler = {
        updateConfig: updateConfigSpy,
      };

      await agentSession.updateConfig({ maxTokens: 4096 });

      expect(updateConfigSpy).toHaveBeenCalledWith({ maxTokens: 4096 });
    });

    it('updateMetadata should delegate to sessionConfigHandler', () => {
      const updateMetadataSpy = mock(() => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).sessionConfigHandler = {
        updateMetadata: updateMetadataSpy,
      };

      agentSession.updateMetadata({ title: 'New Title' });

      expect(updateMetadataSpy).toHaveBeenCalledWith({ title: 'New Title' });
    });

    it('getRewindPoints should delegate to rewindHandler', () => {
      const mockPoints = [{ id: 'cp1', messageId: 'msg1', timestamp: Date.now() }];
      const getRewindPointsSpy = mock(() => mockPoints);
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).rewindHandler = {
        getRewindPoints: getRewindPointsSpy,
      };

      const result = agentSession.getRewindPoints();

      expect(getRewindPointsSpy).toHaveBeenCalled();
      expect(result).toEqual(mockPoints);
    });

    it('previewRewind should delegate to rewindHandler', async () => {
      const mockPreview = { messagesToDelete: [], filesToRevert: [] };
      const previewRewindSpy = mock(async () => mockPreview);
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).rewindHandler = {
        previewRewind: previewRewindSpy,
      };

      const result = await agentSession.previewRewind('cp-123');

      expect(previewRewindSpy).toHaveBeenCalledWith('cp-123');
      expect(result).toEqual(mockPreview);
    });

    it('executeRewind should delegate to rewindHandler', async () => {
      const mockResult = { success: true, messagesDeleted: 5, filesReverted: [] };
      const executeRewindSpy = mock(async () => mockResult);
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).rewindHandler = {
        executeRewind: executeRewindSpy,
      };

      const result = await agentSession.executeRewind('cp-456', 'conversation');

      expect(executeRewindSpy).toHaveBeenCalledWith('cp-456', 'conversation');
      expect(result).toEqual(mockResult);
    });

    it('previewSelectiveRewind should delegate to rewindHandler', async () => {
      const mockPreview = { messagesToDelete: [], filesToRevert: [] };
      const previewSelectiveRewindSpy = mock(async () => mockPreview);
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).rewindHandler = {
        previewSelectiveRewind: previewSelectiveRewindSpy,
      };

      const result = await agentSession.previewSelectiveRewind(['msg1', 'msg2']);

      expect(previewSelectiveRewindSpy).toHaveBeenCalledWith(['msg1', 'msg2']);
      expect(result).toEqual(mockPreview);
    });

    it('setMaxThinkingTokens should delegate to sdkRuntimeConfig', async () => {
      const mockResult = { success: true };
      const setMaxThinkingTokensSpy = mock(async () => mockResult);
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).sdkRuntimeConfig = {
        setMaxThinkingTokens: setMaxThinkingTokensSpy,
      };

      const result = await agentSession.setMaxThinkingTokens(1000);

      expect(setMaxThinkingTokensSpy).toHaveBeenCalledWith(1000);
      expect(result).toEqual(mockResult);
    });

    it('setPermissionMode should delegate to sdkRuntimeConfig', async () => {
      const mockResult = { success: true };
      const setPermissionModeSpy = mock(async () => mockResult);
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).sdkRuntimeConfig = {
        setPermissionMode: setPermissionModeSpy,
      };

      const result = await agentSession.setPermissionMode('auto');

      expect(setPermissionModeSpy).toHaveBeenCalledWith('auto');
      expect(result).toEqual(mockResult);
    });

    it('getMcpServerStatus should delegate to sdkRuntimeConfig', async () => {
      const mockStatus = [{ name: 'server1', status: 'connected' }];
      const getMcpServerStatusSpy = mock(async () => mockStatus);
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).sdkRuntimeConfig = {
        getMcpServerStatus: getMcpServerStatusSpy,
      };

      const result = await agentSession.getMcpServerStatus();

      expect(getMcpServerStatusSpy).toHaveBeenCalled();
      expect(result).toEqual(mockStatus);
    });

    it('updateToolsConfig should delegate to sdkRuntimeConfig', async () => {
      const mockResult = { success: true };
      const updateToolsConfigSpy = mock(async () => mockResult);
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).sdkRuntimeConfig = {
        updateToolsConfig: updateToolsConfigSpy,
      };

      const result = await agentSession.updateToolsConfig({ allowedTools: ['tool1'] });

      expect(updateToolsConfigSpy).toHaveBeenCalledWith({ allowedTools: ['tool1'] });
      expect(result).toEqual(mockResult);
    });

    it('handleQueryTrigger should delegate to queryModeHandler', async () => {
      const mockResult = { success: true, messageCount: 1 };
      const handleQueryTriggerSpy = mock(async () => mockResult);
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).queryModeHandler = {
        handleQueryTrigger: handleQueryTriggerSpy,
      };

      const result = await agentSession.handleQueryTrigger();

      expect(handleQueryTriggerSpy).toHaveBeenCalled();
      expect(result).toEqual(mockResult);
    });

    it('cleanup should delegate to lifecycleManager', async () => {
      const cleanupSpy = mock(async () => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
        cleanup: cleanupSpy,
      };

      await agentSession.cleanup();

      expect(cleanupSpy).toHaveBeenCalled();
    });
  });

  describe('query generation tracking', () => {
    let mockSession: Session;
    let mockDb: Database;
    let mockMessageHub: MessageHub;
    let mockInternalEventBus: InternalEventBus<any>;
    let mockGetApiKey: () => Promise<string | null>;
    let agentSession: AgentSession;

    beforeEach(() => {
      mockSession = {
        id: 'test-session-id',
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
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
      } as Session;

      mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      mockMessageHub = {} as unknown as MessageHub;

      mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;

      mockGetApiKey = mock(async () => 'test-api-key');

      agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
    });

    it('should start with generation 0', () => {
      expect(agentSession.getQueryGeneration()).toBe(0);
    });

    it('incrementQueryGeneration should increment and return new value', () => {
      const gen1 = agentSession.incrementQueryGeneration();
      expect(gen1).toBe(1);
      expect(agentSession.getQueryGeneration()).toBe(1);

      const gen2 = agentSession.incrementQueryGeneration();
      expect(gen2).toBe(2);
      expect(agentSession.getQueryGeneration()).toBe(2);
    });

    it('setCleaningUp should update cleaning up state', () => {
      expect(agentSession.isCleaningUp()).toBe(false);

      agentSession.setCleaningUp(true);
      expect(agentSession.isCleaningUp()).toBe(true);

      agentSession.setCleaningUp(false);
      expect(agentSession.isCleaningUp()).toBe(false);
    });
  });

  describe('executeSelectiveRewind', () => {
    let mockSession: Session;
    let mockDb: Database;
    let mockMessageHub: MessageHub;
    let mockInternalEventBus: InternalEventBus<any>;
    let mockGetApiKey: () => Promise<string | null>;
    let agentSession: AgentSession;

    beforeEach(() => {
      mockSession = {
        id: 'test-session-id',
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
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
      } as Session;

      mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getUserMessages: mock(() => []),
        getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
        deleteMessagesAfter: mock(() => 0),
        deleteMessagesAtAndAfter: mock(() => 0),
        getUserMessageByUuid: mock(() => undefined),
        countMessagesAfter: mock(() => 0),
        updateMessage: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      mockMessageHub = {
        sendMessage: mock(() => {}),
      } as unknown as MessageHub;

      mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;

      mockGetApiKey = mock(async () => 'test-api-key');

      agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
    });

    it('should delegate to rewindHandler.executeSelectiveRewind with messageIds and mode', async () => {
      const messageIds = ['msg-1', 'msg-2'];
      const mode: RewindMode = 'both';
      const expectedResult: SelectiveRewindResult = {
        success: true,
        messagesDeleted: 2,
        filesReverted: ['file1.ts', 'file2.ts'],
        rewindCase: 'sdk-native',
      };

      const executeSelectiveRewindSpy = mock(() => Promise.resolve(expectedResult));
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).rewindHandler = {
        executeSelectiveRewind: executeSelectiveRewindSpy,
      };

      const result = await agentSession.executeSelectiveRewind(messageIds, mode);

      expect(executeSelectiveRewindSpy).toHaveBeenCalledTimes(1);
      expect(executeSelectiveRewindSpy).toHaveBeenCalledWith(messageIds, mode);
      expect(result).toEqual(expectedResult);
    });

    it('should delegate to rewindHandler.executeSelectiveRewind without mode parameter', async () => {
      const messageIds = ['msg-1', 'msg-2'];
      const expectedResult: SelectiveRewindResult = {
        success: true,
        messagesDeleted: 2,
        filesReverted: ['file1.ts'],
        rewindCase: 'diff-based',
      };

      const executeSelectiveRewindSpy = mock(() => Promise.resolve(expectedResult));
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).rewindHandler = {
        executeSelectiveRewind: executeSelectiveRewindSpy,
      };

      const result = await agentSession.executeSelectiveRewind(messageIds);

      expect(executeSelectiveRewindSpy).toHaveBeenCalledTimes(1);
      expect(executeSelectiveRewindSpy).toHaveBeenCalledWith(messageIds, undefined);
      expect(result).toEqual(expectedResult);
    });

    it('should handle different rewind modes', async () => {
      const messageIds = ['msg-1'];
      const modes: RewindMode[] = ['files', 'conversation', 'both'];

      for (const mode of modes) {
        const expectedResult: SelectiveRewindResult = {
          success: true,
          messagesDeleted: 1,
          filesReverted: [],
        };

        const executeSelectiveRewindSpy = mock(() => Promise.resolve(expectedResult));
        // biome-ignore lint: test mock access
        (agentSession as unknown as Record<string, unknown>).rewindHandler = {
          executeSelectiveRewind: executeSelectiveRewindSpy,
        };

        await agentSession.executeSelectiveRewind(messageIds, mode);

        expect(executeSelectiveRewindSpy).toHaveBeenCalledWith(messageIds, mode);
      }
    });
  });

  describe('startStreamingQuery', () => {
    let mockSession: Session;
    let mockDb: Database;
    let mockMessageHub: MessageHub;
    let mockInternalEventBus: InternalEventBus<any>;
    let mockGetApiKey: () => Promise<string | null>;
    let agentSession: AgentSession;

    beforeEach(() => {
      mockSession = {
        id: 'test-session-id',
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
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
      } as Session;

      mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      mockMessageHub = {} as unknown as MessageHub;

      mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;

      mockGetApiKey = mock(async () => 'test-api-key');

      agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
    });

    it('should delegate to queryRunner.start', async () => {
      const startSpy = mock(async () => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).queryRunner = {
        start: startSpy,
      };

      await agentSession.startStreamingQuery();

      expect(startSpy).toHaveBeenCalled();
    });
  });

  describe('ensureQueryStarted', () => {
    let mockSession: Session;
    let mockDb: Database;
    let mockMessageHub: MessageHub;
    let mockInternalEventBus: InternalEventBus<any>;
    let mockGetApiKey: () => Promise<string | null>;
    let agentSession: AgentSession;

    beforeEach(() => {
      mockSession = {
        id: 'test-session-id',
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
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
      } as Session;

      mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      mockMessageHub = {} as unknown as MessageHub;

      mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;

      mockGetApiKey = mock(async () => 'test-api-key');

      agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
    });

    it('should delegate to lifecycleManager.ensureQueryStarted', async () => {
      const ensureQueryStartedSpy = mock(async () => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
        ensureQueryStarted: ensureQueryStartedSpy,
      };

      await agentSession.ensureQueryStarted();

      expect(ensureQueryStartedSpy).toHaveBeenCalled();
    });
  });

  describe('startQueryAndEnqueue', () => {
    let mockSession: Session;
    let mockDb: Database;
    let mockMessageHub: MessageHub;
    let mockInternalEventBus: InternalEventBus<any>;
    let mockGetApiKey: () => Promise<string | null>;
    let agentSession: AgentSession;

    beforeEach(() => {
      mockSession = {
        id: 'test-session-id',
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
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
      } as Session;

      mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      mockMessageHub = {} as unknown as MessageHub;

      mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;

      mockGetApiKey = mock(async () => 'test-api-key');

      agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
    });

    it('should delegate to lifecycleManager.startQueryAndEnqueue', async () => {
      const startQueryAndEnqueueSpy = mock(async () => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
        startQueryAndEnqueue: startQueryAndEnqueueSpy,
      };

      await agentSession.startQueryAndEnqueue('msg-id', 'test content');

      expect(startQueryAndEnqueueSpy).toHaveBeenCalledWith(
        'msg-id',
        'test content',
        undefined,
        undefined
      );
    });

    it('should handle MessageContent array', async () => {
      const startQueryAndEnqueueSpy = mock(async () => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
        startQueryAndEnqueue: startQueryAndEnqueueSpy,
      };

      const content = [{ type: 'text', text: 'hello' }];
      await agentSession.startQueryAndEnqueue('msg-id', content);

      expect(startQueryAndEnqueueSpy).toHaveBeenCalledWith('msg-id', content, undefined, undefined);
    });

    it('cancels the in-flight recovery episode for genuine new input (undefined generation)', async () => {
      const cancelSpy = mock(() => {});
      const clearSpy = mock(() => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).rateLimitWatchdog = {
        cancel: cancelSpy,
        clearPendingCooldown: clearSpy,
      };
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
        startQueryAndEnqueue: mock(async () => {}),
      };
      await agentSession.startQueryAndEnqueue('msg-id', 'content');
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(clearSpy).not.toHaveBeenCalled();
    });

    it('executeRateLimitAutoRetry suppresses the waiter drain when startQueryAndEnqueue throws (Codex P1)', async () => {
      const setIdleSpy = mock(async (_opts?: { suppressDeliveryWaiters?: boolean }) => {});
      agentSession.stateManager.setIdle = setIdleSpy;
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).rateLimitWatchdog = {
        isSuperseded: () => false,
        clearPendingCooldown: () => {},
      };
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
        startQueryAndEnqueue: mock(async () => {
          throw new Error('startup failed');
        }),
      };
      const result = await (
        agentSession as unknown as {
          executeRateLimitAutoRetry: (
            msg: { uuid: string; content: string } | null,
            gen?: number
          ) => Promise<boolean>;
        }
      ).executeRateLimitAutoRetry({ uuid: 'msg-1', content: 'hi' }, 7);
      expect(result).toBe(false);
      expect(setIdleSpy).toHaveBeenCalled();
      for (const call of setIdleSpy.mock.calls) {
        expect(call[0]).toEqual({ suppressDeliveryWaiters: true });
      }
    });

    it('executeRateLimitAutoRetry quiet path: a superseded episode releases only its own waiters', async () => {
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).rateLimitWatchdog = {
        isSuperseded: mock(() => true),
      };
      const stateManager = agentSession.stateManager;
      stateManager.setOnIdleCallback(async () => {});
      let episodeEnded = false;
      let episodeResolved = false;
      let successorResolved = false;
      void stateManager
        .waitForIdleTransition(7, () => {
          episodeEnded = true;
        })
        .promise.then(() => {
          episodeResolved = true;
        });
      void stateManager
        .waitForIdleTransition(9, () => {})
        .promise.then(() => {
          successorResolved = true;
        });

      const result = await (
        agentSession as unknown as {
          executeRateLimitAutoRetry: (
            msg: { uuid: string; content: string } | null,
            gen?: number
          ) => Promise<boolean>;
        }
      ).executeRateLimitAutoRetry({ uuid: 'msg-1', content: 'hi' }, 7);

      expect(result).toBe(false);
      expect(episodeResolved).toBe(true);
      expect(episodeEnded).toBe(true);
      expect(successorResolved).toBe(false);
      expect(stateManager.getState().status).toBe('idle');
      expect(stateManager.isTerminalIdleInFlight()).toBe(false);
    });

    it('executeRateLimitAutoRetry without a user message settles with a loud unscoped idle', async () => {
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).rateLimitWatchdog = {
        isSuperseded: mock(() => true),
      };
      const stateManager = agentSession.stateManager;
      let idleCallbackRan = false;
      stateManager.setOnIdleCallback(async () => {
        idleCallbackRan = true;
      });
      await stateManager.setProcessing('msg-no-message');
      let aResolved = false;
      let bResolved = false;
      void stateManager
        .waitForIdleTransition(3, () => {})
        .promise.then(() => {
          aResolved = true;
        });
      void stateManager
        .waitForIdleTransition(4, () => {})
        .promise.then(() => {
          bResolved = true;
        });

      const result = await (
        agentSession as unknown as {
          executeRateLimitAutoRetry: (
            msg: { uuid: string; content: string } | null,
            gen?: number
          ) => Promise<boolean>;
        }
      ).executeRateLimitAutoRetry(null, 7);

      expect(result).toBe(false);
      expect(aResolved).toBe(true);
      expect(bResolved).toBe(true);
      expect(stateManager.getState().status).toBe('idle');
      expect(idleCallbackRan).toBe(true);
    });

    it('only clears the timer for a recovery re-enqueue (generation provided)', async () => {
      const cancelSpy = mock(() => {});
      const clearSpy = mock(() => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).rateLimitWatchdog = {
        cancel: cancelSpy,
        clearPendingCooldown: clearSpy,
      };
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
        startQueryAndEnqueue: mock(async () => {}),
      };
      await agentSession.startQueryAndEnqueue('msg-id', 'content', 7);
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(cancelSpy).not.toHaveBeenCalled();
    });
  });

  describe('restartQuery', () => {
    let mockSession: Session;
    let mockDb: Database;
    let mockMessageHub: MessageHub;
    let mockInternalEventBus: InternalEventBus<any>;
    let mockGetApiKey: () => Promise<string | null>;
    let agentSession: AgentSession;

    beforeEach(() => {
      mockSession = {
        id: 'test-session-id',
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
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
      } as Session;

      mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      mockMessageHub = {} as unknown as MessageHub;

      mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;

      mockGetApiKey = mock(async () => 'test-api-key');

      agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
    });

    it('should delegate to lifecycleManager.restartQuery', async () => {
      const restartQuerySpy = mock(async () => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
        restartQuery: restartQuerySpy,
      };

      await agentSession.restartQuery();

      expect(restartQuerySpy).toHaveBeenCalled();
    });
  });

  describe('onSDKMessage', () => {
    let mockSession: Session;
    let mockDb: Database;
    let mockMessageHub: MessageHub;
    let mockInternalEventBus: InternalEventBus<any>;
    let mockGetApiKey: () => Promise<string | null>;
    let agentSession: AgentSession;

    beforeEach(() => {
      mockSession = {
        id: 'test-session-id',
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
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
      } as Session;

      mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      mockMessageHub = {} as unknown as MessageHub;

      mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;

      mockGetApiKey = mock(async () => 'test-api-key');

      agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
    });

    it('should delegate to messageHandler.handleMessage', async () => {
      const handleMessageSpy = mock(async () => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).messageHandler = {
        handleMessage: handleMessageSpy,
      };

      const message = { type: 'assistant', message: { content: [] } };
      await agentSession.onSDKMessage(message as never);

      expect(handleMessageSpy).toHaveBeenCalledWith(message, agentSession.getQueryGeneration());
    });

    it('forwards the runner generation so a replaced query cannot consume the successor idle', async () => {
      const handleMessageSpy = mock(async () => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).messageHandler = {
        handleMessage: handleMessageSpy,
      };

      const message = { type: 'assistant', message: { content: [] } };
      await agentSession.onSDKMessage(message as never, undefined, 7);

      expect(handleMessageSpy).toHaveBeenCalledWith(message, 7);
    });

    it('a stale non-idle session-state event does not park the task-notification requery flag', async () => {
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).messageHandler = {
        handleMessage: mock(async () => {}),
      };
      agentSession.incrementQueryGeneration();
      const busy = {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'busy',
      };
      const flag = () =>
        (agentSession as unknown as { taskNotificationRequeryAwaitingSdkIdle: boolean })
          .taskNotificationRequeryAwaitingSdkIdle;

      await agentSession.onSDKMessage(
        busy as never,
        undefined,
        agentSession.getQueryGeneration() - 1
      );
      expect(flag()).toBe(false);

      await agentSession.onSDKMessage(busy as never, undefined, agentSession.getQueryGeneration());
      expect(flag()).toBe(true);
    });

    it('incrementQueryGeneration notes the PSM query-owner epoch: a replaced query waiter no longer consumes the successor idle', async () => {
      const stateManager = agentSession.stateManager;
      const replacedOwner = stateManager.idleOwnerForQuery(agentSession.getQueryGeneration());
      let staleResolved = false;
      void stateManager
        .waitForIdleTransition(undefined, undefined, replacedOwner)
        .promise.then(() => {
          staleResolved = true;
        });

      agentSession.incrementQueryGeneration();

      await stateManager.setIdle({ owner: stateManager.idleOwnerForQuery(1) });
      expect(staleResolved).toBe(false);

      await stateManager.setIdle({ owner: replacedOwner });
      expect(staleResolved).toBe(true);
    });
  });

  describe('onSlashCommandsFetched', () => {
    let mockSession: Session;
    let mockDb: Database;
    let mockMessageHub: MessageHub;
    let mockInternalEventBus: InternalEventBus<any>;
    let mockGetApiKey: () => Promise<string | null>;
    let agentSession: AgentSession;

    beforeEach(() => {
      mockSession = {
        id: 'test-session-id',
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
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
      } as Session;

      mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      mockMessageHub = {} as unknown as MessageHub;

      mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;

      mockGetApiKey = mock(async () => 'test-api-key');

      agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
    });

    it('should delegate to slashCommandManager.fetchAndCache', async () => {
      const fetchAndCacheSpy = mock(async () => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).slashCommandManager = {
        fetchAndCache: fetchAndCacheSpy,
      };

      await agentSession.onSlashCommandsFetched();

      expect(fetchAndCacheSpy).toHaveBeenCalled();
    });
  });

  describe('onMarkApiSuccess', () => {
    let mockSession: Session;
    let mockDb: Database;
    let mockMessageHub: MessageHub;
    let mockInternalEventBus: InternalEventBus<any>;
    let mockGetApiKey: () => Promise<string | null>;
    let agentSession: AgentSession;

    beforeEach(() => {
      mockSession = {
        id: 'test-session-id',
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
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
      } as Session;

      mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      mockMessageHub = {} as unknown as MessageHub;

      mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;

      mockGetApiKey = mock(async () => 'test-api-key');

      agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
    });

    it('should call errorManager.markApiSuccess', async () => {
      const markApiSuccessSpy = mock(() => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).errorManager = {
        markApiSuccess: markApiSuccessSpy,
      };

      await agentSession.onMarkApiSuccess({ type: 'result', subtype: 'success' } as any);

      expect(markApiSuccessSpy).toHaveBeenCalled();
    });

    it('does not reset the rate-limit episode on a non-success frame', async () => {
      const markApiSuccessSpy = mock(() => {});
      const resetSpy = mock(() => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).errorManager = {
        markApiSuccess: markApiSuccessSpy,
      };
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).rateLimitWatchdog = { reset: resetSpy };

      await agentSession.onMarkApiSuccess({ type: 'system', subtype: 'init' } as any);

      expect(markApiSuccessSpy).toHaveBeenCalled();
      expect(resetSpy).not.toHaveBeenCalled();
    });

    it('skips all success bookkeeping when the attempt generation is stale', async () => {
      const markApiSuccessSpy = mock(() => {});
      const resetSpy = mock(() => {});
      const setIdleSpy = mock(async () => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).errorManager = {
        markApiSuccess: markApiSuccessSpy,
      };
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).rateLimitWatchdog = {
        isPending: () => true,
        reset: resetSpy,
      };
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).stateManager = {
        noteQueryOwnerGeneration: mock(() => {}),
        getState: () => ({ status: 'rate_limit_cooldown' }),
        setIdle: setIdleSpy,
      };
      const staleGeneration = agentSession.getQueryGeneration();
      agentSession.incrementQueryGeneration();

      await agentSession.onMarkApiSuccess(
        { type: 'result', subtype: 'success' } as any,
        staleGeneration
      );

      expect(markApiSuccessSpy).not.toHaveBeenCalled();
      expect(resetSpy).not.toHaveBeenCalled();
      expect(setIdleSpy).not.toHaveBeenCalled();
    });

    it('applies success bookkeeping when the attempt generation is current', async () => {
      const markApiSuccessSpy = mock(() => {});
      const resetSpy = mock(() => {});
      const setIdleSpy = mock(async () => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).errorManager = {
        markApiSuccess: markApiSuccessSpy,
      };
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).rateLimitWatchdog = {
        isPending: () => true,
        reset: resetSpy,
      };
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).stateManager = {
        noteQueryOwnerGeneration: mock(() => {}),
        getState: () => ({ status: 'rate_limit_cooldown' }),
        setIdle: setIdleSpy,
      };
      const currentGeneration = agentSession.incrementQueryGeneration();

      await agentSession.onMarkApiSuccess(
        { type: 'result', subtype: 'success' } as any,
        currentGeneration
      );

      expect(markApiSuccessSpy).toHaveBeenCalled();
      expect(resetSpy).toHaveBeenCalled();
      expect(setIdleSpy).toHaveBeenCalled();
    });
  });

  describe('onModelsFetched', () => {
    let mockSession: Session;
    let mockDb: Database;
    let mockMessageHub: MessageHub;
    let mockInternalEventBus: InternalEventBus<any>;
    let mockGetApiKey: () => Promise<string | null>;
    let agentSession: AgentSession;

    beforeEach(() => {
      mockSession = {
        id: 'test-session-id',
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
          maxTokens: 8192,
          temperature: 1.0,
        },
        metadata: {},
      } as Session;

      mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      mockMessageHub = {} as unknown as MessageHub;

      mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;

      mockGetApiKey = mock(async () => 'test-api-key');

      agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );

      setModelsCache(new Map());
    });

    it('skips model discovery entirely when the query generation is stale', async () => {
      const supportedModels = mock(async () => [
        { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet · Test' },
      ]);
      agentSession.queryObject = {
        supportedModels,
      } as unknown as AgentSession['queryObject'];
      const staleGeneration = agentSession.getQueryGeneration();
      agentSession.incrementQueryGeneration();

      await agentSession.onModelsFetched(staleGeneration);

      expect(supportedModels).not.toHaveBeenCalled();
      expect(getModelsCache().get('test-session-id')).toBeUndefined();
    });

    it('caches discovered models when the query generation is current', async () => {
      agentSession.queryObject = {
        supportedModels: mock(async () => [
          { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet · Test' },
        ]),
      } as unknown as AgentSession['queryObject'];
      const currentGeneration = agentSession.incrementQueryGeneration();

      await agentSession.onModelsFetched(currentGeneration);

      expect(getModelsCache().get('test-session-id')?.length).toBe(1);
    });

    it('drops the cache write when the generation moves during discovery', async () => {
      agentSession.queryObject = {
        supportedModels: mock(async () => {
          agentSession.incrementQueryGeneration();
          return [{ value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet · Test' }];
        }),
      } as unknown as AgentSession['queryObject'];
      const generation = agentSession.getQueryGeneration();

      await agentSession.onModelsFetched(generation);

      expect(getModelsCache().get('test-session-id')).toBeUndefined();
    });

    it('drops the cache write when the attempt token is invalidated during discovery', async () => {
      const attemptToken = agentSession.attemptTokens.allocate();
      agentSession.queryObject = {
        supportedModels: mock(async () => {
          agentSession.attemptTokens.invalidate(attemptToken);
          return [{ value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet · Test' }];
        }),
      } as unknown as AgentSession['queryObject'];
      const generation = agentSession.getQueryGeneration();

      await agentSession.onModelsFetched(generation, attemptToken);

      expect(getModelsCache().get('test-session-id')).toBeUndefined();
    });

    it('caches discovered models when the attempt token stays live', async () => {
      const attemptToken = agentSession.attemptTokens.allocate();
      agentSession.queryObject = {
        supportedModels: mock(async () => [
          { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet · Test' },
        ]),
      } as unknown as AgentSession['queryObject'];
      const generation = agentSession.getQueryGeneration();

      await agentSession.onModelsFetched(generation, attemptToken);

      expect(getModelsCache().get('test-session-id')?.length).toBe(1);
    });

    it('drops the cache write when session cleanup starts during discovery', async () => {
      const attemptToken = agentSession.attemptTokens.allocate();
      agentSession.queryObject = {
        supportedModels: mock(async () => {
          (agentSession as unknown as Record<string, unknown>).isCleaningUp = () => true;
          return [{ value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet · Test' }];
        }),
      } as unknown as AgentSession['queryObject'];
      const generation = agentSession.getQueryGeneration();

      await agentSession.onModelsFetched(generation, attemptToken);

      expect(getModelsCache().get('test-session-id')).toBeUndefined();
    });
  });

  describe('getSlashCommands', () => {
    let mockSession: Session;
    let mockDb: Database;
    let mockMessageHub: MessageHub;
    let mockInternalEventBus: InternalEventBus<any>;
    let mockGetApiKey: () => Promise<string | null>;
    let agentSession: AgentSession;

    beforeEach(() => {
      mockSession = {
        id: 'test-session-id',
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
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
      } as Session;

      mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      mockMessageHub = {} as unknown as MessageHub;

      mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;

      mockGetApiKey = mock(async () => 'test-api-key');

      agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
    });

    it('should delegate to slashCommandManager.getSlashCommands', async () => {
      const mockCommands = ['/test', '/help'];
      const getSlashCommandsSpy = mock(async () => mockCommands);
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).slashCommandManager = {
        getSlashCommands: getSlashCommandsSpy,
      };

      const result = await agentSession.getSlashCommands();

      expect(getSlashCommandsSpy).toHaveBeenCalled();
      expect(result).toEqual(mockCommands);
    });
  });

  describe('cleanupEventSubscriptions', () => {
    let mockSession: Session;
    let mockDb: Database;
    let mockMessageHub: MessageHub;
    let mockInternalEventBus: InternalEventBus<any>;
    let mockGetApiKey: () => Promise<string | null>;
    let agentSession: AgentSession;

    beforeEach(() => {
      mockSession = {
        id: 'test-session-id',
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
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
      } as Session;

      mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      mockMessageHub = {} as unknown as MessageHub;

      mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;

      mockGetApiKey = mock(async () => 'test-api-key');

      agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
    });

    it('should delegate to eventSubscriptionSetup.cleanup', () => {
      const cleanupSpy = mock(() => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).eventSubscriptionSetup = {
        cleanup: cleanupSpy,
      };

      agentSession.cleanupEventSubscriptions();

      expect(cleanupSpy).toHaveBeenCalled();
    });
  });

  describe('pendingRestartReason', () => {
    let mockSession: Session;
    let mockDb: Database;
    let mockMessageHub: MessageHub;
    let mockInternalEventBus: InternalEventBus<any>;
    let mockGetApiKey: () => Promise<string | null>;
    let agentSession: AgentSession;

    beforeEach(() => {
      mockSession = {
        id: 'test-session-id',
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
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
      } as Session;

      mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      mockMessageHub = {} as unknown as MessageHub;

      mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;

      mockGetApiKey = mock(async () => 'test-api-key');

      agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
    });

    it('should initialize with null pendingRestartReason', () => {
      expect(agentSession.pendingRestartReason).toBeNull();
    });

    it('should allow setting pendingRestartReason', () => {
      agentSession.pendingRestartReason = 'settings.local.json';
      expect(agentSession.pendingRestartReason).toBe('settings.local.json');

      agentSession.pendingRestartReason = null;
      expect(agentSession.pendingRestartReason).toBeNull();
    });
  });

  describe('originalEnvVars', () => {
    let mockSession: Session;
    let mockDb: Database;
    let mockMessageHub: MessageHub;
    let mockInternalEventBus: InternalEventBus<any>;
    let mockGetApiKey: () => Promise<string | null>;
    let agentSession: AgentSession;

    beforeEach(() => {
      mockSession = {
        id: 'test-session-id',
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
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
      } as Session;

      mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      mockMessageHub = {} as unknown as MessageHub;

      mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;

      mockGetApiKey = mock(async () => 'test-api-key');

      agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
    });

    it('should initialize with empty originalEnvVars', () => {
      expect(agentSession.originalEnvVars).toEqual({});
    });

    it('should allow storing and retrieving env vars', () => {
      agentSession.originalEnvVars = { ANTHROPIC_API_KEY: 'old-key' };
      expect(agentSession.originalEnvVars).toEqual({ ANTHROPIC_API_KEY: 'old-key' });
    });
  });

  describe('createSessionFromInit', () => {
    it('uses provided title when creating a session', () => {
      const session = AgentSession.createSessionFromInit(
        {
          sessionId: 'node-agent:coder',
          title: 'Task #427: Forge MVP 3 — Coder',
          workspacePath: '/test/workspace',
          type: 'worker',
        },
        'claude-sonnet-4-5-20250929'
      );

      expect(session.title).toBe('Task #427: Forge MVP 3 — Coder');
      expect(session.metadata.titleGenerated).toBe(true);
    });

    it('falls back to New Session when title is omitted', () => {
      const session = AgentSession.createSessionFromInit(
        {
          sessionId: 'node-agent:untitled',
          workspacePath: '/test/workspace',
          type: 'worker',
        },
        'claude-sonnet-4-5-20250929'
      );

      expect(session.title).toBe('New Session');
      expect(session.metadata.titleGenerated).toBe(false);
    });

    it('should create a session without mcpServers in config to avoid cyclic serialization errors', () => {
      const mockMcpServer = {
        type: 'sdk' as const,
        name: 'lobby-agent-tools',
        instance: {
          connect: () => {},
          self: null as unknown,
        },
      };
      mockMcpServer.instance.self = mockMcpServer.instance;

      const init = {
        sessionId: 'lobby:default',
        workspacePath: '/test/workspace',
        systemPrompt: 'Test system prompt',
        mcpServers: {
          'lobby-agent-tools': mockMcpServer,
        },
        features: {
          rewind: false,
          worktree: false,
          coordinator: false,
          archive: false,
          sessionInfo: false,
        },
        context: { lobbyId: 'default' },
        type: 'lobby' as const,
        model: 'claude-sonnet-4-5-20250929',
      };

      const session = AgentSession.createSessionFromInit(init, 'claude-sonnet-4-5-20250929');

      expect(session.id).toBe('lobby:default');
      expect(session.type).toBe('lobby');
      expect(session.config.model).toBe('claude-sonnet-4-5-20250929');

      expect(session.config.mcpServers).toBeUndefined();

      expect(() => JSON.stringify(session.config)).not.toThrow();

      const serialized = JSON.stringify(session.config);
      expect(serialized).not.toContain('mcpServers');
    });

    it('should create a room session with serializable config', () => {
      const init = {
        sessionId: 'room:test-room',
        workspacePath: '/test/workspace',
        systemPrompt: 'Room system prompt',
        mcpServers: {
          'room-agent-tools': {
            type: 'sdk' as const,
            name: 'room-agent-tools',
            instance: { cyclic: null as unknown },
          },
        },
        features: {
          rewind: false,
          worktree: false,
          coordinator: false,
          archive: false,
          sessionInfo: false,
        },
        context: { roomId: 'test-room' },
        type: 'room' as const,
        model: 'claude-sonnet-4-5-20250929',
      };
      init.mcpServers!['room-agent-tools'].instance.cyclic =
        init.mcpServers!['room-agent-tools'].instance;

      const session = AgentSession.createSessionFromInit(init, 'claude-sonnet-4-5-20250929');

      expect(session.id).toBe('room:test-room');
      expect(session.type).toBe('room');
      expect(session.context?.roomId).toBe('test-room');

      expect(session.config.mcpServers).toBeUndefined();

      expect(() => JSON.stringify(session.config)).not.toThrow();
    });

    it('should preserve other config fields like systemPrompt and features', () => {
      const init = {
        sessionId: 'test-session',
        workspacePath: '/test/workspace',
        systemPrompt: 'Custom system prompt',
        features: {
          rewind: true,
          worktree: true,
          coordinator: false,
          archive: false,
          sessionInfo: true,
        },
        type: 'room' as const,
        model: 'claude-opus-4-20250514',
      };

      const session = AgentSession.createSessionFromInit(init, 'claude-sonnet-4-5-20250929');

      expect(session.config.systemPrompt).toBe('Custom system prompt');
      expect(session.config.features).toEqual({
        rewind: true,
        worktree: true,
        coordinator: false,
        archive: false,
        sessionInfo: true,
      });
      expect(session.config.model).toBe('claude-opus-4-20250514');
    });

    it('should preserve SDK tool permission fields from init', () => {
      const init = {
        sessionId: 'restricted-worker',
        workspacePath: '/test/workspace',
        type: 'worker' as const,
        model: 'claude-sonnet-4-5-20250929',
        sdkToolsPreset: ['Read', 'Bash'],
        allowedTools: ['Read', 'Bash'],
        disallowedTools: ['Write', 'Edit'],
      };

      const session = AgentSession.createSessionFromInit(init, 'claude-sonnet-4-5-20250929');

      expect(session.config.sdkToolsPreset).toEqual(['Read', 'Bash']);
      expect(session.config.allowedTools).toEqual(['Read', 'Bash']);
      expect(session.config.disallowedTools).toEqual(['Write', 'Edit']);
    });

    it('should persist toolGuards in session config for daemon restart restore', () => {
      const toolGuards = [
        {
          matcher: 'Bash',
          pattern: 'gh\\s+pr\\s+merge\\b',
          decision: 'deny' as const,
          reason: 'Coder agents must not merge PRs',
        },
      ];

      const init = {
        sessionId: 'coder:task-1',
        workspacePath: '/test/workspace',
        type: 'coder' as const,
        model: 'claude-sonnet-4-5-20250929',
        toolGuards,
      };

      const session = AgentSession.createSessionFromInit(init, 'claude-sonnet-4-5-20250929');

      expect(session.config.toolGuards).toEqual(toolGuards);

      const serialized = JSON.stringify(session.config);
      expect(serialized).toContain('toolGuards');
    });
  });

  describe('fromInit', () => {
    it('should merge mcpServers into session config at runtime for query options builder', () => {
      const mockMcpServer = {
        type: 'sdk' as const,
        name: 'test-tools',
        instance: { self: null as unknown },
      };
      mockMcpServer.instance.self = mockMcpServer.instance;

      const init = {
        sessionId: 'test:runtime',
        workspacePath: '/test/workspace',
        mcpServers: {
          'test-tools': mockMcpServer,
        },
        type: 'lobby' as const,
        model: 'claude-sonnet-4-5-20250929',
      };

      const mockDb = {
        getSession: mock(() => null),
        createSession: mock(() => {}),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      const mockMessageHub = {} as MessageHub;
      const mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;
      const mockGetApiKey = mock(async () => 'test-key');

      const agentSession = AgentSession.fromInit(
        init,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey,
        'claude-sonnet-4-5-20250929'
      );

      const sessionData = agentSession.getSessionData();
      expect(sessionData.config.mcpServers).toBeDefined();
      expect(sessionData.config.mcpServers!['test-tools']).toEqual(mockMcpServer);

      const createSessionCall = (mockDb as unknown as { createSession: ReturnType<typeof mock> })
        .createSession.mock.calls[0];
      const persistedSession = createSessionCall[0] as Session;
      expect(persistedSession.config.mcpServers).toBeUndefined();
    });

    it('should apply updated child-agent policy to an existing worker session', () => {
      const existingSession = {
        id: 'space:worker:test',
        title: 'Worker',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active' as const,
        config: { model: 'default', maxTokens: 8192, temperature: 1 },
        metadata: {
          messageCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
        },
        type: 'worker' as const,
      } as Session;
      const agents = {
        'general-purpose': {
          description: 'Investigate directly',
          prompt: 'Do not delegate.',
          disallowedTools: ['Agent', 'Task', 'TaskOutput', 'TaskStop'],
        },
      };
      const mockDb = {
        getSession: mock(() => existingSession),
        createSession: mock(() => {}),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;
      const mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;

      const agentSession = AgentSession.fromInit(
        {
          sessionId: existingSession.id,
          workspacePath: existingSession.workspacePath,
          type: 'worker',
          model: 'default',
          agents,
        },
        mockDb,
        {} as MessageHub,
        mockInternalEventBus,
        mock(async () => 'test-key'),
        'default'
      );

      expect(agentSession.getSessionData().config.agents).toEqual(agents);
      expect(
        (mockDb as unknown as { updateSession: ReturnType<typeof mock> }).updateSession.mock
          .calls[0]
      ).toEqual([
        existingSession.id,
        expect.objectContaining({ config: expect.objectContaining({ agents }) }),
      ]);
    });

    it('should update workspacePath for existing init sessions', () => {
      const existingSession = {
        id: 'room:test',
        title: 'Room Agent',
        workspacePath: '/old/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active' as const,
        config: {
          model: 'default',
          maxTokens: 8192,
          temperature: 1,
        },
        metadata: {
          messageCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
        },
        type: 'room' as const,
        context: { roomId: 'test' },
      } as Session;

      const init = {
        sessionId: 'room:test',
        workspacePath: '/new/workspace',
        type: 'room' as const,
        model: 'default',
      };

      const mockDb = {
        getSession: mock(() => existingSession),
        createSession: mock(() => {}),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      const mockMessageHub = {} as MessageHub;
      const mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;
      const mockGetApiKey = mock(async () => 'test-key');

      const agentSession = AgentSession.fromInit(
        init,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey,
        'default'
      );

      expect(
        (mockDb as unknown as { updateSession: ReturnType<typeof mock> }).updateSession.mock
          .calls[0]
      ).toEqual(['room:test', expect.objectContaining({})]);
      expect(agentSession.getSessionData().workspacePath).toBe('/new/workspace');
    });

    it('should clear stale thinking level when init omits override', () => {
      const existingSession = {
        id: 'space:agent:test',
        title: 'Space Agent',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active' as const,
        config: {
          model: 'default',
          thinkingLevel: 'think16k' as const,
          maxTokens: 8192,
          temperature: 1,
        },
        metadata: {
          messageCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
        },
        type: 'coder' as const,
      } as Session;

      const init = {
        sessionId: 'space:agent:test',
        workspacePath: '/test/workspace',
        type: 'coder' as const,
        model: 'default',
      };

      const mockDb = {
        getSession: mock(() => existingSession),
        createSession: mock(() => {}),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      const mockMessageHub = {} as MessageHub;
      const mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;
      const mockGetApiKey = mock(async () => 'test-key');

      const agentSession = AgentSession.fromInit(
        init,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey,
        'default'
      );

      expect(agentSession.getSessionData().config.thinkingLevel).toBeUndefined();
      expect(
        (mockDb as unknown as { updateSession: ReturnType<typeof mock> }).updateSession.mock
          .calls[0]
      ).toEqual([
        'space:agent:test',
        expect.objectContaining({
          config: expect.not.objectContaining({ thinkingLevel: expect.anything() }),
        }),
      ]);
    });

    it('should clear stale worktree when loading existing room session', () => {
      const existingSession = {
        id: 'room:test',
        title: 'Room Agent',
        workspacePath: '/old/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active' as const,
        config: {
          model: 'default',
          maxTokens: 8192,
          temperature: 1,
        },
        metadata: {
          messageCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
        },
        type: 'worker' as const,
        worktree: {
          isWorktree: true,
          worktreePath: '/stale/worktree',
          mainRepoPath: '/stale/repo',
          branch: 'session/stale',
        },
      } as Session;

      const init = {
        sessionId: 'room:test',
        workspacePath: '/new/workspace',
        type: 'room' as const,
        context: { roomId: 'test' },
        model: 'default',
      };

      const mockDb = {
        getSession: mock(() => existingSession),
        createSession: mock(() => {}),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      const mockMessageHub = {} as MessageHub;
      const mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;
      const mockGetApiKey = mock(async () => 'test-key');

      const agentSession = AgentSession.fromInit(
        init,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey,
        'default'
      );

      expect(
        (mockDb as unknown as { updateSession: ReturnType<typeof mock> }).updateSession.mock
          .calls[0]
      ).toEqual([
        'room:test',
        expect.objectContaining({
          workspacePath: '/new/workspace',
          type: 'room',
          context: { roomId: 'test' },
          worktree: undefined,
        }),
      ]);
      expect(agentSession.getSessionData().worktree).toBeUndefined();
      expect(agentSession.getSessionData().workspacePath).toBe('/new/workspace');
      expect(agentSession.getSessionData().type).toBe('room');
    });
  });

  describe('awaitSdkSessionCaptured', () => {
    function makeAgentSessionWithCapturedId(
      preCapturedSdkSessionId: string | undefined,
      onListener: (handler: (payload: Record<string, unknown>) => void) => {
        fire: (payload: Record<string, unknown>) => void;
        unsubscribe: ReturnType<typeof mock>;
      }
    ): { agentSession: AgentSession; controls: ReturnType<typeof onListener> } {
      const session: Session = {
        id: 'space:s1:task:t1',
        title: 'Task Agent',
        workspacePath: '/tmp/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-5-20250929',
          maxTokens: 8192,
          temperature: 1,
        },
        metadata: {
          messageCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
        },
        type: 'space_task_agent',
        context: { spaceId: 's1', taskId: 't1' },
        sdkSessionId: preCapturedSdkSessionId,
      } as Session;

      const mockDb = {
        getSession: mock(() => session),
        createSession: mock(() => {}),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      let captured: ReturnType<typeof onListener> | null = null;
      const mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((event: string, handler: (payload: Record<string, unknown>) => void) => {
          if (event === 'session.updated') {
            captured = onListener(handler);
            return captured.unsubscribe;
          }
          return () => {};
        }),
      } as unknown as InternalEventBus<any>;
      const mockMessageHub = {} as MessageHub;
      const mockGetApiKey = mock(async () => 'test-key');

      const init = {
        sessionId: session.id,
        workspacePath: session.workspacePath,
        type: 'space_task_agent' as const,
        context: session.context,
        model: session.config.model,
      };

      const agentSession = AgentSession.fromInit(
        init,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey,
        'claude-sonnet-4-5-20250929'
      );

      return {
        agentSession,
        controls: captured as unknown as ReturnType<typeof onListener>,
      };
    }

    it('resolves immediately when sdkSessionId is already set', async () => {
      const { agentSession } = makeAgentSessionWithCapturedId('sdk-already-here', () => ({
        fire: () => {},
        unsubscribe: mock(() => {}),
      }));
      const id = await agentSession.awaitSdkSessionCaptured(500);
      expect(id).toBe('sdk-already-here');
    });

    it('resolves when session.updated fires with a sdkSessionId payload', async () => {
      let handler: ((payload: Record<string, unknown>) => void) | null = null;
      const unsubscribe = mock(() => {});
      const { agentSession } = makeAgentSessionWithCapturedId(undefined, (h) => {
        handler = h;
        return { fire: h, unsubscribe };
      });

      const waiter = agentSession.awaitSdkSessionCaptured(2000);

      handler?.({ sessionId: 'other-session', session: { sdkSessionId: 'ignored' } });
      handler?.({
        sessionId: 'space:s1:task:t1',
        session: { sdkSessionId: 'sdk-just-captured' },
      });

      const id = await waiter;
      expect(id).toBe('sdk-just-captured');
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });

    it('rejects on timeout if the SDK never publishes a sdkSessionId', async () => {
      const unsubscribe = mock(() => {});
      const { agentSession } = makeAgentSessionWithCapturedId(undefined, (_h) => ({
        fire: () => {},
        unsubscribe,
      }));

      await expect(agentSession.awaitSdkSessionCaptured(50)).rejects.toThrow(
        /Timed out after 50ms/
      );
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    });
  });

  describe('setRuntimeSystemPrompt', () => {
    it('should update the in-memory system prompt without persisting it', () => {
      const mockSession: Session = {
        id: 'room:chat:test',
        title: 'Room Chat',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-5-20250929',
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
        type: 'room_chat',
      };

      const mockDb = {
        getSession: mock(() => null),
        createSession: mock(() => {}),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      const mockMessageHub = {} as MessageHub;
      const mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;
      const mockGetApiKey = mock(async () => 'test-api-key');

      const agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );

      expect(agentSession.getSessionData().config.systemPrompt).toBeUndefined();

      agentSession.setRuntimeSystemPrompt('You are the Room Agent.');

      expect(agentSession.getSessionData().config.systemPrompt).toBe('You are the Room Agent.');

      const updateSessionCalls = (mockDb as unknown as { updateSession: ReturnType<typeof mock> })
        .updateSession.mock.calls;
      expect(updateSessionCalls.length).toBe(0);
    });

    it('should overwrite an existing runtime system prompt', () => {
      const mockSession: Session = {
        id: 'room:chat:test2',
        title: 'Room Chat',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-5-20250929',
          maxTokens: 8192,
          temperature: 1.0,
          systemPrompt: 'old prompt',
        },
        metadata: {
          messageCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
          toolCallCount: 0,
        },
        type: 'room_chat',
      };

      const mockDb = {
        getSession: mock(() => null),
        createSession: mock(() => {}),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      const mockMessageHub = {} as MessageHub;
      const mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;
      const mockGetApiKey = mock(async () => 'test-api-key');

      const agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );

      agentSession.setRuntimeSystemPrompt('new prompt');

      expect(agentSession.getSessionData().config.systemPrompt).toBe('new prompt');
    });
  });

  describe('mergeRuntimeMcpServers', () => {
    const makeMockSession = (existingServers?: Record<string, unknown>): Session => ({
      id: 'space:worker:test',
      title: 'Space Worker',
      workspacePath: '/test/workspace',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: {
        model: 'claude-sonnet-4-5-20250929',
        maxTokens: 8192,
        temperature: 1.0,
        mcpServers: existingServers as Record<string, McpServerConfig> | undefined,
      },
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
      },
      type: 'general',
    });

    const makeMocks = () => {
      const mockDb = {
        getSession: mock(() => null),
        createSession: mock(() => {}),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;
      const mockMessageHub = {} as MessageHub;
      const mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;
      const mockGetApiKey = mock(async () => 'test-api-key');
      return { mockDb, mockMessageHub, mockInternalEventBus, mockGetApiKey };
    };

    it('should merge new servers into empty mcpServers config without persisting', () => {
      const mockSession = makeMockSession();
      const { mockDb, mockMessageHub, mockInternalEventBus, mockGetApiKey } = makeMocks();

      const agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );

      expect(agentSession.getSessionData().config.mcpServers).toBeUndefined();

      const newServer = { type: 'sdk', name: 'space-agent-tools' } as unknown as McpServerConfig;
      agentSession.mergeRuntimeMcpServers({ 'space-agent-tools': newServer });

      const merged = agentSession.getSessionData().config.mcpServers;
      expect(merged).toBeDefined();
      expect(merged?.['space-agent-tools']).toBe(newServer);

      const updateSessionCalls = (mockDb as unknown as { updateSession: ReturnType<typeof mock> })
        .updateSession.mock.calls;
      expect(updateSessionCalls.length).toBe(0);
    });

    it('should preserve existing mcpServers while adding new entries', () => {
      const existing = {
        'task-agent': { type: 'sdk', name: 'task-agent' } as unknown as McpServerConfig,
        'db-query': { type: 'sdk', name: 'db-query' } as unknown as McpServerConfig,
      };
      const mockSession = makeMockSession(existing);
      const { mockDb, mockMessageHub, mockInternalEventBus, mockGetApiKey } = makeMocks();

      const agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );

      const spaceAgent = {
        type: 'sdk',
        name: 'space-agent-tools',
      } as unknown as McpServerConfig;
      agentSession.mergeRuntimeMcpServers({ 'space-agent-tools': spaceAgent });

      const merged = agentSession.getSessionData().config.mcpServers;
      expect(merged).toBeDefined();
      expect(merged?.['task-agent']).toBe(existing['task-agent']);
      expect(merged?.['db-query']).toBe(existing['db-query']);
      expect(merged?.['space-agent-tools']).toBe(spaceAgent);
      expect(Object.keys(merged ?? {}).sort()).toEqual([
        'db-query',
        'space-agent-tools',
        'task-agent',
      ]);
    });

    it('should overwrite only overlapping keys, leaving others untouched', () => {
      const originalDbQuery = {
        type: 'sdk',
        name: 'db-query',
        mark: 'original',
      } as unknown as McpServerConfig;
      const existing = {
        'task-agent': { type: 'sdk', name: 'task-agent' } as unknown as McpServerConfig,
        'db-query': originalDbQuery,
      };
      const mockSession = makeMockSession(existing);
      const { mockDb, mockMessageHub, mockInternalEventBus, mockGetApiKey } = makeMocks();

      const agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );

      const replacementDbQuery = {
        type: 'sdk',
        name: 'db-query',
        mark: 'replacement',
      } as unknown as McpServerConfig;
      agentSession.mergeRuntimeMcpServers({ 'db-query': replacementDbQuery });

      const merged = agentSession.getSessionData().config.mcpServers;
      expect(merged?.['db-query']).toBe(replacementDbQuery);
      expect(merged?.['db-query']).not.toBe(originalDbQuery);
      expect(merged?.['task-agent']).toBe(existing['task-agent']);

      const updateSessionCalls = (mockDb as unknown as { updateSession: ReturnType<typeof mock> })
        .updateSession.mock.calls;
      expect(updateSessionCalls.length).toBe(0);
    });

    it('pushes merged runtime MCP servers into an active SDK query', async () => {
      const existing = {
        'task-agent': {
          type: 'sdk',
          name: 'task-agent',
          instance: {},
        } as unknown as McpServerConfig,
      };
      const mockSession = makeMockSession(existing);
      const { mockDb, mockMessageHub, mockInternalEventBus, mockGetApiKey } = makeMocks();
      const agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
      const setMcpServers = mock(async () => ({ added: [], removed: [], errors: {} }));
      agentSession.queryObject = {
        setMcpServers,
      } as unknown as import('@anthropic-ai/claude-agent-sdk').Query;

      const spaceAgent = {
        type: 'sdk',
        name: 'space-agent-tools',
        instance: {},
      } as unknown as McpServerConfig;
      agentSession.mergeRuntimeMcpServers({ 'space-agent-tools': spaceAgent });
      await Promise.resolve();

      expect(setMcpServers).toHaveBeenCalledTimes(1);
      expect(setMcpServers).toHaveBeenCalledWith({
        'task-agent': existing['task-agent'],
        'space-agent-tools': spaceAgent,
      });
    });

    it('can defer constructor pending-message replay until runtime provisioning completes', async () => {
      const mockSession = makeMockSession();
      const replayStatusReads: string[] = [];
      const getUserMessagesByStatus = mock((_sessionId: string, status: string) => {
        if (status === 'enqueued' || status === 'deferred') {
          replayStatusReads.push(status);
        }
        return { messages: [], total: 0 };
      });
      const { mockDb, mockMessageHub, mockInternalEventBus, mockGetApiKey } = makeMocks();
      (
        mockDb as unknown as { getUserMessagesByStatus: ReturnType<typeof mock> }
      ).getUserMessagesByStatus = getUserMessagesByStatus;

      const agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey,
        undefined,
        undefined,
        undefined,
        undefined,
        { autoReplayPendingMessages: false }
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(replayStatusReads).toEqual([]);

      await agentSession.replayPendingMessagesForImmediateMode();
      expect(replayStatusReads).toEqual(['enqueued', 'deferred']);
    });
  });

  describe('detachRuntimeMcpServer', () => {
    const makeMockSession = (existingServers?: Record<string, unknown>): Session => ({
      id: 'space:worker:test',
      title: 'Space Worker',
      workspacePath: '/test/workspace',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: {
        model: 'claude-sonnet-4-5-20250929',
        maxTokens: 8192,
        temperature: 1.0,
        mcpServers: existingServers as Record<string, McpServerConfig> | undefined,
      },
      metadata: {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
      },
      type: 'general',
    });

    const makeMocks = () => {
      const mockDb = {
        getSession: mock(() => null),
        createSession: mock(() => {}),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;
      const mockMessageHub = {} as MessageHub;
      const mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;
      const mockGetApiKey = mock(async () => 'test-api-key');
      return { mockDb, mockMessageHub, mockInternalEventBus, mockGetApiKey };
    };

    it('should remove the named server from mcpServers', () => {
      const existing = {
        'node-agent': { type: 'sdk' } as unknown as McpServerConfig,
        'space-agent-tools': { type: 'sdk' } as unknown as McpServerConfig,
      };
      const mockSession = makeMockSession(existing);
      const { mockDb, mockMessageHub, mockInternalEventBus, mockGetApiKey } = makeMocks();

      const agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );

      agentSession.detachRuntimeMcpServer('node-agent');

      const servers = agentSession.getSessionData().config.mcpServers;
      expect(servers?.['node-agent']).toBeUndefined();
      expect(servers?.['space-agent-tools']).toBe(existing['space-agent-tools']);
    });

    it('should be a no-op when name is not present', () => {
      const existing = {
        'space-agent-tools': { type: 'sdk' } as unknown as McpServerConfig,
      };
      const mockSession = makeMockSession(existing);
      const { mockDb, mockMessageHub, mockInternalEventBus, mockGetApiKey } = makeMocks();

      const agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );

      agentSession.detachRuntimeMcpServer('node-agent');

      const servers = agentSession.getSessionData().config.mcpServers;
      expect(servers?.['space-agent-tools']).toBe(existing['space-agent-tools']);
    });

    it('should be a no-op when mcpServers is not defined', () => {
      const mockSession = makeMockSession();
      const { mockDb, mockMessageHub, mockInternalEventBus, mockGetApiKey } = makeMocks();

      const agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );

      expect(() => agentSession.detachRuntimeMcpServer('node-agent')).not.toThrow();
    });

    it('should not persist the removal to the database', () => {
      const existing = {
        'node-agent': { type: 'sdk' } as unknown as McpServerConfig,
      };
      const mockSession = makeMockSession(existing);
      const { mockDb, mockMessageHub, mockInternalEventBus, mockGetApiKey } = makeMocks();

      const agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );

      agentSession.detachRuntimeMcpServer('node-agent');

      const updateSessionCalls = (mockDb as unknown as { updateSession: ReturnType<typeof mock> })
        .updateSession.mock.calls;
      expect(updateSessionCalls.length).toBe(0);
    });

    it('supports rotate pattern: detach then merge a replacement', () => {
      const staleNodeAgent = { type: 'sdk', tag: 'stale' } as unknown as McpServerConfig;
      const existing = {
        'node-agent': staleNodeAgent,
        'space-agent-tools': { type: 'sdk' } as unknown as McpServerConfig,
      };
      const mockSession = makeMockSession(existing);
      const { mockDb, mockMessageHub, mockInternalEventBus, mockGetApiKey } = makeMocks();

      const agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );

      const freshNodeAgent = { type: 'sdk', tag: 'fresh' } as unknown as McpServerConfig;
      agentSession.detachRuntimeMcpServer('node-agent');
      agentSession.mergeRuntimeMcpServers({ 'node-agent': freshNodeAgent });

      const servers = agentSession.getSessionData().config.mcpServers;
      expect(servers?.['node-agent']).toBe(freshNodeAgent);
      expect(servers?.['node-agent']).not.toBe(staleNodeAgent);
      expect(servers?.['space-agent-tools']).toBe(existing['space-agent-tools']);
    });
  });

  describe('startupTimeoutTimer', () => {
    let mockSession: Session;
    let mockDb: Database;
    let mockMessageHub: MessageHub;
    let mockInternalEventBus: InternalEventBus<any>;
    let mockGetApiKey: () => Promise<string | null>;
    let agentSession: AgentSession;

    beforeEach(() => {
      mockSession = {
        id: 'test-session-id',
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
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
      } as Session;

      mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      mockMessageHub = {} as unknown as MessageHub;

      mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;

      mockGetApiKey = mock(async () => 'test-api-key');

      agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
    });

    it('should initialize with null startupTimeoutTimer', () => {
      expect(agentSession.startupTimeoutTimer).toBeNull();
    });

    it('should allow setting and clearing timeout', () => {
      const timer = setTimeout(() => {}, 1000);
      agentSession.startupTimeoutTimer = timer;
      expect(agentSession.startupTimeoutTimer).toBe(timer);

      clearTimeout(timer);
      agentSession.startupTimeoutTimer = null;
      expect(agentSession.startupTimeoutTimer).toBeNull();
    });
  });

  describe('mcp.attach telemetry log format', () => {
    const makeMockSession = (
      overrides: Partial<Session> & { context?: Record<string, unknown> } = {}
    ): Session => ({
      id: 'space:worker:test',
      title: 'Space Worker',
      workspacePath: '/test/workspace',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: {
        model: 'claude-sonnet-4-5-20250929',
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
      type: 'general',
      ...overrides,
    });

    const makeMocks = () => {
      const mockDb = {
        getSession: mock(() => null),
        createSession: mock(() => {}),
        updateSession: mock(() => {}),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;
      const mockMessageHub = {} as MessageHub;
      const mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;
      const mockGetApiKey = mock(async () => 'test-api-key');
      return { mockDb, mockMessageHub, mockInternalEventBus, mockGetApiKey };
    };

    const captureLogs = (
      agentSession: AgentSession
    ): { entries: Array<Record<string, unknown>> } => {
      const entries: Array<Record<string, unknown>> = [];
      const session = agentSession as unknown as { logger: { info: (msg: string) => void } };
      const original = session.logger.info.bind(session.logger);
      session.logger.info = (...args: unknown[]) => {
        const first = args[0];
        if (typeof first === 'string' && first.startsWith('mcp.attach ')) {
          const tail = first.slice('mcp.attach '.length);
          try {
            entries.push(JSON.parse(tail));
          } catch {}
        }
        original(...(args as [unknown]));
      };
      return { entries };
    };

    it('emits a structured payload with sessionId, action, sorted servers on merge', () => {
      const mockSession = makeMockSession();
      const { mockDb, mockMessageHub, mockInternalEventBus, mockGetApiKey } = makeMocks();

      const agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
      const { entries } = captureLogs(agentSession);

      agentSession.mergeRuntimeMcpServers({
        zeta: { type: 'sdk', name: 'zeta' } as unknown as McpServerConfig,
        alpha: { type: 'sdk', name: 'alpha' } as unknown as McpServerConfig,
      });

      expect(entries.length).toBe(1);
      const payload = entries[0]!;
      expect(payload.event).toBe('mcp.attach');
      expect(payload.sessionId).toBe('space:worker:test');
      expect(payload.action).toBe('merge');
      expect(payload.servers).toEqual(['alpha', 'zeta']);
    });

    it('emits action=detach with the single server name', () => {
      const mockSession = makeMockSession({
        config: {
          model: 'claude-sonnet-4-5-20250929',
          maxTokens: 8192,
          temperature: 1.0,
          mcpServers: {
            'node-agent': { type: 'sdk', name: 'node-agent' } as unknown as McpServerConfig,
          },
        },
      });
      const { mockDb, mockMessageHub, mockInternalEventBus, mockGetApiKey } = makeMocks();

      const agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
      const { entries } = captureLogs(agentSession);

      agentSession.detachRuntimeMcpServer('node-agent');

      expect(entries.length).toBe(1);
      expect(entries[0]).toMatchObject({
        event: 'mcp.attach',
        action: 'detach',
        servers: ['node-agent'],
      });
    });

    it('emits action=replace from the deprecated replaceAllRuntimeMcpServers entry point', () => {
      const mockSession = makeMockSession();
      const { mockDb, mockMessageHub, mockInternalEventBus, mockGetApiKey } = makeMocks();

      const agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
      const { entries } = captureLogs(agentSession);

      agentSession.replaceAllRuntimeMcpServers({
        'task-agent': { type: 'sdk', name: 'task-agent' } as unknown as McpServerConfig,
      });

      expect(entries.length).toBe(1);
      expect(entries[0]!.action).toBe('replace');
      expect(entries[0]!.servers).toEqual(['task-agent']);
    });

    it('extracts taskId from a workflow sub-session id when context is missing', () => {
      const mockSession = makeMockSession({
        id: 'space:s1:task:t-42:exec:e7',
      });
      const { mockDb, mockMessageHub, mockInternalEventBus, mockGetApiKey } = makeMocks();

      const agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
      const { entries } = captureLogs(agentSession);

      agentSession.mergeRuntimeMcpServers({
        'node-agent': { type: 'sdk', name: 'node-agent' } as unknown as McpServerConfig,
      });

      expect(entries.length).toBe(1);
      expect(entries[0]!.taskId).toBe('t-42');
    });

    it('includes spaceId and taskId from session context when present', () => {
      const mockSession = makeMockSession({
        id: 'space:abc:agent:reviewer',
        context: { spaceId: 'abc', taskId: 'task-99' },
      });
      const { mockDb, mockMessageHub, mockInternalEventBus, mockGetApiKey } = makeMocks();

      const agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
      const { entries } = captureLogs(agentSession);

      agentSession.mergeRuntimeMcpServers({
        'space-agent-tools': {
          type: 'sdk',
          name: 'space-agent-tools',
        } as unknown as McpServerConfig,
      });

      expect(entries.length).toBe(1);
      expect(entries[0]!.spaceId).toBe('abc');
      expect(entries[0]!.taskId).toBe('task-99');
    });

    it('omits spaceId/taskId when neither context nor sub-session shape provides them', () => {
      const mockSession = makeMockSession({ id: 'standalone-session' });
      const { mockDb, mockMessageHub, mockInternalEventBus, mockGetApiKey } = makeMocks();

      const agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
      const { entries } = captureLogs(agentSession);

      agentSession.mergeRuntimeMcpServers({
        foo: { type: 'sdk', name: 'foo' } as unknown as McpServerConfig,
      });

      expect(entries.length).toBe(1);
      expect(entries[0]).not.toHaveProperty('spaceId');
      expect(entries[0]).not.toHaveProperty('taskId');
    });
  });

  describe('restore', () => {
    it('should re-apply toolGuards from persisted session config', () => {
      const toolGuards = [
        {
          matcher: 'Bash',
          pattern: 'gh\\s+pr\\s+merge\\b',
          decision: 'deny' as const,
          reason: 'Coder agents must not merge PRs',
        },
      ];

      const seedSession = {
        id: 'restored-session',
        title: 'Restored Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active' as const,
        config: {
          model: 'claude-sonnet-4-5-20250929',
          maxTokens: 4096,
          temperature: 1.0,
          toolGuards,
        },
        metadata: {},
      };

      const db = {
        getSession: mock(() => seedSession),
        updateSession: mock(() => {}),
        getUserMessages: mock(() => []),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
        getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
        deleteMessagesAfter: mock(() => 0),
        deleteMessagesAtAndAfter: mock(() => 0),
        getUserMessageByUuid: mock(() => undefined),
        countMessagesAfter: mock(() => 0),
        updateMessage: mock(() => {}),
      } as unknown as Database;

      const msgHub = {
        onMessage: mock(() => () => {}),
        sendMessage: mock(() => {}),
      } as unknown as MessageHub;

      const mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;

      const getApiKey = mock(async () => 'test-key');

      const agentSession = AgentSession.restore(
        'restored-session',
        db,
        msgHub,
        mockInternalEventBus,
        getApiKey
      );

      expect(agentSession).not.toBeNull();
      expect(agentSession!.toolGuards).toEqual(toolGuards);
    });

    it('should pass undefined toolGuards when config has no toolGuards', () => {
      const seedSession = {
        id: 'restored-session-no-guards',
        title: 'Restored Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active' as const,
        config: {
          model: 'claude-sonnet-4-5-20250929',
          maxTokens: 4096,
          temperature: 1.0,
        },
        metadata: {},
      };

      const db = {
        getSession: mock(() => seedSession),
        updateSession: mock(() => {}),
        getUserMessages: mock(() => []),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
        getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
        deleteMessagesAfter: mock(() => 0),
        deleteMessagesAtAndAfter: mock(() => 0),
        getUserMessageByUuid: mock(() => undefined),
        countMessagesAfter: mock(() => 0),
        updateMessage: mock(() => {}),
      } as unknown as Database;

      const msgHub = {
        onMessage: mock(() => () => {}),
        sendMessage: mock(() => {}),
      } as unknown as MessageHub;

      const mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;

      const getApiKey = mock(async () => 'test-key');

      const agentSession = AgentSession.restore(
        'restored-session-no-guards',
        db,
        msgHub,
        mockInternalEventBus,
        getApiKey
      );

      expect(agentSession).not.toBeNull();
      expect(agentSession!.toolGuards).toBeUndefined();
    });
  });

  describe('MCP server reconciliation', () => {
    let mockSession: Session;
    let mockDb: Database;
    let mockMessageHub: MessageHub;
    let mockInternalEventBus: InternalEventBus<any>;
    let agentSession: AgentSession;

    beforeEach(() => {
      mockSession = {
        id: 'reconcile-session-id',
        title: 'Reconcile',
        workspacePath: '/test',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: { model: 'claude-sonnet-4-20250514' },
        metadata: {},
      } as Session;

      mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
        getSDKMessageCount: mock(() => 0),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      mockMessageHub = { sendMessage: mock(() => {}) } as unknown as MessageHub;
      mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock(() => () => {}),
      } as unknown as InternalEventBus<any>;

      agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mock(async () => 'test-api-key')
      );
    });

    it('reconcileEffectiveMcpServers pushes the effective set to the live query, preserving runtime servers', () => {
      const runtimeServer: McpServerConfig = { command: 'runtime-cmd' };
      agentSession.session.config.mcpServers = { 'space-agent-tools': runtimeServer };

      const setMcpServers = mock(() => Promise.resolve({ added: [], removed: [], errors: [] }));
      agentSession.queryObject = {
        setMcpServers,
      } as unknown as AgentSession['queryObject'];

      agentSession.reconcileEffectiveMcpServers();

      expect(setMcpServers).toHaveBeenCalledTimes(1);
      const pushed = setMcpServers.mock.calls[0][0] as Record<string, McpServerConfig>;
      expect(pushed['space-agent-tools']).toEqual(runtimeServer);
    });

    it('reconcileEffectiveMcpServers is a no-op when there is no live query', () => {
      agentSession.session.config.mcpServers = { 'space-agent-tools': { command: 'runtime-cmd' } };
      expect(agentSession.queryObject).toBeNull();
      expect(() => agentSession.reconcileEffectiveMcpServers()).not.toThrow();
    });
  });

  describe('reconcileStrandedDeliveries admission', () => {
    const sessionId = 'sess-reconcile-admission';
    let db: Database;
    let agentSession: AgentSession;
    beforeEach(async () => {
      db = await createTestDb();
      const session = createTestSession(sessionId);
      db.createSession(session);
      agentSession = new AgentSession(
        session,
        db,
        {} as MessageHub,
        await createTestInternalEventBus(),
        mock(async () => 'test-api-key'),
        undefined,
        undefined,
        undefined,
        undefined,
        { autoReplayPendingMessages: false }
      );
    });

    afterEach(async () => {
      await agentSession.cleanup();
      db.close();
    });

    it('idle admission re-enqueues a stranded enqueued delivery', async () => {
      const uuid = 'msg-stranded-idle';
      db.getSDKMessageRepo().saveUserMessage(
        sessionId,
        {
          type: 'user',
          uuid,
          message: { role: 'user', content: 'recover me' },
        } as unknown as SDKMessage,
        'enqueued'
      );

      expect(await agentSession.reconcileStrandedDeliveries()).toBe(1);
      expect(db.getJobQueueRepo().activeDeliveryMessageUuids(sessionId)).toContain(uuid);
    });

    it('idle admission marks a stale submitted delivery failed and publishes the transition', async () => {
      const uuid = 'msg-stale-submitted';
      const repo = db.getSDKMessageRepo();
      repo.saveUserMessage(
        sessionId,
        {
          type: 'user',
          uuid,
          message: { role: 'user', content: 'stale submission' },
        } as unknown as SDKMessage,
        'enqueued'
      );
      repo.markDeliverySubmittedByUuids(sessionId, [uuid]);
      const statusEvents: Array<{ messageIds: string[]; status: string }> = [];
      const unsubscribe = agentSession.internalEventBus.subscribe(
        'messages.statusChanged',
        (event) => {
          statusEvents.push(event);
        },
        { subscriberName: 'agent-session-reconcile-test' }
      );

      expect(await agentSession.reconcileStrandedDeliveries()).toBe(1);
      await Promise.resolve();

      expect(repo.getDeliveryContent(sessionId, uuid)?.sendStatus).toBe('failed');
      expect(statusEvents).toContainEqual({
        sessionId,
        messageIds: [expect.any(String)],
        status: 'failed',
      });
      unsubscribe();
    });

    it('idle admission leaves submitted deliveries active in the job queue unsettled', async () => {
      const activeUuid = 'msg-submitted-active';
      const staleUuid = 'msg-submitted-stale';
      const repo = db.getSDKMessageRepo();
      for (const uuid of [activeUuid, staleUuid]) {
        repo.saveUserMessage(
          sessionId,
          {
            type: 'user',
            uuid,
            message: { role: 'user', content: 'submitted' },
          } as unknown as SDKMessage,
          'enqueued'
        );
        repo.markDeliverySubmittedByUuids(sessionId, [uuid]);
      }
      deliverMessage(db.getJobQueueRepo(), sessionId, activeUuid, { origin: 'chat' });

      expect(await agentSession.reconcileStrandedDeliveries()).toBe(1);

      expect(repo.getDeliveryContent(sessionId, activeUuid)?.sendStatus).toBe('submitted');
      expect(repo.getDeliveryContent(sessionId, staleUuid)?.sendStatus).toBe('failed');
    });
  });

  describe('driveDeliveryTurn — crash-window reclaim (task #946)', () => {
    let db: Database;
    let agentSession: AgentSession;
    const sessionId = 'sess-crash-window';
    const uuid = 'msg-crash-window';

    async function setupDriverail(opts: {
      marker: boolean;
      successResult: boolean;
    }): Promise<void> {
      db = await createTestDb();
      const session = createTestSession(sessionId);
      db.createSession(session);
      const repo = db.getSDKMessageRepo();
      repo.saveUserMessage(
        sessionId,
        { type: 'user', uuid, message: { role: 'user', content: 'hi' } } as unknown as SDKMessage,
        'enqueued'
      );
      repo.markDeliveryConsumedByUuid(sessionId, uuid);
      if (opts.successResult) {
        repo.saveSDKMessage(sessionId, {
          type: 'result',
          uuid: `${uuid}-result`,
          session_id: sessionId,
          parent_tool_use_id: null,
          subtype: 'success',
          is_error: false,
        } as unknown as SDKMessage);
      }
      if (opts.marker) {
        repo.recordDeliveryTurnEnd(sessionId, uuid, '2026-08-13T00:00:42.000Z');
      }
      const bus = await createTestInternalEventBus();
      agentSession = new AgentSession(
        db.getSession(sessionId) ?? session,
        db,
        {} as MessageHub,
        bus,
        mock(async () => 'test-api-key')
      );
    }

    afterEach(() => {
      try {
        db?.close();
      } catch {}
    });

    it('a bare marker (no success result) is NOT silently completed; a failed pass restores it', async () => {
      await setupDriverail({ marker: true, successResult: false });
      const repo = db.getSDKMessageRepo();
      expect(repo.hasDeliveryTurnEnd(sessionId, uuid)).toBe(true);

      (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
        ensureQueryStarted: mock(async () => {
          throw new Error('test: provider not started');
        }),
      };

      let threw = false;
      let outcome: unknown;
      try {
        outcome = await agentSession.driveDeliveryTurn(uuid, 'hi', null, true);
      } catch (err) {
        threw = err instanceof Error && err.message === 'test: provider not started';
      }
      expect(outcome).not.toEqual({ outcome: 'turn_terminated' });
      expect(threw).toBe(true);
      expect(repo.hasDeliveryTurnEnd(sessionId, uuid)).toBe(true);
    });

    it('a SUCCESS-terminated reclaim aborts admission on the consumed row and never re-feeds it', async () => {
      await setupDriverail({ marker: true, successResult: true });
      const repo = db.getSDKMessageRepo();
      expect(repo.hasTerminalResultAfter(sessionId, uuid)).toBe(true);

      (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
        ensureQueryStarted: mock(async () => 'started'),
      };
      const admitSpy = mock(() => new Promise<void>(() => {}));
      (agentSession as unknown as { messageQueue: unknown }).messageQueue = {
        admitWithId: admitSpy,
        waitForPendingOrInFlight: mock(() => null),
        isRunning: mock(() => false),
        size: mock(() => 0),
      };

      const outcome = await agentSession.driveDeliveryTurn(uuid, 'hi', null, true);
      expect(outcome).toEqual({ outcome: 'aborted' });
      expect(admitSpy).not.toHaveBeenCalled();
      expect(repo.getDeliveryContent(sessionId, uuid)?.sendStatus).toBe('consumed');
    });
  });

  describe('driveDeliveryTurn — admission decision table (A1c)', () => {
    const steerUuid = 'steer-msg-uuid';
    const steerContent = 'steer-content';
    const sessionId = 'sess-steer-a1c';

    type SteerRow = {
      name: string;
      delivery: 'enqueued' | 'submitted' | 'consumed' | 'missing';
      pending: boolean;
      claimGuard: 'held' | 'superseded';
      waitingForInput?: boolean;
      queued?: boolean;
      lifecycle: 'started' | 'blocked';
      provider?: 'acp' | 'anthropic';
      expected: 'aborted' | 'blocked' | 'completed';
    };

    function rowExpectsFreshAdmission(row: SteerRow): boolean {
      return row.expected === 'completed' && !row.pending;
    }

    async function waitForQueueEntry(queue: MessageQueue): Promise<void> {
      for (let i = 0; i < 200 && queue.size() === 0; i++) {
        await Promise.resolve();
      }
    }

    async function runSteerRow(row: SteerRow): Promise<{
      db: Database;
      queue: MessageQueue;
      outcome: unknown;
      admitWithId: ReturnType<typeof mock>;
    }> {
      const db = await createTestDb();
      const session = createTestSession(sessionId);
      session.config.provider = row.provider ?? 'anthropic';
      db.createSession(session);
      const repo = db.getSDKMessageRepo();
      if (row.delivery !== 'missing') {
        repo.saveUserMessage(
          sessionId,
          {
            type: 'user',
            uuid: steerUuid,
            message: { role: 'user', content: steerContent },
          } as unknown as SDKMessage,
          'enqueued'
        );
        if (row.delivery === 'consumed') {
          repo.markDeliveryConsumedByUuid(sessionId, steerUuid);
        } else if (row.delivery === 'submitted') {
          repo.markDeliverySubmittedByUuids(sessionId, [steerUuid]);
        }
      }
      const bus = await createTestInternalEventBus();
      const agentSession = new AgentSession(
        db.getSession(sessionId) ?? session,
        db,
        {} as MessageHub,
        bus,
        mock(async () => 'test-api-key'),
        undefined,
        undefined,
        undefined,
        undefined,
        { autoReplayPendingMessages: false }
      );
      if (row.waitingForInput) {
        await agentSession.stateManager.setWaitingForInput({
          toolUseId: 'tool-ask-1',
          questions: [],
          askedAt: Date.now(),
        });
      }
      if (row.queued) {
        await agentSession.stateManager.setQueued('turn-msg-uuid');
      }
      (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
        ensureQueryStarted: mock(async () => row.lifecycle),
        executeDeferredRestartIfPending: mock(async () => {}),
      };
      const queue = agentSession.messageQueue;
      if (row.pending) {
        queue.admitWithId(steerUuid, steerContent, false, { durable: true });
      }
      const originalAdmit = queue.admitWithId.bind(queue);
      const admitWithId = mock(originalAdmit);
      (queue as unknown as { admitWithId: MessageQueue['admitWithId'] }).admitWithId = admitWithId;
      agentSession.queryPromise = new Promise<void>(() => {});
      const claimGuard = row.claimGuard === 'held' ? () => true : () => false;
      const steerPromise = agentSession.driveDeliveryTurn(
        steerUuid,
        steerContent,
        null,
        false,
        claimGuard
      );
      if (row.pending) {
        for (let i = 0; i < 100; i++) {
          await Promise.resolve();
        }
      } else {
        await waitForQueueEntry(queue);
      }
      if (row.expected === 'completed') {
        queue.remove(steerUuid);
        if (row.provider === 'acp') {
          await new Promise((resolve) => setTimeout(resolve, 0));
          signalDeliveryConsumed(sessionId, steerUuid);
        }
      }
      const outcome = await steerPromise;
      return { db, queue, outcome, admitWithId };
    }

    const rows: SteerRow[] = [
      {
        name: 'a superseded claim aborts before admission and leaves the row enqueued',
        delivery: 'enqueued',
        pending: false,
        claimGuard: 'superseded',
        lifecycle: 'started',
        expected: 'aborted',
      },
      {
        name: 'a superseded claim aborts even while the session waits for input',
        delivery: 'enqueued',
        pending: false,
        claimGuard: 'superseded',
        waitingForInput: true,
        lifecycle: 'started',
        expected: 'aborted',
      },
      {
        name: 'a superseded claim aborts even with an already-pending steer',
        delivery: 'enqueued',
        pending: true,
        claimGuard: 'superseded',
        lifecycle: 'started',
        expected: 'aborted',
      },
      {
        name: 'waiting for input blocks admission with an sdk_resume_choice retry window',
        delivery: 'enqueued',
        pending: false,
        claimGuard: 'held',
        waitingForInput: true,
        lifecycle: 'started',
        expected: 'blocked',
      },
      {
        name: 'a query that cannot start blocks admission with an sdk_resume_choice retry window',
        delivery: 'enqueued',
        pending: false,
        claimGuard: 'held',
        lifecycle: 'blocked',
        expected: 'blocked',
      },
      {
        name: 'a consumed delivery row aborts admission',
        delivery: 'consumed',
        pending: false,
        claimGuard: 'held',
        lifecycle: 'started',
        expected: 'aborted',
      },
      {
        name: 'a missing delivery row aborts admission',
        delivery: 'missing',
        pending: false,
        claimGuard: 'held',
        lifecycle: 'started',
        expected: 'aborted',
      },
      {
        name: 'a submitted ACP delivery row is admitted and completes on the SDK ack',
        delivery: 'submitted',
        pending: false,
        claimGuard: 'held',
        lifecycle: 'started',
        provider: 'acp',
        expected: 'completed',
      },
      {
        name: 'a fresh enqueued steer is admitted durably and completes on the SDK ack',
        delivery: 'enqueued',
        pending: false,
        claimGuard: 'held',
        lifecycle: 'started',
        expected: 'completed',
      },
      {
        name: 'an already-pending steer reuses the in-flight acknowledgment without re-admitting',
        delivery: 'enqueued',
        pending: true,
        claimGuard: 'held',
        lifecycle: 'started',
        expected: 'completed',
      },
      {
        name: 'an already-pending ACP steer also reuses the in-flight acknowledgment',
        delivery: 'enqueued',
        pending: true,
        claimGuard: 'held',
        lifecycle: 'started',
        provider: 'acp',
        expected: 'completed',
      },
    ];

    for (const row of rows) {
      it(row.name, async () => {
        const { db, queue, outcome, admitWithId } = await runSteerRow(row);
        try {
          if (row.expected === 'blocked') {
            expect(outcome).toEqual({
              outcome: 'blocked',
              retryAt: expect.any(Number),
              reason: 'sdk_resume_choice',
            });
          } else {
            expect(outcome).toEqual({ outcome: row.expected });
          }
          if (row.expected === 'completed') {
            expect(
              db.getSDKMessageRepo().getDeliveryContent(sessionId, steerUuid)?.sendStatus
            ).toBe('consumed');
            expect(queue.hasPendingOrInFlight(steerUuid)).toBe(false);
          } else if (row.delivery === 'enqueued' || row.delivery === 'submitted') {
            expect(
              db.getSDKMessageRepo().getDeliveryContent(sessionId, steerUuid)?.sendStatus
            ).toBe(row.delivery);
            expect(queue.size()).toBe(row.pending ? 1 : 0);
          }
          expect(admitWithId).toHaveBeenCalledTimes(rowExpectsFreshAdmission(row) ? 1 : 0);
        } finally {
          db.close();
        }
      });
    }

    it('rejects with a terminal error when the persisted session is archived', async () => {
      const db = await createTestDb();
      try {
        const session = createTestSession(sessionId);
        db.createSession(session);
        db.updateSession(sessionId, { status: 'archived' });
        db.getSDKMessageRepo().saveUserMessage(
          sessionId,
          {
            type: 'user',
            uuid: steerUuid,
            message: { role: 'user', content: steerContent },
          } as unknown as SDKMessage,
          'enqueued'
        );
        const bus = await createTestInternalEventBus();
        const agentSession = new AgentSession(
          db.getSession(sessionId) ?? session,
          db,
          {} as MessageHub,
          bus,
          mock(async () => 'test-api-key'),
          undefined,
          undefined,
          undefined,
          undefined,
          { autoReplayPendingMessages: false }
        );
        agentSession.queryPromise = new Promise<void>(() => {});
        await expect(
          agentSession.driveDeliveryTurn(steerUuid, steerContent, null, false, () => true)
        ).rejects.toThrow('Session is archived');
      } finally {
        db.close();
      }
    });

    it('aborts when the session is cleaning up', async () => {
      const db = await createTestDb();
      try {
        const session = createTestSession(sessionId);
        db.createSession(session);
        db.getSDKMessageRepo().saveUserMessage(
          sessionId,
          {
            type: 'user',
            uuid: steerUuid,
            message: { role: 'user', content: steerContent },
          } as unknown as SDKMessage,
          'enqueued'
        );
        const bus = await createTestInternalEventBus();
        const agentSession = new AgentSession(
          db.getSession(sessionId) ?? session,
          db,
          {} as MessageHub,
          bus,
          mock(async () => 'test-api-key'),
          undefined,
          undefined,
          undefined,
          undefined,
          { autoReplayPendingMessages: false }
        );
        agentSession.queryPromise = new Promise<void>(() => {});
        agentSession.setCleaningUp(true);
        const outcome = await agentSession.driveDeliveryTurn(
          steerUuid,
          steerContent,
          null,
          false,
          () => true
        );
        expect(outcome).toEqual({ outcome: 'aborted' });
        expect(db.getSDKMessageRepo().getDeliveryContent(sessionId, steerUuid)?.sendStatus).toBe(
          'enqueued'
        );
      } finally {
        db.close();
      }
    });

    it('aborts when cleanup starts during the asynchronous query startup', async () => {
      const db = await createTestDb();
      try {
        const session = createTestSession(sessionId);
        db.createSession(session);
        db.getSDKMessageRepo().saveUserMessage(
          sessionId,
          {
            type: 'user',
            uuid: steerUuid,
            message: { role: 'user', content: steerContent },
          } as unknown as SDKMessage,
          'enqueued'
        );
        const bus = await createTestInternalEventBus();
        const agentSession = new AgentSession(
          db.getSession(sessionId) ?? session,
          db,
          {} as MessageHub,
          bus,
          mock(async () => 'test-api-key'),
          undefined,
          undefined,
          undefined,
          undefined,
          { autoReplayPendingMessages: false }
        );
        agentSession.queryPromise = new Promise<void>(() => {});
        let releaseStart!: () => void;
        (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
          ensureQueryStarted: mock(
            async () =>
              new Promise<'started'>((resolve) => {
                releaseStart = () => resolve('started');
              })
          ),
          executeDeferredRestartIfPending: mock(async () => {}),
        };
        const queue = agentSession.messageQueue;
        const originalAdmit = queue.admitWithId.bind(queue);
        const admitSpy = mock(originalAdmit);
        (queue as unknown as { admitWithId: MessageQueue['admitWithId'] }).admitWithId = admitSpy;
        (queue as unknown as { isRunning: () => boolean }).isRunning = mock(() => false);
        const steerPromise = agentSession.driveDeliveryTurn(
          steerUuid,
          steerContent,
          null,
          false,
          () => true
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        agentSession.setCleaningUp(true);
        releaseStart();
        const outcome = await steerPromise;
        expect(outcome).toEqual({ outcome: 'aborted' });
        expect(admitSpy).not.toHaveBeenCalled();
        expect(db.getSDKMessageRepo().getDeliveryContent(sessionId, steerUuid)?.sendStatus).toBe(
          'enqueued'
        );
      } finally {
        db.close();
      }
    });

    it('pins: a claim superseded while waiting for the session lock aborts after acquisition', async () => {
      const db = await createTestDb();
      try {
        const session = createTestSession(sessionId);
        db.createSession(session);
        const repo = db.getSDKMessageRepo();
        repo.saveUserMessage(
          sessionId,
          {
            type: 'user',
            uuid: steerUuid,
            message: { role: 'user', content: steerContent },
          } as unknown as SDKMessage,
          'enqueued'
        );
        const bus = await createTestInternalEventBus();
        const agentSession = new AgentSession(
          db.getSession(sessionId) ?? session,
          db,
          {} as MessageHub,
          bus,
          mock(async () => 'test-api-key'),
          undefined,
          undefined,
          undefined,
          undefined,
          { autoReplayPendingMessages: false }
        );
        await agentSession.stateManager.setProcessing('active-msg-uuid');
        agentSession.queryPromise = new Promise<void>(() => {});
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const hold = withSessionLock(sessionId, () => held);
        let claimHeld = true;
        const steerPromise = agentSession.driveDeliveryTurn(
          steerUuid,
          steerContent,
          null,
          false,
          () => claimHeld
        );
        claimHeld = false;
        release();
        const outcome = await steerPromise;
        expect(outcome).toEqual({ outcome: 'aborted' });
        await hold;
      } finally {
        db.close();
      }
    });

    it('pins: an already-yielded steer reuses the yielded acknowledgment without re-admitting', async () => {
      const db = await createTestDb();
      try {
        const session = createTestSession(sessionId);
        session.config.provider = 'acp';
        db.createSession(session);
        const repo = db.getSDKMessageRepo();
        repo.saveUserMessage(
          sessionId,
          {
            type: 'user',
            uuid: steerUuid,
            message: { role: 'user', content: steerContent },
          } as unknown as SDKMessage,
          'enqueued'
        );
        const bus = await createTestInternalEventBus();
        const agentSession = new AgentSession(
          db.getSession(sessionId) ?? session,
          db,
          {} as MessageHub,
          bus,
          mock(async () => 'test-api-key'),
          undefined,
          undefined,
          undefined,
          undefined,
          { autoReplayPendingMessages: false }
        );
        await agentSession.stateManager.setProcessing('active-msg-uuid');
        agentSession.queryPromise = new Promise<void>(() => {});
        const queue = agentSession.messageQueue;
        queue.admitWithId(steerUuid, steerContent, false, { durable: true });
        const originalAdmit = queue.admitWithId.bind(queue);
        const admitWithId = mock(originalAdmit);
        (queue as unknown as { admitWithId: MessageQueue['admitWithId'] }).admitWithId =
          admitWithId;
        queue.start();
        const generator = queue.messageGenerator(sessionId, { suppressPreYieldCallback: true });
        await generator.next();
        expect(queue.hasYielded(steerUuid)).toBe(true);
        const steerPromise = agentSession.driveDeliveryTurn(
          steerUuid,
          steerContent,
          null,
          false,
          () => true
        );
        for (let i = 0; i < 100; i++) {
          await Promise.resolve();
        }
        queue.acknowledgeYielded(steerUuid);
        await new Promise((resolve) => setTimeout(resolve, 0));
        signalDeliveryConsumed(sessionId, steerUuid);
        const outcome = await steerPromise;
        expect(outcome).toEqual({ outcome: 'completed' });
        expect(admitWithId).toHaveBeenCalledTimes(0);
        expect(queue.hasYielded(steerUuid)).toBe(false);
        expect(queue.size()).toBe(0);
        expect(repo.getDeliveryContent(sessionId, steerUuid)?.sendStatus).toBe('consumed');
      } finally {
        db.close();
      }
    });

    it('throws a recoverable admission timeout when a hung query never acknowledges an unclaimed steer', async () => {
      const previousTimeout = process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS;
      process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = '25';
      const db = await createTestDb();
      try {
        const session = createTestSession(sessionId);
        db.createSession(session);
        const repo = db.getSDKMessageRepo();
        repo.saveUserMessage(
          sessionId,
          {
            type: 'user',
            uuid: steerUuid,
            message: { role: 'user', content: steerContent },
          } as unknown as SDKMessage,
          'enqueued'
        );
        const bus = await createTestInternalEventBus();
        const agentSession = new AgentSession(
          db.getSession(sessionId) ?? session,
          db,
          {} as MessageHub,
          bus,
          mock(async () => 'test-api-key'),
          undefined,
          undefined,
          undefined,
          undefined,
          { autoReplayPendingMessages: false }
        );
        await agentSession.stateManager.setProcessing('active-msg-uuid');
        agentSession.queryPromise = new Promise<void>(() => {});
        (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
          ensureQueryStarted: mock(async () => 'started'),
          executeDeferredRestartIfPending: mock(async () => {}),
        };
        const queue = agentSession.messageQueue;
        const steerPromise = agentSession.driveDeliveryTurn(
          steerUuid,
          steerContent,
          null,
          false,
          () => true
        );
        await waitForQueueEntry(queue);
        await expect(steerPromise).rejects.toThrow('Delivery not consumed within timeout');
        expect(repo.getDeliveryContent(sessionId, steerUuid)?.sendStatus).toBe('enqueued');
        expect(queue.hasPendingOrInFlight(steerUuid)).toBe(false);
      } finally {
        if (previousTimeout === undefined)
          delete process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS;
        else process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = previousTimeout;
        db.close();
      }
    });

    it('settles a yielded steer as acknowledged when the queue durable-yield timeout fires', async () => {
      const previousTimeout = process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS;
      process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = '10000';
      const db = await createTestDb();
      try {
        const session = createTestSession(sessionId);
        db.createSession(session);
        const repo = db.getSDKMessageRepo();
        repo.saveUserMessage(
          sessionId,
          {
            type: 'user',
            uuid: steerUuid,
            message: { role: 'user', content: steerContent },
          } as unknown as SDKMessage,
          'enqueued'
        );
        const bus = await createTestInternalEventBus();
        const agentSession = new AgentSession(
          db.getSession(sessionId) ?? session,
          db,
          {} as MessageHub,
          bus,
          mock(async () => 'test-api-key'),
          undefined,
          undefined,
          undefined,
          undefined,
          { autoReplayPendingMessages: false }
        );
        await agentSession.stateManager.setProcessing('active-msg-uuid');
        agentSession.queryPromise = new Promise<void>(() => {});
        (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
          ensureQueryStarted: mock(async () => 'started'),
          executeDeferredRestartIfPending: mock(async () => {}),
        };
        const queue = agentSession.messageQueue;
        queue.overrideTimeoutMsForTest(25);
        const steerPromise = agentSession.driveDeliveryTurn(
          steerUuid,
          steerContent,
          null,
          false,
          () => true
        );
        await waitForQueueEntry(queue);
        queue.start();
        const generator = queue.messageGenerator(sessionId, { suppressPreYieldCallback: true });
        await generator.next();
        expect(queue.hasYielded(steerUuid)).toBe(true);
        const outcome = await steerPromise;
        expect(outcome).toEqual({ outcome: 'completed' });
        expect(repo.getDeliveryContent(sessionId, steerUuid)?.sendStatus).toBe('consumed');
        expect(queue.hasYielded(steerUuid)).toBe(false);
        expect(queue.size()).toBe(0);
      } finally {
        if (previousTimeout === undefined)
          delete process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS;
        else process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = previousTimeout;
        db.close();
      }
    });

    it('an acknowledgment arriving before the timeout still consumes the steer', async () => {
      const previousTimeout = process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS;
      process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = '10000';
      const db = await createTestDb();
      try {
        const session = createTestSession(sessionId);
        db.createSession(session);
        const repo = db.getSDKMessageRepo();
        repo.saveUserMessage(
          sessionId,
          {
            type: 'user',
            uuid: steerUuid,
            message: { role: 'user', content: steerContent },
          } as unknown as SDKMessage,
          'enqueued'
        );
        const bus = await createTestInternalEventBus();
        const agentSession = new AgentSession(
          db.getSession(sessionId) ?? session,
          db,
          {} as MessageHub,
          bus,
          mock(async () => 'test-api-key'),
          undefined,
          undefined,
          undefined,
          undefined,
          { autoReplayPendingMessages: false }
        );
        await agentSession.stateManager.setProcessing('active-msg-uuid');
        agentSession.queryPromise = new Promise<void>(() => {});
        (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
          ensureQueryStarted: mock(async () => 'started'),
          executeDeferredRestartIfPending: mock(async () => {}),
        };
        const queue = agentSession.messageQueue;
        const steerPromise = agentSession.driveDeliveryTurn(
          steerUuid,
          steerContent,
          null,
          false,
          () => true
        );
        await waitForQueueEntry(queue);
        queue.remove(steerUuid);
        const outcome = await steerPromise;
        expect(outcome).toEqual({ outcome: 'completed' });
        expect(repo.getDeliveryContent(sessionId, steerUuid)?.sendStatus).toBe('consumed');
      } finally {
        if (previousTimeout === undefined)
          delete process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS;
        else process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = previousTimeout;
        db.close();
      }
    });
  });

  describe('delivery continuation hardening (A3a)', () => {
    const hardUuid = 'hard-msg-uuid';
    const hardContent = 'hard-content';

    async function makeHardeningSession(
      sessionId: string,
      opts?: { provider?: Provider }
    ): Promise<{ db: Database; agentSession: AgentSession }> {
      const db = await createTestDb();
      const session = createTestSession(sessionId);
      if (opts?.provider) {
        session.config.provider = opts.provider;
      }
      db.createSession(session);
      db.getSDKMessageRepo().saveUserMessage(
        sessionId,
        {
          type: 'user',
          uuid: hardUuid,
          message: { role: 'user', content: hardContent },
        } as unknown as SDKMessage,
        'enqueued'
      );
      const bus = await createTestInternalEventBus();
      const agentSession = new AgentSession(
        db.getSession(sessionId) ?? session,
        db,
        {} as MessageHub,
        bus,
        mock(async () => 'test-api-key'),
        undefined,
        undefined,
        undefined,
        undefined,
        { autoReplayPendingMessages: false }
      );
      await agentSession.stateManager.setProcessing('active-msg-uuid');
      return { db, agentSession };
    }

    async function waitForQueueEntry(queue: { size: () => number }): Promise<void> {
      for (let i = 0; i < 200 && queue.size() === 0; i++) {
        await Promise.resolve();
      }
    }

    it('a steer whose yielded acknowledgment is cleared by an interrupt reopens for retry instead of consuming', async () => {
      const { db, agentSession } = await makeHardeningSession('sess-a3a-steer-cleared');
      try {
        const queue = agentSession.messageQueue;
        agentSession.queryPromise = new Promise<void>(() => {});
        const steerPromise = agentSession.driveDeliveryTurn(
          hardUuid,
          hardContent,
          null,
          false,
          () => true
        );
        await waitForQueueEntry(queue);
        queue.start();
        const generator = queue.messageGenerator('sess-a3a-steer-cleared', {
          suppressPreYieldCallback: true,
        });
        await generator.next();
        expect(queue.hasYielded(hardUuid)).toBe(true);
        await agentSession.stateManager.setInterrupted();
        queue.clear();
        await expect(steerPromise).rejects.toThrow('Interrupted by user');
        expect(
          db.getSDKMessageRepo().getDeliveryContent('sess-a3a-steer-cleared', hardUuid)?.sendStatus
        ).toBe('enqueued');
        expect(queue.size()).toBe(0);
      } finally {
        db.close();
      }
    });

    it('a steer whose claim is superseded during the acknowledgment wait aborts but still records the SDK acknowledgment', async () => {
      const { db, agentSession } = await makeHardeningSession('sess-a3a-steer-superseded');
      try {
        const queue = agentSession.messageQueue;
        agentSession.queryPromise = new Promise<void>(() => {});
        let claimHeld = true;
        const steerPromise = agentSession.driveDeliveryTurn(
          hardUuid,
          hardContent,
          null,
          false,
          () => claimHeld
        );
        await waitForQueueEntry(queue);
        claimHeld = false;
        queue.remove(hardUuid);
        const outcome = await steerPromise;
        expect(outcome).toEqual({ outcome: 'aborted' });
        expect(
          db.getSDKMessageRepo().getDeliveryContent('sess-a3a-steer-superseded', hardUuid)
            ?.sendStatus
        ).toBe('consumed');
      } finally {
        db.close();
      }
    });

    it('a turn whose claim is superseded during the acknowledgment wait aborts but still marks the batch consumed', async () => {
      const { db, agentSession } = await makeHardeningSession('sess-a3a-turn-superseded');
      try {
        agentSession.lifecycleManager.ensureQueryStarted = mock(async () => 'ok' as never);
        let resolveQuery!: () => void;
        agentSession.queryPromise = new Promise<void>((resolve) => {
          resolveQuery = resolve;
        });
        let claimHeld = true;
        const drive = agentSession.driveDeliveryTurn(
          hardUuid,
          hardContent,
          null,
          false,
          () => claimHeld
        );
        await waitForQueueEntry(agentSession.messageQueue);
        claimHeld = false;
        agentSession.messageQueue.remove(hardUuid);
        await expect(drive).resolves.toEqual({ outcome: 'aborted' });
        expect(
          db.getSDKMessageRepo().getDeliveryContent('sess-a3a-turn-superseded', hardUuid)
            ?.sendStatus
        ).toBe('consumed');
      } finally {
        db.close();
      }
    });

    it('a query-error clear during terminal-idle teardown reopens the steer for retry', async () => {
      const { db, agentSession } = await makeHardeningSession('sess-a3a-steer-terminal-idle');
      try {
        const queue = agentSession.messageQueue;
        agentSession.queryPromise = new Promise<void>(() => {});
        const steerPromise = agentSession.driveDeliveryTurn(
          hardUuid,
          hardContent,
          null,
          false,
          () => true
        );
        await waitForQueueEntry(queue);
        queue.start();
        const generator = queue.messageGenerator('sess-a3a-steer-terminal-idle', {
          suppressPreYieldCallback: true,
        });
        await generator.next();
        agentSession.stateManager.beginTerminalIdle();
        queue.clear();
        await expect(steerPromise).rejects.toThrow('Interrupted by user');
        expect(
          db.getSDKMessageRepo().getDeliveryContent('sess-a3a-steer-terminal-idle', hardUuid)
            ?.sendStatus
        ).toBe('enqueued');
      } finally {
        db.close();
      }
    });

    it('a bare reset clear without a status change reopens the steer for retry', async () => {
      const { db, agentSession } = await makeHardeningSession('sess-a3a-steer-bare-clear');
      try {
        const queue = agentSession.messageQueue;
        agentSession.queryPromise = new Promise<void>(() => {});
        const steerPromise = agentSession.driveDeliveryTurn(
          hardUuid,
          hardContent,
          null,
          false,
          () => true
        );
        await waitForQueueEntry(queue);
        queue.start();
        const generator = queue.messageGenerator('sess-a3a-steer-bare-clear', {
          suppressPreYieldCallback: true,
        });
        await generator.next();
        expect(agentSession.stateManager.getState().status).toBe('processing');
        queue.clear();
        await expect(steerPromise).rejects.toThrow('Interrupted by user');
        expect(
          db.getSDKMessageRepo().getDeliveryContent('sess-a3a-steer-bare-clear', hardUuid)
            ?.sendStatus
        ).toBe('enqueued');
      } finally {
        db.close();
      }
    });

    it('a kickoff already consumed by the SDK yield still signals consumption after the ack', async () => {
      const { db, agentSession } = await makeHardeningSession('sess-a3a-turn-consumed');
      try {
        agentSession.lifecycleManager.ensureQueryStarted = mock(async () => 'ok' as never);
        let resolveQuery!: () => void;
        agentSession.queryPromise = new Promise<void>((resolve) => {
          resolveQuery = resolve;
        });
        const consumed = waitForDeliveryConsumption('sess-a3a-turn-consumed', hardUuid);
        const drive = agentSession.driveDeliveryTurn(
          hardUuid,
          hardContent,
          null,
          false,
          () => true
        );
        const queue = agentSession.messageQueue;
        await waitForQueueEntry(queue);
        queue.start();
        const generator = queue.messageGenerator('sess-a3a-turn-consumed', {
          suppressPreYieldCallback: true,
        });
        await generator.next();
        db.getSDKMessageRepo().markDeliveryConsumedByUuid('sess-a3a-turn-consumed', hardUuid);
        queue.acknowledgeYielded(hardUuid);
        db.getSDKMessageRepo().saveSDKMessage('sess-a3a-turn-consumed', {
          type: 'result',
          uuid: `${hardUuid}-result`,
          session_id: 'sess-a3a-turn-consumed',
          parent_tool_use_id: null,
          subtype: 'success',
          is_error: false,
        } as unknown as SDKMessage);
        await agentSession.stateManager.setIdle();
        resolveQuery();
        await expect(drive).resolves.toEqual({ outcome: 'completed' });
        await expect(consumed.promise).resolves.toBeUndefined();
        consumed.cancel();
      } finally {
        db.close();
      }
    });

    it('an interrupt clearing a yielded kickoff never marks the batch consumed', async () => {
      const { db, agentSession } = await makeHardeningSession('sess-a3a-turn-interrupted');
      try {
        agentSession.lifecycleManager.ensureQueryStarted = mock(async () => 'ok' as never);
        let resolveQuery!: () => void;
        agentSession.queryPromise = new Promise<void>((resolve) => {
          resolveQuery = resolve;
        });
        const drive = agentSession.driveDeliveryTurn(
          hardUuid,
          hardContent,
          null,
          false,
          () => true
        );
        const queue = agentSession.messageQueue;
        await waitForQueueEntry(queue);
        queue.start();
        const generator = queue.messageGenerator('sess-a3a-turn-interrupted', {
          suppressPreYieldCallback: true,
        });
        await generator.next();
        await agentSession.stateManager.setInterrupted();
        queue.clear();
        resolveQuery();
        await expect(drive).rejects.toThrow('Interrupted by user');
        expect(
          db.getSDKMessageRepo().getDeliveryContent('sess-a3a-turn-interrupted', hardUuid)
            ?.sendStatus
        ).toBe('enqueued');
      } finally {
        db.close();
      }
    });

    it('a query-error clear during terminal-idle teardown never marks the kickoff consumed', async () => {
      const { db, agentSession } = await makeHardeningSession('sess-a3a-turn-terminal-idle');
      try {
        agentSession.lifecycleManager.ensureQueryStarted = mock(async () => 'ok' as never);
        let resolveQuery!: () => void;
        agentSession.queryPromise = new Promise<void>((resolve) => {
          resolveQuery = resolve;
        });
        const drive = agentSession.driveDeliveryTurn(
          hardUuid,
          hardContent,
          null,
          false,
          () => true
        );
        const queue = agentSession.messageQueue;
        await waitForQueueEntry(queue);
        queue.start();
        const generator = queue.messageGenerator('sess-a3a-turn-terminal-idle', {
          suppressPreYieldCallback: true,
        });
        await generator.next();
        agentSession.stateManager.beginTerminalIdle();
        queue.clear();
        await expect(drive).rejects.toThrow('Interrupted by user');
        expect(
          db.getSDKMessageRepo().getDeliveryContent('sess-a3a-turn-terminal-idle', hardUuid)
            ?.sendStatus
        ).toBe('enqueued');
      } finally {
        db.close();
      }
    });

    it('a bare reset clear without a status change never marks the kickoff consumed', async () => {
      const { db, agentSession } = await makeHardeningSession('sess-a3a-turn-bare-clear');
      try {
        agentSession.lifecycleManager.ensureQueryStarted = mock(async () => 'ok' as never);
        let resolveQuery!: () => void;
        agentSession.queryPromise = new Promise<void>((resolve) => {
          resolveQuery = resolve;
        });
        const drive = agentSession.driveDeliveryTurn(
          hardUuid,
          hardContent,
          null,
          false,
          () => true
        );
        const queue = agentSession.messageQueue;
        await waitForQueueEntry(queue);
        queue.start();
        const generator = queue.messageGenerator('sess-a3a-turn-bare-clear', {
          suppressPreYieldCallback: true,
        });
        await generator.next();
        expect(agentSession.stateManager.getState().status).toBe('processing');
        queue.clear();
        await expect(drive).rejects.toThrow('Interrupted by user');
        expect(
          db.getSDKMessageRepo().getDeliveryContent('sess-a3a-turn-bare-clear', hardUuid)
            ?.sendStatus
        ).toBe('enqueued');
      } finally {
        db.close();
      }
    });

    it('an ACP kickoff submitted before the ack still counts as acknowledged', async () => {
      const { db, agentSession } = await makeHardeningSession('sess-a3a-turn-submitted', {
        provider: 'acp',
      });
      try {
        agentSession.lifecycleManager.ensureQueryStarted = mock(async () => 'ok' as never);
        let resolveQuery!: () => void;
        agentSession.queryPromise = new Promise<void>((resolve) => {
          resolveQuery = resolve;
        });
        const reportStage = mock(() => {});
        const drive = agentSession.driveDeliveryTurn(
          hardUuid,
          hardContent,
          null,
          false,
          () => true,
          undefined,
          { reportStage }
        );
        const queue = agentSession.messageQueue;
        await waitForQueueEntry(queue);
        queue.start();
        const generator = queue.messageGenerator('sess-a3a-turn-submitted', {
          suppressPreYieldCallback: true,
        });
        await generator.next();
        db.getSDKMessageRepo().markDeliverySubmittedByUuids('sess-a3a-turn-submitted', [hardUuid]);
        queue.acknowledgeYielded(hardUuid);
        await new Promise((resolve) => setTimeout(resolve, 0));
        signalDeliveryConsumed('sess-a3a-turn-submitted', hardUuid);
        await expect(drive).resolves.toEqual({ outcome: 'completed' });
        expect(reportStage).toHaveBeenCalledWith('sdk_admitted', expect.anything());
        expect(
          db.getSDKMessageRepo().getDeliveryContent('sess-a3a-turn-submitted', hardUuid)?.sendStatus
        ).toBe('consumed');
      } finally {
        db.close();
      }
    });
  });

  describe('post-compaction resume hooks', () => {
    let agentSession: AgentSession;
    let mockSession: Session;
    let mockDb: Database;
    let mockMessageHub: MessageHub;
    let mockInternalEventBus: InternalEventBus<any>;
    let mockGetApiKey: () => Promise<string>;

    beforeEach(() => {
      mockSession = {
        id: 'test-session-id',
        title: 'Test Session',
        workspacePath: '/test/workspace',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {
          model: 'claude-sonnet-4-20250514',
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
      } as Session;

      mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getUserMessages: mock(() => []),
        getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
        deleteMessagesAfter: mock(() => 0),
        deleteMessagesAtAndAfter: mock(() => 0),
        getUserMessageByUuid: mock(() => undefined),
        countMessagesAfter: mock(() => 0),
        updateMessage: mock(() => {}),
        getSDKMessageCount: mock(() => 0),
        getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      } as unknown as Database;

      mockMessageHub = {
        sendMessage: mock(() => {}),
      } as unknown as MessageHub;

      mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: { subscriberName: string }) => () => {}),
      } as unknown as InternalEventBus<any>;

      mockGetApiKey = mock(async () => 'test-api-key');

      agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );
    });

    it('resumePendingWorkAfterCompaction enqueues a durable resume prompt when armed and queue is clear', async () => {
      const enqueueSpy = mock(async () => 'resume-uuid');
      const hasOutstandingNonCompactionMessages = mock(() => false);
      const session = agentSession as unknown as {
        messageQueue: {
          enqueue: typeof enqueueSpy;
          hasOutstandingNonCompactionMessages: typeof hasOutstandingNonCompactionMessages;
        };
        pendingResumeAfterCompaction: boolean;
      };
      session.messageQueue.enqueue = enqueueSpy;
      session.messageQueue.hasOutstandingNonCompactionMessages =
        hasOutstandingNonCompactionMessages;
      session.pendingResumeAfterCompaction = true;

      agentSession.resumePendingWorkAfterCompaction();

      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy).toHaveBeenCalledWith(
        'Context was compacted to stay within the configured window. Continue the task you were working on.',
        false,
        { durable: true }
      );
      expect(session.pendingResumeAfterCompaction).toBe(false);
    });

    it('resumePendingWorkAfterCompaction drops the resume when the queue already has user content', async () => {
      const enqueueSpy = mock(async () => 'resume-uuid');
      const hasOutstandingNonCompactionMessages = mock(() => true);
      const session = agentSession as unknown as {
        messageQueue: {
          enqueue: typeof enqueueSpy;
          hasOutstandingNonCompactionMessages: typeof hasOutstandingNonCompactionMessages;
        };
        pendingResumeAfterCompaction: boolean;
      };
      session.messageQueue.enqueue = enqueueSpy;
      session.messageQueue.hasOutstandingNonCompactionMessages =
        hasOutstandingNonCompactionMessages;
      session.pendingResumeAfterCompaction = true;

      agentSession.resumePendingWorkAfterCompaction();

      expect(enqueueSpy).not.toHaveBeenCalled();
      expect(session.pendingResumeAfterCompaction).toBe(false);
    });

    it('clearPendingResumeAfterCompaction disarms a pending resume', async () => {
      const session = agentSession as unknown as {
        pendingResumeAfterCompaction: boolean;
      };
      session.pendingResumeAfterCompaction = true;

      agentSession.clearPendingResumeAfterCompaction();

      expect(session.pendingResumeAfterCompaction).toBe(false);
    });

    it('handleInterrupt clears a pending post-compaction resume', async () => {
      const interruptHandler = { handleInterrupt: mock(async () => {}) };
      const session = agentSession as unknown as {
        interruptHandler: typeof interruptHandler;
        pendingResumeAfterCompaction: boolean;
      };
      session.interruptHandler = interruptHandler;
      session.pendingResumeAfterCompaction = true;

      await agentSession.handleInterrupt();

      expect(session.pendingResumeAfterCompaction).toBe(false);
      expect(interruptHandler.handleInterrupt).toHaveBeenCalled();
    });
  });
});
