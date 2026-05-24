/**
 * Scoped Invalidation Tests
 *
 * Tests for the scope-aware live-query invalidation feature:
 * - TableChangeScope extraction from ReactiveDatabase proxy
 * - Scope-based filtering in LiveQueryEngine
 * - Fallback to full reevaluation when scope is absent
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import { Database as BunDatabase } from 'bun:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Database } from '../../../../src/storage/index';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import type {
  ReactiveDatabase,
  TableChangeScope,
  TableChangeEvent,
} from '../../../../src/storage/reactive-database';
import { LiveQueryEngine } from '../../../../src/storage/live-query';
import type { QueryDiff } from '../../../../src/storage/live-query';
import type { Session, SessionConfig, SessionMetadata } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  return join(tmpdir(), `scoped-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeSession(
  id: string,
  context?: Session['context'],
  type: Session['type'] = 'worker'
): Session {
  const now = new Date().toISOString();
  const config: SessionConfig = {
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 4096,
    temperature: 0.7,
  };
  const metadata: SessionMetadata = {
    messageCount: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalCost: 0,
    toolCallCount: 0,
  };
  return {
    id,
    title: `Session ${id}`,
    workspacePath: '/workspace/test',
    createdAt: now,
    lastActiveAt: now,
    status: 'active',
    config,
    metadata,
    type,
    context,
  };
}

/** Create a mock ReactiveDatabase that can fire scoped change events. */
function createMockReactiveDatabase() {
  const emitter = new EventEmitter();
  const versions: Record<string, number> = {};

  return {
    on(
      event: 'change',
      listener: (data: {
        tables: string[];
        versions: Record<string, number>;
        scope?: TableChangeScope;
      }) => void
    ): void {
      emitter.on(event, listener);
    },
    off(event: string, listener: (...args: unknown[]) => void): void {
      emitter.off(event, listener);
    },
    getTableVersion(table: string): number {
      return versions[table] ?? 0;
    },
    /** Bump version and fire change event with optional scope. */
    bumpAndFire(table: string, scope?: TableChangeScope): void {
      versions[table] = (versions[table] ?? 0) + 1;
      const v = versions[table];
      emitter.emit('change', { tables: [table], versions: { [table]: v }, scope });
    },
  };
}

// ---------------------------------------------------------------------------
// Tests: ReactiveDatabase scope extraction
// ---------------------------------------------------------------------------

describe('ReactiveDatabase — scope extraction', () => {
  let dbPath: string;
  let db: Database;
  let reactiveDb: ReactiveDatabase;

  beforeEach(async () => {
    dbPath = makeTempDbPath();
    db = new Database(dbPath);
    reactiveDb = createReactiveDatabase(db);
    await db.initialize(reactiveDb);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    try {
      rmSync(dbPath, { force: true });
      rmSync(dbPath + '-wal', { force: true });
      rmSync(dbPath + '-shm', { force: true });
    } catch {
      // ignore
    }
  });

  test('saveSDKMessage emits change event with sessionId scope', () => {
    const events: TableChangeEvent[] = [];
    reactiveDb.on('change', (data) => events.push(data));

    reactiveDb.db.createSession(makeSession('sess-1'));
    const message = {
      type: 'assistant',
      uuid: 'test-uuid',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    };
    reactiveDb.db.saveSDKMessage('sess-1', message as any);

    // First event is for sessions (no scope), second is sdk_messages with scope
    const sdkEvent = events.find((e) => e.tables.includes('sdk_messages'));
    expect(sdkEvent).toBeDefined();
    expect(sdkEvent!.scope).toEqual({ sessionId: 'sess-1' });
  });

  test('saveUserMessage emits change event with sessionId scope', () => {
    const events: TableChangeEvent[] = [];
    reactiveDb.on('change', (data) => events.push(data));

    reactiveDb.db.createSession(makeSession('sess-2'));
    const userMsg = {
      type: 'user',
      uuid: 'test-uuid-2',
      session_id: 'sess-2',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    };
    reactiveDb.db.saveUserMessage('sess-2', userMsg as any, 'consumed');

    const sdkEvent = events.find((e) => e.tables.includes('sdk_messages'));
    expect(sdkEvent).toBeDefined();
    expect(sdkEvent!.scope).toEqual({ sessionId: 'sess-2' });
  });

  test('deleteMessagesAfter emits change event with sessionId scope', () => {
    const events: TableChangeEvent[] = [];
    reactiveDb.on('change', (data) => events.push(data));

    reactiveDb.db.createSession(makeSession('sess-3'));
    reactiveDb.db.deleteMessagesAfter('sess-3', Date.now());

    const sdkEvent = events.find((e) => e.tables.includes('sdk_messages'));
    expect(sdkEvent).toBeDefined();
    expect(sdkEvent!.scope).toEqual({ sessionId: 'sess-3' });
  });

  test('updateMessageStatus emits scope when message ids resolve to one scope', () => {
    const events: TableChangeEvent[] = [];
    reactiveDb.on('change', (data) => events.push(data));

    reactiveDb.db.createSession(makeSession('sess-status', { taskId: 'task-status' }));
    const messageId = reactiveDb.db.saveUserMessage(
      'sess-status',
      {
        type: 'user',
        uuid: 'test-uuid-status',
        session_id: 'sess-status',
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: 'status' }] },
      } as any,
      'enqueued'
    );
    events.length = 0;

    reactiveDb.db.updateMessageStatus([messageId], 'consumed');

    const sdkEvent = events.find((e) => e.tables.includes('sdk_messages'));
    expect(sdkEvent).toBeDefined();
    expect(sdkEvent!.scope).toEqual({ sessionId: 'sess-status', taskId: 'task-status' });
  });

  test('change:<table> event includes scope', () => {
    const events: Array<{ table: string; version: number; scope?: TableChangeScope }> = [];
    reactiveDb.on('change:sdk_messages', (data) => events.push(data));

    reactiveDb.db.createSession(makeSession('sess-4'));
    const message = {
      type: 'assistant',
      uuid: 'test-uuid-4',
      session_id: 'sess-4',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'test' }] },
    };
    reactiveDb.db.saveSDKMessage('sess-4', message as any);

    // Should find the sdk_messages per-table event with scope
    const scopedEvent = events.find((e) => e.scope?.sessionId === 'sess-4');
    expect(scopedEvent).toBeDefined();
    expect(scopedEvent!.scope).toEqual({ sessionId: 'sess-4' });
  });

  test('transaction flush preserves compatible scope', () => {
    const events: TableChangeEvent[] = [];
    reactiveDb.on('change', (data) => events.push(data));

    reactiveDb.db.createSession(makeSession('sess-5'));

    reactiveDb.beginTransaction();
    const message = {
      type: 'assistant',
      uuid: 'test-uuid-5',
      session_id: 'sess-5',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'tx' }] },
    };
    reactiveDb.db.saveSDKMessage('sess-5', message as any);
    reactiveDb.commitTransaction();

    const txEvent = events[events.length - 1];
    expect(txEvent.scope).toEqual({ sessionId: 'sess-5' });
  });

  test('sdk message scope includes taskId for task sessions', () => {
    const events: TableChangeEvent[] = [];
    reactiveDb.on('change', (data) => events.push(data));

    reactiveDb.db.createSession(makeSession('sess-task', { taskId: 'task-1' }));
    const message = {
      type: 'assistant',
      uuid: 'test-uuid-task',
      session_id: 'sess-task',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'task' }] },
    };
    reactiveDb.db.saveSDKMessage('sess-task', message as any);

    const sdkEvent = events.find((e) => e.tables.includes('sdk_messages'));
    expect(sdkEvent).toBeDefined();
    expect(sdkEvent!.scope).toEqual({ sessionId: 'sess-task', taskId: 'task-1' });
  });

  test('transaction flush drops scope for mixed sessions', () => {
    const events: TableChangeEvent[] = [];
    reactiveDb.on('change', (data) => events.push(data));

    reactiveDb.db.createSession(makeSession('sess-a', { taskId: 'task-a' }));
    reactiveDb.db.createSession(makeSession('sess-b', { taskId: 'task-b' }));

    reactiveDb.beginTransaction();
    reactiveDb.db.saveSDKMessage('sess-a', {
      type: 'assistant',
      uuid: 'test-uuid-a',
      session_id: 'sess-a',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    } as any);
    reactiveDb.db.saveSDKMessage('sess-b', {
      type: 'assistant',
      uuid: 'test-uuid-b',
      session_id: 'sess-b',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    } as any);
    reactiveDb.commitTransaction();

    const txEvent = events[events.length - 1];
    expect(txEvent.scope).toBeUndefined();
  });

  test('createSession carries scope derived from the session record', () => {
    const events: TableChangeEvent[] = [];
    reactiveDb.on('change', (data) => events.push(data));

    reactiveDb.db.createSession(
      makeSession('sess-with-scope', {
        roomId: 'room-1',
        spaceId: 'space-1',
        taskId: 'task-1',
      })
    );

    const sessionEvent = events.find((e) => e.tables.includes('sessions'));
    expect(sessionEvent).toBeDefined();
    expect(sessionEvent!.scope).toEqual({
      sessionId: 'sess-with-scope',
      sessionType: 'worker',
      roomId: 'room-1',
      spaceId: 'space-1',
      taskId: 'task-1',
    });
  });

  test('createSession scope omits unset context fields', () => {
    const events: TableChangeEvent[] = [];
    reactiveDb.on('change', (data) => events.push(data));

    reactiveDb.db.createSession(makeSession('sess-no-context'));

    const sessionEvent = events.find((e) => e.tables.includes('sessions'));
    expect(sessionEvent).toBeDefined();
    expect(sessionEvent!.scope).toEqual({
      sessionId: 'sess-no-context',
      sessionType: 'worker',
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: LiveQueryEngine scope filtering
// ---------------------------------------------------------------------------

describe('LiveQueryEngine — scope filtering', () => {
  let db: BunDatabase;
  let mockReactive: ReturnType<typeof createMockReactiveDatabase>;
  let engine: LiveQueryEngine;

  const SQL_SESSION_A = 'SELECT id, name FROM items WHERE session_id = ? ORDER BY id';
  const SQL_SESSION_B = 'SELECT id, name FROM items WHERE session_id = ? ORDER BY id';

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    db.exec(`
			CREATE TABLE items (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				session_id TEXT NOT NULL
			);
		`);
    mockReactive = createMockReactiveDatabase();
    engine = new LiveQueryEngine(db, mockReactive as any);
  });

  afterEach(() => {
    engine.dispose();
    db.close();
  });

  test('scoped change only re-evaluates matching query', async () => {
    // Set up data for two sessions
    db.exec(`INSERT INTO items (id, name, session_id) VALUES ('a1', 'Alpha', 'sess-A')`);
    db.exec(`INSERT INTO items (id, name, session_id) VALUES ('b1', 'Beta', 'sess-B')`);

    const diffsA: QueryDiff<{ id: string; name: string }>[] = [];
    const diffsB: QueryDiff<{ id: string; name: string }>[] = [];

    // Subscribe for both sessions with scope filters
    engine.subscribe(SQL_SESSION_A, ['sess-A'], (diff) => diffsA.push(diff), {
      scopeFilter: (scope) => {
        if (!scope.sessionId) return true;
        return scope.sessionId === 'sess-A';
      },
    });
    engine.subscribe(SQL_SESSION_B, ['sess-B'], (diff) => diffsB.push(diff), {
      scopeFilter: (scope) => {
        if (!scope.sessionId) return true;
        return scope.sessionId === 'sess-B';
      },
    });

    // Both should have initial snapshots
    expect(diffsA.length).toBe(1);
    expect(diffsB.length).toBe(1);

    // Write for sess-A
    db.exec(`INSERT INTO items (id, name, session_id) VALUES ('a2', 'Alpha2', 'sess-A')`);
    mockReactive.bumpAndFire('items', { sessionId: 'sess-A' });

    await Promise.resolve();

    // Only sess-A should have a delta
    expect(diffsA.length).toBe(2);
    expect(diffsB.length).toBe(1); // No change for sess-B
  });

  test('unscoped change re-evaluates all queries (fallback)', async () => {
    db.exec(`INSERT INTO items (id, name, session_id) VALUES ('a1', 'Alpha', 'sess-A')`);
    db.exec(`INSERT INTO items (id, name, session_id) VALUES ('b1', 'Beta', 'sess-B')`);

    const diffsA: QueryDiff<{ id: string; name: string }>[] = [];
    const diffsB: QueryDiff<{ id: string; name: string }>[] = [];

    engine.subscribe(SQL_SESSION_A, ['sess-A'], (diff) => diffsA.push(diff), {
      scopeFilter: (scope) => {
        if (!scope.sessionId) return true;
        return scope.sessionId === 'sess-A';
      },
    });
    engine.subscribe(SQL_SESSION_B, ['sess-B'], (diff) => diffsB.push(diff), {
      scopeFilter: (scope) => {
        if (!scope.sessionId) return true;
        return scope.sessionId === 'sess-B';
      },
    });

    // Write for sess-A without scope — both queries should be re-evaluated
    db.exec(`INSERT INTO items (id, name, session_id) VALUES ('a2', 'Alpha2', 'sess-A')`);
    mockReactive.bumpAndFire('items'); // no scope → both queries re-evaluate

    await Promise.resolve();

    // sess-A sees new data → delta
    expect(diffsA.length).toBe(2);
    expect(diffsA[1].type).toBe('delta');
    // sess-B is re-evaluated but data is unchanged → no callback (hash dedup)
    // This is the expected behavior: unscoped changes always trigger re-evaluation
    expect(diffsB.length).toBe(1);
  });

  test('query without scopeFilter is always re-evaluated', async () => {
    db.exec(`INSERT INTO items (id, name, session_id) VALUES ('a1', 'Alpha', 'sess-A')`);

    const diffs: QueryDiff<{ id: string; name: string }>[] = [];

    engine.subscribe(SQL_SESSION_A, ['sess-A'], (diff) => diffs.push(diff));
    // No scopeFilter — always re-evaluate

    expect(diffs.length).toBe(1);

    // Change for sess-A with scoped event — should re-evaluate and produce delta
    db.exec(`INSERT INTO items (id, name, session_id) VALUES ('a2', 'Alpha2', 'sess-A')`);
    mockReactive.bumpAndFire('items', { sessionId: 'sess-A' });

    await Promise.resolve();

    // Without scopeFilter, the query is always re-evaluated regardless of scope
    expect(diffs.length).toBe(2);
    expect(diffs[1].type).toBe('delta');
  });

  test('scopeFilter=false for unrelated session prevents re-evaluation', async () => {
    db.exec(`INSERT INTO items (id, name, session_id) VALUES ('a1', 'Alpha', 'sess-A')`);

    let evalCount = 0;
    const diffs: QueryDiff<{ id: string; name: string }>[] = [];

    engine.subscribe(
      SQL_SESSION_A,
      ['sess-A'],
      (diff) => {
        evalCount++;
        diffs.push(diff);
      },
      {
        scopeFilter: (scope) => {
          if (!scope.sessionId) return true;
          return scope.sessionId === 'sess-A';
        },
      }
    );

    expect(diffs.length).toBe(1); // initial snapshot

    // Write 10 messages for a completely different session
    for (let i = 0; i < 10; i++) {
      db.exec(`INSERT INTO items (id, name, session_id) VALUES ('x${i}', 'X${i}', 'sess-X')`);
      mockReactive.bumpAndFire('items', { sessionId: 'sess-X' });
    }

    await Promise.resolve();

    // Should still be just the snapshot — no deltas from unrelated session
    expect(diffs.length).toBe(1);
  });

  test('scoped change triggers delta when scope matches', async () => {
    db.exec(`INSERT INTO items (id, name, session_id) VALUES ('a1', 'Alpha', 'sess-A')`);

    const diffs: QueryDiff<{ id: string; name: string }>[] = [];
    engine.subscribe(SQL_SESSION_A, ['sess-A'], (diff) => diffs.push(diff), {
      scopeFilter: (scope) => {
        if (!scope.sessionId) return true;
        return scope.sessionId === 'sess-A';
      },
    });

    expect(diffs.length).toBe(1);

    // Write for sess-A — should trigger re-evaluation
    db.exec(`INSERT INTO items (id, name, session_id) VALUES ('a2', 'Alpha2', 'sess-A')`);
    mockReactive.bumpAndFire('items', { sessionId: 'sess-A' });

    await Promise.resolve();

    expect(diffs.length).toBe(2);
    expect(diffs[1].type).toBe('delta');
    expect(diffs[1].added?.length).toBe(1);
    expect(diffs[1].added?.[0].id).toBe('a2');
  });

  test('multiple scope-filtered queries react independently', async () => {
    db.exec(`INSERT INTO items (id, name, session_id) VALUES ('a1', 'Alpha', 'sess-A')`);
    db.exec(`INSERT INTO items (id, name, session_id) VALUES ('b1', 'Beta', 'sess-B')`);
    db.exec(`INSERT INTO items (id, name, session_id) VALUES ('c1', 'Charlie', 'sess-C')`);

    const diffsA: QueryDiff<{ id: string; name: string }>[] = [];
    const diffsB: QueryDiff<{ id: string; name: string }>[] = [];
    const diffsC: QueryDiff<{ id: string; name: string }>[] = [];

    engine.subscribe(SQL_SESSION_A, ['sess-A'], (diff) => diffsA.push(diff), {
      scopeFilter: (s) => !s.sessionId || s.sessionId === 'sess-A',
    });
    engine.subscribe(SQL_SESSION_A, ['sess-B'], (diff) => diffsB.push(diff), {
      scopeFilter: (s) => !s.sessionId || s.sessionId === 'sess-B',
    });
    engine.subscribe(SQL_SESSION_A, ['sess-C'], (diff) => diffsC.push(diff), {
      scopeFilter: (s) => !s.sessionId || s.sessionId === 'sess-C',
    });

    // Write for sess-B
    db.exec(`INSERT INTO items (id, name, session_id) VALUES ('b2', 'Beta2', 'sess-B')`);
    mockReactive.bumpAndFire('items', { sessionId: 'sess-B' });

    await Promise.resolve();

    expect(diffsA.length).toBe(1); // Only snapshot
    expect(diffsB.length).toBe(2); // Snapshot + delta
    expect(diffsC.length).toBe(1); // Only snapshot
  });
});
