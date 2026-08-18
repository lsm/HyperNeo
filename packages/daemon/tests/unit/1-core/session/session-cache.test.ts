import { describe, expect, it, beforeEach, mock, vi } from 'bun:test';
import {
  SessionCache,
  type AgentSessionFactory,
  type SessionLoader,
} from '../../../../src/lib/session/session-cache';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import type { Session } from '@hyperneo/shared';

describe('SessionCache', () => {
  let cache: SessionCache;
  let mockCreateAgentSession: AgentSessionFactory;
  let mockLoadFromDB: SessionLoader;
  let mockAgentSession: AgentSession;
  let mockSession: Session;

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
        titleGenerated: true,
      },
    };

    mockAgentSession = {
      cleanup: mock(async () => {}),
      updateMetadata: mock(() => {}),
      getSessionData: mock(() => mockSession),
    } as unknown as AgentSession;

    mockCreateAgentSession = mock(() => mockAgentSession);
    mockLoadFromDB = mock((sessionId: string) => {
      if (sessionId === 'test-session-id') {
        return mockSession;
      }
      return null;
    });

    cache = new SessionCache(mockCreateAgentSession, mockLoadFromDB);
  });

  describe('constructor', () => {
    it('should initialize with empty cache', () => {
      expect(cache.getActiveCount()).toBe(0);
      expect(cache.has('any-id')).toBe(false);
    });
  });

  describe('get (synchronous)', () => {
    it('should return null for non-existent session', () => {
      const result = cache.get('nonexistent');
      expect(result).toBeNull();
      expect(mockLoadFromDB).toHaveBeenCalledWith('nonexistent');
    });

    it('should load session from database on first access', () => {
      const result = cache.get('test-session-id');

      expect(mockLoadFromDB).toHaveBeenCalledWith('test-session-id');
      expect(mockCreateAgentSession).toHaveBeenCalledWith(mockSession);
      expect(result).toBe(mockAgentSession);
    });

    it('should cache session after first load', () => {
      const result1 = cache.get('test-session-id');
      expect(mockLoadFromDB).toHaveBeenCalledTimes(1);

      const result2 = cache.get('test-session-id');
      expect(mockLoadFromDB).toHaveBeenCalledTimes(1);

      expect(result1).toBe(result2);
    });

    it('should throw error if session is being loaded concurrently', async () => {
      const loadPromise = cache.getAsync('test-session-id');

      expect(() => cache.get('test-session-id')).toThrow(
        'Session test-session-id is being loaded. Use getAsync() for concurrent access.'
      );

      await loadPromise;

      const result = cache.get('test-session-id');
      expect(result).toBe(mockAgentSession);
    });
  });

  describe('getAsync', () => {
    it('should return null for non-existent session', async () => {
      const result = await cache.getAsync('nonexistent');
      expect(result).toBeNull();
      expect(mockLoadFromDB).toHaveBeenCalledWith('nonexistent');
    });

    it('should load session from database on first access', async () => {
      const result = await cache.getAsync('test-session-id');

      expect(mockLoadFromDB).toHaveBeenCalledWith('test-session-id');
      expect(mockCreateAgentSession).toHaveBeenCalledWith(mockSession);
      expect(result).toBe(mockAgentSession);
    });

    it('should cache session after first load', async () => {
      const result1 = await cache.getAsync('test-session-id');
      expect(mockLoadFromDB).toHaveBeenCalledTimes(1);

      const result2 = await cache.getAsync('test-session-id');
      expect(mockLoadFromDB).toHaveBeenCalledTimes(1);

      expect(result1).toBe(result2);
    });

    it('should handle concurrent requests for same session', async () => {
      const promises = await Promise.all([
        cache.getAsync('test-session-id'),
        cache.getAsync('test-session-id'),
        cache.getAsync('test-session-id'),
      ]);

      expect(promises[0]).toBe(mockAgentSession);
      expect(promises[1]).toBe(mockAgentSession);
      expect(promises[2]).toBe(mockAgentSession);

      expect(mockLoadFromDB).toHaveBeenCalledTimes(1);
    });

    it('should return null if loadFromDB returns null', async () => {
      const result = await cache.getAsync('nonexistent');
      expect(result).toBeNull();
    });

    it('should handle factory errors gracefully', async () => {
      const errorFactory = mock(() => {
        throw new Error('Factory error');
      });
      const errorCache = new SessionCache(errorFactory, mockLoadFromDB);

      const result = await errorCache.getAsync('test-session-id');
      expect(result).toBeNull();
    });
  });

  describe('set', () => {
    it('should add session to cache', () => {
      cache.set('manual-id', mockAgentSession);

      expect(cache.has('manual-id')).toBe(true);
      expect(cache.get('manual-id')).toBe(mockAgentSession);
    });

    it('should overwrite existing session', () => {
      const anotherSession = { ...mockAgentSession } as AgentSession;

      cache.set('test-id', mockAgentSession);
      cache.set('test-id', anotherSession);

      expect(cache.get('test-id')).toBe(anotherSession);
    });
  });

  describe('remove', () => {
    it('should remove session from cache', () => {
      cache.set('test-id', mockAgentSession);
      expect(cache.has('test-id')).toBe(true);

      cache.remove('test-id');
      expect(cache.has('test-id')).toBe(false);
    });

    it('should be idempotent for non-existent session', () => {
      expect(() => cache.remove('nonexistent')).not.toThrow();
    });

    it('should allow fresh getAsync after remove (no stale lock)', async () => {
      cache.set('test-session-id', mockAgentSession);
      cache.remove('test-session-id');
      const result = await cache.getAsync('test-session-id');
      expect(mockLoadFromDB).toHaveBeenCalledWith('test-session-id');
      expect(result).toBe(mockAgentSession);
    });

    it('should clear in-flight load lock so getAsync after remove does a fresh load', async () => {
      const firstLoadPromise = cache.getAsync('test-session-id');

      cache.remove('test-session-id');

      await firstLoadPromise;

      (mockLoadFromDB as ReturnType<typeof mock>).mockClear();
      cache.remove('test-session-id');

      const result = await cache.getAsync('test-session-id');
      expect(result).toBe(mockAgentSession);
      expect(mockLoadFromDB).toHaveBeenCalledWith('test-session-id');
    });
  });

  describe('has', () => {
    it('should return false for non-existent session', () => {
      expect(cache.has('nonexistent')).toBe(false);
    });

    it('should return true for cached session', () => {
      cache.set('test-id', mockAgentSession);
      expect(cache.has('test-id')).toBe(true);
    });

    it('should return false after removal', () => {
      cache.set('test-id', mockAgentSession);
      cache.remove('test-id');
      expect(cache.has('test-id')).toBe(false);
    });
  });

  describe('getActiveCount', () => {
    it('should return 0 for empty cache', () => {
      expect(cache.getActiveCount()).toBe(0);
    });

    it('should return correct count after additions', () => {
      cache.set('id1', mockAgentSession);
      expect(cache.getActiveCount()).toBe(1);

      cache.set('id2', mockAgentSession);
      expect(cache.getActiveCount()).toBe(2);
    });

    it('should return correct count after removals', () => {
      cache.set('id1', mockAgentSession);
      cache.set('id2', mockAgentSession);
      cache.remove('id1');
      expect(cache.getActiveCount()).toBe(1);
    });

    it('should return 0 after clear', () => {
      cache.set('id1', mockAgentSession);
      cache.set('id2', mockAgentSession);
      cache.clear();
      expect(cache.getActiveCount()).toBe(0);
    });
  });

  describe('clear', () => {
    it('should remove all sessions from cache', () => {
      cache.set('id1', mockAgentSession);
      cache.set('id2', mockAgentSession);
      cache.set('id3', mockAgentSession);

      cache.clear();

      expect(cache.getActiveCount()).toBe(0);
      expect(cache.has('id1')).toBe(false);
      expect(cache.has('id2')).toBe(false);
      expect(cache.has('id3')).toBe(false);
    });

    it('should be idempotent for empty cache', () => {
      expect(() => cache.clear()).not.toThrow();
      expect(cache.getActiveCount()).toBe(0);
    });
  });

  describe('getAll', () => {
    it('should return empty map for empty cache', () => {
      const result = cache.getAll();
      expect(result.size).toBe(0);
    });

    it('should return all cached sessions', () => {
      cache.set('id1', mockAgentSession);
      cache.set('id2', mockAgentSession);

      const result = cache.getAll();

      expect(result.size).toBe(2);
      expect(result.get('id1')).toBe(mockAgentSession);
      expect(result.get('id2')).toBe(mockAgentSession);
    });

    it('should return a reference to the internal map', () => {
      cache.set('id1', mockAgentSession);
      const result = cache.getAll();

      result.set('id2', mockAgentSession);
      expect(cache.has('id2')).toBe(true);
    });
  });

  describe('entries', () => {
    it('should return empty iterator for empty cache', () => {
      const entries = [...cache.entries()];
      expect(entries).toHaveLength(0);
    });

    it('should iterate over all cached sessions', () => {
      cache.set('id1', mockAgentSession);
      cache.set('id2', mockAgentSession);

      const entries = [...cache.entries()];

      expect(entries).toHaveLength(2);
      expect(entries.map(([id]) => id)).toContain('id1');
      expect(entries.map(([id]) => id)).toContain('id2');
    });

    it('should be usable in for-of loop', () => {
      cache.set('id1', mockAgentSession);
      cache.set('id2', mockAgentSession);

      const ids: string[] = [];
      for (const [id, session] of cache.entries()) {
        ids.push(id);
        expect(session).toBe(mockAgentSession);
      }

      expect(ids).toContain('id1');
      expect(ids).toContain('id2');
    });
  });
});
