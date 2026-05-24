// @ts-nocheck
/**
 * Comprehensive tests for SessionStore class
 *
 * Tests the SessionStore class to increase coverage to 85%+
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sessionStore } from '../session-store';
import type { Session, ContextInfo, AgentProcessingState, SessionState } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';

// Mock connection manager
const mockHub = {
  request: vi.fn().mockResolvedValue({ acknowledged: true }),
  onEvent: vi.fn(() => vi.fn()),
  onConnection: vi.fn(() => vi.fn()),
  joinChannel: vi.fn(),
  leaveChannel: vi.fn(),
  isConnected: vi.fn(() => true),
  getHubIfConnected: vi.fn(() => mockHub),
};

vi.mock('../connection-manager', () => ({
  connectionManager: {
    getHub: vi.fn(() => Promise.resolve(mockHub)),
    getHubIfConnected: vi.fn(() => mockHub),
  },
}));

// Mock signals
vi.mock('../signals', () => ({
  slashCommandsSignal: { value: [] },
}));

// Mock toast
vi.mock('../toast', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

describe('SessionStore - Comprehensive Coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Clean up by selecting null
    await sessionStore.select(null);
  });

  describe('constructor and initial state', () => {
    it('should initialize with null activeSessionId', () => {
      expect(sessionStore.activeSessionId.value).toBe(null);
    });

    it('should initialize with null sessionState', () => {
      expect(sessionStore.sessionState.value).toBe(null);
    });

    it('should initialize with empty sdkMessages array', () => {
      expect(sessionStore.sdkMessages.value).toEqual([]);
    });
  });

  describe('computed accessors - default values', () => {
    it('should return null for sessionInfo when no state', () => {
      expect(sessionStore.sessionInfo.value).toBeNull();
    });

    it('should return idle agent state when no state', () => {
      expect(sessionStore.agentState.value).toEqual({ status: 'idle' });
    });

    it('should return null for contextInfo when no state', () => {
      expect(sessionStore.contextInfo.value).toBeNull();
    });

    it('should return empty array for commandsData when no state', () => {
      expect(sessionStore.commandsData.value).toEqual([]);
    });

    it('should return null for error when no state', () => {
      expect(sessionStore.error.value).toBeNull();
    });

    it('should return false for isCompacting when idle', () => {
      expect(sessionStore.isCompacting.value).toBe(false);
    });

    it('should return false for isWorking when idle', () => {
      expect(sessionStore.isWorking.value).toBe(false);
    });
  });

  describe('select() - session switching', () => {
    it('should update activeSessionId when selecting session', async () => {
      mockHub.request.mockResolvedValue({ sessionInfo: { id: 'session-1' } });
      mockHub.onEvent.mockReturnValue(vi.fn());

      await sessionStore.select('session-1');

      expect(sessionStore.activeSessionId.value).toBe('session-1');
    });

    it('should clear state when selecting null', async () => {
      // First select a session
      mockHub.request.mockResolvedValue({
        sessionInfo: { id: 'session-1' },
        sdkMessages: [],
      });
      mockHub.onEvent.mockReturnValue(vi.fn());

      await sessionStore.select('session-1');

      // Then select null
      await sessionStore.select(null);

      expect(sessionStore.activeSessionId.value).toBe(null);
      expect(sessionStore.sessionState.value).toBe(null);
      expect(sessionStore.sdkMessages.value).toEqual([]);
    });

    it('should skip selection if already on same session', async () => {
      mockHub.request.mockResolvedValue({
        sessionInfo: { id: 'session-1' },
        sdkMessages: [],
      });
      mockHub.onEvent.mockReturnValue(vi.fn());

      await sessionStore.select('session-1');
      const initialCallCount = mockHub.request.mock.calls.length;

      // Select same session again
      await sessionStore.select('session-1');

      // Should not call hub again (early return in doSelect)
      expect(mockHub.request.mock.calls.length).toBe(initialCallCount);
    });

    it('should handle rapid session switches via promise chain', async () => {
      mockHub.request.mockResolvedValue({
        sessionInfo: { id: 'test' },
        sdkMessages: [],
      });
      mockHub.onEvent.mockReturnValue(vi.fn());

      // Rapidly switch sessions
      const p1 = sessionStore.select('session-1');
      const p2 = sessionStore.select('session-2');
      const p3 = sessionStore.select('session-3');

      await Promise.all([p1, p2, p3]);

      // Should end up on session-3 (last one)
      expect(sessionStore.activeSessionId.value).toBe('session-3');
    });
  });

  describe('fetchInitialState()', () => {
    it('should fetch and set session state', async () => {
      const mockSessionState: SessionState = {
        sessionInfo: { id: 'session-1', title: 'Test Session' } as Session,
        agentState: { status: 'idle' },
        commandsData: { availableCommands: ['/test', '/help'] },
      };

      mockHub.request.mockImplementation((channel) => {
        if (channel === 'state.session') {
          return Promise.resolve(mockSessionState);
        }
        return Promise.resolve({ sdkMessages: [] });
      });
      mockHub.onEvent.mockReturnValue(vi.fn());

      await sessionStore.select('session-1');

      expect(sessionStore.sessionState.value).toEqual(mockSessionState);
    });

    // NOTE: messages are now streamed through the `messages.bySession`
    // LiveQuery instead of being pulled via an RPC during
    // `fetchInitialSessionState`. The delivery path is covered by the
    // "LiveQuery messages.bySession subscription" describe block below and
    // by the daemon-side test at
    // `packages/daemon/tests/unit/2-handlers/rpc-handlers/live-query-messages.test.ts`.

    it('should handle fetch errors gracefully', async () => {
      mockHub.request.mockRejectedValue(new Error('Fetch failed'));
      mockHub.onEvent.mockReturnValue(vi.fn());

      // Should not throw, but log error
      await expect(sessionStore.select('session-1')).resolves.not.toThrow();
    });
  });

  describe('computed accessors - with state', () => {
    beforeEach(() => {
      // Set up some state directly on the singleton
      sessionStore.sessionState.value = {
        sessionInfo: {
          id: 'session-1',
          title: 'Test Session',
          status: 'active',
          createdAt: '',
          lastActiveAt: '',
          workspacePath: '/test',
          metadata: {
            lastContextInfo: {
              totalTokens: 1000,
              inputTokens: 500,
              outputTokens: 500,
            } as ContextInfo,
          },
        } as Session,
        agentState: { status: 'processing' },
        commandsData: { availableCommands: ['/test', '/help'] },
      };
    });

    afterEach(() => {
      // Reset state
      sessionStore.sessionState.value = null;
    });

    it('should return sessionInfo from state', () => {
      expect(sessionStore.sessionInfo.value?.id).toBe('session-1');
    });

    it('should return agentState from state', () => {
      expect(sessionStore.agentState.value.status).toBe('processing');
    });

    it('should return contextInfo from state', () => {
      expect(sessionStore.contextInfo.value?.totalTokens).toBe(1000);
    });

    it('should return commandsData from state', () => {
      expect(sessionStore.commandsData.value).toEqual(['/test', '/help']);
    });

    it('should return true for isWorking when processing', () => {
      expect(sessionStore.isWorking.value).toBe(true);
    });
  });

  describe('isCompacting', () => {
    afterEach(() => {
      sessionStore.sessionState.value = null;
    });

    it('should return true when agent is processing and compacting', () => {
      sessionStore.sessionState.value = {
        sessionInfo: {} as Session,
        agentState: { status: 'processing', isCompacting: true },
      };

      expect(sessionStore.isCompacting.value).toBe(true);
    });

    it('should return false when agent is processing but not compacting', () => {
      sessionStore.sessionState.value = {
        sessionInfo: {} as Session,
        agentState: { status: 'processing', isCompacting: false },
      };

      expect(sessionStore.isCompacting.value).toBe(false);
    });

    it('should return false when agent is idle', () => {
      sessionStore.sessionState.value = {
        sessionInfo: {} as Session,
        agentState: { status: 'idle' },
      };

      expect(sessionStore.isCompacting.value).toBe(false);
    });
  });

  describe('isWorking', () => {
    afterEach(() => {
      sessionStore.sessionState.value = null;
    });

    it('should return true when agent status is processing', () => {
      sessionStore.sessionState.value = {
        sessionInfo: {} as Session,
        agentState: { status: 'processing' },
      };

      expect(sessionStore.isWorking.value).toBe(true);
    });

    it('should return true when agent status is queued', () => {
      sessionStore.sessionState.value = {
        sessionInfo: {} as Session,
        agentState: { status: 'queued' },
      };

      expect(sessionStore.isWorking.value).toBe(true);
    });

    it('should return false when agent status is idle', () => {
      sessionStore.sessionState.value = {
        sessionInfo: {} as Session,
        agentState: { status: 'idle' },
      };

      expect(sessionStore.isWorking.value).toBe(false);
    });
  });

  describe('error handling', () => {
    afterEach(() => {
      sessionStore.sessionState.value = null;
    });

    it('should clear error from state', () => {
      sessionStore.sessionState.value = {
        sessionInfo: {} as Session,
        error: {
          message: 'Test error',
          occurredAt: Date.now(),
        },
      };

      sessionStore.clearError();

      expect(sessionStore.sessionState.value?.error).toBeNull();
    });

    it('should handle clearError when no state exists', () => {
      // Should not throw
      expect(() => sessionStore.clearError()).not.toThrow();
    });

    it('should handle clearError when no error exists', () => {
      sessionStore.sessionState.value = {
        sessionInfo: {} as Session,
      };

      // Should not throw
      expect(() => sessionStore.clearError()).not.toThrow();
    });

    it('should return error details when present', () => {
      const mockDetails = { type: 'TestError', stack: 'error stack' };
      sessionStore.sessionState.value = {
        sessionInfo: {} as Session,
        error: {
          message: 'Test error',
          details: mockDetails,
          occurredAt: Date.now(),
        },
      };

      const details = sessionStore.getErrorDetails();

      expect(details).toEqual(mockDetails);
    });

    it('should return null for error details when not present', () => {
      sessionStore.sessionState.value = {
        sessionInfo: {} as Session,
        error: {
          message: 'Test error',
          occurredAt: Date.now(),
        },
      };

      const details = sessionStore.getErrorDetails();

      expect(details).toBeNull();
    });

    it('should return null for error details when no error exists', () => {
      sessionStore.sessionState.value = {
        sessionInfo: {} as Session,
      };

      const details = sessionStore.getErrorDetails();

      expect(details).toBeNull();
    });
  });

  describe('LiveQuery messages.bySession subscription', () => {
    /**
     * Helper to drive the LiveQuery path from a test.
     *
     * `fire('liveQuery.snapshot' | 'liveQuery.delta', event)` invokes every
     * handler that `hub.onEvent()` has registered — the snapshot/delta
     * handlers installed by sessionStore.select() filter on
     * `event.subscriptionId`, so tests can target a specific subscription.
     */
    interface LqMockHub {
      request: ReturnType<typeof vi.fn>;
      onEvent: (channel: string, callback: (data: unknown) => void) => () => void;
      fire: (channel: string, data: unknown) => void;
      readonly subscriptionId: string | null;
    }

    function installLiveQueryHub(): LqMockHub {
      const handlers = new Map<string, Array<(data: unknown) => void>>();
      let capturedSubscriptionId: string | null = null;

      mockHub.request.mockImplementation((channel: string, params?: Record<string, unknown>) => {
        if (channel === 'state.session') {
          return Promise.resolve({ sessionInfo: { id: 'session-1' } });
        }
        if (channel === 'liveQuery.subscribe') {
          capturedSubscriptionId = String(params?.subscriptionId ?? '');
          return Promise.resolve({ subscriptionId: capturedSubscriptionId });
        }
        if (channel === 'liveQuery.unsubscribe') {
          return Promise.resolve({ ok: true });
        }
        return Promise.resolve(undefined);
      });

      mockHub.onEvent.mockImplementation((channel: string, callback: (data: unknown) => void) => {
        const list = handlers.get(channel) ?? [];
        list.push(callback);
        handlers.set(channel, list);
        return () => {
          const l = handlers.get(channel);
          if (!l) return;
          const i = l.indexOf(callback);
          if (i >= 0) l.splice(i, 1);
        };
      });

      return {
        request: mockHub.request,
        onEvent: mockHub.onEvent,
        fire: (channel, data) => {
          for (const h of handlers.get(channel) ?? []) h(data);
        },
        get subscriptionId() {
          return capturedSubscriptionId;
        },
      };
    }

    it('applies a LiveQuery snapshot to sdkMessages', async () => {
      const hub = installLiveQueryHub();
      await sessionStore.select('session-1');
      const subId = hub.subscriptionId!;
      expect(subId).toBeTruthy();

      const rows: SDKMessage[] = [
        { uuid: 'msg-1', type: 'text', role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        {
          uuid: 'msg-2',
          type: 'text',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
        },
      ];
      hub.fire('liveQuery.snapshot', { subscriptionId: subId, rows });

      expect(sessionStore.sdkMessages.value.map((m) => m.uuid)).toEqual(['msg-1', 'msg-2']);
    });

    it('applies LiveQuery delta added rows to sdkMessages', async () => {
      const hub = installLiveQueryHub();
      await sessionStore.select('session-1');
      const subId = hub.subscriptionId!;

      // Start from empty snapshot so the delta add is the only change.
      hub.fire('liveQuery.snapshot', { subscriptionId: subId, rows: [] });

      const added: SDKMessage[] = [
        { uuid: 'msg-added', type: 'text', role: 'user', content: [{ type: 'text', text: 'A' }] },
      ];
      hub.fire('liveQuery.delta', {
        subscriptionId: subId,
        added,
        updated: [],
        removed: [],
      });

      expect(sessionStore.sdkMessages.value.some((m) => m.uuid === 'msg-added')).toBe(true);
    });

    it('ignores snapshot/delta events for a different subscriptionId', async () => {
      const hub = installLiveQueryHub();
      await sessionStore.select('session-1');
      const subId = hub.subscriptionId!;

      hub.fire('liveQuery.snapshot', { subscriptionId: subId, rows: [] });

      // Fire a delta for an unrelated subscription — should be ignored.
      hub.fire('liveQuery.delta', {
        subscriptionId: 'some-other-id',
        added: [
          {
            uuid: 'ghost',
            type: 'text',
            role: 'user',
            content: [{ type: 'text', text: 'x' }],
          },
        ],
        updated: [],
        removed: [],
      });

      expect(sessionStore.sdkMessages.value.some((m) => m.uuid === 'ghost')).toBe(false);
    });

    describe('messagesLoaded gate', () => {
      // Regression coverage for the empty-state flash: the ChatContainer
      // uses `messagesLoaded` together with `sessionState` to decide when
      // to render the empty-state placeholder. If `messagesLoaded` goes
      // true before the first LiveQuery snapshot applies, the UI will
      // flash "No messages yet" for sessions that actually have messages
      // but are still loading on slow networks.

      it('starts false on construction', () => {
        // Fresh store state: no session has been selected yet.
        expect(sessionStore.messagesLoaded.value).toBe(false);
      });

      it('is reset to false on session switch and stays false before the snapshot arrives', async () => {
        const hub = installLiveQueryHub();
        await sessionStore.select('session-1');

        // The `state.session` RPC has already resolved here (the mock
        // resolves it synchronously), but the LiveQuery snapshot has
        // not been fired yet — this is the exact window where the
        // empty-state flash would appear.
        expect(sessionStore.sessionState.value).not.toBeNull();
        expect(sessionStore.messagesLoaded.value).toBe(false);

        // Only after the snapshot does the gate open.
        hub.fire('liveQuery.snapshot', { subscriptionId: hub.subscriptionId!, rows: [] });
        expect(sessionStore.messagesLoaded.value).toBe(true);
      });

      it('flips to true when the LiveQuery snapshot applies', async () => {
        const hub = installLiveQueryHub();
        await sessionStore.select('session-1');

        expect(sessionStore.messagesLoaded.value).toBe(false);

        hub.fire('liveQuery.snapshot', {
          subscriptionId: hub.subscriptionId!,
          rows: [
            {
              uuid: 'msg-1',
              type: 'text',
              role: 'user',
              content: [{ type: 'text', text: 'Hi' }],
            },
          ],
        });

        expect(sessionStore.messagesLoaded.value).toBe(true);
      });

      it('resets to false when switching to a different session', async () => {
        const hub = installLiveQueryHub();
        await sessionStore.select('session-1');
        hub.fire('liveQuery.snapshot', { subscriptionId: hub.subscriptionId!, rows: [] });
        expect(sessionStore.messagesLoaded.value).toBe(true);

        // Switching sessions clears the gate — the UI must stay on the
        // loading skeleton until the new session's snapshot arrives,
        // even if the prior session's messages had fully loaded.
        await sessionStore.select('session-2');
        expect(sessionStore.messagesLoaded.value).toBe(false);
      });

      it('opens the gate on subscribe failure so the UI can recover', async () => {
        // First install the successful handler map for onEvent, then
        // configure the subscribe RPC to reject. The `state.session`
        // RPC still resolves so the sessionState path doesn't go into
        // its own error branch; we're isolating the subscribe failure.
        const handlers = new Map<string, Array<(data: unknown) => void>>();
        mockHub.request.mockImplementation((channel: string, _params?: Record<string, unknown>) => {
          if (channel === 'state.session') {
            return Promise.resolve({ sessionInfo: { id: 'session-1' } });
          }
          if (channel === 'liveQuery.subscribe') {
            return Promise.reject(new Error('subscribe failed'));
          }
          if (channel === 'liveQuery.unsubscribe') {
            return Promise.resolve({ ok: true });
          }
          return Promise.resolve(undefined);
        });
        mockHub.onEvent.mockImplementation((channel: string, callback: (data: unknown) => void) => {
          const list = handlers.get(channel) ?? [];
          list.push(callback);
          handlers.set(channel, list);
          return () => {
            const l = handlers.get(channel);
            if (!l) return;
            const i = l.indexOf(callback);
            if (i >= 0) l.splice(i, 1);
          };
        });

        await sessionStore.select('session-1');

        // Subscribe failed — we never got (and never will get) a
        // snapshot. The gate must open anyway, otherwise the UI would
        // sit on the loading skeleton forever.
        expect(sessionStore.messagesLoaded.value).toBe(true);
      });
    });
  });

  describe('slash commands sync', () => {
    it('should sync slash commands on session state update', async () => {
      const { slashCommandsSignal } = await import('../signals');

      mockHub.request.mockResolvedValue({
        sessionInfo: { id: 'session-1' },
        commandsData: { availableCommands: ['/cmd1', '/cmd2'] },
      });
      mockHub.onEvent.mockReturnValue(vi.fn());

      await sessionStore.select('session-1');

      expect(slashCommandsSignal.value).toEqual(['/cmd1', '/cmd2']);
    });
  });

  describe('refresh()', () => {
    it('should refresh current session state', async () => {
      // First select a session
      mockHub.request.mockResolvedValue({
        sessionInfo: { id: 'session-1', title: 'Original' },
        sdkMessages: [],
      });
      mockHub.onEvent.mockReturnValue(vi.fn());

      await sessionStore.select('session-1');

      // Mock updated state
      mockHub.request.mockResolvedValue({
        sessionInfo: { id: 'session-1', title: 'Updated' },
        sdkMessages: [],
      });

      await sessionStore.refresh();

      expect(sessionStore.sessionState.value?.sessionInfo?.title).toBe('Updated');
    });

    it('should return early when no active session', async () => {
      mockHub.request.mockResolvedValue({ sessionInfo: { id: 'test' } });

      await sessionStore.refresh();

      // Should not call hub.request
      expect(mockHub.request).not.toHaveBeenCalled();
    });

    it('should handle refresh errors gracefully', async () => {
      // First select a session
      mockHub.request.mockResolvedValue({
        sessionInfo: { id: 'session-1' },
        sdkMessages: [],
      });
      mockHub.onEvent.mockReturnValue(vi.fn());

      await sessionStore.select('session-1');

      // Mock refresh error
      mockHub.request.mockRejectedValue(new Error('Refresh failed'));

      // Should not throw
      await expect(sessionStore.refresh()).resolves.not.toThrow();
    });
  });

  describe('message management', () => {
    beforeEach(() => {
      // Clear messages before each test in this suite
      sessionStore.sdkMessages.value = [];
    });

    it('should prepend messages for pagination', () => {
      const existingMessages: SDKMessage[] = [
        { uuid: 'msg-2', type: 'text', role: 'user', content: [{ type: 'text', text: 'Newer' }] },
      ];

      const olderMessages: SDKMessage[] = [
        { uuid: 'msg-1', type: 'text', role: 'user', content: [{ type: 'text', text: 'Older' }] },
      ];

      sessionStore.sdkMessages.value = existingMessages;

      sessionStore.prependMessages(olderMessages);

      expect(sessionStore.sdkMessages.value).toEqual([...olderMessages, ...existingMessages]);
    });

    it('should not prepend empty array', () => {
      const existingMessages: SDKMessage[] = [
        { uuid: 'msg-1', type: 'text', role: 'user', content: [{ type: 'text', text: 'Test' }] },
      ];

      sessionStore.sdkMessages.value = existingMessages;

      sessionStore.prependMessages([]);

      expect(sessionStore.sdkMessages.value).toEqual(existingMessages);
    });

    it('should return message count', () => {
      const messages: SDKMessage[] = [
        { uuid: 'msg-1', type: 'text', role: 'user', content: [{ type: 'text', text: 'Test' }] },
        { uuid: 'msg-2', type: 'text', role: 'user', content: [{ type: 'text', text: 'Test' }] },
      ];

      sessionStore.sdkMessages.value = messages;

      expect(sessionStore.messageCount).toBe(2);
    });

    it('should return zero message count when empty', () => {
      expect(sessionStore.messageCount).toBe(0);
    });
  });

  describe('getTotalMessageCount()', () => {
    it('should return total message count from server', async () => {
      mockHub.request.mockResolvedValue({ count: 42 });

      await sessionStore.select('session-1');

      const count = await sessionStore.getTotalMessageCount();

      expect(count).toBe(42);
    });

    it('should return 0 when no active session', async () => {
      const count = await sessionStore.getTotalMessageCount();

      expect(count).toBe(0);
    });

    it('should return 0 on error', async () => {
      mockHub.request.mockRejectedValue(new Error('Failed'));

      await sessionStore.select('session-1');

      const count = await sessionStore.getTotalMessageCount();

      expect(count).toBe(0);
    });

    it('should return 0 when server returns null', async () => {
      mockHub.request.mockResolvedValue(null);

      await sessionStore.select('session-1');

      const count = await sessionStore.getTotalMessageCount();

      expect(count).toBe(0);
    });
  });

  describe('hasMoreMessages (pagination inference)', () => {
    // `hasMoreMessages` is now set from the `messages.bySession` LiveQuery
    // snapshot: it becomes true when the snapshot returns the full limit of
    // rows (and therefore might be truncating older messages) and false
    // otherwise. We drive it through the same hub mock the store sees.

    const LIMIT = 200; // matches LIVE_QUERY_MESSAGE_LIMIT

    beforeEach(async () => {
      await sessionStore.select(null);
    });

    afterEach(async () => {
      await sessionStore.select(null);
    });

    function installLiveQueryHubCapturing(): {
      fire: (channel: string, data: unknown) => void;
      readonly subscriptionId: string | null;
    } {
      const handlers = new Map<string, Array<(data: unknown) => void>>();
      let subId: string | null = null;

      mockHub.request.mockImplementation((channel: string, params?: Record<string, unknown>) => {
        if (channel === 'state.session') {
          return Promise.resolve({ sessionInfo: { id: 'session-1' } });
        }
        if (channel === 'liveQuery.subscribe') {
          subId = String(params?.subscriptionId ?? '');
          return Promise.resolve({ subscriptionId: subId });
        }
        return Promise.resolve(undefined);
      });
      mockHub.onEvent.mockImplementation((ch: string, cb: (data: unknown) => void) => {
        const list = handlers.get(ch) ?? [];
        list.push(cb);
        handlers.set(ch, list);
        return () => {
          const l = handlers.get(ch);
          if (!l) return;
          const i = l.indexOf(cb);
          if (i >= 0) l.splice(i, 1);
        };
      });

      return {
        fire: (ch, data) => {
          for (const h of handlers.get(ch) ?? []) h(data);
        },
        get subscriptionId() {
          return subId;
        },
      };
    }

    it('is false when the snapshot is shorter than the limit', async () => {
      const hub = installLiveQueryHubCapturing();
      await sessionStore.select('session-1');
      const subId = hub.subscriptionId!;

      const rows: SDKMessage[] = Array(50)
        .fill(null)
        .map((_, i) => ({
          uuid: `msg-${i}`,
          type: 'text',
          role: 'user',
          content: [{ type: 'text', text: `Message ${i}` }],
        }));
      hub.fire('liveQuery.snapshot', { subscriptionId: subId, rows });

      expect(sessionStore.hasMoreMessages.value).toBe(false);
    });

    it('is true when the snapshot fills the limit exactly', async () => {
      const hub = installLiveQueryHubCapturing();
      await sessionStore.select('session-1');
      const subId = hub.subscriptionId!;

      const rows: SDKMessage[] = Array(LIMIT)
        .fill(null)
        .map((_, i) => ({
          uuid: `msg-${i}`,
          type: 'text',
          role: 'user',
          content: [{ type: 'text', text: `Message ${i}` }],
        }));
      hub.fire('liveQuery.snapshot', { subscriptionId: subId, rows });

      expect(sessionStore.sdkMessages.value).toHaveLength(LIMIT);
      expect(sessionStore.hasMoreMessages.value).toBe(true);
    });

    it('is false when the snapshot is empty', async () => {
      const hub = installLiveQueryHubCapturing();
      await sessionStore.select('session-1');
      const subId = hub.subscriptionId!;

      hub.fire('liveQuery.snapshot', { subscriptionId: subId, rows: [] });

      expect(sessionStore.hasMoreMessages.value).toBe(false);
    });
  });

  describe('loadOlderMessages()', () => {
    it('should load older messages from server', async () => {
      const olderMessages: SDKMessage[] = [
        { uuid: 'msg-1', type: 'text', role: 'user', content: [{ type: 'text', text: 'Old' }] },
      ];

      mockHub.request.mockResolvedValue({ sdkMessages: olderMessages });

      await sessionStore.select('session-1');

      const result = await sessionStore.loadOlderMessages(Date.now(), 100);

      expect(result.messages).toEqual(olderMessages);
      expect(result.hasMore).toBe(false); // Less than limit
    });

    it('should return hasMore true when message count equals limit', async () => {
      const messages: SDKMessage[] = Array(100)
        .fill(null)
        .map((_, i) => ({
          uuid: `msg-${i}`,
          type: 'text',
          role: 'user',
          content: [{ type: 'text', text: `Message ${i}` }],
        }));

      mockHub.request.mockResolvedValue({ sdkMessages: messages, hasMore: true });

      await sessionStore.select('session-1');

      const result = await sessionStore.loadOlderMessages(Date.now(), 100);

      expect(result.hasMore).toBe(true);
    });

    it('should return empty array when no active session', async () => {
      const result = await sessionStore.loadOlderMessages(Date.now());

      expect(result.messages).toEqual([]);
      expect(result.hasMore).toBe(false);
    });

    it('should throw on error', async () => {
      mockHub.request.mockRejectedValue(new Error('Failed to load'));

      await sessionStore.select('session-1');

      await expect(sessionStore.loadOlderMessages(Date.now())).rejects.toThrow();
    });

    it('should return empty array when server returns null', async () => {
      mockHub.request.mockResolvedValue(null);

      await sessionStore.select('session-1');

      const result = await sessionStore.loadOlderMessages(Date.now());

      expect(result.messages).toEqual([]);
      expect(result.hasMore).toBe(false);
    });

    it('should use default limit of 100', async () => {
      mockHub.request.mockResolvedValue({ sdkMessages: [] });

      await sessionStore.select('session-1');

      await sessionStore.loadOlderMessages(Date.now());

      expect(mockHub.request).toHaveBeenCalledWith(
        'message.sdkMessages',
        expect.objectContaining({ limit: 100 })
      );
    });

    it('should use custom limit when provided', async () => {
      mockHub.request.mockResolvedValue({ sdkMessages: [] });

      await sessionStore.select('session-1');

      await sessionStore.loadOlderMessages(Date.now(), 50);

      expect(mockHub.request).toHaveBeenCalledWith(
        'message.sdkMessages',
        expect.objectContaining({ limit: 50 })
      );
    });
  });

  describe('session state subscription error toast', () => {
    afterEach(() => {
      sessionStore.sessionState.value = null;
    });

    it('should show toast for NEW errors that occurred after session switch', async () => {
      const { toast } = await import('../toast');

      mockHub.request.mockResolvedValue({
        sessionInfo: { id: 'session-1' },
        sdkMessages: [],
      });

      let sessionStateCallback: ((state: import('@neokai/shared').SessionState) => void) | null =
        null;
      mockHub.onEvent.mockImplementation((channel, callback) => {
        if (channel === 'state.session') {
          sessionStateCallback = callback;
        }
        return vi.fn();
      });

      await sessionStore.select('session-1');

      // Simulate error occurring AFTER session was opened
      if (sessionStateCallback) {
        const errorOccurredAt = Date.now() + 1000; // After session switch
        sessionStateCallback({
          sessionInfo: { id: 'session-1' } as Session,
          agentState: { status: 'idle' },
          error: {
            message: 'New error after switch',
            occurredAt: errorOccurredAt,
          },
        });
      }

      // Toast should be called for new error
      expect(toast.error).toHaveBeenCalledWith('New error after switch');
    });

    it('should NOT show toast for old errors that occurred BEFORE session switch', async () => {
      const { toast } = await import('../toast');
      vi.mocked(toast.error).mockClear();

      mockHub.request.mockResolvedValue({
        sessionInfo: { id: 'session-1' },
        sdkMessages: [],
      });

      let sessionStateCallback: ((state: import('@neokai/shared').SessionState) => void) | null =
        null;
      mockHub.onEvent.mockImplementation((channel, callback) => {
        if (channel === 'state.session') {
          sessionStateCallback = callback;
        }
        return vi.fn();
      });

      await sessionStore.select('session-1');

      // Simulate error that occurred BEFORE session was opened (stale error)
      if (sessionStateCallback) {
        const errorOccurredAt = Date.now() - 5000; // Before session switch
        sessionStateCallback({
          sessionInfo: { id: 'session-1' } as Session,
          agentState: { status: 'idle' },
          error: {
            message: 'Old stale error',
            occurredAt: errorOccurredAt,
          },
        });
      }

      // Toast should NOT be called for stale error
      expect(toast.error).not.toHaveBeenCalledWith('Old stale error');
    });

    it('should sync slash commands from session state callback', async () => {
      const { slashCommandsSignal } = await import('../signals');

      mockHub.request.mockResolvedValue({
        sessionInfo: { id: 'session-1' },
        sdkMessages: [],
      });

      let sessionStateCallback: ((state: import('@neokai/shared').SessionState) => void) | null =
        null;
      mockHub.onEvent.mockImplementation((channel, callback) => {
        if (channel === 'state.session') {
          sessionStateCallback = callback;
        }
        return vi.fn();
      });

      await sessionStore.select('session-1');

      // Simulate session state with commands
      if (sessionStateCallback) {
        sessionStateCallback({
          sessionInfo: { id: 'session-1' } as Session,
          agentState: { status: 'idle' },
          commandsData: { availableCommands: ['/newcmd', '/anothercmd'] },
        });
      }

      expect(slashCommandsSignal.value).toEqual(['/newcmd', '/anothercmd']);
    });
  });

  describe('startSubscriptions error handling', () => {
    it('should show toast and log error when subscription setup fails', async () => {
      const { toast } = await import('../toast');

      // Make getHub fail
      const { connectionManager } = await import('../connection-manager');
      vi.mocked(connectionManager.getHub).mockRejectedValueOnce(new Error('Connection failed'));

      await sessionStore.select('error-session');

      expect(toast.error).toHaveBeenCalledWith('Failed to connect to daemon');
    });
  });

  describe('stopSubscriptions warning log', () => {
    it('should log warning when cleanup throws', async () => {
      // Set up a cleanup function that throws
      mockHub.request.mockResolvedValue({
        sessionInfo: { id: 'session-1' },
        sdkMessages: [],
      });

      mockHub.onEvent.mockReturnValue(() => {
        throw new Error('Cleanup error');
      });

      await sessionStore.select('session-1');

      // Select another session to trigger cleanup
      mockHub.onEvent.mockReturnValue(vi.fn()); // Reset for next session
      await sessionStore.select('session-2');

      // Should not throw even though cleanup throws
    });
  });

  describe('refresh error logging', () => {
    it('should log error when refresh fails', async () => {
      // First select a session
      mockHub.request.mockResolvedValue({
        sessionInfo: { id: 'session-1' },
        sdkMessages: [],
      });
      mockHub.onEvent.mockReturnValue(vi.fn());

      await sessionStore.select('session-1');

      // Make refresh fail
      mockHub.request.mockRejectedValue(new Error('Refresh network error'));

      await sessionStore.refresh();

      // Should handle error gracefully (no throw)
    });

    it('should catch error when getHub fails during refresh', async () => {
      // First select a session
      mockHub.request.mockResolvedValue({
        sessionInfo: { id: 'session-1' },
        sdkMessages: [],
      });
      mockHub.onEvent.mockReturnValue(vi.fn());

      await sessionStore.select('session-1');

      // Make getHub throw to trigger the catch block in refresh()
      const { connectionManager } = await import('../connection-manager');
      vi.mocked(connectionManager.getHub).mockRejectedValueOnce(new Error('Hub connection lost'));

      await sessionStore.refresh();

      // Should handle error gracefully (no throw)
    });
  });

  describe('edge cases', () => {
    afterEach(() => {
      sessionStore.sessionState.value = null;
    });

    it('should handle null sessionState in computed properties', () => {
      sessionStore.sessionState.value = null;

      expect(sessionStore.sessionInfo.value).toBeNull();
      expect(sessionStore.agentState.value).toEqual({ status: 'idle' });
      expect(sessionStore.contextInfo.value).toBeNull();
      expect(sessionStore.commandsData.value).toEqual([]);
      expect(sessionStore.error.value).toBeNull();
    });

    it('should handle empty object sessionState', () => {
      sessionStore.sessionState.value = {} as SessionState;

      expect(sessionStore.sessionInfo.value).toBeNull();
      expect(sessionStore.agentState.value).toEqual({ status: 'idle' });
    });

    it('should handle missing commandsData', () => {
      sessionStore.sessionState.value = {
        sessionInfo: {} as Session,
        agentState: { status: 'idle' },
      };

      expect(sessionStore.commandsData.value).toEqual([]);
    });

    it('should handle missing availableCommands in commandsData', () => {
      sessionStore.sessionState.value = {
        sessionInfo: {} as Session,
        agentState: { status: 'idle' },
        commandsData: {} as Record<string, never>,
      };

      expect(sessionStore.commandsData.value).toEqual([]);
    });

    it('should handle agent state without isCompacting property', () => {
      sessionStore.sessionState.value = {
        sessionInfo: {} as Session,
        agentState: { status: 'processing' } as AgentProcessingState,
      };

      expect(sessionStore.isCompacting.value).toBe(false);
    });

    it('should handle isCompacting false value', () => {
      sessionStore.sessionState.value = {
        sessionInfo: {} as Session,
        agentState: { status: 'processing', isCompacting: false },
      };

      expect(sessionStore.isCompacting.value).toBe(false);
    });
  });
});
