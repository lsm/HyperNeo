// @ts-nocheck

import { signal } from '@preact/signals';
import type { SessionState, AgentProcessingState } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';

class TestSessionStore {
  readonly activeSessionId = signal<string | null>(null);
  readonly sessionState = signal<SessionState | null>(null);
  readonly sdkMessages = signal<SDKMessage[]>([]);

  get sessionInfo() {
    return this.sessionState.value?.sessionInfo || null;
  }

  get agentState(): AgentProcessingState {
    return this.sessionState.value?.agentState || { status: 'idle' };
  }

  get contextInfo() {
    return this.sessionState.value?.sessionInfo?.metadata?.lastContextInfo || null;
  }

  get commandsData(): string[] {
    return this.sessionState.value?.commandsData?.availableCommands || [];
  }

  get error() {
    return this.sessionState.value?.error || null;
  }

  get isCompacting(): boolean {
    const state = this.agentState;
    return state.status === 'processing' && 'isCompacting' in state && state.isCompacting === true;
  }

  get isWorking(): boolean {
    const state = this.agentState;
    return state.status === 'processing' || state.status === 'queued';
  }

  private sessionSwitchTime = 0;

  async select(sessionId: string | null): Promise<void> {
    if (this.activeSessionId.value === sessionId) {
      return;
    }

    this.sessionState.value = null;
    this.sdkMessages.value = [];
    this.sessionSwitchTime = Date.now();
    this.activeSessionId.value = sessionId;
  }

  clearError(): void {
    if (this.sessionState.value?.error) {
      this.sessionState.value = {
        ...this.sessionState.value,
        error: null,
      };
    }
  }

  prependMessages(messages: SDKMessage[]): void {
    if (messages.length === 0) return;
    this.sdkMessages.value = [...messages, ...this.sdkMessages.value];
  }

  get messageCount(): number {
    return this.sdkMessages.value.length;
  }

  getSessionSwitchTime(): number {
    return this.sessionSwitchTime;
  }
}

describe('SessionStore', () => {
  let store: TestSessionStore;

  beforeEach(() => {
    store = new TestSessionStore();
  });

  describe('Initial State', () => {
    it('should start with null activeSessionId', () => {
      expect(store.activeSessionId.value).toBeNull();
    });

    it('should start with null sessionState', () => {
      expect(store.sessionState.value).toBeNull();
    });

    it('should start with empty sdkMessages', () => {
      expect(store.sdkMessages.value).toEqual([]);
    });
  });

  describe('Computed Accessors', () => {
    it('sessionInfo should return null when sessionState is null', () => {
      expect(store.sessionInfo).toBeNull();
    });

    it('sessionInfo should return sessionInfo from sessionState', () => {
      store.sessionState.value = {
        sessionInfo: {
          id: 'test-session',
          title: 'Test Session',
          status: 'active',
        } as import('@hyperneo/shared').Session,
        agentState: { status: 'idle' },

        commandsData: null,
        error: null,
      };
      expect(store.sessionInfo?.id).toBe('test-session');
    });

    it('agentState should default to idle when sessionState is null', () => {
      expect(store.agentState).toEqual({ status: 'idle' });
    });

    it('agentState should return agentState from sessionState', () => {
      store.sessionState.value = {
        sessionInfo: null as unknown as import('@hyperneo/shared').Session,
        agentState: { status: 'processing', phase: 'thinking' },

        commandsData: null,
        error: null,
      };
      expect(store.agentState).toEqual({
        status: 'processing',
        phase: 'thinking',
      });
    });

    it('contextInfo should return null when sessionState is null', () => {
      expect(store.contextInfo).toBeNull();
    });

    it('commandsData should return empty array when sessionState is null', () => {
      expect(store.commandsData).toEqual([]);
    });

    it('commandsData should return availableCommands', () => {
      store.sessionState.value = {
        sessionInfo: null as unknown as import('@hyperneo/shared').Session,
        agentState: { status: 'idle' },

        commandsData: { availableCommands: ['/help', '/clear', '/reset'] },
        error: null,
      };
      expect(store.commandsData).toEqual(['/help', '/clear', '/reset']);
    });

    it('error should return null when sessionState is null', () => {
      expect(store.error).toBeNull();
    });

    it('error should return error from sessionState', () => {
      const errorInfo = {
        message: 'Test error',
        occurredAt: Date.now(),
      };
      store.sessionState.value = {
        sessionInfo: null as unknown as import('@hyperneo/shared').Session,
        agentState: { status: 'idle' },

        commandsData: null,
        error: errorInfo,
      };
      expect(store.error).toEqual(errorInfo);
    });
  });

  describe('isCompacting', () => {
    it('should return false when status is idle', () => {
      store.sessionState.value = {
        sessionInfo: null as unknown as import('@hyperneo/shared').Session,
        agentState: { status: 'idle' },

        commandsData: null,
        error: null,
      };
      expect(store.isCompacting).toBe(false);
    });

    it('should return false when processing but not compacting', () => {
      store.sessionState.value = {
        sessionInfo: null as unknown as import('@hyperneo/shared').Session,
        agentState: { status: 'processing', phase: 'thinking' },

        commandsData: null,
        error: null,
      };
      expect(store.isCompacting).toBe(false);
    });

    it('should return true when processing and compacting', () => {
      store.sessionState.value = {
        sessionInfo: null as unknown as import('@hyperneo/shared').Session,
        agentState: {
          status: 'processing',
          phase: 'finalizing',
          isCompacting: true,
        },

        commandsData: null,
        error: null,
      };
      expect(store.isCompacting).toBe(true);
    });
  });

  describe('isWorking', () => {
    it('should return false when idle', () => {
      store.sessionState.value = {
        sessionInfo: null as unknown as import('@hyperneo/shared').Session,
        agentState: { status: 'idle' },

        commandsData: null,
        error: null,
      };
      expect(store.isWorking).toBe(false);
    });

    it('should return true when processing', () => {
      store.sessionState.value = {
        sessionInfo: null as unknown as import('@hyperneo/shared').Session,
        agentState: { status: 'processing', phase: 'thinking' },

        commandsData: null,
        error: null,
      };
      expect(store.isWorking).toBe(true);
    });

    it('should return true when queued', () => {
      store.sessionState.value = {
        sessionInfo: null as unknown as import('@hyperneo/shared').Session,
        agentState: { status: 'queued' },

        commandsData: null,
        error: null,
      };
      expect(store.isWorking).toBe(true);
    });

    it('should return false when interrupted', () => {
      store.sessionState.value = {
        sessionInfo: null as unknown as import('@hyperneo/shared').Session,
        agentState: { status: 'interrupted' },

        commandsData: null,
        error: null,
      };
      expect(store.isWorking).toBe(false);
    });
  });

  describe('select', () => {
    it('should update activeSessionId', async () => {
      await store.select('test-session-1');
      expect(store.activeSessionId.value).toBe('test-session-1');
    });

    it('should clear sessionState on select', async () => {
      store.sessionState.value = {
        sessionInfo: { id: 'old' } as import('@hyperneo/shared').Session,
        agentState: { status: 'idle' },

        commandsData: null,
        error: null,
      };
      await store.select('new-session');
      expect(store.sessionState.value).toBeNull();
    });

    it('should clear sdkMessages on select', async () => {
      store.sdkMessages.value = [{ type: 'assistant', uuid: '1' } as SDKMessage];
      await store.select('new-session');
      expect(store.sdkMessages.value).toEqual([]);
    });

    it('should update sessionSwitchTime on select', async () => {
      const before = Date.now();
      await store.select('new-session');
      const after = Date.now();
      expect(store.getSessionSwitchTime()).toBeGreaterThanOrEqual(before);
      expect(store.getSessionSwitchTime()).toBeLessThanOrEqual(after);
    });

    it('should skip if selecting same session', async () => {
      await store.select('same-session');
      const firstSwitchTime = store.getSessionSwitchTime();

      await new Promise((resolve) => setTimeout(resolve, 10));

      await store.select('same-session');
      expect(store.getSessionSwitchTime()).toBe(firstSwitchTime);
    });

    it('should handle null session selection', async () => {
      await store.select('test-session');
      await store.select(null);
      expect(store.activeSessionId.value).toBeNull();
    });
  });

  describe('clearError', () => {
    it('should clear error from sessionState', () => {
      store.sessionState.value = {
        sessionInfo: { id: 'test' } as import('@hyperneo/shared').Session,
        agentState: { status: 'idle' },

        commandsData: null,
        error: { message: 'Test error', occurredAt: Date.now() },
      };
      store.clearError();
      expect(store.error).toBeNull();
    });

    it('should not throw when sessionState is null', () => {
      expect(() => store.clearError()).not.toThrow();
    });

    it('should not throw when error is already null', () => {
      store.sessionState.value = {
        sessionInfo: { id: 'test' } as import('@hyperneo/shared').Session,
        agentState: { status: 'idle' },

        commandsData: null,
        error: null,
      };
      expect(() => store.clearError()).not.toThrow();
    });
  });

  describe('prependMessages', () => {
    it('should prepend messages to existing messages', () => {
      store.sdkMessages.value = [{ type: 'assistant', uuid: 'c' } as SDKMessage];
      store.prependMessages([
        { type: 'user', uuid: 'a' } as SDKMessage,
        { type: 'assistant', uuid: 'b' } as SDKMessage,
      ]);

      expect(store.sdkMessages.value).toHaveLength(3);
      expect(store.sdkMessages.value[0].uuid).toBe('a');
      expect(store.sdkMessages.value[1].uuid).toBe('b');
      expect(store.sdkMessages.value[2].uuid).toBe('c');
    });

    it('should not change messages when prepending empty array', () => {
      store.sdkMessages.value = [{ type: 'assistant', uuid: 'a' } as SDKMessage];
      store.prependMessages([]);
      expect(store.sdkMessages.value).toHaveLength(1);
    });

    it('should work on empty messages array', () => {
      store.prependMessages([{ type: 'user', uuid: 'a' } as SDKMessage]);
      expect(store.sdkMessages.value).toHaveLength(1);
    });
  });

  describe('messageCount', () => {
    it('should return 0 for empty messages', () => {
      expect(store.messageCount).toBe(0);
    });

    it('should return correct count', () => {
      store.sdkMessages.value = [
        { type: 'user', uuid: 'a' } as SDKMessage,
        { type: 'assistant', uuid: 'b' } as SDKMessage,
      ];
      expect(store.messageCount).toBe(2);
    });
  });
});
