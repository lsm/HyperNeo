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

    // write succeeds, but the reconciling reload (list) fails.
    mockRequest.mockImplementation(async (method: string) => {
      if (method === 'agentMemory.write') return makeMemory('beta', { updatedAt: 5 });
      if (method === 'agentMemory.list') throw new Error('connection dropped');
      throw new Error(`unexpected ${method}`);
    });

    const entry = await memoryStore.write({ key: 'beta', content: 'x' });
    expect(entry.key).toBe('beta');

    const keys = memoryStore.memories.value.map((m) => m.key);
    expect(keys).toContain('beta'); // optimistic upsert survived the failed reload
    expect(keys).toContain('alpha');
    // The mutation did not throw and no "retry the write" error is surfaced.
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
      // A full first page signals more may exist; a short second page ends it.
      if (offset === 0) return Array.from({ length: 100 }, (_, i) => makeMemory(`k${i}`));
      return [makeMemory('k100'), makeMemory('k0')]; // k0 duplicates the first page
    });

    await memoryStore.attach('space-1');
    expect(memoryStore.memories.value).toHaveLength(100);
    expect(memoryStore.hasMore.value).toBe(true);

    await memoryStore.loadMore();
    // 100 + 1 fresh (k100), k0 de-duped against the first page.
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

    // A new search reload fails.
    mockRequest.mockRejectedValue(new Error('boom'));
    await expect(memoryStore.search('anything')).rejects.toThrow('boom');
    // hasMore reset, so Load-more can't append stale rows for the new query.
    expect(memoryStore.hasMore.value).toBe(false);
  });

  it('a stale loadMore does not clear a newer space loadMore spinner', async () => {
    mockRequest.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => makeMemory(`a${i}`)));
    await memoryStore.attach('space-1');

    // space-1 loadMore A — deferred so it stays pending across the switch.
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

    // Switch to space-2 (detach invalidates A) and load a full page.
    memoryStore.detach();
    mockRequest.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => makeMemory(`b${i}`)));
    await memoryStore.attach('space-2');
    expect(memoryStore.hasMore.value).toBe(true);

    // space-2 loadMore B — deferred.
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

    // Stale A settles — must NOT clear B's spinner.
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

    // loadMore's fetch is deferred so a reload can interrupt mid-flight.
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
      return Promise.resolve([]); // the interrupting reload resolves immediately
    });

    const loadMoreP = memoryStore.loadMore();
    await Promise.resolve();
    await Promise.resolve();
    expect(memoryStore.isLoadingMore.value).toBe(true);

    await memoryStore.reload(); // advances loadGeneration while loadMore is pending
    expect(memoryStore.isLoading.value).toBe(false);

    releaseLoadMore([makeMemory('k100')]);
    await loadMoreP;
    // Spinner cleared despite the interrupt (was stuck before the fix).
    expect(memoryStore.isLoadingMore.value).toBe(false);
  });

  it('does not contaminate the new space when a write completes after a switch', async () => {
    mockRequest.mockImplementation(async (method: string) => {
      if (method === 'agentMemory.list') return [makeMemory('alpha')];
      throw new Error(`unexpected ${method}`);
    });
    await memoryStore.attach('space-1');

    // Defer the write RPC so we can switch space before it resolves.
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

    await memoryStore.attach('space-2'); // switch space mid-write
    expect(memoryStore.memories.value.map((m) => m.key)).toEqual(['gamma']);

    releaseWrite(makeMemory('beta'));
    const entry = await writeP;
    expect(entry.key).toBe('beta');
    // beta (space-1) must not appear in space-2's list.
    expect(memoryStore.memories.value.map((m) => m.key)).toEqual(['gamma']);
  });
});
