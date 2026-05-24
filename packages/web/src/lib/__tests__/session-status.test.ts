// @ts-nocheck
/**
 * Tests for Session Status Tracking
 *
 * Tests the actual exported functions from session-status.ts:
 * - initSessionStatusTracking()
 * - allSessionStatuses (computed signal)
 * - getProcessingPhaseColor()
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Session, AgentProcessingState } from '@neokai/shared';
import type { Signal } from '@preact/signals';

// Mock localStorage
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

// Setup state signals for mocking
let mockSessions: Signal<Session[]>;
let mockCurrentSessionIdSignal: Signal<string | null>;

describe('session-status (real module tests)', () => {
  beforeEach(() => {
    // Setup mock localStorage
    globalThis.localStorage = mockLocalStorage as unknown as Storage;
    mockLocalStorage.clear();
    vi.clearAllMocks();

    // Reset signals
    const { signal } = require('@preact/signals');
    mockSessions = signal<Session[]>([]);
    mockCurrentSessionIdSignal = signal<string | null>(null);
  });

  afterEach(() => {
    globalThis.localStorage = originalLocalStorage;
    vi.resetModules();
  });

  // Helper to create mock sessions
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

  describe('getProcessingPhaseColor', () => {
    it('should return null for idle status', async () => {
      // Mock dependencies
      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const { getProcessingPhaseColor } = await import('../session-status.js');

      expect(getProcessingPhaseColor({ status: 'idle' })).toBeNull();
    });

    it('should return null for interrupted status', async () => {
      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const { getProcessingPhaseColor } = await import('../session-status.js');

      expect(getProcessingPhaseColor({ status: 'interrupted' })).toBeNull();
    });

    it('should return yellow for queued status', async () => {
      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const { getProcessingPhaseColor } = await import('../session-status.js');

      expect(getProcessingPhaseColor({ status: 'queued' })).toEqual({
        dot: 'bg-yellow-500',
        text: 'text-yellow-400',
      });
    });

    it('should return blue for thinking phase', async () => {
      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const { getProcessingPhaseColor } = await import('../session-status.js');

      expect(getProcessingPhaseColor({ status: 'processing', phase: 'thinking' })).toEqual({
        dot: 'bg-blue-500',
        text: 'text-blue-400',
      });
    });

    it('should return green for streaming phase', async () => {
      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const { getProcessingPhaseColor } = await import('../session-status.js');

      expect(getProcessingPhaseColor({ status: 'processing', phase: 'streaming' })).toEqual({
        dot: 'bg-green-500',
        text: 'text-green-400',
      });
    });

    it('should return purple for finalizing phase', async () => {
      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const { getProcessingPhaseColor } = await import('../session-status.js');

      expect(getProcessingPhaseColor({ status: 'processing', phase: 'finalizing' })).toEqual({
        dot: 'bg-purple-500',
        text: 'text-purple-400',
      });
    });

    it('should return yellow for initializing phase', async () => {
      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const { getProcessingPhaseColor } = await import('../session-status.js');

      expect(getProcessingPhaseColor({ status: 'processing', phase: 'initializing' })).toEqual({
        dot: 'bg-yellow-500',
        text: 'text-yellow-400',
      });
    });
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

    it('should compute hasUnread correctly', async () => {
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

      // Set localStorage data
      mockLocalStorage.setItem('kai:session-last-seen', JSON.stringify({ 'sess-1': 5 }));

      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const module = await import('../session-status.js');
      const { allSessionStatuses } = module;

      // Need to call initSessionStatusTracking to load the localStorage data
      module.initSessionStatusTracking();

      // sess-1: 10 > 5, so unread
      expect(allSessionStatuses.value.get('sess-1')?.hasUnread).toBe(true);
      // sess-2: 5 > 0, so unread
      expect(allSessionStatuses.value.get('sess-2')?.hasUnread).toBe(true);
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

      expect(allSessionStatuses.value.get('sess-1')?.hasUnread).toBe(false);
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
      // Set up localStorage with data
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

      // After initialization, check that statuses reflect loaded data
      expect(module.allSessionStatuses.value.get('sess-1')?.hasUnread).toBe(true); // 10 > 5
      expect(module.allSessionStatuses.value.get('sess-2')?.hasUnread).toBe(true); // 15 > 10
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

      // Initially unread
      expect(module.allSessionStatuses.value.get('sess-1')?.hasUnread).toBe(true);

      // Simulate switching to this session (which marks it as read)
      mockCurrentSessionIdSignal.value = 'sess-1';

      // Now should be marked as read
      expect(module.allSessionStatuses.value.get('sess-1')?.hasUnread).toBe(false);
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

      // Switch to session - should mark as read
      mockCurrentSessionIdSignal.value = 'sess-1';

      // Check localStorage was updated
      const stored = mockLocalStorage.getItem('kai:session-last-seen');
      expect(stored).toBeDefined();
      const data = JSON.parse(stored!);
      expect(data['sess-1']).toBe(10);
    });

    it('should handle corrupted localStorage data gracefully', async () => {
      // Set invalid data
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

      // Should not throw, should handle gracefully
      expect(() => module.initSessionStatusTracking()).not.toThrow();
      expect(module.allSessionStatuses.value.get('sess-1')?.hasUnread).toBe(true); // 5 > 0 (default)
    });

    it('should handle empty localStorage', async () => {
      // No localStorage data set

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
      // All sessions should be unread when no lastSeen data exists
      expect(module.allSessionStatuses.value.get('sess-1')?.hasUnread).toBe(true);
    });
  });

  describe('reactivity to signal changes', () => {
    it('should compute statuses from sessions signal', async () => {
      // Set up sessions with two sessions from the start
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

      // Should have both sessions
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
      expect(typeof status?.hasUnread).toBe('boolean');
    });
  });

  describe('getProcessingPhaseColor edge cases', () => {
    it('should return purple for unknown processing phase (default case)', async () => {
      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const { getProcessingPhaseColor } = await import('../session-status.js');

      // Test with an unknown phase value - should hit default case (line 196)
      const result = getProcessingPhaseColor({
        status: 'processing',
        phase: 'unknown-phase' as unknown as AgentProcessingState['phase'],
      });
      expect(result).toEqual({
        dot: 'bg-purple-500',
        text: 'text-purple-400',
      });
    });

    it('should return null for completely unknown status (final return null)', async () => {
      vi.doMock('../state.js', () => ({
        sessions: mockSessions,
      }));
      vi.doMock('../signals.js', () => ({
        currentSessionIdSignal: mockCurrentSessionIdSignal,
      }));

      const { getProcessingPhaseColor } = await import('../session-status.js');

      // Test with an unrecognized status - should hit final return null (line 200)
      const result = getProcessingPhaseColor({
        status: 'unknown-status' as unknown as AgentProcessingState['status'],
      });
      expect(result).toBeNull();
    });
  });

  describe('localStorage save error handling', () => {
    it('should handle localStorage.setItem failure gracefully (line 69)', async () => {
      // Create a localStorage that throws on setItem
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

      // Switch to session - should trigger save which will fail
      mockCurrentSessionIdSignal.value = 'sess-1';

      // Should have handled error gracefully (no throw)
    });
  });
});
