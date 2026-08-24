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

function errorResult(uuid: string): SDKMessage {
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
  } as unknown as SDKMessage;
}

function sessionState(state: 'busy' | 'idle'): SDKMessage {
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

    const mockContext: SDKMessageHandlerContext = {
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
    };

    handler = new SDKMessageHandler(mockContext);
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
        await handler.handleMessage(sessionState('busy'));
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
        expect(replayCount()).toBe(row.expectedReplay);
        expect(readFlags(handler)).toEqual(resetFlags);
      });
    }

    it('a non-idle session-state event only arms the expectation flags and takes no action', async () => {
      await handler.handleMessage(thinkingTokensMessage(120));
      await handler.handleMessage(sessionState('busy'));

      expect(beginTerminalIdleSpy).not.toHaveBeenCalled();
      expect(setIdleSpy).not.toHaveBeenCalled();
      expect(replayCount()).toBe(0);
      expect(readFlags(handler)).toEqual({
        ...resetFlags,
        usesSessionStateChangedTurnEnd: true,
        expectsSessionStateIdleAfterResult: true,
        currentThinkingTokensEstimate: 120,
      });
    });

    it('an idle session-state event with no preceding result finishes the turn and resets flags', async () => {
      await handler.handleMessage(sessionState('idle'));

      expect(setIdleSpy).toHaveBeenCalledTimes(1);
      expect(replayCount()).toBe(1);
      expect(readFlags(handler)).toEqual(resetFlags);
    });

    it('a suppressed confirmed result under session-state mode holds the shell retention row until idle', async () => {
      await handler.handleMessage(sessionState('busy'));
      handler.suppressIdleForNextResult();
      const wait = handler.waitForSuppressedResult(5_000, 'clear-msg-id');

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
      });

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

      await handler.handleMessage(sessionState('busy'));
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

      await expect(handler.handleMessage(successResult('effect-fail-armed'))).rejects.toThrow(
        'session.errorClear subscriber failed'
      );

      expect(duringSessionUpdated).toHaveLength(1);
      expect(duringSessionUpdated[0].lastResultWasSuccess).toBe(true);
      expect(duringSessionUpdated[0].suppressIdleOnNextResult).toBe(true);
      expect(await wait).toBe('reset');
      expect(readFlags(handler)).toEqual(resetFlags);
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
        name: 'a top-level result resets the thinking estimate',
        messages: async () => {
          await handler.handleMessage(thinkingTokensMessage(120));
          await handler.handleMessage(successResult('thinking-reset'));
        },
        expectedFlags: { ...resetFlags, lastResultWasSuccess: true },
      },
      {
        name: 'a nested result retains the thinking estimate',
        messages: async () => {
          await handler.handleMessage(thinkingTokensMessage(120));
          await handler.handleMessage(
            successResult('thinking-nested', { parent_tool_use_id: 'toolu-1' })
          );
        },
        expectedFlags: { ...resetFlags, currentThinkingTokensEstimate: 120 },
      },
      {
        name: 'a non-idle session-state event retains the estimate while an idle event resets it',
        messages: async () => {
          await handler.handleMessage(thinkingTokensMessage(120));
          await handler.handleMessage(sessionState('busy'));
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
      await handler.handleMessage(sessionState('busy'));
      await handler.handleMessage(errorResult('state-stale-error'));
      expect(readFlags(handler).lastResultWasSuccess).toBe(false);

      await handler.handleMessage(sessionState('idle'));
      expect(readFlags(handler).lastResultWasSuccess).toBe(null);

      await handler.handleMessage(assistantMessage('post-idle-assistant'));
      expect(readFlags(handler).lastResultWasSuccess).toBe(null);
    });
  });
});
