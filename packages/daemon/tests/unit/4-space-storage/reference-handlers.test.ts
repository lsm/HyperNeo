import { describe, expect, it } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { REFERENCE_PATTERN } from '@hyperneo/shared';
import { setupReferenceHandlers } from '../../../src/lib/rpc-handlers/reference-handlers';
import type { FileIndex, FileIndexEntry } from '../../../src/lib/file-index';

function buildMessageHub(): {
  hub: MessageHub;
  call: (method: string, data: unknown) => Promise<unknown>;
} {
  const handlers = new Map<string, (data: unknown) => Promise<unknown>>();
  const hub = {
    onRequest: (method: string, handler: (data: unknown) => Promise<unknown>) => {
      handlers.set(method, handler);
      return () => {};
    },
  } as unknown as MessageHub;

  return {
    hub,
    call: async (method: string, data: unknown) => {
      const handler = handlers.get(method);
      if (!handler) throw new Error(`No handler for ${method}`);
      return handler(data);
    },
  };
}

function buildFileIndex(entries: FileIndexEntry[] = []): FileIndex {
  return {
    isReady: () => true,
    search: (query: string, limit = 50) => {
      const q = query.toLowerCase();
      return entries
        .filter((e) => e.name.toLowerCase().includes(q) || e.path.toLowerCase().includes(q))
        .slice(0, limit);
    },
    init: async () => {},
    dispose: () => {},
    invalidate: () => {},
    invalidateAll: () => {},
    setIgnorePatterns: () => {},
    size: () => entries.length,
  } as unknown as FileIndex;
}

function searchWith(entries: FileIndexEntry[] = []) {
  const { hub, call } = buildMessageHub();
  setupReferenceHandlers(hub, { sessionManager: {} as never, fileIndex: buildFileIndex(entries) });
  return (params: Record<string, unknown>) =>
    call('reference.search', { sessionId: 'sess-1', ...params }) as Promise<{
      results: Array<{ type: string; id: string; displayText: string; subtitle?: string }>;
    }>;
}

describe('reference.search handler', () => {
  describe('file/folder search', () => {
    it('returns file results from FileIndex', async () => {
      const search = searchWith([
        { path: 'src/components/Button.tsx', name: 'Button.tsx', type: 'file' },
        { path: 'src/components/Modal.tsx', name: 'Modal.tsx', type: 'file' },
      ]);

      const result = await search({ query: 'Button' });

      const fileResults = result.results.filter((r) => r.type === 'file');
      expect(fileResults).toHaveLength(1);
      expect(fileResults[0].id).toBe('src/components/Button.tsx');
      expect(fileResults[0].displayText).toBe('Button.tsx');
      expect(fileResults[0].subtitle).toBe('src/components/Button.tsx');
    });

    it('returns folder results from FileIndex', async () => {
      const search = searchWith([
        { path: 'src/components', name: 'components', type: 'folder' },
        { path: 'src/lib', name: 'lib', type: 'folder' },
      ]);

      const result = await search({ query: 'comp' });

      expect(result.results.filter((r) => r.type === 'folder')).toHaveLength(1);
    });

    it('returns nothing for the retired goal and task types', async () => {
      const search = searchWith([{ path: 'goal.ts', name: 'goal.ts', type: 'file' }]);

      const result = await search({ query: 'goal', types: ['goal', 'task'] });

      expect(result.results).toEqual([]);
    });
  });

  describe('path traversal prevention', () => {
    it('returns empty file results for queries containing ..', async () => {
      const search = searchWith([{ path: 'src/secret.ts', name: 'secret.ts', type: 'file' }]);

      const result = await search({ query: '../../etc/passwd', types: ['file', 'folder'] });

      expect(result.results).toHaveLength(0);
    });

    it('returns empty file results for absolute path queries', async () => {
      const search = searchWith([{ path: 'src/main.ts', name: 'main.ts', type: 'file' }]);

      const result = await search({ query: '/etc/passwd', types: ['file', 'folder'] });

      expect(result.results).toHaveLength(0);
    });
  });

  describe('type filtering', () => {
    it('returns only file results when types=["file"]', async () => {
      const search = searchWith([
        { path: 'src/index.ts', name: 'index.ts', type: 'file' },
        { path: 'src', name: 'src', type: 'folder' },
      ]);

      const result = await search({ query: 'index', types: ['file'] });

      expect(result.results.length).toBeGreaterThan(0);
      expect(result.results.every((r) => r.type === 'file')).toBe(true);
    });

    it('returns files and folders when types is omitted', async () => {
      const search = searchWith([
        { path: 'main.ts', name: 'main.ts', type: 'file' },
        { path: 'main', name: 'main', type: 'folder' },
      ]);

      const result = await search({ query: 'main' });

      expect(new Set(result.results.map((r) => r.type))).toEqual(new Set(['file', 'folder']));
    });
  });

  describe('input validation', () => {
    it('throws when sessionId is missing', async () => {
      const { hub, call } = buildMessageHub();
      setupReferenceHandlers(hub, { sessionManager: {} as never, fileIndex: buildFileIndex() });

      await expect(call('reference.search', { query: 'test' })).rejects.toThrow(
        'sessionId is required'
      );
    });

    it('throws when query is not a string', async () => {
      const search = searchWith();

      await expect(search({ query: 42 })).rejects.toThrow('query must be a string');
    });

    it('returns empty results for a whitespace-only query', async () => {
      const search = searchWith([{ path: 'a.ts', name: 'a.ts', type: 'file' }]);

      const result = await search({ query: '   ' });

      expect(result.results).toHaveLength(0);
    });
  });
});

describe('REFERENCE_PATTERN', () => {
  it('matches @ref{task:t-42}', () => {
    REFERENCE_PATTERN.lastIndex = 0;
    const match = REFERENCE_PATTERN.exec('@ref{task:t-42}');
    expect(match).not.toBeNull();
    expect(match![1]).toBe('task');
    expect(match![2]).toBe('t-42');
  });

  it('matches @ref{goal:g-7}', () => {
    REFERENCE_PATTERN.lastIndex = 0;
    const match = REFERENCE_PATTERN.exec('@ref{goal:g-7}');
    expect(match).not.toBeNull();
    expect(match![1]).toBe('goal');
    expect(match![2]).toBe('g-7');
  });

  it('matches @ref{file:src/index.ts}', () => {
    REFERENCE_PATTERN.lastIndex = 0;
    const match = REFERENCE_PATTERN.exec('@ref{file:src/index.ts}');
    expect(match).not.toBeNull();
    expect(match![1]).toBe('file');
    expect(match![2]).toBe('src/index.ts');
  });

  it('matches @ref{folder:packages/daemon}', () => {
    REFERENCE_PATTERN.lastIndex = 0;
    const match = REFERENCE_PATTERN.exec('@ref{folder:packages/daemon}');
    expect(match).not.toBeNull();
    expect(match![1]).toBe('folder');
    expect(match![2]).toBe('packages/daemon');
  });

  it('does not match plain @mentions', () => {
    REFERENCE_PATTERN.lastIndex = 0;
    const match = REFERENCE_PATTERN.exec('@username');
    expect(match).toBeNull();
  });

  it('does not match markdown links', () => {
    REFERENCE_PATTERN.lastIndex = 0;
    const match = REFERENCE_PATTERN.exec('[link](https://example.com)');
    expect(match).toBeNull();
  });

  it('matches multiple references in a string via matchAll', () => {
    const text = 'Fix @ref{task:t-1} related to @ref{goal:g-2}';
    const matches = [...text.matchAll(/@ref\{([^}:]+):([^}]+)\}/g)];
    expect(matches).toHaveLength(2);
    expect(matches[0][1]).toBe('task');
    expect(matches[1][1]).toBe('goal');
  });
});
