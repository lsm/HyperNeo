import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../src/storage/sqlite-compat';
import type { MessageHub } from '@hyperneo/shared';
import { REFERENCE_PATTERN } from '@hyperneo/shared';
import { setupReferenceHandlers } from '../../../src/lib/rpc-handlers/reference-handlers';
import type { ReferenceHandlerDeps } from '../../../src/lib/rpc-handlers/reference-handlers';
import type { FileIndex, FileIndexEntry } from '../../../src/lib/file-index';
import type { ReactiveDatabase } from '../../../src/storage/reactive-database';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
		CREATE TABLE IF NOT EXISTS rooms (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			background_context TEXT,
			instructions TEXT,
			allowed_paths TEXT DEFAULT '[]',
			default_path TEXT,
			default_model TEXT,
			allowed_models TEXT DEFAULT '[]',
			session_ids TEXT DEFAULT '[]',
			status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);

  db.exec(`
		CREATE TABLE IF NOT EXISTS goals (
			id TEXT PRIMARY KEY,
			room_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'needs_human', 'completed', 'archived')),
			priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),
			progress INTEGER DEFAULT 0,
			linked_task_ids TEXT DEFAULT '[]',
			metrics TEXT DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			completed_at INTEGER,
			planning_attempts INTEGER DEFAULT 0,
			goal_review_attempts INTEGER DEFAULT 0,
			mission_type TEXT NOT NULL DEFAULT 'one_shot' CHECK(mission_type IN ('one_shot', 'measurable', 'recurring')),
			autonomy_level TEXT NOT NULL DEFAULT 'supervised' CHECK(autonomy_level IN ('supervised', 'semi_autonomous')),
			schedule TEXT,
			schedule_paused INTEGER NOT NULL DEFAULT 0,
			next_run_at INTEGER,
			structured_metrics TEXT,
			max_consecutive_failures INTEGER NOT NULL DEFAULT 3,
			max_planning_attempts INTEGER NOT NULL DEFAULT 0,
			consecutive_failures INTEGER NOT NULL DEFAULT 0,
			replan_count INTEGER NOT NULL DEFAULT 0,
			short_id TEXT,
			FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
		)
	`);

  db.exec(`
		CREATE TABLE IF NOT EXISTS short_id_counters (
			entity_type TEXT NOT NULL,
			scope_id TEXT NOT NULL,
			counter INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (entity_type, scope_id)
		)
	`);

  return db;
}

function insertRoom(db: Database, id: string, name = 'Test Room'): void {
  const now = Date.now();
  db.prepare(`INSERT INTO rooms (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(
    id,
    name,
    now,
    now
  );
}

function insertGoal(
  db: Database,
  roomId: string,
  id: string,
  title: string,
  shortId?: string,
  status = 'active'
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO goals (id, room_id, title, status, created_at, updated_at, short_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, roomId, title, status, now, now, shortId ?? null);
}

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

function buildReactiveDb(): ReactiveDatabase {
  return { notifyChange: () => {} } as unknown as ReactiveDatabase;
}

function buildShortIdAllocator() {
  return { allocate: () => null } as never;
}

function buildSessionManager(sessionMap: Map<string, { roomId?: string }>) {
  return {
    getSessionFromDB: (sessionId: string) => {
      const entry = sessionMap.get(sessionId);
      if (!entry) return null;
      return { context: { roomId: entry.roomId } };
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

describe('reference.search handler', () => {
  let db: Database;
  let roomId: string;

  beforeEach(() => {
    db = createTestDb();
    roomId = 'room-test-001';
    insertRoom(db, roomId);
  });

  afterEach(() => {
    db.close();
  });

  describe('goal search', () => {
    it('returns goals matching the query', async () => {
      insertGoal(db, roomId, 'goal-1', 'Improve code quality', 'g-1');
      insertGoal(db, roomId, 'goal-2', 'Launch new feature', 'g-2');

      const sessions = new Map([['sess-1', { roomId }]]);
      const { hub, call } = buildMessageHub();
      setupReferenceHandlers(hub, {
        db: db as never,
        reactiveDb: buildReactiveDb(),
        shortIdAllocator: buildShortIdAllocator(),
        sessionManager: buildSessionManager(sessions) as never,
        fileIndex: buildFileIndex(),
      });

      const result = (await call('reference.search', {
        sessionId: 'sess-1',
        query: 'code',
      })) as { results: Array<{ type: string; id: string }> };

      expect(result.results.filter((r) => r.type === 'goal')).toHaveLength(1);
      expect(result.results[0].id).toBe('goal-1');
    });

    it('includes goal status as subtitle', async () => {
      insertGoal(db, roomId, 'goal-1', 'Ship MVP', 'g-1', 'completed');

      const sessions = new Map([['sess-1', { roomId }]]);
      const { hub, call } = buildMessageHub();
      setupReferenceHandlers(hub, {
        db: db as never,
        reactiveDb: buildReactiveDb(),
        shortIdAllocator: buildShortIdAllocator(),
        sessionManager: buildSessionManager(sessions) as never,
        fileIndex: buildFileIndex(),
      });

      const result = (await call('reference.search', {
        sessionId: 'sess-1',
        query: 'Ship',
      })) as { results: Array<{ subtitle?: string }> };

      expect(result.results[0].subtitle).toBe('completed');
    });
  });

  describe('file/folder search', () => {
    it('returns file results from FileIndex', async () => {
      const files: FileIndexEntry[] = [
        { path: 'src/components/Button.tsx', name: 'Button.tsx', type: 'file' },
        { path: 'src/components/Modal.tsx', name: 'Modal.tsx', type: 'file' },
      ];

      const sessions = new Map([['sess-1', { roomId: undefined }]]);
      const { hub, call } = buildMessageHub();
      setupReferenceHandlers(hub, {
        db: db as never,
        reactiveDb: buildReactiveDb(),
        shortIdAllocator: buildShortIdAllocator(),
        sessionManager: buildSessionManager(sessions) as never,
        fileIndex: buildFileIndex(files),
      });

      const result = (await call('reference.search', {
        sessionId: 'sess-1',
        query: 'Button',
      })) as {
        results: Array<{ type: string; id: string; displayText: string; subtitle: string }>;
      };

      const fileResults = result.results.filter((r) => r.type === 'file');
      expect(fileResults).toHaveLength(1);
      expect(fileResults[0].id).toBe('src/components/Button.tsx');
      expect(fileResults[0].displayText).toBe('Button.tsx');
      expect(fileResults[0].subtitle).toBe('src/components/Button.tsx');
    });

    it('returns folder results from FileIndex', async () => {
      const entries: FileIndexEntry[] = [
        { path: 'src/components', name: 'components', type: 'folder' },
        { path: 'src/lib', name: 'lib', type: 'folder' },
      ];

      const sessions = new Map([['sess-1', {}]]);
      const { hub, call } = buildMessageHub();
      setupReferenceHandlers(hub, {
        db: db as never,
        reactiveDb: buildReactiveDb(),
        shortIdAllocator: buildShortIdAllocator(),
        sessionManager: buildSessionManager(sessions) as never,
        fileIndex: buildFileIndex(entries),
      });

      const result = (await call('reference.search', {
        sessionId: 'sess-1',
        query: 'comp',
      })) as { results: Array<{ type: string }> };

      const folderResults = result.results.filter((r) => r.type === 'folder');
      expect(folderResults).toHaveLength(1);
    });

    it('always returns file/folder results even for sessions without room context', async () => {
      const files: FileIndexEntry[] = [{ path: 'README.md', name: 'README.md', type: 'file' }];

      const sessions = new Map([['sess-standalone', {}]]);
      const { hub, call } = buildMessageHub();
      setupReferenceHandlers(hub, {
        db: db as never,
        reactiveDb: buildReactiveDb(),
        shortIdAllocator: buildShortIdAllocator(),
        sessionManager: buildSessionManager(sessions) as never,
        fileIndex: buildFileIndex(files),
      });

      const result = (await call('reference.search', {
        sessionId: 'sess-standalone',
        query: 'README',
      })) as { results: Array<{ type: string }> };

      expect(result.results.filter((r) => r.type === 'file')).toHaveLength(1);
    });
  });

  describe('standalone sessions (no room context)', () => {
    it('returns no goal results for sessions without roomId', async () => {
      insertGoal(db, roomId, 'goal-1', 'Some goal', 'g-1');

      const sessions = new Map([['sess-standalone', {}]]);
      const { hub, call } = buildMessageHub();
      setupReferenceHandlers(hub, {
        db: db as never,
        reactiveDb: buildReactiveDb(),
        shortIdAllocator: buildShortIdAllocator(),
        sessionManager: buildSessionManager(sessions) as never,
        fileIndex: buildFileIndex(),
      });

      const result = (await call('reference.search', {
        sessionId: 'sess-standalone',
        query: 'Some',
      })) as { results: Array<{ type: string }> };

      expect(result.results.filter((r) => r.type === 'goal')).toHaveLength(0);
    });

    it('does not throw for unknown sessionId', async () => {
      const sessions = new Map<string, { roomId?: string }>();
      const { hub, call } = buildMessageHub();
      setupReferenceHandlers(hub, {
        db: db as never,
        reactiveDb: buildReactiveDb(),
        shortIdAllocator: buildShortIdAllocator(),
        sessionManager: buildSessionManager(sessions) as never,
        fileIndex: buildFileIndex(),
      });

      const result = (await call('reference.search', {
        sessionId: 'unknown-session',
        query: 'anything',
      })) as { results: unknown[] };

      expect(result.results).toHaveLength(0);
    });
  });

  describe('path traversal prevention', () => {
    it('returns empty file results for queries containing ..', async () => {
      const files: FileIndexEntry[] = [{ path: 'src/secret.ts', name: 'secret.ts', type: 'file' }];

      const sessions = new Map([['sess-1', {}]]);
      const { hub, call } = buildMessageHub();
      setupReferenceHandlers(hub, {
        db: db as never,
        reactiveDb: buildReactiveDb(),
        shortIdAllocator: buildShortIdAllocator(),
        sessionManager: buildSessionManager(sessions) as never,
        fileIndex: buildFileIndex(files),
      });

      const result = (await call('reference.search', {
        sessionId: 'sess-1',
        query: '../../etc/passwd',
        types: ['file', 'folder'],
      })) as { results: unknown[] };

      expect(result.results).toHaveLength(0);
    });

    it('returns empty file results for absolute path queries', async () => {
      const files: FileIndexEntry[] = [{ path: 'src/main.ts', name: 'main.ts', type: 'file' }];

      const sessions = new Map([['sess-1', {}]]);
      const { hub, call } = buildMessageHub();
      setupReferenceHandlers(hub, {
        db: db as never,
        reactiveDb: buildReactiveDb(),
        shortIdAllocator: buildShortIdAllocator(),
        sessionManager: buildSessionManager(sessions) as never,
        fileIndex: buildFileIndex(files),
      });

      const result = (await call('reference.search', {
        sessionId: 'sess-1',
        query: '/etc/passwd',
        types: ['file', 'folder'],
      })) as { results: unknown[] };

      expect(result.results).toHaveLength(0);
    });

    it('traversal guard is in the file/folder branch — goal search is unaffected', async () => {
      insertGoal(db, roomId, 'goal-1', 'traversal fix', 'g-1');
      insertGoal(db, roomId, 'goal-2', 'other goal', 'g-2');

      const sessions = new Map([['sess-1', { roomId }]]);
      const { hub, call } = buildMessageHub();
      setupReferenceHandlers(hub, {
        db: db as never,
        reactiveDb: buildReactiveDb(),
        shortIdAllocator: buildShortIdAllocator(),
        sessionManager: buildSessionManager(sessions) as never,
        fileIndex: buildFileIndex(),
      });

      const resultGoal = (await call('reference.search', {
        sessionId: 'sess-1',
        query: 'traversal',
        types: ['goal'],
      })) as { results: Array<{ type: string; id: string }> };
      expect(resultGoal.results.filter((r) => r.type === 'goal')).toHaveLength(1);
      expect(resultGoal.results[0].id).toBe('goal-1');

      const resultMixed = (await call('reference.search', {
        sessionId: 'sess-1',
        query: 'traversal',
        types: ['goal', 'file'],
      })) as { results: Array<{ type: string }> };
      expect(resultMixed.results.filter((r) => r.type === 'goal')).toHaveLength(1);
      expect(resultMixed.results.filter((r) => r.type === 'file')).toHaveLength(0);
    });
  });

  describe('type filtering', () => {
    it('returns only goal results when types=["goal"]', async () => {
      insertGoal(db, roomId, 'goal-1', 'Auth goal', 'g-1');
      const files: FileIndexEntry[] = [{ path: 'auth.ts', name: 'auth.ts', type: 'file' }];

      const sessions = new Map([['sess-1', { roomId }]]);
      const { hub, call } = buildMessageHub();
      setupReferenceHandlers(hub, {
        db: db as never,
        reactiveDb: buildReactiveDb(),
        shortIdAllocator: buildShortIdAllocator(),
        sessionManager: buildSessionManager(sessions) as never,
        fileIndex: buildFileIndex(files),
      });

      const result = (await call('reference.search', {
        sessionId: 'sess-1',
        query: 'Auth',
        types: ['goal'],
      })) as { results: Array<{ type: string }> };

      expect(result.results.every((r) => r.type === 'goal')).toBe(true);
      expect(result.results).toHaveLength(1);
    });

    it('returns only file results when types=["file"]', async () => {
      insertGoal(db, roomId, 'goal-1', 'index goal', 'g-1');
      const files: FileIndexEntry[] = [
        { path: 'src/index.ts', name: 'index.ts', type: 'file' },
        { path: 'src', name: 'src', type: 'folder' },
      ];

      const sessions = new Map([['sess-1', { roomId }]]);
      const { hub, call } = buildMessageHub();
      setupReferenceHandlers(hub, {
        db: db as never,
        reactiveDb: buildReactiveDb(),
        shortIdAllocator: buildShortIdAllocator(),
        sessionManager: buildSessionManager(sessions) as never,
        fileIndex: buildFileIndex(files),
      });

      const result = (await call('reference.search', {
        sessionId: 'sess-1',
        query: 'index',
        types: ['file'],
      })) as { results: Array<{ type: string }> };

      expect(result.results.every((r) => r.type === 'file')).toBe(true);
    });

    it('returns all types when types is omitted', async () => {
      insertGoal(db, roomId, 'goal-1', 'main goal', 'g-1');
      const files: FileIndexEntry[] = [
        { path: 'main.ts', name: 'main.ts', type: 'file' },
        { path: 'src', name: 'src', type: 'folder' },
      ];

      const sessions = new Map([['sess-1', { roomId }]]);
      const { hub, call } = buildMessageHub();
      setupReferenceHandlers(hub, {
        db: db as never,
        reactiveDb: buildReactiveDb(),
        shortIdAllocator: buildShortIdAllocator(),
        sessionManager: buildSessionManager(sessions) as never,
        fileIndex: buildFileIndex(files),
      });

      const result = (await call('reference.search', {
        sessionId: 'sess-1',
        query: 'main',
      })) as { results: Array<{ type: string }> };

      const types = new Set(result.results.map((r) => r.type));
      expect(types.has('task')).toBe(false);
      expect(types.has('goal')).toBe(true);
      expect(types.has('file')).toBe(true);
    });
  });

  describe('relevance sorting', () => {
    it('sorts exact name match above starts-with above contains', async () => {
      insertGoal(db, roomId, 'goal-1', 'login', 'g-1');
      insertGoal(db, roomId, 'goal-2', 'login page', 'g-2');
      insertGoal(db, roomId, 'goal-3', 'fix login bug', 'g-3');

      const sessions = new Map([['sess-1', { roomId }]]);
      const { hub, call } = buildMessageHub();
      setupReferenceHandlers(hub, {
        db: db as never,
        reactiveDb: buildReactiveDb(),
        shortIdAllocator: buildShortIdAllocator(),
        sessionManager: buildSessionManager(sessions) as never,
        fileIndex: buildFileIndex(),
      });

      const result = (await call('reference.search', {
        sessionId: 'sess-1',
        query: 'login',
        types: ['goal'],
      })) as { results: Array<{ id: string }> };

      expect(result.results[0].id).toBe('goal-1');
      expect(result.results[1].id).toBe('goal-2');
      expect(result.results[2].id).toBe('goal-3');
    });
  });

  describe('input validation', () => {
    it('throws when sessionId is missing', async () => {
      const { hub, call } = buildMessageHub();
      setupReferenceHandlers(hub, {
        db: db as never,
        reactiveDb: buildReactiveDb(),
        shortIdAllocator: buildShortIdAllocator(),
        sessionManager: buildSessionManager(new Map()) as never,
        fileIndex: buildFileIndex(),
      });

      await expect(call('reference.search', { query: 'test' })).rejects.toThrow(
        'sessionId is required'
      );
    });

    it('throws when query is not a string', async () => {
      const { hub, call } = buildMessageHub();
      setupReferenceHandlers(hub, {
        db: db as never,
        reactiveDb: buildReactiveDb(),
        shortIdAllocator: buildShortIdAllocator(),
        sessionManager: buildSessionManager(new Map()) as never,
        fileIndex: buildFileIndex(),
      });

      await expect(call('reference.search', { sessionId: 'sess-1', query: 42 })).rejects.toThrow(
        'query must be a string'
      );
    });

    it('returns empty results for whitespace-only query without room context', async () => {
      insertGoal(db, roomId, 'goal-1', 'Some goal', 'g-1');

      const sessions = new Map();
      const { hub, call } = buildMessageHub();
      setupReferenceHandlers(hub, {
        db: db as never,
        reactiveDb: buildReactiveDb(),
        shortIdAllocator: buildShortIdAllocator(),
        sessionManager: buildSessionManager(sessions) as never,
        fileIndex: buildFileIndex(),
      });

      const result = (await call('reference.search', {
        sessionId: 'sess-1',
        query: '   ',
      })) as { results: unknown[] };

      expect(result.results).toHaveLength(0);
    });

    it('returns all goals for empty query when room context exists', async () => {
      insertGoal(db, roomId, 'goal-1', 'Some goal', 'g-1');

      const sessions = new Map([['sess-1', { roomId }]]);
      const { hub, call } = buildMessageHub();
      setupReferenceHandlers(hub, {
        db: db as never,
        reactiveDb: buildReactiveDb(),
        shortIdAllocator: buildShortIdAllocator(),
        sessionManager: buildSessionManager(sessions) as never,
        fileIndex: buildFileIndex(),
      });

      const result = (await call('reference.search', {
        sessionId: 'sess-1',
        query: '   ',
      })) as { results: Array<{ type: string }> };

      expect(result.results).toHaveLength(1);
      expect(result.results[0].type).toBe('goal');
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
