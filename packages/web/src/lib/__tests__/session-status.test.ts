// @ts-nocheck

import type { AgentProcessingState, Session } from '@hyperneo/shared';
import type { Signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createMockLocalStorage = () => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    _store: () => store,
  };
};

const mockLocalStorage = createMockLocalStorage();
const originalLocalStorage = globalThis.localStorage;

let mockSessions: Signal<Session[]>;
let mockCurrentSessionIdSignal: Signal<string | null>;

describe('session-status (real module tests)', () => {
  beforeEach(() => {
    globalThis.localStorage = mockLocalStorage as unknown as Storage;
    mockLocalStorage.clear();
    vi.clearAllMocks();

    const { signal } = require('@preact/signals');
    mockSessions = signal<Session[]>([]);
    mockCurrentSessionIdSignal = signal<string | null>(null);
  });

  afterEach(() => {
    globalThis.localStorage = originalLocalStorage;
    vi.resetModules();
  });

  const createMockSession = (id: string, overrides: Partial<Session> = {}): Session => ({
    id,
    title: `Session ${id}`,
    workspacePath: `/path/to/${id}`,
    status: 'active',
    config: {} as Session['config'],
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
    createdAt: '2024-01-01T00:00:00Z',
    lastActiveAt: '2024-01-01T00:00:00Z',
    processingState: undefined,
    ...overrides,
  });

  describe('allSessionStatuses computed signal', () => {
    it('should return empty map when no sessions', async () => {
      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const { allSessionStatuses } = await import('../session-status.js');

      expect(allSessionStatuses.value.size).toBe(0);
    });

    it('should compute processing state from session object', async () => {
      mockSessions.value = [
        createMockSession('sess-1', {
          processingState: JSON.stringify({ status: 'processing', phase: 'thinking' }),
        }),
      ];

      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const { allSessionStatuses } = await import('../session-status.js');

      const status = allSessionStatuses.value.get('sess-1');
      expect(status?.processingState).toEqual({ status: 'processing', phase: 'thinking' });
    });

    it('should compute unreadCount correctly', async () => {
      mockSessions.value = [
        createMockSession('sess-1', {
          metadata: {
            messageCount: 10,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalCost: 0,
            toolCallCount: 0,
          },
        }),
        createMockSession('sess-2', {
          metadata: {
            messageCount: 5,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalCost: 0,
            toolCallCount: 0,
          },
        }),
      ];

      mockLocalStorage.setItem('kai:session-last-seen', JSON.stringify({ 'sess-1': 5 }));

      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const module = await import('../session-status.js');
      const { allSessionStatuses } = module;

      module.initSessionStatusTracking();

      expect(allSessionStatuses.value.get('sess-1')?.unreadCount).toBe(5);
      expect(allSessionStatuses.value.get('sess-2')?.unreadCount).toBe(5);
    });

    it('should mark current session as read regardless of message count', async () => {
      mockSessions.value = [
        createMockSession('sess-1', {
          metadata: {
            messageCount: 100,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalCost: 0,
            toolCallCount: 0,
          },
        }),
      ];
      mockCurrentSessionIdSignal.value = 'sess-1';

      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const { allSessionStatuses } = await import('../session-status.js');

      expect(allSessionStatuses.value.get('sess-1')?.unreadCount).toBe(0);
    });

    it('should handle object processingState', async () => {
      const processingState: AgentProcessingState = { status: 'queued', messageId: 'msg-1' };
      mockSessions.value = [createMockSession('sess-1', { processingState })];

      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const { allSessionStatuses } = await import('../session-status.js');

      expect(allSessionStatuses.value.get('sess-1')?.processingState).toEqual({
        status: 'queued',
        messageId: 'msg-1',
      });
    });

    it('should default to idle when processingState is undefined', async () => {
      mockSessions.value = [createMockSession('sess-1')];

      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const { allSessionStatuses } = await import('../session-status.js');

      expect(allSessionStatuses.value.get('sess-1')?.processingState).toEqual({ status: 'idle' });
    });
  });

  describe('initSessionStatusTracking', () => {
    it('should load last seen counts from localStorage', async () => {
      mockLocalStorage.setItem(
        'kai:session-last-seen',
        JSON.stringify({ 'sess-1': 5, 'sess-2': 10 })
      );

      mockSessions.value = [
        createMockSession('sess-1', {
          metadata: {
            messageCount: 10,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalCost: 0,
            toolCallCount: 0,
          },
        }),
        createMockSession('sess-2', {
          metadata: {
            messageCount: 15,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalCost: 0,
            toolCallCount: 0,
          },
        }),
      ];

      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const module = await import('../session-status.js');
      module.initSessionStatusTracking();

      expect(module.allSessionStatuses.value.get('sess-1')?.unreadCount).toBe(5);
      expect(module.allSessionStatuses.value.get('sess-2')?.unreadCount).toBe(5);
    });

    it('should subscribe to currentSessionIdSignal changes', async () => {
      mockSessions.value = [
        createMockSession('sess-1', {
          metadata: {
            messageCount: 20,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalCost: 0,
            toolCallCount: 0,
          },
        }),
      ];

      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const module = await import('../session-status.js');
      module.initSessionStatusTracking();

      expect(module.allSessionStatuses.value.get('sess-1')?.unreadCount).toBe(20);

      mockCurrentSessionIdSignal.value = 'sess-1';

      expect(module.allSessionStatuses.value.get('sess-1')?.unreadCount).toBe(0);
    });
  });

  describe('parseProcessingState behavior (via allSessionStatuses)', () => {
    it('should handle undefined processingState', async () => {
      mockSessions.value = [createMockSession('sess-1', { processingState: undefined })];

      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const { allSessionStatuses } = await import('../session-status.js');

      expect(allSessionStatuses.value.get('sess-1')?.processingState).toEqual({ status: 'idle' });
    });

    it('should parse valid JSON string', async () => {
      mockSessions.value = [
        createMockSession('sess-1', {
          processingState: JSON.stringify({
            status: 'processing',
            phase: 'streaming',
            messageId: 'msg-1',
          }),
        }),
      ];

      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const { allSessionStatuses } = await import('../session-status.js');

      expect(allSessionStatuses.value.get('sess-1')?.processingState).toEqual({
        status: 'processing',
        phase: 'streaming',
        messageId: 'msg-1',
      });
    });

    it('should handle invalid JSON string gracefully', async () => {
      mockSessions.value = [createMockSession('sess-1', { processingState: 'invalid json' })];

      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const { allSessionStatuses } = await import('../session-status.js');

      expect(allSessionStatuses.value.get('sess-1')?.processingState).toEqual({ status: 'idle' });
    });

    it('should handle object processingState directly', async () => {
      const state: AgentProcessingState = { status: 'queued', messageId: 'msg-2' };
      mockSessions.value = [createMockSession('sess-1', { processingState: state })];

      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const { allSessionStatuses } = await import('../session-status.js');

      expect(allSessionStatuses.value.get('sess-1')?.processingState).toEqual({
        status: 'queued',
        messageId: 'msg-2',
      });
    });
  });

  describe('localStorage operations', () => {
    it('should save last seen counts when session is marked as read', async () => {
      mockSessions.value = [
        createMockSession('sess-1', {
          metadata: {
            messageCount: 10,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalCost: 0,
            toolCallCount: 0,
          },
        }),
      ];

      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const module = await import('../session-status.js');
      module.initSessionStatusTracking();

      mockCurrentSessionIdSignal.value = 'sess-1';

      const stored = mockLocalStorage.getItem('kai:session-last-seen');
      expect(stored).toBeDefined();
      const data = JSON.parse(stored!);
      expect(data['sess-1']).toBe(10);
    });

    it('should handle corrupted localStorage data gracefully', async () => {
      mockLocalStorage.setItem('kai:session-last-seen', 'not valid json');

      mockSessions.value = [
        createMockSession('sess-1', {
          metadata: {
            messageCount: 5,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalCost: 0,
            toolCallCount: 0,
          },
        }),
      ];

      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const module = await import('../session-status.js');

      expect(() => module.initSessionStatusTracking()).not.toThrow();
      expect(module.allSessionStatuses.value.get('sess-1')?.unreadCount).toBe(5);
    });

    it('should handle empty localStorage', async () => {
      mockSessions.value = [
        createMockSession('sess-1', {
          metadata: {
            messageCount: 5,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalCost: 0,
            toolCallCount: 0,
          },
        }),
      ];

      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const module = await import('../session-status.js');

      expect(() => module.initSessionStatusTracking()).not.toThrow();
      expect(module.allSessionStatuses.value.get('sess-1')?.unreadCount).toBe(5);
    });
  });

  describe('reactivity to signal changes', () => {
    it('should compute statuses from sessions signal', async () => {
      mockSessions.value = [
        createMockSession('sess-1', {
          processingState: JSON.stringify({ status: 'processing', phase: 'thinking' }),
        }),
        createMockSession('sess-2', { processingState: JSON.stringify({ status: 'idle' }) }),
      ];

      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const { allSessionStatuses } = await import('../session-status.js');

      expect(allSessionStatuses.value.size).toBe(2);
      expect(allSessionStatuses.value.get('sess-1')?.processingState).toEqual({
        status: 'processing',
        phase: 'thinking',
      });
      expect(allSessionStatuses.value.get('sess-2')?.processingState).toEqual({
        status: 'idle',
      });
    });
  });

  describe('SessionStatusInfo interface', () => {
    it('should return correct SessionStatusInfo shape', async () => {
      mockSessions.value = [
        createMockSession('sess-1', {
          processingState: JSON.stringify({ status: 'processing', phase: 'thinking' }),
          metadata: {
            messageCount: 10,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalCost: 0,
            toolCallCount: 0,
          },
        }),
      ];

      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const { allSessionStatuses } = await import('../session-status.js');

      const status = allSessionStatuses.value.get('sess-1');
      expect(status).toBeDefined();
      expect(status?.processingState).toBeDefined();
      expect(typeof status?.unreadCount).toBe('number');
    });
  });

  describe('localStorage save error handling', () => {
    it('should handle localStorage.setItem failure gracefully (line 69)', async () => {
      const throwingLocalStorage = {
        ...createMockLocalStorage(),
        setItem: vi.fn(() => {
          throw new Error('Storage quota exceeded');
        }),
      };
      globalThis.localStorage = throwingLocalStorage as unknown as Storage;

      mockSessions.value = [
        createMockSession('sess-1', {
          metadata: {
            messageCount: 10,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            totalCost: 0,
            toolCallCount: 0,
          },
        }),
      ];

      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const module = await import('../session-status.js');
      module.initSessionStatusTracking();

      mockCurrentSessionIdSignal.value = 'sess-1';
    });
  });
});
