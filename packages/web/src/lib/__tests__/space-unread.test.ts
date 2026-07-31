/**
 * Tests for space-unread.ts — client-local unread tracking for space sessions
 * and tasks.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const createMockLocalStorage = () => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
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

describe('space-unread', () => {
  beforeEach(() => {
    globalThis.localStorage = mockLocalStorage as unknown as Storage;
    mockLocalStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.localStorage = originalLocalStorage;
  });

  describe('space session unread', () => {
    it('reports the messageCount delta as unread', async () => {
      const { getSpaceSessionUnreadCount } = await import('../space-unread.js');
      expect(getSpaceSessionUnreadCount('s1', 10)).toBe(10);
    });

    it('returns 0 when messageCount is missing', async () => {
      const { getSpaceSessionUnreadCount } = await import('../space-unread.js');
      expect(getSpaceSessionUnreadCount('s1', undefined)).toBe(0);
    });

    it('clears once the session is marked read and persists to localStorage', async () => {
      const { getSpaceSessionUnreadCount, markSpaceSessionRead } = await import(
        '../space-unread.js'
      );
      expect(getSpaceSessionUnreadCount('s1', 10)).toBe(10);
      markSpaceSessionRead('s1', 10);
      expect(getSpaceSessionUnreadCount('s1', 10)).toBe(0);
      const stored = JSON.parse(mockLocalStorage.getItem('kai:space-session-last-seen')!);
      expect(stored.s1).toBe(10);
    });

    it('loads last-seen counts from localStorage on import', async () => {
      mockLocalStorage.setItem('kai:space-session-last-seen', JSON.stringify({ s1: 7 }));
      const { getSpaceSessionUnreadCount } = await import('../space-unread.js');
      expect(getSpaceSessionUnreadCount('s1', 10)).toBe(3);
    });
  });

  describe('space task unread', () => {
    it('is not unread before being seeded (no cold-start noise)', async () => {
      const { isSpaceTaskUnread } = await import('../space-unread.js');
      expect(isSpaceTaskUnread('t1', 100)).toBe(false);
    });

    it('seeds tasks at their current updatedAt, treating them as read', async () => {
      const { seedSpaceTasksSeen, isSpaceTaskUnread } = await import('../space-unread.js');
      seedSpaceTasksSeen([{ id: 't1', updatedAt: 100 }]);
      // Same updatedAt as the seed → not unread.
      expect(isSpaceTaskUnread('t1', 100)).toBe(false);
      // A later update (e.g. agent activity) → unread.
      expect(isSpaceTaskUnread('t1', 150)).toBe(true);
    });

    it('does not re-seed a task that is already known', async () => {
      const { seedSpaceTasksSeen, markSpaceTaskRead, isSpaceTaskUnread } = await import(
        '../space-unread.js'
      );
      seedSpaceTasksSeen([{ id: 't1', updatedAt: 100 }]);
      markSpaceTaskRead('t1', 200);
      // Re-seeding with an older updatedAt must not clobber the newer seen value.
      seedSpaceTasksSeen([{ id: 't1', updatedAt: 100 }]);
      expect(isSpaceTaskUnread('t1', 200)).toBe(false);
      expect(isSpaceTaskUnread('t1', 250)).toBe(true);
    });

    it('clears once the task is marked read and persists to localStorage', async () => {
      const { seedSpaceTasksSeen, isSpaceTaskUnread, markSpaceTaskRead } = await import(
        '../space-unread.js'
      );
      seedSpaceTasksSeen([{ id: 't1', updatedAt: 100 }]);
      expect(isSpaceTaskUnread('t1', 150)).toBe(true);
      markSpaceTaskRead('t1', 150);
      expect(isSpaceTaskUnread('t1', 150)).toBe(false);
      const stored = JSON.parse(mockLocalStorage.getItem('kai:space-task-last-seen')!);
      expect(stored.t1).toBe(150);
    });
  });
});
