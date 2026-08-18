/**
 * AgentSession Tests
 *
 * Tests for the main agent orchestration class.
 * Note: AgentSession has many dependencies, so we test what we can without
 * using mock.module() which affects other test files globally.
 */

import { describe, expect, it, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type {
  Session,
  ContextInfo,
  AgentProcessingState,
  SelectiveRewindResult,
  RewindMode,
  McpServerConfig,
} from '@hyperneo/shared';
import { AcpQueryRunner } from '../../../../src/lib/acp/acp-query-runner';
import { AgentSession } from '../../../../src/lib/agent/agent-session';
import { QueryRunner } from '../../../../src/lib/agent/query-runner';
import type { QueryRunnerContext } from '../../../../src/lib/agent/query-runner';
import type { Database } from '../../../../src/storage/database';
import type { MessageHub } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database';

// Test the AgentSession class indirectly through its components
// since direct testing with mock.module() causes global mock pollution

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

      // Simulate partial update
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
        getMessagesByStatus: mock(() => []),
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
        // No pid — the VM/container/remote spawn path.
        once: mock((_event: string, handler: () => void) => {
          if (_event === 'exit') fireExit = handler;
          return noPidProc;
        }),
        kill: mock(() => true),
      };

      agentSession.trackAgentProcess(noPidProc as never);
      agentSession.terminateTrackedAgentProcesses({ forceDelayMs: 10 });

      // SIGTERM is signaled immediately via the handle's kill().
      expect(noPidProc.kill).toHaveBeenCalledWith('SIGTERM');

      await new Promise((resolve) => setTimeout(resolve, 25));
      // The deferred SIGKILL fired for the no-PID handle too.
      expect(noPidProc.kill).toHaveBeenCalledWith('SIGKILL');

      // Natural exit self-cleans the durable handle collection.
      fireExit?.();
      agentSession.terminateTrackedAgentProcesses({ forceDelayMs: 5 });
      await new Promise((resolve) => setTimeout(resolve, 15));
      const sigtermCalls = (noPidProc.kill as ReturnType<typeof mock>).mock.calls.filter(
        (args) => args[0] === 'SIGTERM'
      ).length;
      expect(sigtermCalls).toBe(1); // not re-signaled after exit
    });

    it('scopes no-PID termination to the supplied snapshot, sparing a replacement handle', async () => {
      // Codex P2 follow-up: stop() captures a snapshot before awaiting so a
      // concurrently started replacement is not killed. The no-PID path must
      // honor the snapshot exactly like the PID path.
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
      // The replacement starts AFTER the snapshot was captured.
      agentSession.trackAgentProcess(replacementProc as never);

      agentSession.terminateTrackedAgentProcesses({ forceDelayMs: 10, noPidProcesses: snapshot });
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(oldProc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(oldProc.kill).toHaveBeenCalledWith('SIGKILL');
      expect(replacementProc.kill).not.toHaveBeenCalled();
    });

    it('keeps a retained no-PID orphan in the exit aggregate after reset (Codex P2, PR #2491)', async () => {
      // resetProcessExitedPromise() abandons the wait but must not drop a
      // still-live orphan's exit promise: the next updateProcessExitedPromise()
      // rebuild derives from the retained handles, so a later stop() still
      // waits for the orphan to exit before restarting.
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

      agentSession.trackAgentProcess(procA as never); // no-PID orphan
      agentSession.resetProcessExitedPromise(); // retry path abandons the wait
      agentSession.trackAgentProcess(procB as never); // replacement tracked
      const aggregate = agentSession.processExitedPromise;
      expect(aggregate).not.toBeNull();

      let resolved = false;
      void aggregate!.then(() => {
        resolved = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50)); // B exited, A alive
      expect(resolved).toBe(false); // aggregate still waits on the orphan
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
        getMessagesByStatus: mock(() => []),
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

      // Track a numeric-PID process first
      const numericProc = {
        pid: 500,
        once: mock((_event: string, _handler: () => void) => numericProc),
        kill: mock(() => true),
      };
      agentSession.trackAgentProcess(numericProc as never);
      const existingPromise = agentSession.processExitedPromise;
      expect(existingPromise).not.toBeNull();

      // Track a no-PID process — should NOT overwrite processExitedPromise
      const noPidProc = {
        once: mock((_event: string, _handler: () => void) => noPidProc),
        kill: mock(() => true),
      };
      agentSession.trackAgentProcess(noPidProc as never);
      const updatedPromise = agentSession.processExitedPromise;

      // processExitedPromise should still be set (not null) and should
      // aggregate both the numeric-PID and no-PID exit promises
      expect(updatedPromise).not.toBeNull();
      // It should be a new promise (aggregated), not the same reference
      expect(updatedPromise).not.toBe(existingPromise);
    });

    it('aggregates no-PID exit promise with existing numeric-PID promises', async () => {
      const agentSession = createAgentSession();

      // Track a numeric-PID process
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

      // Track a no-PID process
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

      // Resolve the numeric-PID process — promise should NOT resolve yet
      // because the no-PID promise is still pending
      exitHandler1?.();
      await new Promise((resolve) => setTimeout(resolve, 5));
      // Resolve the no-PID process
      exitHandlerNoPid?.();
      await expect(promise).resolves.toBeUndefined();
    });

    it('no-PID-first then numeric-PID keeps no-PID promise in aggregation', async () => {
      const agentSession = createAgentSession();

      // Track a no-PID process first
      let noPidExitHandler: (() => void) | null = null;
      const noPidProc = {
        once: mock((_event: string, handler: () => void) => {
          noPidExitHandler = handler;
          return noPidProc;
        }),
        kill: mock(() => true),
      };
      agentSession.trackAgentProcess(noPidProc as never);

      // Now track a numeric-PID process — updateProcessExitedPromise must
      // still include the pending no-PID promise.
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

      // Resolve the numeric process — promise should NOT resolve yet
      numericExitHandler?.();
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Now resolve the no-PID process
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

      // Resolve first two — promise should still be pending
      exitHandlers[0]();
      exitHandlers[1]();
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Resolve the last one
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
        getMessagesByStatus: mock(() => []),
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
      // Regression guard: auto-recovery wiring removed in Task 2.1/2.2
      expect(
        'startupTimeoutAutoRecoverAttempts' in (agentSession as unknown as Record<string, unknown>)
      ).toBe(false);
    });

    it('should NOT have onStartupTimeoutAutoRecover method (Task 2.2)', () => {
      // Regression guard: auto-recovery wiring removed in Task 2.1/2.2
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
      // May be null if no context has been tracked yet
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
        getMessagesByStatus: mock(() => []),
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
      // A turn that consumed its kickoff but produced no result must flip the
      // row back to `enqueued` so the retry RE-FEEDS it (resume alone does not
      // continue an incomplete trailing user turn) — but ONLY while this
      // attempt's job claim is still current. An interrupt (Stop) deletes the
      // delivery job FIRST and leaves the consumed row by design; the unwind's
      // idle transition then lands in the no-result branch with a dead claim.
      // Reopening there would strand an `enqueued` orphan that the reconciler
      // replays, undoing the user's Stop. (Codex P1.)
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
      // A query that never settles on its own — the turn-end waiter drives the
      // outcome, like a real long turn.
      (agentSession as unknown as { queryPromise: Promise<unknown> }).queryPromise = new Promise(
        () => {}
      );

      // Live claim: the row is reopened, and the bridge throws recoverable so
      // the job retries (and re-feeds).
      await agentSession.stateManager.setProcessing('uuid-reopen');
      const live = agentSession.driveDeliveryTurn('uuid-reopen', 'hello', null, true, () => true);
      await agentSession.stateManager.setIdle();
      await expect(live).rejects.toThrow('Turn ended without a response');
      expect(retrySpy).toHaveBeenCalledTimes(1);

      // Dead claim (interrupt deleted the job mid-turn): the row must stay
      // `consumed`. The claim was live when the turn started — the interrupt
      // deletes the job while the turn is being awaited, so the idle transition
      // lands in the no-result branch with a dead claim.
      let claimAlive = true;
      await agentSession.stateManager.setProcessing('uuid-reopen-2');
      const cancelled = agentSession.driveDeliveryTurn(
        'uuid-reopen-2',
        'hello',
        null,
        true,
        () => claimAlive
      );
      // Let the drive pass its locked start section, then kill the claim
      // (InterruptHandler deletes the delivery job before unwinding the query).
      await new Promise((resolve) => setTimeout(resolve, 10));
      claimAlive = false;
      await agentSession.stateManager.setIdle();
      await expect(cancelled).rejects.toThrow();
      expect(retrySpy).toHaveBeenCalledTimes(1); // no additional reopen
    });

    it('driveDeliveryTurn re-arms through a spurious turn-end fired right after a fresh admission', async () => {
      // The previous turn's teardown can release idle waiters a few ms AFTER a
      // promoted kickoff was admitted — before this turn's result can possibly
      // exist. Failing there reopened the row and re-fed a prompt the
      // still-live query was already answering (duplicate feed → dead air →
      // stall watchdog). The drive must re-arm its waiter and wait for the
      // turn's REAL end instead. (PR #2499 CI trace.)
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
      // A query that never settles on its own — only the idle waiter can end
      // the turn, so a premature failure cannot hide behind queryPromise.
      (agentSession as unknown as { queryPromise: Promise<unknown> }).queryPromise = new Promise(
        () => {}
      );
      (agentSession as unknown as { messageQueue: unknown }).messageQueue = {
        admitWithId: mock(() => Promise.resolve()),
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
      // Admission resolves; the PREVIOUS turn's teardown then fires an idle
      // transition almost immediately — before any result exists.
      await new Promise((resolve) => setTimeout(resolve, 10));
      await agentSession.stateManager.setIdle();
      // The drive must NOT fail on the spurious fire (query alive, no result):
      // give it a beat to prove it is still waiting rather than thrown.
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The turn's REAL end: the result lands, then the terminal idle.
      resultLanded = true;
      await agentSession.stateManager.setProcessing('uuid-spurious');
      await agentSession.stateManager.setIdle();
      await expect(drive).resolves.toEqual({ outcome: 'completed' });
    });

    it('driveDeliveryTurn narrows the batch payload even when only the kickoff is admitted', async () => {
      // Singleton admission (e.g. the budget fits only the kickoff, or every
      // other member was deferred/removed since enqueue) must STILL persist the
      // admitted set — otherwise the payload keeps the full batchUuids and the
      // omitted tail is consumed at ACP acceptance / failed on dead-letter as
      // part of a batch it was never fed into. (Codex round 3, P1.)
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
      // A never-resolving admission keeps the drive pending on the (unmocked)
      // consume path — the narrowing happens BEFORE admission under the lock.
      (agentSession as unknown as { messageQueue: unknown }).messageQueue = {
        admitWithId: mock(() => new Promise<void>(() => {})),
        isRunning: mock(() => false),
        size: mock(() => 0),
      };

      await agentSession.stateManager.setProcessing('kick-only');
      // Intentionally not awaited: the turn awaits a never-settling admission.
      void agentSession.driveDeliveryTurn('kick-only', 'estimate', null, false, () => true, [
        'kick-only',
        'tail-member',
      ]);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(narrowSpy).toHaveBeenCalledTimes(1);
      expect(narrowSpy.mock.calls[0]).toEqual(['test-session-id', 'kick-only', ['kick-only']]);
    });

    it('driveDeliveryTurn refuses to feed a reduced batch when narrowing cannot persist', async () => {
      // Narrowing is REQUIRED before feeding: if it returns false (claim
      // cancelled / row gone) the drive aborts WITHOUT admitting the prompt —
      // never feed a reduced prompt while the durable payload still holds the
      // superset (ACP acceptance / dead-letter would settle unsent rows).
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
      // A resume-blocked startup persists the sdk_resume_choice action and
      // parks the session as `queued` — `waiting_for_input` belongs to
      // AskUserQuestion, so the state alone can't see this gate. Steers parked
      // behind an unanswered resume card must not charge their park budget.
      // (Codex P2.)
      let unresolved = true;
      mockDb.getSDKMessageRepo = mock(() => ({
        hasUnresolvedHyperNeoAction: mock(() => unresolved),
      }));
      await agentSession.stateManager.setQueued('msg-gate');
      expect(agentSession.isWaitingForInput()).toBe(true);
      unresolved = false;
      expect(agentSession.isWaitingForInput()).toBe(false);
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
      // No hardcoded 'enqueued' filter — the frontend Remove button targets
      // both current-turn (enqueued) and next-turn (deferred) rows.
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
      // During rate_limit_cooldown the prior durable turn still occupies the
      // active-turn slot, so the replacement is classified as a steer. It must
      // STILL cancel the cooldown or the watchdog's timer replays the stale
      // prompt instead of letting the user's replacement take over. (Codex P1.)
      let turnAttempt = 0;
      const jobQueue = {
        enqueue: mock(() => {
          turnAttempt++;
          if (turnAttempt === 1) {
            // First (turn) insert hits the active-turn unique index → re-insert as steer.
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
      // A steer does not claim the queued marker (only the turn owner does).
      expect(agentSession.stateManager.setQueuedIfIdle).not.toHaveBeenCalled();
    });

    it('deliverChatMessage does NOT bump the watchdog generation for a steer into a live turn', async () => {
      // A normal steer feeds a LIVE turn; cancelling here would bump the episode
      // generation and desync the rate-limit episode from the active turn's
      // turn-end waiter tag (P1-2), stranding it on a later 429. Only a turn, or
      // a steer during rate_limit_cooldown, may cancel.
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
      // Codex P2 (PR #2499): the bump that starts the delivery's query must
      // retag AND claim (clear pendingStart) the armed observer, so the new
      // query's first frame fences clean while a predecessor's earlier frame
      // (before this bump) stays inactive.
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
      // Codex P2 (PR #2499): a predecessor query's late terminal frame landing
      // while ensureQueryStarted awaits an interrupt must not be consumed as
      // THIS delivery's first response — it carries the pre-bump generation and
      // would clear the observer before the replacement query claims it.
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
      // Create minimal mock session
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

      // Create minimal mock database
      mockDb = {
        getSession: mock(() => mockSession),
        updateSession: mock(() => {}),
        getUserMessages: mock(() => []),
        getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
        deleteMessagesAfter: mock(() => 0),
        deleteMessagesAtAndAfter: mock(() => 0),
        getUserMessageByUuid: mock(() => undefined),
        countMessagesAfter: mock(() => 0),
        getMessagesByStatus: mock(() => []),
        updateMessage: mock(() => {}),
      } as unknown as Database;

      // Create minimal mock message hub
      mockMessageHub = {
        sendMessage: mock(() => {}),
      } as unknown as MessageHub;

      // Create mock API key getter
      mockInternalEventBus = {
        publish: mock(async () => {}),
        publishAsync: mock(() => {}),
        subscribe: mock((_: string, __: Function, ___: object) => () => {}),
      } as unknown as InternalEventBus<any>;

      mockGetApiKey = mock(async () => 'test-api-key');

      // Create AgentSession instance
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

      // Mock the rewindHandler's executeSelectiveRewind method
      const executeSelectiveRewindSpy = mock(() => Promise.resolve(expectedResult));
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).rewindHandler = {
        executeSelectiveRewind: executeSelectiveRewindSpy,
      };

      // Call the method
      const result = await agentSession.executeSelectiveRewind(messageIds, mode);

      // Verify the handler was called with correct arguments
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

      // Mock the rewindHandler's executeSelectiveRewind method
      const executeSelectiveRewindSpy = mock(() => Promise.resolve(expectedResult));
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).rewindHandler = {
        executeSelectiveRewind: executeSelectiveRewindSpy,
      };

      // Call the method without mode parameter
      const result = await agentSession.executeSelectiveRewind(messageIds);

      // Verify the handler was called with correct arguments (mode should be undefined)
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

  describe('isInStartupBackoff', () => {
    it('surfaces the SDK runner window and stays false for ACP runners or closed windows', () => {
      // Round-13 P3: this accessor is the runner→session seam the delivery
      // handler's park exemption rides on — a regression here (wrong field,
      // dropped instanceof guard, ACP leaking through) silently kills the
      // exemption for every real session while the handler/runner tests all
      // stay green, so the seam gets its own pin.
      const agentSession = new AgentSession(
        {
          id: 'seam-session',
          title: 'Seam',
          workspacePath: '/test/workspace',
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
          status: 'active',
          config: { model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 1.0 },
          metadata: {},
        } as never,
        { getSession: mock(() => null) } as never,
        {} as never,
        {
          publish: mock(() => {}),
          subscribe: mock(() => () => {}),
        } as never,
        mock(async () => null)
      );
      // No runner window yet.
      expect(agentSession.isInStartupBackoff()).toBe(false);

      // A QueryRunner with a closed window stays false; an open owner token
      // (what the retry branch mints for the teardown+backoff span) is
      // surfaced as true.
      const runner = new QueryRunner({} as QueryRunnerContext);
      (agentSession as unknown as Record<string, unknown>).queryRunner = runner;
      expect(agentSession.isInStartupBackoff()).toBe(false);
      (runner as unknown as Record<string, unknown>)._startupBackoffOwner = {};
      expect(agentSession.isInStartupBackoff()).toBe(true);

      // An ACP runner with a closed window stays false; an open owner token
      // (mirrored field) surfaces true — the exemption is runner-agnostic.
      const acpRunner = new AcpQueryRunner(agentSession as never, (() => {}) as never);
      (agentSession as unknown as Record<string, unknown>).queryRunner = acpRunner;
      expect(agentSession.isInStartupBackoff()).toBe(false);
      (acpRunner as unknown as Record<string, unknown>)._startupBackoffOwner = {};
      expect(agentSession.isInStartupBackoff()).toBe(true);
    });
  });

  describe('resetStartupTimeoutRetryBudget', () => {
    it('delegates the retry-lane budget reset to the SDK runner (round-14 P2)', () => {
      const agentSession = new AgentSession(
        {
          id: 'seam-session',
          title: 'Seam',
          workspacePath: '/test/workspace',
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
          status: 'active',
          config: { model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 1.0 },
          metadata: {},
        } as never,
        { getSession: mock(() => null) } as never,
        {} as never,
        {
          publish: mock(() => {}),
          subscribe: mock(() => () => {}),
        } as never,
        mock(async () => null)
      );
      const runner = new QueryRunner({} as QueryRunnerContext);
      (agentSession as unknown as Record<string, unknown>).queryRunner = runner;
      const state = { key: 'retried-uuid', retries: 9 };
      (runner as unknown as Record<string, unknown>)._startupTimeoutRetryState = state;

      // Matching uuid resets; a different delivery's budget is untouched.
      agentSession.resetStartupTimeoutRetryBudget('other-uuid');
      expect((runner as unknown as Record<string, unknown>)._startupTimeoutRetryState).toBe(state);
      agentSession.resetStartupTimeoutRetryBudget('retried-uuid');
      expect((runner as unknown as Record<string, unknown>)._startupTimeoutRetryState).toEqual({
        key: null,
        retries: 0,
      });
    });

    it('delegates the retry-lane budget reset to the ACP runner (mirror)', () => {
      const agentSession = new AgentSession(
        {
          id: 'seam-session',
          title: 'Seam',
          workspacePath: '/test/workspace',
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
          status: 'active',
          config: { model: 'claude-sonnet-4-20250514', maxTokens: 8192, temperature: 1.0 },
          metadata: {},
        } as never,
        { getSession: mock(() => null) } as never,
        {} as never,
        {
          publish: mock(() => {}),
          subscribe: mock(() => () => {}),
        } as never,
        mock(async () => null)
      );
      const acpRunner = new AcpQueryRunner(agentSession as never, (() => {}) as never);
      (agentSession as unknown as Record<string, unknown>).queryRunner = acpRunner;
      const state = { key: 'retried-uuid', retries: 9 };
      (acpRunner as unknown as Record<string, unknown>)._startupTimeoutRetryState = state;

      // Matching uuid resets; a different delivery's budget is untouched.
      agentSession.resetStartupTimeoutRetryBudget('other-uuid');
      expect((acpRunner as unknown as Record<string, unknown>)._startupTimeoutRetryState).toBe(
        state
      );
      agentSession.resetStartupTimeoutRetryBudget('retried-uuid');
      expect((acpRunner as unknown as Record<string, unknown>)._startupTimeoutRetryState).toEqual({
        key: null,
        retries: 0,
      });
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

      expect(startQueryAndEnqueueSpy).toHaveBeenCalledWith('msg-id', 'test content', undefined);
    });

    it('should handle MessageContent array', async () => {
      const startQueryAndEnqueueSpy = mock(async () => {});
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
        startQueryAndEnqueue: startQueryAndEnqueueSpy,
      };

      const content = [{ type: 'text', text: 'hello' }];
      await agentSession.startQueryAndEnqueue('msg-id', content);

      expect(startQueryAndEnqueueSpy).toHaveBeenCalledWith('msg-id', content, undefined);
    });

    it('cancels the in-flight recovery episode for genuine new input (undefined generation)', async () => {
      // Genuine new user input supersedes any in-flight fallback/cooldown-retry:
      // cancel() bumps the generation so the stale continuation aborts instead
      // of replaying the old message alongside the new turn. (Codex P1.)
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
      await agentSession.startQueryAndEnqueue('msg-id', 'content'); // undefined → genuine input
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(clearSpy).not.toHaveBeenCalled();
    });

    it('executeRateLimitAutoRetry suppresses the waiter drain when startQueryAndEnqueue throws (Codex P1)', async () => {
      // The retry catch must NOT drain: returning false makes the watchdog
      // schedule another startup attempt for this same episode, so the old
      // prompt is still slated for replay — draining would complete the durable
      // job and free the active-turn slot mid-retry. Every setIdle in the retry
      // path is suppressed; the waiter is released only on supersession.
      const setIdleSpy = mock(async (_opts?: { suppressDeliveryWaiters?: boolean }) => {});
      agentSession.stateManager.setIdle = setIdleSpy;
      // biome-ignore lint: test mock access
      (agentSession as unknown as Record<string, unknown>).rateLimitWatchdog = {
        isSuperseded: () => false, // episode still active → retry proceeds
        clearPendingCooldown: () => {}, // startQueryAndEnqueue (generation provided) clears the timer
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
      // The catch's setIdle (and the try's) are both suppressed — no drain.
      expect(setIdleSpy).toHaveBeenCalled();
      for (const call of setIdleSpy.mock.calls) {
        expect(call[0]).toEqual({ suppressDeliveryWaiters: true });
      }
    });

    it('only clears the timer for a recovery re-enqueue (generation provided)', async () => {
      // An internal recovery re-enqueue is the SAME episode — clear only the
      // timer, don't bump the generation (which would self-abort the in-flight
      // fallback). (Codex P1.)
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
      await agentSession.startQueryAndEnqueue('msg-id', 'content', 7); // recovery
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

      // A success-result frame is the signal that resets the rate-limit episode.
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

      // A system:init frame must mark API success (circuit breaker) but NOT
      // reset the fallback episode (would cause an A/B loop on repeated 429).
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
      // Simulate what createSdkMcpServer returns - an object with a non-serializable instance
      const mockMcpServer = {
        type: 'sdk' as const,
        name: 'lobby-agent-tools',
        // This instance property contains cyclic references
        instance: {
          connect: () => {},
          // Create a cyclic reference
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

      // Verify the session was created
      expect(session.id).toBe('lobby:default');
      expect(session.type).toBe('lobby');
      expect(session.config.model).toBe('claude-sonnet-4-5-20250929');

      // Most importantly, mcpServers should NOT be in the persisted config
      // because it contains non-serializable objects
      expect(session.config.mcpServers).toBeUndefined();

      // The config should be JSON-serializable without errors
      expect(() => JSON.stringify(session.config)).not.toThrow();

      // Verify the serialized JSON doesn't contain mcpServers
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

      // Config should not contain mcpServers
      expect(session.config.mcpServers).toBeUndefined();

      // Should be serializable
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

      // Config should be JSON-serializable
      const serialized = JSON.stringify(session.config);
      expect(serialized).toContain('toolGuards');
    });
  });

  describe('fromInit', () => {
    it('should merge mcpServers into session config at runtime for query options builder', () => {
      // Create a mock cyclic MCP server instance
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

      // Create a mock database that returns null for getSession (new session)
      const mockDb = {
        getSession: mock(() => null),
        createSession: mock(() => {}),
        updateSession: mock(() => {}),
        getMessagesByStatus: mock(() => []),
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

      // The runtime session should have mcpServers available for query options builder
      const sessionData = agentSession.getSessionData();
      expect(sessionData.config.mcpServers).toBeDefined();
      expect(sessionData.config.mcpServers!['test-tools']).toEqual(mockMcpServer);

      // The database should have been called with a session that has NO mcpServers
      // (because we don't persist non-serializable objects)
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
        getMessagesByStatus: mock(() => []),
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
        getMessagesByStatus: mock(() => []),
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
        getMessagesByStatus: mock(() => []),
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
        getMessagesByStatus: mock(() => []),
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
  // ---------------------------------------------------------------------------
  // awaitSdkSessionCaptured
  // ---------------------------------------------------------------------------

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
        getMessagesByStatus: mock(() => []),
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
        // `controls` may still be null if `on()` wasn't called (fast path hit),
        // callers that need it should trigger the slow path first.
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

      // Fire an unrelated session.updated event (different sessionId) — ignored.
      handler?.({ sessionId: 'other-session', session: { sdkSessionId: 'ignored' } });
      // Fire a matching event → resolves.
      handler?.({
        sessionId: 'space:s1:task:t1',
        session: { sdkSessionId: 'sdk-just-captured' },
      });

      const id = await waiter;
      expect(id).toBe('sdk-just-captured');
      // Listener must be torn down to avoid leaks.
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
      // Listener must be torn down on timeout too.
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
        getMessagesByStatus: mock(() => []),
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

      // Initially no system prompt
      expect(agentSession.getSessionData().config.systemPrompt).toBeUndefined();

      // Set the runtime system prompt
      agentSession.setRuntimeSystemPrompt('You are the Room Agent.');

      // In-memory config should reflect the new prompt
      expect(agentSession.getSessionData().config.systemPrompt).toBe('You are the Room Agent.');

      // The DB update should NOT have been called (runtime-only, not persisted)
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
        getMessagesByStatus: mock(() => []),
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
        getMessagesByStatus: mock(() => []),
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

      // Runtime-only: DB update should NOT be called
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
      // Existing entries preserved
      expect(merged?.['task-agent']).toBe(existing['task-agent']);
      expect(merged?.['db-query']).toBe(existing['db-query']);
      // New entry added
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
      // Overlapping key was overwritten
      expect(merged?.['db-query']).toBe(replacementDbQuery);
      expect(merged?.['db-query']).not.toBe(originalDbQuery);
      // Non-overlapping key preserved
      expect(merged?.['task-agent']).toBe(existing['task-agent']);

      // Runtime-only: DB update should NOT be called
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
      const getMessagesByStatus = mock((_sessionId: string, status: string) => {
        if (status === 'enqueued' || status === 'deferred') {
          replayStatusReads.push(status);
        }
        return [];
      });
      const { mockDb, mockMessageHub, mockInternalEventBus, mockGetApiKey } = makeMocks();
      (mockDb as unknown as { getMessagesByStatus: ReturnType<typeof mock> }).getMessagesByStatus =
        getMessagesByStatus;

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
        getMessagesByStatus: mock(() => []),
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
      // Other server must survive
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

      // Should not throw
      agentSession.detachRuntimeMcpServer('node-agent');

      const servers = agentSession.getSessionData().config.mcpServers;
      expect(servers?.['space-agent-tools']).toBe(existing['space-agent-tools']);
    });

    it('should be a no-op when mcpServers is not defined', () => {
      const mockSession = makeMockSession(); // no existing servers
      const { mockDb, mockMessageHub, mockInternalEventBus, mockGetApiKey } = makeMocks();

      const agentSession = new AgentSession(
        mockSession,
        mockDb,
        mockMessageHub,
        mockInternalEventBus,
        mockGetApiKey
      );

      // Should not throw even with no mcpServers key at all
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
      // Fresh server replaces stale one
      expect(servers?.['node-agent']).toBe(freshNodeAgent);
      expect(servers?.['node-agent']).not.toBe(staleNodeAgent);
      // Unrelated server is untouched
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

  // -------------------------------------------------------------------------
  // mcp.attach telemetry — Task #140 acceptance #9
  // -------------------------------------------------------------------------

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
        getMessagesByStatus: mock(() => []),
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

    /**
     * Capture mcp.attach log lines by monkey-patching the agentSession.logger.
     * The structured payload is the second arg passed to logger.info, but the
     * production code passes a single pre-formatted string `mcp.attach {...}`.
     * We parse out the JSON tail.
     */
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
          } catch {
            // ignore
          }
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
      // Servers must be sorted for deterministic grep output
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
        getMessagesByStatus: mock(() => []),
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
        getMessagesByStatus: mock(() => []),
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
        getMessagesByStatus: mock(() => []),
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
      // Runtime-injected server (e.g. space-agent-tools) lives in config.mcpServers.
      const runtimeServer: McpServerConfig = { command: 'runtime-cmd' };
      agentSession.session.config.mcpServers = { 'space-agent-tools': runtimeServer };

      const setMcpServers = mock(() => Promise.resolve({ added: [], removed: [], errors: [] }));
      agentSession.queryObject = {
        setMcpServers,
      } as unknown as AgentSession['queryObject'];

      agentSession.reconcileEffectiveMcpServers();

      expect(setMcpServers).toHaveBeenCalledTimes(1);
      const pushed = setMcpServers.mock.calls[0][0] as Record<string, McpServerConfig>;
      // Runtime server is preserved across reconciliation.
      expect(pushed['space-agent-tools']).toEqual(runtimeServer);
    });

    it('reconcileEffectiveMcpServers is a no-op when there is no live query', () => {
      agentSession.session.config.mcpServers = { 'space-agent-tools': { command: 'runtime-cmd' } };
      expect(agentSession.queryObject).toBeNull();
      // Must not throw when there is no queryObject to push to.
      expect(() => agentSession.reconcileEffectiveMcpServers()).not.toThrow();
    });
  });

  // Driving a real AgentSession against a real DB to cover the bridge wiring
  // the pure-helper tests cannot: that reclaimTurnAlreadySucceeded clears the
  // bare marker on 'redrive' and that driveDeliveryTurn does NOT silently
  // complete (turn_terminated) over a crash-window marker. (Task #946, PR #2477
  // review P1.)
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
      // Order matters for the success case: the kickoff is consumed FIRST
      // (markDeliveryConsumedByUuid stamps its consumption watermark from the
      // shared counter), THEN the terminal result is inserted (stamped from the
      // same counter, so it sorts after consumption). hasTerminalResultAfter
      // compares counter-to-counter.
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
      } catch {
        // ignore
      }
    });

    it('a bare marker (no success result) is cleared and NOT silently completed', async () => {
      // The crash window: consumed kickoff + bare marker, daemon exited before
      // the producedResult/retry decision. reclaimTurnAlreadySucceeded must
      // clear the marker and fall through (re-drive), not return turn_terminated.
      await setupDriverail({ marker: true, successResult: false });
      const repo = db.getSDKMessageRepo();
      expect(repo.hasDeliveryTurnEnd(sessionId, uuid)).toBe(true);

      // The redrive falls through to ensureQueryStarted; mock it to throw so the
      // outcome is predictable without a real provider. The marker clear happens
      // BEFORE this call (in the reclaim short-circuit), so it is durable.
      (agentSession as unknown as Record<string, unknown>).lifecycleManager = {
        ensureQueryStarted: mock(async () => {
          throw new Error('test: provider not started');
        }),
      };

      let threw = false;
      let outcome: unknown = undefined;
      try {
        outcome = await agentSession.driveDeliveryTurn(uuid, 'hi', null, true);
      } catch (err) {
        threw = err instanceof Error && err.message === 'test: provider not started';
      }
      // (a) NOT turn_terminated — it did not silently complete.
      expect(outcome).not.toEqual({ outcome: 'turn_terminated' });
      expect(threw).toBe(true);
      // (b) the bare marker was cleared in the DB by reclaimTurnAlreadySucceeded.
      expect(repo.hasDeliveryTurnEnd(sessionId, uuid)).toBe(false);
    });

    it('a SUCCESS-terminated reclaim still completes (turn_terminated) without starting a query', async () => {
      // Regression guard: a turn that genuinely succeeded completes at the
      // reclaim short-circuit (before ensureQueryStarted — no provider needed).
      await setupDriverail({ marker: true, successResult: true });
      const repo = db.getSDKMessageRepo();
      expect(repo.hasTerminalResultAfter(sessionId, uuid)).toBe(true);

      // ensureQueryStarted must NOT be reached; prove it by mocking it to throw —
      // if the short-circuit works, the throw never happens.
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

  describe('feedDeliverySteer — startup-backoff window (park, not dead-letter)', () => {
    // Round-5 P2 regression: during the startup-timeout retry's 15-240 s
    // backoff the session is 'processing' with queryPromise set, but the queue
    // is STOPPED (restarted only post-sleep). Admitting a steer there parks it
    // in a queue nothing consumes — the 30 s admission TTL rejects it and the
    // delivery job's retry budget drains re-admitting into the still-stopped
    // queue before dead-lettering `failed`. The feed branch must park instead.
    let db: Database;
    let agentSession: AgentSession;
    const sessionId = 'sess-backoff-steer';
    const steerUuid = 'msg-backoff-steer';

    async function setupBackoffSteer(): Promise<void> {
      db = await createTestDb();
      const session = createTestSession(sessionId);
      db.createSession(session);
      db.getSDKMessageRepo().saveUserMessage(
        sessionId,
        {
          type: 'user',
          uuid: steerUuid,
          message: { role: 'user', content: 'follow-up' },
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
      // Reproduce the backoff window: processing + queryPromise set + queue
      // stopped (the real MessageQueue starts not-running).
      await agentSession.stateManager.setProcessing('kickoff-uuid', 'initializing');
      agentSession.queryPromise = Promise.resolve();
    }

    afterEach(() => {
      try {
        db?.close();
      } catch {
        // ignore
      }
    });

    it('parks a steer sent while the queue is stopped instead of admitting it into a queue nothing consumes', async () => {
      await setupBackoffSteer();
      expect(agentSession.messageQueue.isRunning()).toBe(false);

      const outcome = await agentSession.feedDeliverySteer(steerUuid, 'follow-up');

      // Parked: the job re-evaluates on its park cadence and feeds (or
      // promotes once the turn settles) after the backoff ends.
      expect(outcome).toEqual({ outcome: 'park' });
      // Nothing was admitted — no TTL timer armed, nothing to dead-letter.
      expect(agentSession.messageQueue.size()).toBe(0);
    });

    it('still admits into a RUNNING queue (the gate covers only the stopped/backoff state)', async () => {
      await setupBackoffSteer();
      agentSession.messageQueue.start();
      expect(agentSession.messageQueue.isRunning()).toBe(true);

      // Do not await the outcome: the feed acknowledgment resolves only when a
      // generator consumes the entry. Assert the admission itself — the entry
      // lands in the queue — then clean up before the admission TTL fires.
      const pending = agentSession.feedDeliverySteer(steerUuid, 'follow-up').catch(() => {});
      for (let i = 0; i < 100 && agentSession.messageQueue.size() === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(agentSession.messageQueue.size()).toBe(1);
      agentSession.messageQueue.clear();
      agentSession.messageQueue.stop();
      await pending;
    });
  });
});
