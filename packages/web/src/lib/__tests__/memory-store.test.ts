import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMemoryEntry } from '@hyperneo/shared';

const mockRequest = vi.fn();

vi.mock('../connection-manager', () => ({
  connectionManager: {
    getHub: async () => ({ request: mockRequest }),
  },
}));

import { memoryStore } from '../memory-store';

function makeMemory(key: string, overrides: Partial<AgentMemoryEntry> = {}): AgentMemoryEntry {
  return {
    key,
    spaceId: 'space-1',
    content: `body ${key}`,
    tags: [],
    createdBySession: null,
    createdAt: 1,
    updatedAt: 1,
    accessCount: 0,
    lastAccessedAt: null,
    ...overrides,
  };
}

describe('memoryStore', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    memoryStore.detach();
  });

  afterEach(() => {
    memoryStore.detach();
  });

  it('optimistically reflects a write even when the follow-up reload fails', async () => {
    mockRequest.mockImplementation(async (method: string) => {
      if (method === 'agentMemory.list') return [makeMemory('alpha')];
      throw new Error(`unexpected ${method}`);
    });
    await memoryStore.attach('space-1');
    expect(memoryStore.memories.value.map((m) => m.key)).toEqual(['alpha']);

    mockRequest.mockImplementation(async (method: string) => {
      if (method === 'agentMemory.write') return makeMemory('beta', { updatedAt: 5 });
      if (method === 'agentMemory.list') throw new Error('connection dropped');
      throw new Error(`unexpected ${method}`);
    });

    const entry = await memoryStore.write({ key: 'beta', content: 'x' });
    expect(entry.key).toBe('beta');

    const keys = memoryStore.memories.value.map((m) => m.key);
    expect(keys).toContain('beta');
    expect(keys).toContain('alpha');
    expect(memoryStore.error.value).toBeNull();
  });

  it('create uses the atomic insert RPC', async () => {
    let createPayload: Record<string, unknown> | undefined;
    mockRequest.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'agentMemory.list') return [];
      if (method === 'agentMemory.create') {
        createPayload = params;
        return makeMemory('beta');
      }
      throw new Error(`unexpected ${method}`);
    });
    await memoryStore.attach('space-1');

    const entry = await memoryStore.create({ key: 'beta', content: 'x', tags: ['t'] });
    expect(entry.key).toBe('beta');
    expect(createPayload).toMatchObject({ key: 'beta', content: 'x', tags: ['t'] });
  });

  it('create propagates a conflict', async () => {
    mockRequest.mockImplementation(async (method: string) => {
      if (method === 'agentMemory.list') return [];
      if (method === 'agentMemory.create') {
        throw new Error('A memory with the key "beta" already exists in this space.');
      }
      throw new Error(`unexpected ${method}`);
    });
    await memoryStore.attach('space-1');
    await expect(memoryStore.create({ key: 'beta', content: 'x' })).rejects.toThrow(
      'already exists'
    );
  });

  it('does not optimistically insert during an active search', async () => {
    mockRequest.mockImplementation(async (method: string) => {
      if (method === 'agentMemory.list') return [makeMemory('alpha')];
      if (method === 'agentMemory.write') return makeMemory('beta', { updatedAt: 9 });
      throw new Error(`unexpected ${method}`);
    });
    await memoryStore.attach('space-1');
    await memoryStore.search('alpha');

    await memoryStore.write({ key: 'beta', content: 'x' });
    expect(memoryStore.memories.value.map((m) => m.key)).toEqual(['alpha']);
  });

  it('updates an edited search result in place even when the refresh fails', async () => {
    mockRequest.mockImplementation(async (method: string) => {
      if (method === 'agentMemory.list')
        return [makeMemory('alpha', { content: 'old', updatedAt: 1 })];
      throw new Error(`unexpected ${method}`);
    });
    await memoryStore.attach('space-1');
    await memoryStore.search('alpha');

    mockRequest.mockImplementation(async (method: string) => {
      if (method === 'agentMemory.write')
        return makeMemory('alpha', { content: 'new', updatedAt: 2 });
      if (method === 'agentMemory.list') throw new Error('refresh failed');
      throw new Error(`unexpected ${method}`);
    });
    await memoryStore.write({ key: 'alpha', content: 'new' });

    const alpha = memoryStore.memories.value.find((m) => m.key === 'alpha');
    expect(alpha?.content).toBe('new');
  });

  it('edits a search result without re-ranking the relevance order', async () => {
    mockRequest.mockImplementation(async (method: string) => {
      if (method === 'agentMemory.list') {
        return [makeMemory('alpha', { updatedAt: 1 }), makeMemory('beta', { updatedAt: 1 })];
      }
      throw new Error(`unexpected ${method}`);
    });
    await memoryStore.attach('space-1');
    await memoryStore.search('term');

    mockRequest.mockImplementation(async (method: string) => {
      if (method === 'agentMemory.write')
        return makeMemory('beta', { content: 'new', updatedAt: 999 });
      if (method === 'agentMemory.list') throw new Error('refresh failed');
      throw new Error(`unexpected ${method}`);
    });
    await memoryStore.write({ key: 'beta', content: 'new' });

    const keys = memoryStore.memories.value.map((m) => m.key);
    expect(keys).toEqual(['alpha', 'beta']);
    const edited = memoryStore.memories.value.find((m) => m.key === 'beta');
    expect(edited?.content).toBe('new');
  });

  it('keeps the load error visible when a create refresh fails before first load', async () => {
    mockRequest.mockRejectedValueOnce(new Error('initial load failed'));
    await expect(memoryStore.attach('space-1')).rejects.toThrow('initial load failed');
    expect(memoryStore.loaded.value).toBe(false);

    mockRequest.mockImplementation(async (method: string) => {
      if (method === 'agentMemory.create') return makeMemory('beta');
      if (method === 'agentMemory.list') throw new Error('refresh failed');
      throw new Error(`unexpected ${method}`);
    });
    const entry = await memoryStore.create({ key: 'beta', content: 'x' });
    expect(entry.key).toBe('beta');
    expect(memoryStore.error.value).toBeTruthy();
    expect(memoryStore.loaded.value).toBe(false);
  });

  it('restores hasMore when a refresh fails after a full page loaded', async () => {
    mockRequest.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => makeMemory(`a${i}`)));
    await memoryStore.attach('space-1');
    expect(memoryStore.hasMore.value).toBe(true);

    mockRequest.mockImplementation(async (method: string) => {
      if (method === 'agentMemory.write') return makeMemory('new', { updatedAt: 99 });
      if (method === 'agentMemory.list') throw new Error('refresh failed');
      throw new Error(`unexpected ${method}`);
    });
    await memoryStore.write({ key: 'new', content: 'x' });
    expect(memoryStore.hasMore.value).toBe(true);
    expect(memoryStore.error.value).toBeNull();
  });

  it('restores offset when a refresh fails, so the next Load-more is not a no-op', async () => {
    mockRequest.mockImplementation(async (_method: string, params: { offset?: number }) => {
      const offset = params?.offset ?? 0;
      return Array.from({ length: 100 }, (_, i) => makeMemory(`k${offset + i}`));
    });
    await memoryStore.attach('space-1');
    await memoryStore.loadMore();
    expect(memoryStore.memories.value).toHaveLength(200);

    mockRequest.mockImplementation(async (method: string) => {
      if (method === 'agentMemory.write') return makeMemory('new', { updatedAt: 999 });
      if (method === 'agentMemory.list') throw new Error('refresh failed');
      throw new Error(`unexpected ${method}`);
    });
    await memoryStore.write({ key: 'new', content: 'x' });
    expect(memoryStore.hasMore.value).toBe(true);

    let loadMoreOffset: number | undefined;
    mockRequest.mockImplementation(async (_method: string, params: { offset?: number }) => {
      if (loadMoreOffset === undefined) loadMoreOffset = params?.offset;
      const offset = params?.offset ?? 0;
      return Array.from({ length: 100 }, (_, i) => makeMemory(`k${offset + i}`));
    });
    await memoryStore.loadMore();

    expect(loadMoreOffset).toBe(200);
    expect(memoryStore.memories.value.length).toBeGreaterThanOrEqual(300);
  });

  it('optimistically removes a deleted memory', async () => {
    mockRequest.mockImplementation(async (method: string) => {
      if (method === 'agentMemory.list') return [makeMemory('alpha'), makeMemory('beta')];
      throw new Error(`unexpected ${method}`);
    });
    await memoryStore.attach('space-1');
    expect(memoryStore.memories.value.map((m) => m.key)).toEqual(['alpha', 'beta']);

    mockRequest.mockImplementation(async (method: string) => {
      if (method === 'agentMemory.delete') return { deleted: true };
      if (method === 'agentMemory.list') return [makeMemory('beta')];
      throw new Error(`unexpected ${method}`);
    });

    const deleted = await memoryStore.deleteMemory('alpha');
    expect(deleted).toBe(true);
    expect(memoryStore.memories.value.map((m) => m.key)).toEqual(['beta']);
  });

  it('loadMore appends the next page and de-duplicates by key', async () => {
    mockRequest.mockImplementation(async (_method: string, params: { offset?: number }) => {
      const offset = params?.offset ?? 0;
      if (offset === 0) return Array.from({ length: 100 }, (_, i) => makeMemory(`k${i}`));
      return [makeMemory('k100'), makeMemory('k0')];
    });

    await memoryStore.attach('space-1');
    expect(memoryStore.memories.value).toHaveLength(100);
    expect(memoryStore.hasMore.value).toBe(true);

    await memoryStore.loadMore();
    expect(memoryStore.memories.value).toHaveLength(101);
    expect(memoryStore.hasMore.value).toBe(false);
  });

  it('infers hasMore from page size and clears it on a short page', async () => {
    mockRequest.mockResolvedValue([makeMemory('only')]);
    await memoryStore.attach('space-1');
    expect(memoryStore.hasMore.value).toBe(false);
  });

  it('exists reports backend presence read-only', async () => {
    let readPayload: Record<string, unknown> | undefined;
    mockRequest.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'agentMemory.list') return [];
      if (method === 'agentMemory.read') {
        readPayload = params;
        return makeMemory('alpha');
      }
      throw new Error(`unexpected ${method}`);
    });
    await memoryStore.attach('space-1');

    const present = await memoryStore.exists('alpha');
    expect(present).toBe(true);
    expect(readPayload?.recordAccess).toBe(false);
  });

  it('exists returns false when absent or on transport error', async () => {
    mockRequest.mockImplementation(async (method: string) => {
      if (method === 'agentMemory.list') return [];
      if (method === 'agentMemory.read') return null;
      throw new Error(`unexpected ${method}`);
    });
    await memoryStore.attach('space-1');
    expect(await memoryStore.exists('missing')).toBe(false);

    mockRequest.mockRejectedValue(new Error('network'));
    expect(await memoryStore.exists('alpha')).toBe(false);
  });

  it('clears hasMore when a reload fails so stale rows cannot be extended', async () => {
    mockRequest.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => makeMemory(`a${i}`)));
    await memoryStore.attach('space-1');
    expect(memoryStore.hasMore.value).toBe(true);

    mockRequest.mockRejectedValue(new Error('boom'));
    await expect(memoryStore.search('anything')).rejects.toThrow('boom');
    expect(memoryStore.hasMore.value).toBe(false);
  });

  it('a stale loadMore does not clear a newer space loadMore spinner', async () => {
    mockRequest.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => makeMemory(`a${i}`)));
    await memoryStore.attach('space-1');

    let releaseA!: (rows: AgentMemoryEntry[]) => void;
    mockRequest.mockImplementation(
      () =>
        new Promise<AgentMemoryEntry[]>((resolve) => {
          releaseA = resolve;
        })
    );
    const loadMoreA = memoryStore.loadMore();
    await Promise.resolve();
    await Promise.resolve();
    expect(memoryStore.isLoadingMore.value).toBe(true);

    memoryStore.detach();
    mockRequest.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => makeMemory(`b${i}`)));
    await memoryStore.attach('space-2');
    expect(memoryStore.hasMore.value).toBe(true);

    let releaseB!: (rows: AgentMemoryEntry[]) => void;
    mockRequest.mockImplementation(
      () =>
        new Promise<AgentMemoryEntry[]>((resolve) => {
          releaseB = resolve;
        })
    );
    const loadMoreB = memoryStore.loadMore();
    await Promise.resolve();
    await Promise.resolve();
    expect(memoryStore.isLoadingMore.value).toBe(true);

    releaseA([makeMemory('a100')]);
    await loadMoreA;
    expect(memoryStore.isLoadingMore.value).toBe(true);

    releaseB([makeMemory('b100')]);
    await loadMoreB;
    expect(memoryStore.isLoadingMore.value).toBe(false);
  });

  it('clears the load-more spinner when a reload interrupts it', async () => {
    mockRequest.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => makeMemory(`a${i}`)));
    await memoryStore.attach('space-1');
    expect(memoryStore.hasMore.value).toBe(true);

    let releaseLoadMore!: (rows: AgentMemoryEntry[]) => void;
    let loadMoreFetchStarted = false;
    mockRequest.mockImplementation((method: string) => {
      if (method !== 'agentMemory.list') throw new Error(`unexpected ${method}`);
      if (!loadMoreFetchStarted) {
        loadMoreFetchStarted = true;
        return new Promise<AgentMemoryEntry[]>((resolve) => {
          releaseLoadMore = resolve;
        });
      }
      return Promise.resolve([]);
    });

    const loadMoreP = memoryStore.loadMore();
    await Promise.resolve();
    await Promise.resolve();
    expect(memoryStore.isLoadingMore.value).toBe(true);

    await memoryStore.reload();
    expect(memoryStore.isLoading.value).toBe(false);

    releaseLoadMore([makeMemory('k100')]);
    await loadMoreP;
    expect(memoryStore.isLoadingMore.value).toBe(false);
  });

  it('does not contaminate the new space when a write completes after a switch', async () => {
    mockRequest.mockImplementation(async (method: string) => {
      if (method === 'agentMemory.list') return [makeMemory('alpha')];
      throw new Error(`unexpected ${method}`);
    });
    await memoryStore.attach('space-1');

    let releaseWrite!: (entry: AgentMemoryEntry) => void;
    mockRequest.mockImplementation((method: string) => {
      if (method === 'agentMemory.write') {
        return new Promise<AgentMemoryEntry>((resolve) => {
          releaseWrite = resolve;
        });
      }
      if (method === 'agentMemory.list') return Promise.resolve([makeMemory('gamma')]);
      throw new Error(`unexpected ${method}`);
    });

    const writeP = memoryStore.write({ key: 'beta', content: 'x' });
    await Promise.resolve();
    await Promise.resolve();

    await memoryStore.attach('space-2');
    expect(memoryStore.memories.value.map((m) => m.key)).toEqual(['gamma']);

    releaseWrite(makeMemory('beta'));
    const entry = await writeP;
    expect(entry.key).toBe('beta');
    expect(memoryStore.memories.value.map((m) => m.key)).toEqual(['gamma']);
  });
});
