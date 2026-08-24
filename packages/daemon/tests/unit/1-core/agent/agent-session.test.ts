import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type {
  AgentProcessingState,
  ContextInfo,
  McpServerConfig,
  MessageHub,
  RewindMode,
  SelectiveRewindResult,
  Session,
} from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { AgentSession } from '../../../../src/lib/agent/agent-session';
import {
  deliverMessage,
  MessageDeliveryRecoverableTurnError,
  MessageDeliveryTerminalTurnError,
  waitForDeliveryConsumption,
  withSessionLock,
  withSessionResetCoordination,
} from '../../../../src/lib/agent/message-delivery';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { Database } from '../../../../src/storage/database';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database';

type DeliveryResponseObserver = {
  generation: number;
  observer: { reportStage: (stage: string, details?: Record<string, unknown>) => void };
  pendingStart?: boolean;
};

function getDeliveryResponseObserver(agentSession: AgentSession): DeliveryResponseObserver | null {
  return (agentSession as unknown as { deliveryResponseObserver: DeliveryResponseObserver | null })
    .deliveryResponseObserver;
}

function setDeliveryResponseObserver(
  agentSession: AgentSession,
  observer: DeliveryResponseObserver
): void {
  (
    agentSession as unknown as { deliveryResponseObserver: DeliveryResponseObserver | null }
  ).deliveryResponseObserver = observer;
}

function shadowReplaySeams(session: AgentSession): {
  ensureQueryStarted: ReturnType<typeof mock>;
  enqueueWithId: ReturnType<typeof mock>;
} {
  const ensureQueryStarted = mock(async () => {});
  const enqueueWithId = mock(async () => {});
  const seams = session as unknown as {
    ensureQueryStarted: () => Promise<void>;
    messageQueue: { enqueueWithId: (uuid: string, content: unknown) => Promise<void> };
  };
  seams.ensureQueryStarted = ensureQueryStarted;
  seams.messageQueue.enqueueWithId = enqueueWithId;
  return { ensureQueryStarted, enqueueWithId };
}

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
        mockGetApiKey
      );
    });

    it('driveDeliveryTurn reopens a no-result consumed row for retry only while the claim is current', async () => {
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

      await agentSession.stateManager.setProcessing('uuid-reopen');
      const live = agentSession.driveDeliveryTurn('uuid-reopen', 'hello', null, true, () => true);
      await agentSession.stateManager.setIdle();
      const error = await live.catch((caught) => caught);
      expect(error).toBeInstanceOf(MessageDeliveryRecoverableTurnError);
      expect(error).toMatchObject({ message: 'Turn ended without a response' });
      expect(retrySpy).toHaveBeenCalledTimes(1);

      let claimAlive = true;
      await agentSession.stateManager.setProcessing('uuid-reopen-2');
      const cancelled = agentSession.driveDeliveryTurn(
        'uuid-reopen-2',
        'hello',
        null,
        true,
        () => claimAlive
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      claimAlive = false;
      await agentSession.stateManager.setIdle();
      await expect(cancelled).rejects.toThrow();
      expect(retrySpy).toHaveBeenCalledTimes(1);
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

      expect(result).toEqual({ outcome: 'recovery_pending', retryAt: cooldownRetryAt });
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

      expect(result.outcome).toBe('recovery_pending');
      expect(result.retryAt).toBeGreaterThanOrEqual(before + 4 * 60_000);
      expect(retrySpy).not.toHaveBeenCalled();
    });

    it('driveDeliveryTurn reopens a consumed reclaim immediately when no query or recovery owns it', async () => {
      const retrySpy = mock(() => 'db-1');
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock(() => ({ content: 'x', sendStatus: 'consumed' })),
        hasTerminalResultAfter: mock(() => false),
        hasRecoveryInterceptedResultAfter: mock(() => true),
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

      await agentSession.stateManager.setProcessing('uuid-reclaim');
      const drive = agentSession.driveDeliveryTurn('uuid-reclaim', 'hello', null, true, () => true);
      const error = await drive.catch((caught) => caught);

      expect(error).toBeInstanceOf(MessageDeliveryRecoverableTurnError);
      expect(error).toMatchObject({ message: 'Turn ended without a response' });
      expect(retrySpy).toHaveBeenCalledTimes(1);
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

    it('driveDeliveryTurn makes a terminal turn error non-retryable without reopening', async () => {
      const retrySpy = mock(() => 'db-terminal');
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

      await agentSession.stateManager.setProcessing('uuid-terminal-error');
      const drive = agentSession.driveDeliveryTurn('uuid-terminal-error', 'hello', null, true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      (
        agentSession as unknown as {
          lastTerminalError: { error: Record<string, unknown>; at: number };
        }
      ).lastTerminalError = {
        error: {
          category: 'authentication',
          code: 'UNAUTHORIZED',
          message: 'provider rejected credentials',
          userMessage: 'Sign in again',
          recoverable: true,
          timestamp: new Date().toISOString(),
        },
        at: Date.now(),
      };
      await agentSession.stateManager.setIdle();

      const error = await drive.catch((caught) => caught);
      expect(error).toBeInstanceOf(MessageDeliveryTerminalTurnError);
      expect(error).toMatchObject({ message: 'Sign in again', category: 'authentication' });
      expect(retrySpy).not.toHaveBeenCalled();
    });

    it('driveDeliveryTurn treats a non-retryable persisted error subtype as terminal', async () => {
      const retrySpy = mock(() => 'db-terminal-subtype');
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock(() => ({ content: 'x', sendStatus: 'consumed' })),
        hasTerminalResultAfter: mock(() => false),
        hasDeliveryTurnEnd: mock(() => false),
        clearDeliveryTurnEnd: mock(() => {}),
        getErrorTerminalResultSubtypeAfter: mock(() => 'error_max_budget_usd'),
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

      await agentSession.stateManager.setProcessing('uuid-terminal-subtype');
      const drive = agentSession.driveDeliveryTurn('uuid-terminal-subtype', 'hello', null, true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await agentSession.stateManager.setIdle();

      const error = await drive.catch((caught) => caught);
      expect(error).toBeInstanceOf(MessageDeliveryTerminalTurnError);
      expect(error).toMatchObject({ category: 'error_max_budget_usd' });
      expect(retrySpy).not.toHaveBeenCalled();
    });

    it('driveDeliveryTurn re-arms at most twice within the 250ms spurious turn-end grace', async () => {
      let sendStatus = 'enqueued';
      const retrySpy = mock(() => 'db-grace-cap');
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock(() => ({ content: 'x', sendStatus })),
        hasTerminalResultAfter: mock(() => false),
        hasDeliveryTurnEnd: mock(() => false),
        clearDeliveryTurnEnd: mock(() => {}),
        getErrorTerminalResultSubtypeAfter: mock(() => null),
        recordDeliveryTurnEnd: mock(() => {}),
        markDeliveryConsumedByUuids: mock(() => {
          sendStatus = 'consumed';
          return [];
        }),
        markDeliveryRetryableByUuid: retrySpy,
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

      await agentSession.stateManager.setProcessing('uuid-grace-cap');
      const drive = agentSession.driveDeliveryTurn(
        'uuid-grace-cap',
        'hello',
        null,
        false,
        () => true
      );
      let settled = false;
      void drive.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      for (let fire = 0; fire < 3; fire++) {
        await agentSession.stateManager.setIdle();
        if (fire < 2) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          expect(settled).toBe(false);
          await agentSession.stateManager.setProcessing('uuid-grace-cap');
        }
      }

      const error = await drive.catch((caught) => caught);
      expect(error).toBeInstanceOf(MessageDeliveryRecoverableTurnError);
      expect(retrySpy).toHaveBeenCalledTimes(1);
    });

    it('driveDeliveryTurn re-arms through a spurious turn-end fired right after a fresh admission', async () => {
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

    it('driveDeliveryTurn re-arms through a spurious turn-end after reusing an acknowledgment', async () => {
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

    it('driveDeliveryTurn aborts when startup consumes the pending queue entry', async () => {
      let sendStatus = 'enqueued';
      let queuePending = true;
      const getPendingOrInFlightContentSpy = mock(() => (queuePending ? 'hello' : null));
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock(() => ({ content: 'hello', sendStatus })),
      }));
      agentSession.lifecycleManager.ensureQueryStarted = mock(async () => {
        queuePending = false;
        sendStatus = 'consumed';
        return 'ok' as never;
      });
      (agentSession as unknown as { queryPromise: Promise<unknown> }).queryPromise = new Promise(
        () => {}
      );
      const admitSpy = mock(() => Promise.resolve());
      (agentSession as unknown as { messageQueue: unknown }).messageQueue = {
        admitWithId: admitSpy,
        getPendingOrInFlightContent: getPendingOrInFlightContentSpy,
        waitForPendingOrInFlight: mock(() => null),
        isRunning: mock(() => true),
        size: mock(() => 0),
      };

      const result = await agentSession.driveDeliveryTurn(
        'uuid-startup-consumed',
        'hello',
        null,
        false,
        () => true
      );

      expect(result).toEqual({ outcome: 'aborted' });
      expect(getPendingOrInFlightContentSpy).toHaveBeenCalledTimes(1);
      expect(admitSpy).not.toHaveBeenCalled();
    });

    it('driveDeliveryTurn aborts fresh admission when startup consumes an untracked row', async () => {
      let sendStatus = 'enqueued';
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock(() => ({ content: 'hello', sendStatus })),
      }));
      agentSession.lifecycleManager.ensureQueryStarted = mock(async () => {
        sendStatus = 'consumed';
        return 'ok' as never;
      });
      (agentSession as unknown as { queryPromise: Promise<unknown> }).queryPromise = new Promise(
        () => {}
      );
      const admitSpy = mock(() => Promise.resolve());
      (agentSession as unknown as { messageQueue: unknown }).messageQueue = {
        admitWithId: admitSpy,
        getPendingOrInFlightContent: mock(() => null),
        waitForPendingOrInFlight: mock(() => null),
        isRunning: mock(() => true),
        size: mock(() => 0),
      };

      const result = await agentSession.driveDeliveryTurn(
        'uuid-startup-untracked',
        'hello',
        null,
        false,
        () => true
      );

      expect(result).toEqual({ outcome: 'aborted' });
      expect(admitSpy).not.toHaveBeenCalled();
    });

    it('driveDeliveryTurn admits refreshed content after startup', async () => {
      let content = 'before startup';
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock(() => ({ content, sendStatus: 'enqueued' })),
      }));
      agentSession.lifecycleManager.ensureQueryStarted = mock(async () => {
        content = 'after startup';
        return 'ok' as never;
      });
      (agentSession as unknown as { queryPromise: Promise<unknown> }).queryPromise = new Promise(
        () => {}
      );
      const admitSpy = mock(() => new Promise<void>(() => {}));
      (agentSession as unknown as { messageQueue: unknown }).messageQueue = {
        admitWithId: admitSpy,
        getPendingOrInFlightContent: mock(() => null),
        waitForPendingOrInFlight: mock(() => null),
        isRunning: mock(() => true),
        size: mock(() => 0),
      };

      void agentSession.driveDeliveryTurn(
        'uuid-startup-refreshed',
        'before startup',
        null,
        false,
        () => true
      );
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(admitSpy).toHaveBeenCalledWith('uuid-startup-refreshed', 'after startup', false, {
        durable: true,
      });
    });

    it('driveDeliveryTurn retries when a matching pending entry vanishes during startup', async () => {
      let queuePending = true;
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock(() => ({ content: 'hello', sendStatus: 'enqueued' })),
      }));
      agentSession.lifecycleManager.ensureQueryStarted = mock(async () => {
        queuePending = false;
        return 'ok' as never;
      });
      (agentSession as unknown as { queryPromise: Promise<unknown> }).queryPromise = new Promise(
        () => {}
      );
      const admitSpy = mock(() => Promise.resolve());
      (agentSession as unknown as { messageQueue: unknown }).messageQueue = {
        admitWithId: admitSpy,
        getPendingOrInFlightContent: mock(() => (queuePending ? 'hello' : null)),
        waitForPendingOrInFlight: mock(() => null),
        isRunning: mock(() => true),
        size: mock(() => 0),
      };

      await expect(
        agentSession.driveDeliveryTurn('uuid-startup-vanished', 'hello', null, false, () => true)
      ).rejects.toThrow('Pending queue entry disappeared before delivery admission');
      expect(admitSpy).not.toHaveBeenCalled();
    });

    it('driveDeliveryTurn aborts when vanished pending content differs after startup', async () => {
      let queuePending = true;
      let content = 'before startup';
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock(() => ({ content, sendStatus: 'enqueued' })),
      }));
      agentSession.lifecycleManager.ensureQueryStarted = mock(async () => {
        queuePending = false;
        content = 'after startup';
        return 'ok' as never;
      });
      (agentSession as unknown as { queryPromise: Promise<unknown> }).queryPromise = new Promise(
        () => {}
      );
      const admitSpy = mock(() => Promise.resolve());
      (agentSession as unknown as { messageQueue: unknown }).messageQueue = {
        admitWithId: admitSpy,
        getPendingOrInFlightContent: mock(() => (queuePending ? 'before startup' : null)),
        waitForPendingOrInFlight: mock(() => null),
        isRunning: mock(() => true),
        size: mock(() => 0),
      };

      const result = await agentSession.driveDeliveryTurn(
        'uuid-startup-changed',
        'before startup',
        null,
        false,
        () => true
      );

      expect(result).toEqual({ outcome: 'aborted' });
      expect(admitSpy).not.toHaveBeenCalled();
    });

    it('driveDeliveryTurn aborts when fresh batch rebuild omits the kickoff', async () => {
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock((_sessionId: string, uuid: string) =>
          uuid === 'kickoff-omitted'
            ? {
                content: [
                  {
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: 'x' },
                  },
                ],
                sendStatus: 'enqueued',
              }
            : { content: 'member', sendStatus: 'enqueued' }
        ),
      }));
      mockDb.getJobQueueRepo = mock(() => ({}));
      agentSession.lifecycleManager.ensureQueryStarted = mock(async () => 'ok' as never);
      (agentSession as unknown as { queryPromise: Promise<unknown> }).queryPromise = new Promise(
        () => {}
      );
      const admitSpy = mock(() => Promise.resolve());
      (agentSession as unknown as { messageQueue: unknown }).messageQueue = {
        admitWithId: admitSpy,
        getPendingOrInFlightContent: mock(() => null),
        waitForPendingOrInFlight: mock(() => null),
        isRunning: mock(() => true),
        size: mock(() => 0),
      };

      const result = await agentSession.driveDeliveryTurn(
        'kickoff-omitted',
        'before startup',
        null,
        false,
        () => true,
        ['kickoff-omitted', 'member-kept']
      );

      expect(result).toEqual({ outcome: 'aborted' });
      expect(admitSpy).not.toHaveBeenCalled();
    });

    it('driveDeliveryTurn reuses a pending batch acknowledgment on retry', async () => {
      let resultLanded = false;
      const markSubmittedSpy = mock(() => ['db-member']);
      const markConsumedSpy = mock(() => ['db-pending', 'db-member']);
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock((_sessionId: string, uuid: string) => ({
          content: uuid === 'uuid-pending' ? 'kickoff' : 'member',
          sendStatus: 'enqueued',
        })),
        hasTerminalResultAfter: mock(() => resultLanded),
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
      const admitSpy = mock(() => Promise.resolve());
      const existing = Promise.withResolvers<void>();
      (agentSession as unknown as { messageQueue: unknown }).messageQueue = {
        admitWithId: admitSpy,
        waitForPendingOrInFlight: mock((uuid: string) =>
          uuid === 'uuid-pending'
            ? {
                acknowledgment: existing.promise,
                content: '--- message 1 of 2 ---\nkickoff\n\n--- message 2 of 2 ---\nmember',
              }
            : null
        ),
        isRunning: mock(() => false),
        size: mock(() => 1),
      };

      await agentSession.stateManager.setProcessing('uuid-pending');
      const kickoffConsumed = waitForDeliveryConsumption('test-session-id', 'uuid-pending');
      const memberConsumed = waitForDeliveryConsumption('test-session-id', 'uuid-member');
      const drive = agentSession.driveDeliveryTurn(
        'uuid-pending',
        'hello',
        null,
        false,
        () => true,
        ['uuid-pending', 'uuid-member']
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(admitSpy).not.toHaveBeenCalled();
      expect(markSubmittedSpy).toHaveBeenCalledWith('test-session-id', ['uuid-member']);
      expect(markConsumedSpy).not.toHaveBeenCalled();

      existing.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(markConsumedSpy).toHaveBeenCalledWith('test-session-id', [
        'uuid-pending',
        'uuid-member',
      ]);
      await expect(kickoffConsumed.promise).resolves.toBeUndefined();
      await expect(memberConsumed.promise).resolves.toBeUndefined();

      resultLanded = true;
      await agentSession.stateManager.setIdle();
      await expect(drive).resolves.toEqual({ outcome: 'completed' });
      kickoffConsumed.cancel();
      memberConsumed.cancel();
    });

    it('driveDeliveryTurn rejects reused content that does not match the rebuilt batch', async () => {
      const markSubmittedSpy = mock(() => ['db-member']);
      const markConsumedSpy = mock(() => ['db-pending', 'db-member']);
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock((_sessionId: string, uuid: string) => ({
          content: uuid === 'uuid-pending' ? 'kickoff' : 'member',
          sendStatus: 'enqueued',
        })),
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
      const existing = Promise.withResolvers<void>();
      const removeSpy = mock(() => true);
      (agentSession as unknown as { messageQueue: unknown }).messageQueue = {
        admitWithId: mock(() => Promise.resolve()),
        waitForPendingOrInFlight: mock(() => ({
          acknowledgment: existing.promise,
          content: 'kickoff',
        })),
        hasYielded: mock(() => false),
        remove: removeSpy,
        isRunning: mock(() => false),
        size: mock(() => 1),
      };

      await agentSession.stateManager.setProcessing('uuid-pending');
      const result = await agentSession.driveDeliveryTurn(
        'uuid-pending',
        'hello',
        null,
        false,
        () => true,
        ['uuid-pending', 'uuid-member']
      );

      expect(result).toEqual({ outcome: 'aborted' });
      expect(removeSpy).toHaveBeenCalledWith('uuid-pending');
      expect(markSubmittedSpy).not.toHaveBeenCalled();
      expect(markConsumedSpy).not.toHaveBeenCalled();
      existing.reject(new Error('Interrupted by user'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it('driveDeliveryTurn preserves yielded content that does not match a rebuilt batch', async () => {
      const removeSpy = mock(() => true);
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock((_sessionId: string, uuid: string) => ({
          content: uuid === 'uuid-yielded' ? 'kickoff' : 'member',
          sendStatus: 'enqueued',
        })),
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
        'hello',
        null,
        false,
        () => true,
        ['uuid-yielded', 'uuid-member']
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
        undefined,
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

    it('driveDeliveryTurn narrows the batch payload even when only the kickoff is admitted', async () => {
      const narrowSpy = mock(() => true);
      const contents: Record<string, { content: string; sendStatus: string }> = {
        'kick-only': { content: 'first and only fitting message', sendStatus: 'enqueued' },
        'tail-member': { content: 'deferred out before delivery', sendStatus: 'deferred' },
      };
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock((_sid: string, uuid: string) => contents[uuid] ?? null),
        hasTerminalResultAfter: mock(() => false),
        hasDeliveryTurnEnd: mock(() => false),
        clearDeliveryTurnEnd: mock(() => {}),
        getErrorTerminalResultSubtypeAfter: mock(() => null),
        recordDeliveryTurnEnd: mock(() => {}),
        markDeliveryConsumedByUuids: mock(() => []),
      }));
      mockDb.getJobQueueRepo = mock(() => ({
        isProcessingDelivery: mock(() => true),
        narrowActiveDeliveryBatchUuids: narrowSpy,
      }));
      agentSession.lifecycleManager.ensureQueryStarted = mock(async () => 'ok' as never);
      (agentSession as unknown as { queryPromise: Promise<unknown> }).queryPromise = new Promise(
        () => {}
      );
      (agentSession as unknown as { messageQueue: unknown }).messageQueue = {
        admitWithId: mock(() => new Promise<void>(() => {})),
        waitForPendingOrInFlight: mock(() => null),
        isRunning: mock(() => false),
        size: mock(() => 0),
      };

      await agentSession.stateManager.setProcessing('kick-only');
      void agentSession.driveDeliveryTurn('kick-only', 'estimate', null, false, () => true, [
        'kick-only',
        'tail-member',
      ]);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(narrowSpy).toHaveBeenCalledTimes(1);
      expect(narrowSpy.mock.calls[0]).toEqual(['test-session-id', 'kick-only', ['kick-only']]);
    });

    it('driveDeliveryTurn neutralizes reused acknowledgment when batch narrowing aborts', async () => {
      const catchSpy = mock(() => Promise.resolve());
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock((_sid: string, uuid: string) =>
          uuid === 'kick-reused'
            ? { content: 'kickoff', sendStatus: 'enqueued' }
            : uuid === 'member-reused'
              ? { content: 'member', sendStatus: 'deferred' }
              : null
        ),
      }));
      mockDb.getJobQueueRepo = mock(() => ({
        narrowActiveDeliveryBatchUuids: mock(() => false),
      }));
      agentSession.lifecycleManager.ensureQueryStarted = mock(async () => 'ok' as never);
      (agentSession as unknown as { queryPromise: Promise<unknown> }).queryPromise = new Promise(
        () => {}
      );
      (agentSession as unknown as { messageQueue: unknown }).messageQueue = {
        waitForPendingOrInFlight: mock(() => ({
          acknowledgment: { catch: catchSpy } as unknown as Promise<void>,
          content: 'kickoff',
        })),
        isRunning: mock(() => false),
        size: mock(() => 1),
      };

      const outcome = await agentSession.driveDeliveryTurn(
        'kick-reused',
        'estimate',
        null,
        false,
        () => true,
        ['kick-reused', 'member-reused']
      );

      expect(outcome).toEqual({ outcome: 'aborted' });
      expect(catchSpy).toHaveBeenCalledTimes(1);
    });

    it('driveDeliveryTurn refuses to feed a reduced batch when narrowing cannot persist', async () => {
      const admitSpy = mock(() => new Promise<void>(() => {}));
      mockDb.getSDKMessageRepo = mock(() => ({
        getDeliveryContent: mock((_sid: string, uuid: string) =>
          uuid === 'kick-2'
            ? { content: 'kickoff', sendStatus: 'enqueued' }
            : uuid === 'member-2'
              ? { content: 'member', sendStatus: 'deferred' }
              : null
        ),
        hasTerminalResultAfter: mock(() => false),
        hasDeliveryTurnEnd: mock(() => false),
        clearDeliveryTurnEnd: mock(() => {}),
        getErrorTerminalResultSubtypeAfter: mock(() => null),
        recordDeliveryTurnEnd: mock(() => {}),
      }));
      mockDb.getJobQueueRepo = mock(() => ({
        isProcessingDelivery: mock(() => true),
        narrowActiveDeliveryBatchUuids: mock(() => false),
      }));
      agentSession.lifecycleManager.ensureQueryStarted = mock(async () => 'ok' as never);
      (agentSession as unknown as { queryPromise: Promise<unknown> }).queryPromise = new Promise(
        () => {}
      );
      (agentSession as unknown as { messageQueue: unknown }).messageQueue = {
        admitWithId: admitSpy,
        waitForPendingOrInFlight: mock(() => null),
        isRunning: mock(() => false),
        size: mock(() => 0),
      };

      await agentSession.stateManager.setProcessing('kick-2');
      const outcome = await agentSession.driveDeliveryTurn(
        'kick-2',
        'estimate',
        null,
        false,
        () => true,
        ['kick-2', 'member-2']
      );
      expect(outcome).toEqual({ outcome: 'aborted' });
      expect(admitSpy).not.toHaveBeenCalled();
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
      const previous = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
      process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '1';
      try {
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
      } finally {
        if (previous === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
        else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = previous;
      }
    });

    it('reconcileStrandedDeliveries waits for the reset-coordination lock before re-enqueueing', async () => {
      const previous = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
      process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '1';
      try {
        const enqueue = mock(() => ({}));
        mockDb.getJobQueueRepo = mock(() => ({
          activeDeliveryMessageUuids: mock(() => new Set<string>()),
          getActiveDeliveryRole: mock(() => null),
          enqueue,
        }));
        mockDb.getUserMessageIdsByStatus = mock((_sessionId: string, status: string) =>
          status === 'enqueued' ? [{ dbId: 'db-1', uuid: 'uuid-1', timestamp: 1 }] : []
        );
        mockDb.getSDKMessageRepo = mock(() => ({
          markDeliveryFailedByUuid: mock(() => null),
        }));

        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const holder = withSessionResetCoordination('test-session-id', async () => {
          await gate;
        });
        const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
        const reconcilePromise = agentSession.reconcileStrandedDeliveries();
        await settle();
        await settle();

        expect(enqueue).not.toHaveBeenCalled();

        release();
        await holder;
        await reconcilePromise;

        expect(enqueue).toHaveBeenCalledTimes(1);
      } finally {
        if (previous === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
        else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = previous;
      }
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
        getActiveDeliveryRole: mock(() => null),
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
        getActiveDeliveryRole: mock(() => null),
      };
      mockDb.getJobQueueRepo = mock(() => jobQueue);
      agentSession.stateManager.setQueuedIfIdle = mock(async () => {
        throw new Error('subscriber failed');
      });

      await expect(agentSession.deliverChatMessage('publish-failure')).resolves.toBeUndefined();
      expect(jobQueue.enqueue).toHaveBeenCalled();
    });

    it('deliverChatMessage cancels a rate-limit cooldown for a replacement chat even when classified as a steer', async () => {
      let turnAttempt = 0;
      const jobQueue = {
        enqueue: mock(() => {
          turnAttempt++;
          if (turnAttempt === 1) {
            throw new Error('UNIQUE constraint failed: job_queue.uq_message_delivery_active_turn');
          }
          return { id: 'job' };
        }),
        getActiveDeliveryRole: mock(() => null),
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
      expect(agentSession.stateManager.setQueuedIfIdle).not.toHaveBeenCalled();
    });

    it('deliverChatMessage does NOT bump the watchdog generation for a steer into a live turn', async () => {
      let turnAttempt = 0;
      const jobQueue = {
        enqueue: mock(() => {
          turnAttempt++;
          if (turnAttempt === 1) {
            throw new Error('UNIQUE constraint failed: job_queue.uq_message_delivery_active_turn');
          }
          return { id: 'job' };
        }),
        getActiveDeliveryRole: mock(() => null),
      };
      mockDb.getJobQueueRepo = mock(() => jobQueue);
      const cancelSpy = mock(() => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).rateLimitWatchdog = {
        cancel: cancelSpy,
      };
      agentSession.stateManager.setQueuedIfIdle = mock(async () => false);

      await agentSession.deliverChatMessage('live-steer');

      expect(cancelSpy).not.toHaveBeenCalled();
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
        getActiveDeliveryRole: mock(() => null),
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

    it('incrementQueryGeneration claims a pending delivery observer', () => {
      const reportStage = mock(() => {});
      setDeliveryResponseObserver(agentSession, {
        generation: 0,
        observer: { reportStage },
        pendingStart: true,
      });

      const next = agentSession.incrementQueryGeneration();

      const observer = getDeliveryResponseObserver(agentSession);
      expect(next).toBe(1);
      expect(observer?.generation).toBe(1);
      expect(observer?.pendingStart).toBe(false);
    });

    it('reportFirstDeliverySDKResponse ignores a pending (unclaimed) observer', () => {
      const reportStage = mock(() => {});
      setDeliveryResponseObserver(agentSession, {
        generation: 0,
        observer: { reportStage },
        pendingStart: true,
      });

      agentSession.reportFirstDeliverySDKResponse('assistant');

      const observer = getDeliveryResponseObserver(agentSession);
      expect(observer).not.toBeNull();
      expect(reportStage).not.toHaveBeenCalled();
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

      expect(handleMessageSpy).toHaveBeenCalledWith(message);
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
    let previousDeliveryV2: string | undefined;

    beforeEach(async () => {
      previousDeliveryV2 = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
      process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '1';
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
      if (previousDeliveryV2 === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
      else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = previousDeliveryV2;
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
  });

  describe('startup pending-message replay (scheduleInitialPendingMessageReplay)', () => {
    let db: Database;
    let agentSession: AgentSession | null;
    let previousDeliveryV2: string | undefined;

    async function flushStartupReplay(): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    async function prepareStartupSession(
      sessionId: string,
      options?: {
        queryMode?: 'immediate' | 'manual';
        persistedStatus?: string;
        autoReplayPendingMessages?: boolean;
      }
    ): Promise<() => AgentSession> {
      const session = createTestSession(sessionId);
      if (options?.queryMode) session.config.queryMode = options.queryMode;
      db.createSession(session);
      if (options?.persistedStatus) {
        db.updateSession(sessionId, {
          processingState: JSON.stringify({ status: options.persistedStatus }),
        });
      }
      const restored = db.getSession(sessionId) ?? session;
      const bus = await createTestInternalEventBus();
      const runtimeOptions =
        options?.autoReplayPendingMessages === undefined
          ? {}
          : { autoReplayPendingMessages: options.autoReplayPendingMessages };
      return () => {
        agentSession = new AgentSession(
          restored,
          db,
          {} as MessageHub,
          bus,
          mock(async () => 'test-api-key'),
          undefined,
          undefined,
          undefined,
          undefined,
          runtimeOptions
        );
        return agentSession;
      };
    }

    beforeEach(() => {
      previousDeliveryV2 = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
      process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '0';
      agentSession = null;
    });

    afterEach(async () => {
      await agentSession?.cleanup();
      db?.close();
      if (previousDeliveryV2 === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
      else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = previousDeliveryV2;
    });

    it('replays persisted enqueued messages through the startup microtask', async () => {
      db = await createTestDb();
      const sessionId = 'sess-startup-replay-happy';
      const uuid = 'msg-startup-replay-happy';
      const construct = await prepareStartupSession(sessionId);
      db.getSDKMessageRepo().saveUserMessage(
        sessionId,
        {
          type: 'user',
          uuid,
          message: { role: 'user', content: 'recover me' },
        } as unknown as SDKMessage,
        'enqueued'
      );
      const session = construct();
      const seams = shadowReplaySeams(session);

      await flushStartupReplay();

      expect(seams.ensureQueryStarted).toHaveBeenCalledTimes(1);
      expect(seams.enqueueWithId).toHaveBeenCalledWith(uuid, 'recover me');
    });

    it('does not schedule replay when the restored status is waiting_for_input', async () => {
      db = await createTestDb();
      const sessionId = 'sess-startup-replay-waiting';
      const uuid = 'msg-startup-replay-waiting';
      const construct = await prepareStartupSession(sessionId, {
        persistedStatus: 'waiting_for_input',
      });
      db.getSDKMessageRepo().saveUserMessage(
        sessionId,
        { type: 'user', uuid, message: { role: 'user', content: 'hold' } } as unknown as SDKMessage,
        'enqueued'
      );
      const session = construct();
      const seams = shadowReplaySeams(session);

      await flushStartupReplay();

      expect(seams.ensureQueryStarted).not.toHaveBeenCalled();
      expect(seams.enqueueWithId).not.toHaveBeenCalled();
      expect(db.getSDKMessageRepo().getDeliveryContent(sessionId, uuid)?.sendStatus).toBe(
        'enqueued'
      );
    });

    it('does not schedule replay when queryMode is manual', async () => {
      db = await createTestDb();
      const sessionId = 'sess-startup-replay-manual';
      const construct = await prepareStartupSession(sessionId, { queryMode: 'manual' });
      const session = construct();
      const seams = shadowReplaySeams(session);

      await flushStartupReplay();

      expect(seams.ensureQueryStarted).not.toHaveBeenCalled();
      expect(seams.enqueueWithId).not.toHaveBeenCalled();
    });

    it('returns early without flushing deferred messages when the enqueued replay fails', async () => {
      db = await createTestDb();
      const sessionId = 'sess-startup-replay-failed';
      const enqueuedUuid = 'msg-startup-replay-failed-enqueued';
      const deferredUuid = 'msg-startup-replay-failed-deferred';
      const repo = db.getSDKMessageRepo();
      const construct = await prepareStartupSession(sessionId);
      repo.saveUserMessage(
        sessionId,
        {
          type: 'user',
          uuid: enqueuedUuid,
          message: { role: 'user', content: 'current turn' },
        } as unknown as SDKMessage,
        'enqueued'
      );
      repo.saveUserMessage(
        sessionId,
        {
          type: 'user',
          uuid: deferredUuid,
          message: { role: 'user', content: 'next turn' },
        } as unknown as SDKMessage,
        'deferred'
      );
      const session = construct();
      const seams = shadowReplaySeams(session);
      const realByStatus = db.getUserMessagesByStatus.bind(db);
      (db as unknown as Record<string, unknown>).getUserMessagesByStatus = mock(
        (targetSessionId: string, status: string) => {
          if (status === 'enqueued') throw new Error('disk unavailable');
          return realByStatus(targetSessionId, status);
        }
      );

      await flushStartupReplay();

      expect(seams.ensureQueryStarted).not.toHaveBeenCalled();
      expect(seams.enqueueWithId).not.toHaveBeenCalled();
      expect(repo.getDeliveryContent(sessionId, deferredUuid)?.sendStatus).toBe('deferred');
    });

    it('schedules a post-settlement flush when an active delivery job holds the turn open', async () => {
      db = await createTestDb();
      const sessionId = 'sess-startup-replay-postsettlement';
      const ownedUuid = 'msg-startup-replay-owned';
      const deferredUuid = 'msg-startup-replay-postsettlement-deferred';
      const repo = db.getSDKMessageRepo();
      const construct = await prepareStartupSession(sessionId);
      repo.saveUserMessage(
        sessionId,
        {
          type: 'user',
          uuid: ownedUuid,
          message: { role: 'user', content: 'owned by delivery job' },
        } as unknown as SDKMessage,
        'enqueued'
      );
      repo.saveUserMessage(
        sessionId,
        {
          type: 'user',
          uuid: deferredUuid,
          message: { role: 'user', content: 'next turn' },
        } as unknown as SDKMessage,
        'deferred'
      );
      const session = construct();
      const seams = shadowReplaySeams(session);
      deliverMessage(db.getJobQueueRepo(), sessionId, ownedUuid, { origin: 'recovery' });
      expect(db.getJobQueueRepo().activeDeliveryMessageUuids(sessionId).size).toBe(1);

      await flushStartupReplay();

      expect(repo.getDeliveryContent(sessionId, deferredUuid)?.sendStatus).toBe('deferred');
      expect(seams.enqueueWithId).not.toHaveBeenCalledWith(deferredUuid, 'next turn');

      db.getJobQueueRepo().cancelDelivery(sessionId, ownedUuid);
      await new Promise((resolve) => setTimeout(resolve, 800));

      expect(repo.getDeliveryContent(sessionId, deferredUuid)?.sendStatus).toBe('enqueued');
      expect(seams.enqueueWithId).toHaveBeenCalledWith(deferredUuid, 'next turn');
    });
  });

  describe('reconcilerProvisioned lifecycle', () => {
    let db: Database;
    let agentSession: AgentSession | null;
    let previousDeliveryV2: string | undefined;

    function readProvisioned(session: AgentSession): boolean {
      return (session as unknown as { reconcilerProvisioned: boolean }).reconcilerProvisioned;
    }

    beforeEach(() => {
      previousDeliveryV2 = process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
      process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = '0';
      agentSession = null;
    });

    afterEach(async () => {
      await agentSession?.cleanup();
      db?.close();
      if (previousDeliveryV2 === undefined) delete process.env.HYPERNEO_MESSAGE_DELIVERY_V2;
      else process.env.HYPERNEO_MESSAGE_DELIVERY_V2 = previousDeliveryV2;
    });

    it('stays unprovisioned and skips startup replay when autoReplayPendingMessages is false', async () => {
      db = await createTestDb();
      const sessionId = 'sess-reconciler-optout';
      const session = createTestSession(sessionId);
      db.createSession(session);
      const bus = await createTestInternalEventBus();
      agentSession = new AgentSession(
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
      const seams = shadowReplaySeams(agentSession);

      expect(readProvisioned(agentSession)).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(seams.ensureQueryStarted).not.toHaveBeenCalled();
      expect(seams.enqueueWithId).not.toHaveBeenCalled();
    });

    it('default startup provisions the reconciler and replays pending messages exactly once', async () => {
      db = await createTestDb();
      const sessionId = 'sess-reconciler-default';
      const uuid = 'msg-reconciler-default';
      const session = createTestSession(sessionId);
      db.createSession(session);
      db.getSDKMessageRepo().saveUserMessage(
        sessionId,
        {
          type: 'user',
          uuid,
          message: { role: 'user', content: 'recover me' },
        } as unknown as SDKMessage,
        'enqueued'
      );
      const bus = await createTestInternalEventBus();
      agentSession = new AgentSession(
        db.getSession(sessionId) ?? session,
        db,
        {} as MessageHub,
        bus,
        mock(async () => 'test-api-key')
      );
      expect(readProvisioned(agentSession)).toBe(true);
      const seams = shadowReplaySeams(agentSession);
      const scheduleAgain = (
        agentSession as unknown as { scheduleInitialPendingMessageReplay: () => void }
      ).scheduleInitialPendingMessageReplay;
      scheduleAgain.call(agentSession);

      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(seams.ensureQueryStarted).toHaveBeenCalledTimes(1);
      expect(seams.enqueueWithId).toHaveBeenCalledTimes(1);
    });

    it('replayAllPendingMessages provisions the reconciler and bypasses mode/status guards', async () => {
      db = await createTestDb();
      const sessionId = 'sess-reconciler-replay-all';
      const uuid = 'msg-reconciler-replay-all';
      const session = createTestSession(sessionId);
      session.config.queryMode = 'manual';
      db.createSession(session);
      db.updateSession(sessionId, {
        processingState: JSON.stringify({ status: 'waiting_for_input' }),
      });
      db.getSDKMessageRepo().saveUserMessage(
        sessionId,
        {
          type: 'user',
          uuid,
          message: { role: 'user', content: 'explicit flush' },
        } as unknown as SDKMessage,
        'enqueued'
      );
      const bus = await createTestInternalEventBus();
      agentSession = new AgentSession(
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
      expect(readProvisioned(agentSession)).toBe(false);
      const seams = shadowReplaySeams(agentSession);

      await agentSession.replayAllPendingMessages();

      expect(readProvisioned(agentSession)).toBe(true);
      expect(seams.ensureQueryStarted).toHaveBeenCalledTimes(1);
      expect(seams.enqueueWithId).toHaveBeenCalledWith(uuid, 'explicit flush');
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

    it('a bare marker (no success result) is cleared and NOT silently completed', async () => {
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
      expect(repo.hasDeliveryTurnEnd(sessionId, uuid)).toBe(false);
    });

    it('a SUCCESS-terminated reclaim still completes (turn_terminated) without starting a query', async () => {
      await setupDriverail({ marker: true, successResult: true });
      const repo = db.getSDKMessageRepo();
      expect(repo.hasTerminalResultAfter(sessionId, uuid)).toBe(true);

      const ensure = mock(async () => {
        throw new Error('test: should not start a query on a terminated reclaim');
      });
      (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
        ensureQueryStarted: ensure,
      };

      const outcome = await agentSession.driveDeliveryTurn(uuid, 'hi', null, true);
      expect(outcome).toEqual({ outcome: 'turn_terminated' });
      expect(ensure).not.toHaveBeenCalled();
    });
  });

  describe('feedDeliverySteer — steer-ladder decision table (A1c)', () => {
    const steerUuid = 'steer-msg-uuid';
    const steerContent = 'steer-content';
    const sessionId = 'sess-steer-a1c';

    type SteerRow = {
      name: string;
      status: 'idle' | 'queued' | 'processing';
      delivery: 'enqueued' | 'consumed' | 'missing';
      queryPromise: 'present' | 'absent';
      provider: 'acp' | 'anthropic';
      pending: boolean;
      claimGuard: 'held' | 'superseded';
      expected: 'aborted' | 'park' | 'promote' | 'awaiting_acceptance' | 'consumed';
    };

    function rowExpectsAdmission(row: Omit<SteerRow, 'name'>): boolean {
      return (
        row.expected === 'consumed' || (row.expected === 'awaiting_acceptance' && !row.pending)
      );
    }

    async function settleFeedAck(
      steerPromise: Promise<unknown>,
      queue: MessageQueue,
      expectsAdmission: boolean
    ): Promise<void> {
      if (!expectsAdmission) {
        await steerPromise;
        return;
      }
      for (let i = 0; i < 200; i++) {
        const done = await Promise.race([
          steerPromise.then(
            () => true,
            () => true
          ),
          Promise.resolve().then(() => queue.remove(steerUuid) || false),
        ]);
        if (done) return;
      }
    }

    async function waitForQueueEntry(queue: MessageQueue): Promise<void> {
      for (let i = 0; i < 200 && queue.size() === 0; i++) {
        await Promise.resolve();
      }
    }

    async function runSteerRow(
      row: Omit<SteerRow, 'name'>
    ): Promise<{ db: Database; queue: MessageQueue; outcome: unknown }> {
      const db = await createTestDb();
      const session = createTestSession(sessionId);
      if (row.provider === 'acp') session.config.provider = 'acp';
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
      if (row.status === 'processing') {
        await agentSession.stateManager.setProcessing(steerUuid);
      } else if (row.status === 'queued') {
        await agentSession.stateManager.setQueued(steerUuid);
      }
      const queue = agentSession.messageQueue;
      (queue as unknown as { hasPendingOrInFlight: (id: string) => boolean }).hasPendingOrInFlight =
        mock(() => row.pending);
      if (row.queryPromise === 'present') {
        agentSession.queryPromise = new Promise<void>(() => {});
      }
      const claimGuard = row.claimGuard === 'held' ? () => true : () => false;
      const steerPromise = agentSession.feedDeliverySteer(
        steerUuid,
        steerContent,
        null,
        claimGuard
      );
      await settleFeedAck(steerPromise, queue, rowExpectsAdmission(row));
      const outcome = await steerPromise;
      return { db, queue, outcome };
    }

    const rows: SteerRow[] = [
      {
        name: 'superseded claim aborts at processing before the status ladder',
        status: 'processing',
        delivery: 'enqueued',
        queryPromise: 'present',
        provider: 'anthropic',
        pending: true,
        claimGuard: 'superseded',
        expected: 'aborted',
      },
      {
        name: 'superseded claim aborts at queued before the status ladder',
        status: 'queued',
        delivery: 'enqueued',
        queryPromise: 'present',
        provider: 'anthropic',
        pending: false,
        claimGuard: 'superseded',
        expected: 'aborted',
      },
      {
        name: 'superseded claim aborts at idle before the status ladder',
        status: 'idle',
        delivery: 'enqueued',
        queryPromise: 'present',
        provider: 'anthropic',
        pending: false,
        claimGuard: 'superseded',
        expected: 'aborted',
      },
      {
        name: 'queued parks regardless of delivery validity, live query, ACP provider, and pending steer',
        status: 'queued',
        delivery: 'consumed',
        queryPromise: 'present',
        provider: 'acp',
        pending: true,
        claimGuard: 'held',
        expected: 'park',
      },
      {
        name: 'queued parks even with an absent query and a fresh valid delivery',
        status: 'queued',
        delivery: 'enqueued',
        queryPromise: 'absent',
        provider: 'anthropic',
        pending: false,
        claimGuard: 'held',
        expected: 'park',
      },
      {
        name: 'idle promotes regardless of delivery validity and absent query',
        status: 'idle',
        delivery: 'consumed',
        queryPromise: 'absent',
        provider: 'anthropic',
        pending: false,
        claimGuard: 'held',
        expected: 'promote',
      },
      {
        name: 'processing aborts on a consumed delivery row',
        status: 'processing',
        delivery: 'consumed',
        queryPromise: 'present',
        provider: 'anthropic',
        pending: false,
        claimGuard: 'held',
        expected: 'aborted',
      },
      {
        name: 'processing aborts on a missing delivery row',
        status: 'processing',
        delivery: 'missing',
        queryPromise: 'present',
        provider: 'anthropic',
        pending: false,
        claimGuard: 'held',
        expected: 'aborted',
      },
      {
        name: 'processing promotes when no query is live',
        status: 'processing',
        delivery: 'enqueued',
        queryPromise: 'absent',
        provider: 'anthropic',
        pending: false,
        claimGuard: 'held',
        expected: 'promote',
      },
      {
        name: 'ACP with an already-pending steer returns awaiting_acceptance without admitting a fresh feed',
        status: 'processing',
        delivery: 'enqueued',
        queryPromise: 'present',
        provider: 'acp',
        pending: true,
        claimGuard: 'held',
        expected: 'awaiting_acceptance',
      },
      {
        name: 'non-ACP with an already-pending steer still admits a feed (ownership does not gate admission)',
        status: 'processing',
        delivery: 'enqueued',
        queryPromise: 'present',
        provider: 'anthropic',
        pending: true,
        claimGuard: 'held',
        expected: 'consumed',
      },
      {
        name: 'ACP with a fresh steer admits and returns awaiting_acceptance after the SDK ack',
        status: 'processing',
        delivery: 'enqueued',
        queryPromise: 'present',
        provider: 'acp',
        pending: false,
        claimGuard: 'held',
        expected: 'awaiting_acceptance',
      },
      {
        name: 'non-ACP with a fresh steer admits and returns consumed after the SDK ack',
        status: 'processing',
        delivery: 'enqueued',
        queryPromise: 'present',
        provider: 'anthropic',
        pending: false,
        claimGuard: 'held',
        expected: 'consumed',
      },
    ];

    for (const row of rows) {
      it(row.name, async () => {
        const { db, queue, outcome } = await runSteerRow(row);
        try {
          expect(outcome).toEqual({ outcome: row.expected });
          if (row.expected === 'consumed') {
            expect(
              db.getSDKMessageRepo().getDeliveryContent(sessionId, steerUuid)?.sendStatus
            ).toBe('consumed');
          } else if (row.expected === 'awaiting_acceptance' && row.provider === 'acp') {
            expect(
              db.getSDKMessageRepo().getDeliveryContent(sessionId, steerUuid)?.sendStatus
            ).toBe('enqueued');
          }
          if (!rowExpectsAdmission(row)) {
            expect(queue.size()).toBe(0);
          }
        } finally {
          db.close();
        }
      });
    }

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
        await agentSession.stateManager.setProcessing(steerUuid);
        agentSession.queryPromise = new Promise<void>(() => {});
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const hold = withSessionLock(sessionId, () => held);
        let claimHeld = true;
        const steerPromise = agentSession.feedDeliverySteer(
          steerUuid,
          steerContent,
          null,
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

    it('pins: a live query ending after the steer was SDK-yielded and consumed reopens the delivery and throws', async () => {
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
        await agentSession.stateManager.setProcessing(steerUuid);
        let resolveQuery!: () => void;
        agentSession.queryPromise = new Promise<void>((resolve) => {
          resolveQuery = resolve;
        });
        const queue = agentSession.messageQueue;
        const steerPromise = agentSession.feedDeliverySteer(
          steerUuid,
          steerContent,
          null,
          () => true
        );
        await waitForQueueEntry(queue);
        queue.start();
        const generator = queue.messageGenerator(sessionId, { suppressPreYieldCallback: true });
        await generator.next();
        repo.markDeliveryConsumedByUuid(sessionId, steerUuid);
        resolveQuery();
        await expect(steerPromise).rejects.toThrow(
          'Steer target query ended before the SDK consumed the steer'
        );
        expect(repo.getDeliveryContent(sessionId, steerUuid)?.sendStatus).toBe('enqueued');
        expect(queue.size()).toBe(1);
      } finally {
        db.close();
      }
    });
  });
});
