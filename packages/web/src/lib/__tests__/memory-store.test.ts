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
});
