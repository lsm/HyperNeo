import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MessageHub, Session } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { ContextTracker } from '../../../../src/lib/agent/context-tracker';
import type { MessageQueue } from '../../../../src/lib/agent/message-queue';
import type { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import type { QueryLifecycleManager } from '../../../../src/lib/agent/query-lifecycle-manager';
import {
  SDKMessageHandler,
  type SDKMessageHandlerContext,
} from '../../../../src/lib/agent/sdk-message-handler';
import type { ErrorManager } from '../../../../src/lib/error-manager';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import type { Database } from '../../../../src/storage/database';

type FlagView = {
  suppressIdleOnNextResult: boolean;
  usesSessionStateChangedTurnEnd: boolean;
  expectsSessionStateIdleAfterResult: boolean;
  lastResultWasSuccess: boolean | null;
  clearAwaitingTrailingIdle: boolean;
  clearMessageInFlight: boolean;
  currentThinkingTokensEstimate: number | null;
  lastStampedThinkingTokensEstimate: number;
};

const resetFlags: FlagView = {
  suppressIdleOnNextResult: false,
  usesSessionStateChangedTurnEnd: false,
  expectsSessionStateIdleAfterResult: false,
  lastResultWasSuccess: null,
  clearAwaitingTrailingIdle: false,
  clearMessageInFlight: false,
  currentThinkingTokensEstimate: null,
  lastStampedThinkingTokensEstimate: 0,
};

function readFlags(handler: SDKMessageHandler): FlagView {
  const view = handler as unknown as FlagView;
  return {
    suppressIdleOnNextResult: view.suppressIdleOnNextResult,
    usesSessionStateChangedTurnEnd: view.usesSessionStateChangedTurnEnd,
    expectsSessionStateIdleAfterResult: view.expectsSessionStateIdleAfterResult,
    lastResultWasSuccess: view.lastResultWasSuccess,
    clearAwaitingTrailingIdle: view.clearAwaitingTrailingIdle,
    clearMessageInFlight: view.clearMessageInFlight,
    currentThinkingTokensEstimate: view.currentThinkingTokensEstimate,
    lastStampedThinkingTokensEstimate: view.lastStampedThinkingTokensEstimate,
  };
}

const resultUsage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function successResult(uuid: string, overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    uuid,
    parent_tool_use_id: null,
    usage: resultUsage,
    total_cost_usd: 0.001,
    modelUsage: {},
    ...overrides,
  } as unknown as SDKMessage;
}

function errorResult(uuid: string, overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    uuid,
    parent_tool_use_id: null,
    is_error: true,
    errors: ['boom'],
    usage: resultUsage,
    total_cost_usd: 0.001,
    modelUsage: {},
    ...overrides,
  } as unknown as SDKMessage;
}

function sessionState(state: 'idle' | 'running' | 'requires_action'): SDKMessage {
  return {
    type: 'system',
    subtype: 'session_state_changed',
    state,
    uuid: `state-${state}`,
  } as unknown as SDKMessage;
}

function thinkingTokensMessage(estimatedTokens: number): SDKMessage {
  return {
    type: 'system',
    subtype: 'thinking_tokens',
    estimated_tokens: estimatedTokens,
    uuid: 'thinking-tokens',
  } as unknown as SDKMessage;
}

function assistantMessage(uuid: string): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [] },
  } as unknown as SDKMessage;
}

function thinkingAssistantMessage(uuid: string): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'deliberating' }] },
  } as unknown as SDKMessage;
}

describe('SDKMessageHandler flag-machine truth table (C1a)', () => {
  let handler: SDKMessageHandler;
  let mockSession: Session;
  let saveSDKMessageSpy: ReturnType<typeof mock>;
  let publishSpy: ReturnType<typeof mock>;
  let emitSpy: ReturnType<typeof mock>;
  let setIdleSpy: ReturnType<typeof mock>;
  let beginTerminalIdleSpy: ReturnType<typeof mock>;

  const replayCount = (): number =>
    emitSpy.mock.calls.filter((call) => call[0] === 'query.trigger').length;

  function createContext(
    overrides: Partial<SDKMessageHandlerContext> = {}
  ): SDKMessageHandlerContext {
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

    saveSDKMessageSpy = mock(() => true);
    const mockDb = {
      saveSDKMessage: saveSDKMessageSpy,
      updateSession: mock(() => {}),
      getUserMessagesByStatus: mock(() => ({ messages: [], total: 0 })),
      getMessageByStatusAndUuid: mock(() => null),
      updateMessageStatus: mock(() => {}),
      updateMessageTimestamp: mock(() => {}),
      beginTransaction: mock(() => {}),
      commitTransaction: mock(() => {}),
      abortTransaction: mock(() => {}),
    } as unknown as Database;

    publishSpy = mock((_topic: string) => {});
    const mockMessageHub = {
      event: publishSpy,
      onRequest: mock((_method: string, _handler: Function) => () => {}),
      query: mock(async () => ({})),
      command: mock(async () => {}),
    } as unknown as MessageHub;

    emitSpy = mock(async () => {});
    const mockInternalEventBus = {
      publish: emitSpy,
      publishAsync: emitSpy,
      subscribe: mock(
        (_topic: string, _fn: Function, _opts: { subscriberName: string }) => () => {}
      ),
    } as unknown as InternalEventBus<any>;

    setIdleSpy = mock(async () => {});
    beginTerminalIdleSpy = mock(() => {});
    const mockStateManager = {
      detectPhaseFromMessage: mock(async () => {}),
      setIdle: setIdleSpy,
      beginTerminalIdle: beginTerminalIdleSpy,
      setCompacting: mock(async () => {}),
      getIsCompacting: mock(() => false),
      getState: mock(() => ({ phase: 'idle' })),
    } as unknown as ProcessingStateManager;

    const mockContextTracker = {
      getContextInfo: mock(() => ({ totalTokens: 1000, maxTokens: 128000 })),
      updateWithDetailedBreakdown: mock(() => {}),
      shouldCompact: mock(() => false),
      shouldCompactAt: mock(() => false),
      markCompactionTriggered: mock(() => {}),
    } as unknown as ContextTracker;

    const mockMessageQueue = {
      enqueue: mock(async () => 'context-id'),
      enqueueWithId: mock(async () => {}),
      clear: mock(() => {}),
      hasPendingOrClaimed: mock(() => false),
      hasYielded: mock(() => false),
      acknowledgeYielded: mock(() => false),
    } as unknown as MessageQueue;

    return {
      session: mockSession,
      db: mockDb,
      messageHub: mockMessageHub,
      internalEventBus: mockInternalEventBus,
      stateManager: mockStateManager,
      contextTracker: mockContextTracker,
      messageQueue: mockMessageQueue,
      errorManager: { handleError: mock(async () => {}) } as unknown as ErrorManager,
      lifecycleManager: { stop: mock(async () => {}) } as unknown as QueryLifecycleManager,
      queryObject: null,
      queryPromise: null,
      onInitSlashCommands: mock(async () => {}),
      onCommandsChanged: mock(async () => {}),
      ...overrides,
    };
  }

  beforeEach(() => {
    handler = new SDKMessageHandler(createContext());
  });

  describe('legacy direct-idle rows (no session-state events)', () => {
    type LegacyRow = {
      name: string;
      result: () => SDKMessage;
      suppress?: boolean;
      clearInFlight?: boolean;
      manual?: boolean;
      expectedFence: number;
      expectedSetIdle: number;
      expectedReplay: number;
      expectedWait?: 'reset';
      expectedFlags: FlagView;
    };

    const legacyRows: LegacyRow[] = [
      {
        name: 'success without suppression: fence, doubled idle (direct + finishTurn), replay',
        result: () => successResult('legacy-success'),
        expectedFence: 1,
        expectedSetIdle: 2,
        expectedReplay: 1,
        expectedFlags: { ...resetFlags, lastResultWasSuccess: true },
      },
      {
        name: 'success without suppression in manual mode: fence, doubled idle, no replay',
        result: () => successResult('legacy-success-manual'),
        manual: true,
        expectedFence: 1,
        expectedSetIdle: 2,
        expectedReplay: 0,
        expectedFlags: { ...resetFlags, lastResultWasSuccess: true },
      },
      {
        name: 'error result without suppression: fence, direct idle only, no replay',
        result: () => errorResult('legacy-error'),
        expectedFence: 1,
        expectedSetIdle: 1,
        expectedReplay: 0,
        expectedFlags: { ...resetFlags, lastResultWasSuccess: false },
      },
      {
        name: 'suppressed success: no fence, no idle, suppression cleared by confirmation',
        result: () => successResult('legacy-suppressed-success'),
        suppress: true,
        expectedFence: 0,
        expectedSetIdle: 0,
        expectedReplay: 0,
        expectedFlags: { ...resetFlags, lastResultWasSuccess: true },
      },
      {
        name: 'suppressed error with no clear in flight: no fence, no idle, suppression retained',
        result: () => errorResult('legacy-suppressed-error'),
        suppress: true,
        expectedFence: 0,
        expectedSetIdle: 0,
        expectedReplay: 0,
        expectedFlags: {
          ...resetFlags,
          lastResultWasSuccess: false,
          suppressIdleOnNextResult: true,
        },
      },
      {
        name: 'suppressed error with clear in flight: bookkeeping unwind resets every flag',
        result: () => errorResult('legacy-clear-error'),
        suppress: true,
        clearInFlight: true,
        expectedFence: 0,
        expectedSetIdle: 0,
        expectedReplay: 0,
        expectedWait: 'reset',
        expectedFlags: resetFlags,
      },
    ];

    for (const row of legacyRows) {
      it(row.name, async () => {
        if (row.manual) {
          mockSession.config = { ...mockSession.config, queryMode: 'manual' };
        }
        if (row.suppress) {
          handler.suppressIdleForNextResult();
        }
        let wait: Promise<string> | null = null;
        if (row.clearInFlight) {
          wait = handler.waitForSuppressedResult(5_000);
          handler.markClearMessageSent();
        }

        await handler.handleMessage(row.result());

        expect(beginTerminalIdleSpy).toHaveBeenCalledTimes(row.expectedFence);
        expect(setIdleSpy).toHaveBeenCalledTimes(row.expectedSetIdle);
        expect(setIdleSpy.mock.calls).toEqual(
          Array.from({ length: row.expectedSetIdle }, () => [])
        );
        expect(replayCount()).toBe(row.expectedReplay);
        expect(readFlags(handler)).toEqual(row.expectedFlags);
        if (row.expectedWait !== undefined && wait !== null) {
          expect(await wait).toBe(row.expectedWait);
        }
      });
    }

    it('a nested result is saved and published but performs no idle or flag transition', async () => {
      await handler.handleMessage(errorResult('nested-prime-error'));
      saveSDKMessageSpy.mockClear();
      publishSpy.mockClear();
      emitSpy.mockClear();
      setIdleSpy.mockClear();
      beginTerminalIdleSpy.mockClear();

      const nested = successResult('nested-success', { parent_tool_use_id: 'toolu-1' });
      await handler.handleMessage(nested);

      expect(saveSDKMessageSpy).toHaveBeenCalledWith('test-session-id', nested);
      expect(publishSpy).toHaveBeenCalled();
      expect(emitSpy.mock.calls.some((call) => call[0] === 'sdk.message')).toBe(true);
      expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({ ...resetFlags, lastResultWasSuccess: false });
    });

    it('a nested result during an armed clear leaves suppression and the waiter untouched', async () => {
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000);
      handler.markClearMessageSent();
      let settled: string | null = null;
      void wait.then((outcome) => {
        settled = outcome;
      });

      await handler.handleMessage(
        successResult('suppressed-nested', { parent_tool_use_id: 'toolu-1' })
      );
      expect(settled).toBe(null);
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        suppressIdleOnNextResult: true,
        clearMessageInFlight: true,
      });

      await handler.handleMessage(
        errorResult('suppressed-nested-error', { parent_tool_use_id: 'toolu-1' })
      );
      expect(settled).toBe(null);
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        suppressIdleOnNextResult: true,
        clearMessageInFlight: true,
      });

      await handler.handleMessage(successResult('suppressed-nested-top-level'));
      expect(await wait).toBe('confirmed');
      expect(readFlags(handler)).toEqual({ ...resetFlags, lastResultWasSuccess: true });
    });

    it('a successful sent clear in legacy mode confirms immediately without a trailing idle', async () => {
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000, 'clear-msg-id');
      handler.markClearMessageSent();

      await handler.handleMessage(
        successResult('legacy-sent-clear', { user_message_uuid: 'clear-msg-id' })
      );

      expect(await wait).toBe('confirmed');
      expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({ ...resetFlags, lastResultWasSuccess: true });
    });
  });

  describe('session-state turn-end rows', () => {
    type StateModeRow = {
      name: string;
      result: () => SDKMessage;
      manual?: boolean;
      expectedMidFlags: FlagView;
      expectedReplay: number;
    };

    const stateModeRows: StateModeRow[] = [
      {
        name: 'success then idle event: fence on the result, finishTurn on idle with replay',
        result: () => successResult('state-success'),
        expectedMidFlags: {
          ...resetFlags,
          usesSessionStateChangedTurnEnd: true,
          expectsSessionStateIdleAfterResult: true,
          lastResultWasSuccess: true,
        },
        expectedReplay: 1,
      },
      {
        name: 'success then idle event in manual mode: finishTurn idles without replay',
        result: () => successResult('state-success-manual'),
        manual: true,
        expectedMidFlags: {
          ...resetFlags,
          usesSessionStateChangedTurnEnd: true,
          expectsSessionStateIdleAfterResult: true,
          lastResultWasSuccess: true,
        },
        expectedReplay: 0,
      },
      {
        name: 'error result then idle event: finishTurn idles without replay',
        result: () => errorResult('state-error'),
        expectedMidFlags: {
          ...resetFlags,
          usesSessionStateChangedTurnEnd: true,
          expectsSessionStateIdleAfterResult: true,
          lastResultWasSuccess: false,
        },
        expectedReplay: 0,
      },
    ];

    for (const row of stateModeRows) {
      it(row.name, async () => {
        if (row.manual) {
          mockSession.config = { ...mockSession.config, queryMode: 'manual' };
        }
        await handler.handleMessage(sessionState('running'));
        expect(readFlags(handler)).toEqual({
          ...resetFlags,
          usesSessionStateChangedTurnEnd: true,
          expectsSessionStateIdleAfterResult: true,
        });

        setIdleSpy.mockClear();
        beginTerminalIdleSpy.mockClear();
        emitSpy.mockClear();

        await handler.handleMessage(row.result());
        expect(beginTerminalIdleSpy).toHaveBeenCalledTimes(1);
        expect(setIdleSpy).not.toHaveBeenCalled();
        expect(replayCount()).toBe(0);
        expect(readFlags(handler)).toEqual(row.expectedMidFlags);

        await handler.handleMessage(sessionState('idle'));
        expect(setIdleSpy).toHaveBeenCalledTimes(1);
        expect(setIdleSpy.mock.calls[0]).toEqual([]);
        expect(replayCount()).toBe(row.expectedReplay);
        expect(readFlags(handler)).toEqual(resetFlags);
      });
    }

    it('each real non-idle session-state event only arms the expectation flags and takes no action', async () => {
      const nonIdleStates: Array<'running' | 'requires_action'> = ['running', 'requires_action'];
      for (const state of nonIdleStates) {
        handler = new SDKMessageHandler(createContext());
        await handler.handleMessage(thinkingTokensMessage(120));
        await handler.handleMessage(thinkingAssistantMessage(`stamp-${state}`));
        await handler.handleMessage(sessionState(state));

        expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
        expect(setIdleSpy).not.toHaveBeenCalled();
        expect(replayCount()).toBe(0);
        expect(readFlags(handler)).toEqual({
          ...resetFlags,
          usesSessionStateChangedTurnEnd: true,
          expectsSessionStateIdleAfterResult: true,
          currentThinkingTokensEstimate: 120,
          lastStampedThinkingTokensEstimate: 120,
        });
      }
    });

    it('an idle session-state event with no preceding result finishes the turn and resets flags', async () => {
      await handler.handleMessage(thinkingTokensMessage(120));
      await handler.handleMessage(thinkingAssistantMessage('idle-prime-stamp'));

      await handler.handleMessage(sessionState('idle'));

      expect(setIdleSpy).toHaveBeenCalledTimes(1);
      expect(setIdleSpy.mock.calls[0]).toEqual([]);
      expect(replayCount()).toBe(1);
      expect(readFlags(handler)).toEqual(resetFlags);
    });

    it('an idle session-state event with no preceding result obeys the manual no-replay gate', async () => {
      mockSession.config = { ...mockSession.config, queryMode: 'manual' };
      await handler.handleMessage(thinkingTokensMessage(120));
      await handler.handleMessage(thinkingAssistantMessage('idle-prime-stamp-manual'));

      await handler.handleMessage(sessionState('idle'));

      expect(setIdleSpy).toHaveBeenCalledTimes(1);
      expect(setIdleSpy.mock.calls[0]).toEqual([]);
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual(resetFlags);
    });

    it('consecutive non-idle events keep the expectation armed with no turn-end action', async () => {
      await handler.handleMessage(sessionState('running'));
      const armedFlags = {
        ...resetFlags,
        usesSessionStateChangedTurnEnd: true,
        expectsSessionStateIdleAfterResult: true,
      };
      expect(readFlags(handler)).toEqual(armedFlags);

      await handler.handleMessage(sessionState('requires_action'));
      expect(readFlags(handler)).toEqual(armedFlags);
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
    });

    it('a suppressed result-less idle event uses the suppressed transition and retains the clear', async () => {
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000);
      handler.markClearMessageSent();
      let settled: string | null = null;
      void wait.then((outcome) => {
        settled = outcome;
      });

      await handler.handleMessage(sessionState('idle'));

      expect(settled).toBe(null);
      expect(setIdleSpy).toHaveBeenCalledTimes(1);
      expect(setIdleSpy).toHaveBeenCalledWith({
        suppressDeliveryWaiters: true,
        suppressIdlePublish: true,
        suppressIdleCallback: true,
      });
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        suppressIdleOnNextResult: true,
        clearMessageInFlight: true,
      });

      handler.clearIdleSuppression();
      expect(await wait).toBe('reset');
    });

    it('a result-less idle event with an armed but unsent clear also uses the suppressed transition', async () => {
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000);
      let settled: string | null = null;
      void wait.then((outcome) => {
        settled = outcome;
      });

      await handler.handleMessage(sessionState('idle'));

      expect(settled).toBe(null);
      expect(setIdleSpy).toHaveBeenCalledTimes(1);
      expect(setIdleSpy).toHaveBeenCalledWith({
        suppressDeliveryWaiters: true,
        suppressIdlePublish: true,
        suppressIdleCallback: true,
      });
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({ ...resetFlags, suppressIdleOnNextResult: true });

      handler.clearIdleSuppression();
      expect(await wait).toBe('reset');
    });

    it('a result-less idle after the mode is armed still uses the suppressed transition', async () => {
      await handler.handleMessage(sessionState('running'));

      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000);
      handler.markClearMessageSent();
      let settled: string | null = null;
      void wait.then((outcome) => {
        settled = outcome;
      });

      await handler.handleMessage(sessionState('idle'));

      expect(settled).toBe(null);
      expect(setIdleSpy).toHaveBeenCalledTimes(1);
      expect(setIdleSpy).toHaveBeenCalledWith({
        suppressDeliveryWaiters: true,
        suppressIdlePublish: true,
        suppressIdleCallback: true,
      });
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        suppressIdleOnNextResult: true,
        clearMessageInFlight: true,
      });

      handler.clearIdleSuppression();
      expect(await wait).toBe('reset');
    });

    it('a suppressed confirmed result under session-state mode holds the shell retention row until idle', async () => {
      await handler.handleMessage(sessionState('running'));
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000, 'clear-msg-id');
      handler.markClearMessageSent();
      expect(readFlags(handler).clearMessageInFlight).toBe(true);

      await handler.handleMessage(
        successResult('state-clear-result', { user_message_uuid: 'clear-msg-id' })
      );
      expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        usesSessionStateChangedTurnEnd: true,
        expectsSessionStateIdleAfterResult: true,
        lastResultWasSuccess: true,
        clearAwaitingTrailingIdle: true,
        clearMessageInFlight: true,
      });

      await handler.handleMessage(thinkingTokensMessage(120));
      await handler.handleMessage(thinkingAssistantMessage('trailing-idle-prime'));
      expect(readFlags(handler).currentThinkingTokensEstimate).toBe(120);
      expect(readFlags(handler).lastStampedThinkingTokensEstimate).toBe(120);

      let settled: string | null = null;
      void wait.then((outcome) => {
        settled = outcome;
      });

      await handler.handleMessage(sessionState('idle'));
      expect(settled).toBe('confirmed');
      expect(await wait).toBe('confirmed');
      expect(setIdleSpy).toHaveBeenCalledTimes(1);
      expect(setIdleSpy).toHaveBeenCalledWith({
        suppressDeliveryWaiters: true,
        suppressIdlePublish: true,
        suppressIdleCallback: true,
      });
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual(resetFlags);
    });

    type StateCrossRow = {
      name: string;
      prime?: () => Promise<void>;
      suppress?: 'plain' | 'clearInFlight' | 'mismatch';
      result?: () => SDKMessage;
      afterBusy: FlagView;
      afterResult?: FlagView;
      sendIdleEvent: boolean;
      expectedIdle: 'plain' | 'suppressed' | 'none';
      expectedReplay: number;
      expectedWait?: 'reset';
      expectedFlags: FlagView;
      cleanupClear?: boolean;
    };

    const stateCrossRows: StateCrossRow[] = [
      {
        name: 'session-state mode with a suppressed error retains suppression past the idle event',
        suppress: 'plain',
        result: () => errorResult('state-suppressed-error'),
        afterBusy: {
          ...resetFlags,
          usesSessionStateChangedTurnEnd: true,
          expectsSessionStateIdleAfterResult: true,
        },
        afterResult: {
          ...resetFlags,
          suppressIdleOnNextResult: true,
          usesSessionStateChangedTurnEnd: true,
          expectsSessionStateIdleAfterResult: true,
          lastResultWasSuccess: false,
        },
        sendIdleEvent: true,
        expectedIdle: 'suppressed',
        expectedReplay: 0,
        expectedFlags: { ...resetFlags, suppressIdleOnNextResult: true },
      },
      {
        name: 'session-state mode with a suppressed error and clear in flight unwinds on the result',
        suppress: 'clearInFlight',
        result: () => errorResult('state-clear-error'),
        afterBusy: {
          ...resetFlags,
          usesSessionStateChangedTurnEnd: true,
          expectsSessionStateIdleAfterResult: true,
        },
        afterResult: resetFlags,
        sendIdleEvent: false,
        expectedIdle: 'none',
        expectedReplay: 0,
        expectedWait: 'reset',
        expectedFlags: resetFlags,
      },
      {
        name: 'session-state mode with a suppressed success for another turn keeps suppression armed',
        suppress: 'mismatch',
        result: () => successResult('state-mismatch', { user_message_uuid: 'unrelated-msg-id' }),
        afterBusy: {
          ...resetFlags,
          usesSessionStateChangedTurnEnd: true,
          expectsSessionStateIdleAfterResult: true,
        },
        afterResult: {
          ...resetFlags,
          suppressIdleOnNextResult: true,
          usesSessionStateChangedTurnEnd: true,
          expectsSessionStateIdleAfterResult: true,
          lastResultWasSuccess: true,
          clearMessageInFlight: true,
        },
        sendIdleEvent: true,
        expectedIdle: 'suppressed',
        expectedReplay: 0,
        expectedFlags: {
          ...resetFlags,
          suppressIdleOnNextResult: true,
          clearMessageInFlight: true,
        },
        cleanupClear: true,
        expectedWait: 'reset',
      },
      {
        name: 'session-state mode with a nested result defers everything to the idle event with replay',
        result: () => successResult('state-nested', { parent_tool_use_id: 'toolu-1' }),
        afterBusy: {
          ...resetFlags,
          usesSessionStateChangedTurnEnd: true,
          expectsSessionStateIdleAfterResult: true,
        },
        afterResult: {
          ...resetFlags,
          usesSessionStateChangedTurnEnd: true,
          expectsSessionStateIdleAfterResult: true,
        },
        sendIdleEvent: true,
        expectedIdle: 'plain',
        expectedReplay: 1,
        expectedFlags: resetFlags,
      },
      {
        name: 'session-state mode with a nested error also defers to the idle event with replay',
        result: () => errorResult('state-nested-error', { parent_tool_use_id: 'toolu-1' }),
        afterBusy: {
          ...resetFlags,
          usesSessionStateChangedTurnEnd: true,
          expectsSessionStateIdleAfterResult: true,
        },
        afterResult: {
          ...resetFlags,
          usesSessionStateChangedTurnEnd: true,
          expectsSessionStateIdleAfterResult: true,
        },
        sendIdleEvent: true,
        expectedIdle: 'plain',
        expectedReplay: 1,
        expectedFlags: resetFlags,
      },
      {
        name: 'a stale success verdict carried into session-state mode still allows replay on idle',
        prime: async () => {
          await handler.handleMessage(successResult('prime-stale-true'));
        },
        afterBusy: {
          ...resetFlags,
          usesSessionStateChangedTurnEnd: true,
          expectsSessionStateIdleAfterResult: true,
          lastResultWasSuccess: true,
        },
        sendIdleEvent: true,
        expectedIdle: 'plain',
        expectedReplay: 1,
        expectedFlags: resetFlags,
      },
      {
        name: 'a stale error verdict carried into session-state mode still blocks replay on idle',
        prime: async () => {
          await handler.handleMessage(errorResult('prime-stale-false'));
        },
        afterBusy: {
          ...resetFlags,
          usesSessionStateChangedTurnEnd: true,
          expectsSessionStateIdleAfterResult: true,
          lastResultWasSuccess: false,
        },
        sendIdleEvent: true,
        expectedIdle: 'plain',
        expectedReplay: 0,
        expectedFlags: resetFlags,
      },
    ];

    for (const row of stateCrossRows) {
      it(row.name, async () => {
        if (row.prime) {
          await row.prime();
        }
        setIdleSpy.mockClear();
        beginTerminalIdleSpy.mockClear();
        emitSpy.mockClear();

        await handler.handleMessage(sessionState('running'));
        expect(readFlags(handler)).toEqual(row.afterBusy);

        let wait: Promise<string> | null = null;
        if (row.suppress === 'plain' || row.suppress === 'mismatch') {
          handler.suppressIdleForNextResult();
        }
        if (row.suppress === 'mismatch') {
          wait = handler.waitForSuppressedResult(5_000, 'other-msg-id');
          handler.markClearMessageSent();
        }
        if (row.suppress === 'clearInFlight') {
          handler.suppressIdleForNextResult();
          wait = handler.waitForSuppressedResult(5_000);
          handler.markClearMessageSent();
        }
        let settled: string | null = null;
        if (wait !== null) {
          void wait.then((outcome) => {
            settled = outcome;
          });
        }

        if (row.result) {
          await handler.handleMessage(row.result());
          expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
          expect(setIdleSpy).not.toHaveBeenCalled();
          expect(readFlags(handler)).toEqual(row.afterResult);
          if (row.suppress === 'mismatch') {
            expect(settled).toBe(null);
          }
        }

        if (row.sendIdleEvent) {
          await handler.handleMessage(sessionState('idle'));
          if (row.expectedIdle === 'suppressed') {
            expect(setIdleSpy).toHaveBeenCalledTimes(1);
            expect(setIdleSpy).toHaveBeenCalledWith({
              suppressDeliveryWaiters: true,
              suppressIdlePublish: true,
              suppressIdleCallback: true,
            });
          }
        }
        if (row.expectedIdle === 'plain') {
          expect(setIdleSpy).toHaveBeenCalledTimes(1);
          expect(setIdleSpy.mock.calls[0]).toEqual([]);
        }
        if (row.expectedIdle === 'none') {
          expect(setIdleSpy).not.toHaveBeenCalled();
        }

        expect(replayCount()).toBe(row.expectedReplay);
        expect(readFlags(handler)).toEqual(row.expectedFlags);

        if (row.cleanupClear) {
          expect(settled).toBe(null);
          handler.clearIdleSuppression();
        }
        if (row.expectedWait !== undefined && wait !== null) {
          expect(await wait).toBe(row.expectedWait);
        }
      });
    }
  });

  describe('publication phase and failure-path boundaries', () => {
    it('legacy success: fence fires before publication, direct idle follows it, finishTurn idles last', async () => {
      const order: string[] = [];
      saveSDKMessageSpy.mockImplementation(() => {
        order.push('save');
        return true;
      });
      beginTerminalIdleSpy.mockImplementation(() => {
        order.push('fence');
      });
      publishSpy.mockImplementation((topic: string) => {
        if (topic === 'state.sdkMessages.delta') {
          order.push('delta');
        }
      });
      emitSpy.mockImplementation(async (topic: string) => {
        order.push(topic);
      });
      setIdleSpy.mockImplementation(async () => {
        order.push('setIdle');
      });

      await handler.handleMessage(successResult('ordered-success'));

      expect(order).toEqual([
        'save',
        'fence',
        'delta',
        'sdk.message',
        'setIdle',
        'session.updated',
        'session.errorClear',
        'setIdle',
        'query.trigger',
      ]);
    });

    it('session-state mode: fence fires before publication but idle is deferred to the idle event', async () => {
      const order: string[] = [];
      beginTerminalIdleSpy.mockImplementation(() => {
        order.push('fence');
      });
      publishSpy.mockImplementation((topic: string) => {
        if (topic === 'state.sdkMessages.delta') {
          order.push('delta');
        }
      });
      emitSpy.mockImplementation(async (topic: string) => {
        order.push(topic);
      });
      setIdleSpy.mockImplementation(async () => {
        order.push('setIdle');
      });

      await handler.handleMessage(sessionState('running'));
      order.length = 0;
      await handler.handleMessage(successResult('ordered-state-success'));
      expect(order).toEqual([
        'fence',
        'delta',
        'sdk.message',
        'session.updated',
        'session.errorClear',
      ]);

      order.length = 0;
      await handler.handleMessage(sessionState('idle'));
      expect(order).toEqual(['delta', 'sdk.message', 'setIdle', 'query.trigger']);
    });

    it('lastResultWasSuccess lands before the awaited effects while suppression clears only after them', async () => {
      const duringEffects: FlagView[] = [];
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'session.updated' || topic === 'session.errorClear') {
          duringEffects.push(readFlags(handler));
        }
      });
      handler.suppressIdleForNextResult();

      await handler.handleMessage(successResult('phased-suppressed-success'));

      expect(duringEffects).toHaveLength(2);
      for (const snapshot of duringEffects) {
        expect(snapshot.lastResultWasSuccess).toBe(true);
        expect(snapshot.suppressIdleOnNextResult).toBe(true);
      }
      expect(readFlags(handler)).toEqual({ ...resetFlags, lastResultWasSuccess: true });
    });

    it('sdk.message publication rejection under an armed clear unwinds every flag', async () => {
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'sdk.message') {
          throw new Error('sdk.message subscriber failed');
        }
      });
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000);
      handler.markClearMessageSent();
      expect(readFlags(handler).clearMessageInFlight).toBe(true);

      await expect(handler.handleMessage(successResult('reject-armed'))).rejects.toThrow(
        'sdk.message subscriber failed'
      );

      expect(await wait).toBe('reset');
      expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual(resetFlags);
    });

    it('sdk.message publication rejection without an armed clear leaves the intermediate flag state', async () => {
      const duringPublish: FlagView[] = [];
      await handler.handleMessage(thinkingTokensMessage(120));
      await handler.handleMessage(thinkingAssistantMessage('reject-plain-prime'));
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'sdk.message') {
          duringPublish.push(readFlags(handler));
          throw new Error('sdk.message subscriber failed');
        }
      });

      await expect(handler.handleMessage(successResult('reject-plain'))).rejects.toThrow(
        'sdk.message subscriber failed'
      );

      expect(duringPublish).toHaveLength(1);
      expect(duringPublish[0].lastResultWasSuccess).toBe(true);
      expect(duringPublish[0].currentThinkingTokensEstimate).toBe(null);
      expect(duringPublish[0].lastStampedThinkingTokensEstimate).toBe(0);
      expect(beginTerminalIdleSpy).toHaveBeenCalledTimes(1);
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({ ...resetFlags, lastResultWasSuccess: true });
    });

    it('a later-effect failure without an armed clear keeps flags and the already-fired direct idle', async () => {
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'session.errorClear') {
          throw new Error('session.errorClear subscriber failed');
        }
      });

      await expect(handler.handleMessage(successResult('effect-fail-plain'))).rejects.toThrow(
        'session.errorClear subscriber failed'
      );

      expect(setIdleSpy).toHaveBeenCalledTimes(1);
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({ ...resetFlags, lastResultWasSuccess: true });
    });

    it('a later-effect failure under an armed clear unwinds every flag after the effects saw them set', async () => {
      const duringSessionUpdated: FlagView[] = [];
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'session.updated') {
          duringSessionUpdated.push(readFlags(handler));
        }
        if (topic === 'session.errorClear') {
          throw new Error('session.errorClear subscriber failed');
        }
      });
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000);
      handler.markClearMessageSent();
      expect(readFlags(handler).clearMessageInFlight).toBe(true);

      await expect(handler.handleMessage(successResult('effect-fail-armed'))).rejects.toThrow(
        'session.errorClear subscriber failed'
      );

      expect(duringSessionUpdated).toHaveLength(1);
      expect(duringSessionUpdated[0].lastResultWasSuccess).toBe(true);
      expect(duringSessionUpdated[0].suppressIdleOnNextResult).toBe(true);
      expect(await wait).toBe('reset');
      expect(readFlags(handler)).toEqual(resetFlags);
    });

    it('session-state mode: sdk.message rejection retains the armed mode flags and never idles', async () => {
      await handler.handleMessage(sessionState('running'));
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'sdk.message') {
          throw new Error('sdk.message subscriber failed');
        }
      });

      await expect(handler.handleMessage(successResult('state-reject-plain'))).rejects.toThrow(
        'sdk.message subscriber failed'
      );

      expect(beginTerminalIdleSpy).toHaveBeenCalledTimes(1);
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        usesSessionStateChangedTurnEnd: true,
        expectsSessionStateIdleAfterResult: true,
        lastResultWasSuccess: true,
      });
    });

    it('session-state mode: sdk.message rejection under an armed clear unwinds every flag', async () => {
      await handler.handleMessage(sessionState('running'));
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000, 'clear-msg-id');
      handler.markClearMessageSent();
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'sdk.message') {
          throw new Error('sdk.message subscriber failed');
        }
      });

      await expect(
        handler.handleMessage(
          successResult('state-reject-armed', { user_message_uuid: 'clear-msg-id' })
        )
      ).rejects.toThrow('sdk.message subscriber failed');

      expect(await wait).toBe('reset');
      expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual(resetFlags);
    });

    it('session-state mode: a later-effect failure keeps the mode armed and never idles', async () => {
      await handler.handleMessage(sessionState('running'));
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'session.errorClear') {
          throw new Error('session.errorClear subscriber failed');
        }
      });

      await expect(handler.handleMessage(successResult('state-effect-fail-plain'))).rejects.toThrow(
        'session.errorClear subscriber failed'
      );

      expect(beginTerminalIdleSpy).toHaveBeenCalledTimes(1);
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        usesSessionStateChangedTurnEnd: true,
        expectsSessionStateIdleAfterResult: true,
        lastResultWasSuccess: true,
      });
    });

    it('a rejecting direct legacy setIdle stops the turn before any later effect', async () => {
      setIdleSpy.mockImplementation(async () => {
        throw new Error('setIdle transition failed');
      });

      await expect(handler.handleMessage(successResult('direct-idle-reject'))).rejects.toThrow(
        'setIdle transition failed'
      );

      expect(beginTerminalIdleSpy).toHaveBeenCalledTimes(1);
      expect(setIdleSpy).toHaveBeenCalledTimes(1);
      expect(setIdleSpy.mock.calls[0]).toEqual([]);
      expect(emitSpy.mock.calls.some((call) => call[0] === 'session.updated')).toBe(false);
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({ ...resetFlags, lastResultWasSuccess: true });
    });

    it('a rejecting finishTurn idle after the earlier effects rejects the handle with no replay', async () => {
      let idleCalls = 0;
      setIdleSpy.mockImplementation(async () => {
        idleCalls += 1;
        if (idleCalls === 2) {
          throw new Error('setIdle transition failed');
        }
      });

      await expect(handler.handleMessage(successResult('finish-idle-reject'))).rejects.toThrow(
        'setIdle transition failed'
      );

      expect(setIdleSpy).toHaveBeenCalledTimes(2);
      expect(emitSpy.mock.calls.some((call) => call[0] === 'session.errorClear')).toBe(true);
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({ ...resetFlags, lastResultWasSuccess: true });
    });

    it('a failing idle transition retains the error verdict and replay stays blocked on retry', async () => {
      await handler.handleMessage(sessionState('running'));
      await handler.handleMessage(errorResult('verdict-fail-error'));

      setIdleSpy.mockImplementation(async () => {
        throw new Error('setIdle transition failed');
      });
      await expect(handler.handleMessage(sessionState('idle'))).rejects.toThrow(
        'setIdle transition failed'
      );
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        usesSessionStateChangedTurnEnd: true,
        expectsSessionStateIdleAfterResult: true,
        lastResultWasSuccess: false,
      });

      setIdleSpy.mockImplementation(async () => {});
      await handler.handleMessage(sessionState('idle'));
      expect(setIdleSpy).toHaveBeenCalledTimes(2);
      expect(setIdleSpy.mock.calls[1]).toEqual([]);
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual(resetFlags);
    });

    it('a confirmed clear that never receives its trailing idle times out as reset via the rearmed timer', async () => {
      await handler.handleMessage(sessionState('running'));
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(25, 'clear-msg-id');
      handler.markClearMessageSent();

      await handler.handleMessage(
        successResult('trailing-idle-timeout', { user_message_uuid: 'clear-msg-id' })
      );
      expect(readFlags(handler).clearAwaitingTrailingIdle).toBe(true);

      expect(await wait).toBe('reset');
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        usesSessionStateChangedTurnEnd: true,
        expectsSessionStateIdleAfterResult: true,
        lastResultWasSuccess: true,
        clearAwaitingTrailingIdle: true,
        clearMessageInFlight: true,
      });
    });

    it('a rejected publication of an unrelated result leaves the armed clear waiting', async () => {
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000, 'clear-msg-id');
      handler.markClearMessageSent();
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'sdk.message') {
          throw new Error('sdk.message subscriber failed');
        }
      });
      let settled: string | null = null;
      void wait.then((outcome) => {
        settled = outcome;
      });

      await expect(
        handler.handleMessage(
          successResult('mismatch-publish-reject', { user_message_uuid: 'unrelated-msg-id' })
        )
      ).rejects.toThrow('sdk.message subscriber failed');

      expect(settled).toBe(null);
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        suppressIdleOnNextResult: true,
        clearMessageInFlight: true,
        lastResultWasSuccess: true,
      });

      handler.clearIdleSuppression();
      expect(await wait).toBe('reset');
    });

    it('a failed bookkeeping effect of an unrelated result leaves the armed clear waiting', async () => {
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000, 'clear-msg-id');
      handler.markClearMessageSent();
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'session.errorClear') {
          throw new Error('session.errorClear subscriber failed');
        }
      });
      let settled: string | null = null;
      void wait.then((outcome) => {
        settled = outcome;
      });

      await expect(
        handler.handleMessage(
          successResult('mismatch-effect-reject', { user_message_uuid: 'unrelated-msg-id' })
        )
      ).rejects.toThrow('session.errorClear subscriber failed');

      expect(settled).toBe(null);
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        suppressIdleOnNextResult: true,
        clearMessageInFlight: true,
        lastResultWasSuccess: true,
      });

      handler.clearIdleSuppression();
      expect(await wait).toBe('reset');
    });

    it('an armed sent clear whose error publication rejects also unwinds every flag', async () => {
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000);
      handler.markClearMessageSent();
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'sdk.message') {
          throw new Error('sdk.message subscriber failed');
        }
      });

      await expect(
        handler.handleMessage(errorResult('armed-error-publish-reject'))
      ).rejects.toThrow('sdk.message subscriber failed');

      expect(await wait).toBe('reset');
      expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual(resetFlags);
    });

    it('a failed save with a primed mode and verdict leaves them untouched and still blocks replay', async () => {
      await handler.handleMessage(errorResult('save-fail-prime-error'));
      await handler.handleMessage(sessionState('running'));
      await handler.handleMessage(thinkingTokensMessage(120));
      await handler.handleMessage(thinkingAssistantMessage('save-fail-prime-stamp'));
      const primedFlags = {
        ...resetFlags,
        usesSessionStateChangedTurnEnd: true,
        expectsSessionStateIdleAfterResult: true,
        lastResultWasSuccess: false,
        currentThinkingTokensEstimate: 120,
        lastStampedThinkingTokensEstimate: 120,
      };
      expect(readFlags(handler)).toEqual(primedFlags);
      setIdleSpy.mockClear();
      beginTerminalIdleSpy.mockClear();

      saveSDKMessageSpy.mockReturnValueOnce(false);
      await handler.handleMessage(successResult('save-fail-primed'));

      expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(readFlags(handler)).toEqual(primedFlags);

      await handler.handleMessage(sessionState('idle'));
      expect(setIdleSpy).toHaveBeenCalledTimes(1);
      expect(setIdleSpy.mock.calls[0]).toEqual([]);
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual(resetFlags);
    });

    it('a rejected publication of the first non-idle event leaves the mode flags unset', async () => {
      await handler.handleMessage(thinkingTokensMessage(120));
      await handler.handleMessage(thinkingAssistantMessage('nonidle-pub-reject-prime'));
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'sdk.message') {
          throw new Error('sdk.message subscriber failed');
        }
      });

      await expect(handler.handleMessage(sessionState('running'))).rejects.toThrow(
        'sdk.message subscriber failed'
      );

      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        currentThinkingTokensEstimate: 120,
        lastStampedThinkingTokensEstimate: 120,
      });
    });

    it('a failing suppressed result-less idle after the mode is armed retains every flag', async () => {
      await handler.handleMessage(sessionState('running'));
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000);
      handler.markClearMessageSent();
      setIdleSpy.mockImplementation(async () => {
        throw new Error('setIdle transition failed');
      });
      let settled: string | null = null;
      void wait.then((outcome) => {
        settled = outcome;
      });

      await expect(handler.handleMessage(sessionState('idle'))).rejects.toThrow(
        'setIdle transition failed'
      );

      expect(settled).toBe(null);
      expect(setIdleSpy).toHaveBeenCalledWith({
        suppressDeliveryWaiters: true,
        suppressIdlePublish: true,
        suppressIdleCallback: true,
      });
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        suppressIdleOnNextResult: true,
        usesSessionStateChangedTurnEnd: true,
        expectsSessionStateIdleAfterResult: true,
        clearMessageInFlight: true,
      });

      handler.clearIdleSuppression();
      expect(await wait).toBe('reset');
    });

    it('an intercepted limit result still resets both thinking counters before its early return', async () => {
      handler = new SDKMessageHandler(
        createContext({ onResultLimitError: mock(async () => true) })
      );
      await handler.handleMessage(thinkingTokensMessage(120));
      await handler.handleMessage(thinkingAssistantMessage('limit-prime-stamp'));

      await handler.handleMessage(
        successResult('limit-intercepted', {
          is_error: true,
          result: 'Usage limit reached. Your limit resets at 12:00 UTC.',
          terminal_reason: 'blocking_limit',
        })
      );

      expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({ ...resetFlags, lastResultWasSuccess: false });
    });

    it('a failed save under an armed clear unwinds the suppression without any idle action', async () => {
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000);
      handler.markClearMessageSent();
      saveSDKMessageSpy.mockReturnValueOnce(false);

      await handler.handleMessage(successResult('save-fail-armed'));

      expect(await wait).toBe('reset');
      expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual(resetFlags);
    });

    it('session-state mode: a later-effect failure under an armed clear unwinds every flag', async () => {
      await handler.handleMessage(sessionState('running'));
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000, 'clear-msg-id');
      handler.markClearMessageSent();
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'session.errorClear') {
          throw new Error('session.errorClear subscriber failed');
        }
      });

      await expect(
        handler.handleMessage(
          successResult('state-effect-fail-armed', { user_message_uuid: 'clear-msg-id' })
        )
      ).rejects.toThrow('session.errorClear subscriber failed');

      expect(await wait).toBe('reset');
      expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual(resetFlags);
    });

    it('a legacy error result whose publication rejects keeps the false verdict and never idles', async () => {
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'sdk.message') {
          throw new Error('sdk.message subscriber failed');
        }
      });

      await expect(handler.handleMessage(errorResult('legacy-error-reject'))).rejects.toThrow(
        'sdk.message subscriber failed'
      );

      expect(beginTerminalIdleSpy).toHaveBeenCalledTimes(1);
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({ ...resetFlags, lastResultWasSuccess: false });
    });

    it('a state-mode error result whose publication rejects keeps the false verdict and blocks replay on idle', async () => {
      await handler.handleMessage(sessionState('running'));
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'sdk.message') {
          throw new Error('sdk.message subscriber failed');
        }
      });

      await expect(handler.handleMessage(errorResult('state-error-reject'))).rejects.toThrow(
        'sdk.message subscriber failed'
      );
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        usesSessionStateChangedTurnEnd: true,
        expectsSessionStateIdleAfterResult: true,
        lastResultWasSuccess: false,
      });

      emitSpy.mockImplementation(async () => {});
      await handler.handleMessage(sessionState('idle'));
      expect(setIdleSpy).toHaveBeenCalledTimes(1);
      expect(setIdleSpy.mock.calls[0]).toEqual([]);
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual(resetFlags);
    });

    it('a rejected publication of the idle event itself keeps every flag and both thinking counters', async () => {
      await handler.handleMessage(sessionState('running'));
      await handler.handleMessage(successResult('idle-reject-preceding'));
      await handler.handleMessage(thinkingTokensMessage(120));
      await handler.handleMessage(thinkingAssistantMessage('idle-reject-prime'));
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'sdk.message') {
          throw new Error('sdk.message subscriber failed');
        }
      });

      await expect(handler.handleMessage(sessionState('idle'))).rejects.toThrow(
        'sdk.message subscriber failed'
      );

      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        usesSessionStateChangedTurnEnd: true,
        expectsSessionStateIdleAfterResult: true,
        lastResultWasSuccess: true,
        currentThinkingTokensEstimate: 120,
        lastStampedThinkingTokensEstimate: 120,
      });
    });

    it('a failing setIdle during the idle event keeps the mode flags while the thinking reset already ran', async () => {
      await handler.handleMessage(sessionState('running'));
      await handler.handleMessage(successResult('setidle-fail-preceding'));
      await handler.handleMessage(thinkingTokensMessage(120));
      await handler.handleMessage(thinkingAssistantMessage('setidle-fail-prime'));
      setIdleSpy.mockImplementation(async () => {
        throw new Error('setIdle transition failed');
      });

      await expect(handler.handleMessage(sessionState('idle'))).rejects.toThrow(
        'setIdle transition failed'
      );

      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        usesSessionStateChangedTurnEnd: true,
        expectsSessionStateIdleAfterResult: true,
        lastResultWasSuccess: true,
      });
    });

    it('a failing suppressed setIdle during the trailing idle keeps the clear bookkeeping armed', async () => {
      await handler.handleMessage(sessionState('running'));
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000, 'clear-msg-id');
      handler.markClearMessageSent();
      await handler.handleMessage(
        successResult('suppressed-setidle-fail', { user_message_uuid: 'clear-msg-id' })
      );
      expect(readFlags(handler).clearAwaitingTrailingIdle).toBe(true);

      setIdleSpy.mockImplementation(async () => {
        throw new Error('setIdle transition failed');
      });
      let settled: string | null = null;
      void wait.then((outcome) => {
        settled = outcome;
      });

      await expect(handler.handleMessage(sessionState('idle'))).rejects.toThrow(
        'setIdle transition failed'
      );

      expect(settled).toBe(null);
      expect(setIdleSpy).toHaveBeenCalledWith({
        suppressDeliveryWaiters: true,
        suppressIdlePublish: true,
        suppressIdleCallback: true,
      });
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        usesSessionStateChangedTurnEnd: true,
        expectsSessionStateIdleAfterResult: true,
        lastResultWasSuccess: true,
        clearAwaitingTrailingIdle: true,
        clearMessageInFlight: true,
      });

      handler.clearIdleSuppression();
      expect(await wait).toBe('reset');
    });

    it('a rejected query.trigger publication does not fail the legacy turn transition', async () => {
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'query.trigger') {
          throw new Error('query.trigger subscriber failed');
        }
      });

      await handler.handleMessage(successResult('replay-reject-legacy'));

      expect(setIdleSpy).toHaveBeenCalledTimes(2);
      expect(setIdleSpy.mock.calls).toEqual([[], []]);
      expect(replayCount()).toBe(1);
      expect(readFlags(handler)).toEqual({ ...resetFlags, lastResultWasSuccess: true });
    });

    it('a rejected query.trigger publication does not fail the session-state turn transition', async () => {
      await handler.handleMessage(sessionState('running'));
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'query.trigger') {
          throw new Error('query.trigger subscriber failed');
        }
      });

      await handler.handleMessage(sessionState('idle'));

      expect(setIdleSpy).toHaveBeenCalledTimes(1);
      expect(setIdleSpy.mock.calls[0]).toEqual([]);
      expect(replayCount()).toBe(1);
      expect(readFlags(handler)).toEqual(resetFlags);
    });

    it('a failing setIdle on a first idle event retains the mode flag without the expectation', async () => {
      await handler.handleMessage(thinkingTokensMessage(120));
      await handler.handleMessage(thinkingAssistantMessage('first-idle-fail-prime'));
      setIdleSpy.mockImplementation(async () => {
        throw new Error('setIdle transition failed');
      });

      await expect(handler.handleMessage(sessionState('idle'))).rejects.toThrow(
        'setIdle transition failed'
      );

      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({ ...resetFlags, usesSessionStateChangedTurnEnd: true });

      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000, 'clear-msg-id');
      handler.markClearMessageSent();

      await handler.handleMessage(
        successResult('mode-only-clear-confirm', { user_message_uuid: 'clear-msg-id' })
      );

      expect(await wait).toBe('confirmed');
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        usesSessionStateChangedTurnEnd: true,
        lastResultWasSuccess: true,
      });
    });

    it('a failing suppressed setIdle on a result-less idle retains the armed clear', async () => {
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000);
      handler.markClearMessageSent();
      setIdleSpy.mockImplementation(async () => {
        throw new Error('setIdle transition failed');
      });
      let settled: string | null = null;
      void wait.then((outcome) => {
        settled = outcome;
      });

      await expect(handler.handleMessage(sessionState('idle'))).rejects.toThrow(
        'setIdle transition failed'
      );

      expect(settled).toBe(null);
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        suppressIdleOnNextResult: true,
        usesSessionStateChangedTurnEnd: true,
        clearMessageInFlight: true,
      });

      handler.clearIdleSuppression();
      expect(await wait).toBe('reset');
    });

    it('a rejected publication of a first idle event leaves flags and thinking counters untouched', async () => {
      await handler.handleMessage(thinkingTokensMessage(120));
      await handler.handleMessage(thinkingAssistantMessage('idle-pub-reject-prime'));
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'sdk.message') {
          throw new Error('sdk.message subscriber failed');
        }
      });

      await expect(handler.handleMessage(sessionState('idle'))).rejects.toThrow(
        'sdk.message subscriber failed'
      );

      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        currentThinkingTokensEstimate: 120,
        lastStampedThinkingTokensEstimate: 120,
      });
    });

    it('a rejected idle-event publication under an armed clear retains the clear untouched', async () => {
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000);
      handler.markClearMessageSent();
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'sdk.message') {
          throw new Error('sdk.message subscriber failed');
        }
      });
      let settled: string | null = null;
      void wait.then((outcome) => {
        settled = outcome;
      });

      await expect(handler.handleMessage(sessionState('idle'))).rejects.toThrow(
        'sdk.message subscriber failed'
      );

      expect(settled).toBe(null);
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        suppressIdleOnNextResult: true,
        clearMessageInFlight: true,
      });

      handler.clearIdleSuppression();
      expect(await wait).toBe('reset');
    });

    it('a rejecting metadata publication under an armed clear unwinds every flag', async () => {
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000);
      handler.markClearMessageSent();
      emitSpy.mockImplementation(async (topic: string) => {
        if (topic === 'session.updated') {
          throw new Error('session.updated subscriber failed');
        }
      });

      await expect(handler.handleMessage(successResult('metadata-fail-armed'))).rejects.toThrow(
        'session.updated subscriber failed'
      );

      expect(await wait).toBe('reset');
      expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual(resetFlags);
    });

    it('a failed save of a matching error result under a sent clear unwinds the suppression', async () => {
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000);
      handler.markClearMessageSent();
      saveSDKMessageSpy.mockReturnValueOnce(false);

      await handler.handleMessage(errorResult('save-fail-clear-error'));

      expect(await wait).toBe('reset');
      expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual(resetFlags);
    });

    it('a failed save of a mismatched success retains the armed clear', async () => {
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000, 'other-msg-id');
      handler.markClearMessageSent();
      saveSDKMessageSpy.mockReturnValueOnce(false);
      let settled: string | null = null;
      void wait.then((outcome) => {
        settled = outcome;
      });

      await handler.handleMessage(
        successResult('save-fail-mismatch', { user_message_uuid: 'unrelated-msg-id' })
      );

      expect(settled).toBe(null);
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        suppressIdleOnNextResult: true,
        clearMessageInFlight: true,
      });

      handler.clearIdleSuppression();
      expect(await wait).toBe('reset');
    });

    it('a failed save of a nested result during an armed clear leaves the clear untouched', async () => {
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000);
      handler.markClearMessageSent();
      saveSDKMessageSpy.mockReturnValueOnce(false);
      let settled: string | null = null;
      void wait.then((outcome) => {
        settled = outcome;
      });

      await handler.handleMessage(
        successResult('save-fail-nested', { parent_tool_use_id: 'toolu-1' })
      );

      expect(settled).toBe(null);
      expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        suppressIdleOnNextResult: true,
        clearMessageInFlight: true,
      });

      handler.clearIdleSuppression();
      expect(await wait).toBe('reset');
    });
  });

  describe('thinking-token reset action', () => {
    type ThinkingRow = {
      name: string;
      messages: () => Promise<void>;
      expectedFlags: FlagView;
    };

    const thinkingRows: ThinkingRow[] = [
      {
        name: 'a top-level result resets both the live estimate and the stamped counter',
        messages: async () => {
          await handler.handleMessage(thinkingTokensMessage(120));
          await handler.handleMessage(thinkingAssistantMessage('thinking-stamp-result'));
          await handler.handleMessage(successResult('thinking-reset'));
        },
        expectedFlags: { ...resetFlags, lastResultWasSuccess: true },
      },
      {
        name: 'a top-level error result also resets both thinking counters',
        messages: async () => {
          await handler.handleMessage(thinkingTokensMessage(120));
          await handler.handleMessage(thinkingAssistantMessage('thinking-stamp-error'));
          await handler.handleMessage(errorResult('thinking-error-reset'));
        },
        expectedFlags: { ...resetFlags, lastResultWasSuccess: false },
      },
      {
        name: 'a nested result retains both the live estimate and the stamped counter',
        messages: async () => {
          await handler.handleMessage(thinkingTokensMessage(120));
          await handler.handleMessage(thinkingAssistantMessage('thinking-stamp-nested'));
          await handler.handleMessage(
            successResult('thinking-nested', { parent_tool_use_id: 'toolu-1' })
          );
        },
        expectedFlags: {
          ...resetFlags,
          currentThinkingTokensEstimate: 120,
          lastStampedThinkingTokensEstimate: 120,
        },
      },
      {
        name: 'a nested error result also retains both thinking counters',
        messages: async () => {
          await handler.handleMessage(thinkingTokensMessage(120));
          await handler.handleMessage(thinkingAssistantMessage('thinking-stamp-nested-error'));
          await handler.handleMessage(
            errorResult('thinking-nested-error', { parent_tool_use_id: 'toolu-1' })
          );
        },
        expectedFlags: {
          ...resetFlags,
          currentThinkingTokensEstimate: 120,
          lastStampedThinkingTokensEstimate: 120,
        },
      },
      {
        name: 'a non-idle session-state event retains both counters while an idle event resets them',
        messages: async () => {
          await handler.handleMessage(thinkingTokensMessage(120));
          await handler.handleMessage(thinkingAssistantMessage('thinking-stamp-state'));
          await handler.handleMessage(sessionState('running'));
          await handler.handleMessage(sessionState('idle'));
        },
        expectedFlags: resetFlags,
      },
    ];

    for (const row of thinkingRows) {
      it(row.name, async () => {
        await row.messages();
        expect(readFlags(handler)).toEqual(row.expectedFlags);
      });
    }
  });

  describe('stale lastResultWasSuccess window (characterization)', () => {
    it('legacy mode keeps the stale error verdict across non-result messages until the next result', async () => {
      await handler.handleMessage(errorResult('stale-error'));
      expect(readFlags(handler).lastResultWasSuccess).toBe(false);

      await handler.handleMessage(assistantMessage('stale-assistant'));
      expect(readFlags(handler).lastResultWasSuccess).toBe(false);

      await handler.handleMessage(successResult('stale-success'));
      expect(readFlags(handler).lastResultWasSuccess).toBe(true);
    });

    it('session-state mode clears the verdict to null on the idle event and keeps it null after', async () => {
      await handler.handleMessage(sessionState('running'));
      await handler.handleMessage(errorResult('state-stale-error'));
      expect(readFlags(handler).lastResultWasSuccess).toBe(false);

      await handler.handleMessage(sessionState('idle'));
      expect(readFlags(handler).lastResultWasSuccess).toBe(null);

      await handler.handleMessage(assistantMessage('post-idle-assistant'));
      expect(readFlags(handler).lastResultWasSuccess).toBe(null);
    });

    it('a stale error verdict with no expectation armed still blocks replay on a direct idle event', async () => {
      await handler.handleMessage(errorResult('direct-idle-stale-error'));
      expect(setIdleSpy).toHaveBeenCalledTimes(1);

      await handler.handleMessage(sessionState('idle'));

      expect(setIdleSpy).toHaveBeenCalledTimes(2);
      expect(setIdleSpy.mock.calls[1]).toEqual([]);
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual(resetFlags);
    });
  });
});
