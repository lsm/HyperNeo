import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Database } from '../../../../src/storage/index';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';
import type { Session, SessionConfig, SessionMetadata } from '@hyperneo/shared';

function makeTempDbPath(): string {
  return join(tmpdir(), `reactive-db-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
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
    ...overrides,
  };
}

describe('ReactiveDatabase', () => {
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
      // ignore cleanup errors
    }
  });

  describe('change event', () => {
    test('emits change event after createSession', () => {
      const events: Array<{ tables: string[]; versions: Record<string, number> }> = [];
      reactiveDb.on('change', (data) => events.push(data));

      reactiveDb.db.createSession(makeSession('s1'));

      expect(events.length).toBe(1);
      expect(events[0].tables).toContain('sessions');
    });

    test('emits change event after updateSession', () => {
      db.createSession(makeSession('s2'));

      const events: Array<{ tables: string[] }> = [];
      reactiveDb.on('change', (data) => events.push(data));

      reactiveDb.db.updateSession('s2', { title: 'Updated' });

      expect(events.length).toBe(1);
      expect(events[0].tables).toContain('sessions');
    });

    test('emits change event after deleteSession', () => {
      db.createSession(makeSession('s3'));

      const events: Array<{ tables: string[] }> = [];
      reactiveDb.on('change', (data) => events.push(data));

      reactiveDb.db.deleteSession('s3');

      expect(events.length).toBe(1);
      expect(events[0].tables).toContain('sessions');
    });

    test('includes correct table name in event payload', () => {
      const events: Array<{ tables: string[]; versions: Record<string, number> }> = [];
      reactiveDb.on('change', (data) => events.push(data));

      reactiveDb.db.createSession(makeSession('s4'));

      expect(events[0].tables).toEqual(['sessions']);
      expect(events[0].versions).toHaveProperty('sessions');
    });

    test('does NOT emit change event for read-only getSession', () => {
      db.createSession(makeSession('s5'));

      const events: unknown[] = [];
      reactiveDb.on('change', (data) => events.push(data));

      reactiveDb.db.getSession('s5');

      expect(events.length).toBe(0);
    });

    test('does NOT emit change event for read-only listSessions', () => {
      db.createSession(makeSession('s6'));

      const events: unknown[] = [];
      reactiveDb.on('change', (data) => events.push(data));

      reactiveDb.db.listSessions();

      expect(events.length).toBe(0);
    });
  });

  describe('change event scope from persisted session context', () => {
    test('updateSession emits roomId/spaceId/taskId read from the sessions row', () => {
      db.createSession(
        makeSession('scoped-1', {
          context: { roomId: 'room-1', spaceId: 'space-1', taskId: 'task-1' },
        })
      );

      const events: Array<{ scope?: { roomId?: string; spaceId?: string; taskId?: string } }> = [];
      reactiveDb.on('change', (data) => events.push(data));

      reactiveDb.db.updateSession('scoped-1', { title: 'Updated' });

      expect(events.length).toBe(1);
      expect(events[0].scope).toEqual({
        sessionId: 'scoped-1',
        sessionType: 'worker',
        roomId: 'room-1',
        spaceId: 'space-1',
        taskId: 'task-1',
      });
    });

    test('updateSession on a contextless session emits a bare session scope', () => {
      db.createSession(makeSession('plain-1'));

      const events: Array<{ scope?: { roomId?: string; spaceId?: string; taskId?: string } }> = [];
      reactiveDb.on('change', (data) => events.push(data));

      reactiveDb.db.updateSession('plain-1', { title: 'Updated' });

      expect(events.length).toBe(1);
      expect(events[0].scope).toEqual({ sessionId: 'plain-1', sessionType: 'worker' });
    });

    test('deleteSession emits a bare session scope once the row is removed', () => {
      db.createSession(
        makeSession('scoped-2', {
          type: 'space_task_agent',
          context: { spaceId: 'space-2', taskId: 'task-2' },
        })
      );

      const events: Array<{ scope?: { spaceId?: string; taskId?: string } }> = [];
      reactiveDb.on('change', (data) => events.push(data));

      reactiveDb.db.deleteSession('scoped-2');

      expect(events.length).toBe(1);
      expect(events[0].scope).toEqual({ sessionId: 'scoped-2' });
    });
  });

  describe('change:<table> event', () => {
    test('emits change:sessions after createSession', () => {
      const events: Array<{ table: string; version: number }> = [];
      reactiveDb.on('change:sessions', (data) => events.push(data));

      reactiveDb.db.createSession(makeSession('pt1'));

      expect(events.length).toBe(1);
      expect(events[0].table).toBe('sessions');
    });

    test('per-table event includes version', () => {
      const events: Array<{ table: string; version: number }> = [];
      reactiveDb.on('change:sessions', (data) => events.push(data));

      reactiveDb.db.createSession(makeSession('pt2'));

      expect(events[0].version).toBeGreaterThan(0);
    });

    test('change:sessions fires independently of change:sdk_messages', () => {
      const sessionEvents: unknown[] = [];
      const msgEvents: unknown[] = [];
      reactiveDb.on('change:sessions', () => sessionEvents.push(1));
      reactiveDb.on('change:sdk_messages', () => msgEvents.push(1));

      reactiveDb.db.createSession(makeSession('pt3'));

      expect(sessionEvents.length).toBe(1);
      expect(msgEvents.length).toBe(0);
    });
  });

  describe('getTableVersion', () => {
    test('returns 0 before any writes', () => {
      expect(reactiveDb.getTableVersion('sessions')).toBe(0);
    });

    test('returns 1 after first write', () => {
      reactiveDb.db.createSession(makeSession('v1'));
      expect(reactiveDb.getTableVersion('sessions')).toBe(1);
    });

    test('increments monotonically on successive writes', () => {
      reactiveDb.db.createSession(makeSession('v2'));
      const v1 = reactiveDb.getTableVersion('sessions');

      reactiveDb.db.createSession(makeSession('v3'));
      const v2 = reactiveDb.getTableVersion('sessions');

      reactiveDb.db.createSession(makeSession('v4'));
      const v3 = reactiveDb.getTableVersion('sessions');

      expect(v2).toBe(v1 + 1);
      expect(v3).toBe(v2 + 1);
    });

    test('version in change event matches getTableVersion', () => {
      const events: Array<{ versions: Record<string, number> }> = [];
      reactiveDb.on('change', (data) => events.push(data));

      reactiveDb.db.createSession(makeSession('v5'));

      expect(events[0].versions['sessions']).toBe(reactiveDb.getTableVersion('sessions'));
    });

    test('tracks versions per table independently', () => {
      reactiveDb.db.createSession(makeSession('v6'));
      reactiveDb.db.createSession(makeSession('v7'));

      const sessionsVersion = reactiveDb.getTableVersion('sessions');
      const messagesVersion = reactiveDb.getTableVersion('sdk_messages');

      expect(sessionsVersion).toBe(2);
      expect(messagesVersion).toBe(0);
    });
  });

  describe('proxied db returns correct values', () => {
    test('createSession via proxied db persists data readable by getSession', () => {
      const session = makeSession('proxy1');
      reactiveDb.db.createSession(session);

      const retrieved = reactiveDb.db.getSession('proxy1');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe('proxy1');
      expect(retrieved?.title).toBe('Session proxy1');
    });

    test('updateSession via proxied db applies changes', () => {
      reactiveDb.db.createSession(makeSession('proxy2'));
      reactiveDb.db.updateSession('proxy2', { title: 'Modified' });

      const retrieved = reactiveDb.db.getSession('proxy2');
      expect(retrieved?.title).toBe('Modified');
    });

    test('deleteSession via proxied db removes session', () => {
      reactiveDb.db.createSession(makeSession('proxy3'));
      reactiveDb.db.deleteSession('proxy3');

      expect(reactiveDb.db.getSession('proxy3')).toBeNull();
    });
  });

  describe('error handling', () => {
    test('does NOT emit event when write operation throws (duplicate id)', () => {
      const session = makeSession('dup1');
      reactiveDb.db.createSession(session);

      const events: unknown[] = [];
      reactiveDb.on('change', (data) => events.push(data));

      try {
        reactiveDb.db.createSession(session);
      } catch {
        // expected
      }

      expect(reactiveDb.getTableVersion('sessions')).toBe(1);
    });
  });

  describe('beginTransaction / commitTransaction', () => {
    test('suppresses individual events during transaction', () => {
      const events: unknown[] = [];
      reactiveDb.on('change', (data) => events.push(data));

      reactiveDb.beginTransaction();
      reactiveDb.db.createSession(makeSession('tx1'));
      reactiveDb.db.createSession(makeSession('tx2'));

      expect(events.length).toBe(0);

      reactiveDb.commitTransaction();

      expect(events.length).toBe(1);
    });

    test('batched change event contains all affected tables deduplicated', () => {
      const events: Array<{ tables: string[]; versions: Record<string, number> }> = [];
      reactiveDb.on('change', (data) => events.push(data));

      reactiveDb.beginTransaction();
      reactiveDb.db.createSession(makeSession('tx3'));
      reactiveDb.db.createSession(makeSession('tx4'));
      reactiveDb.db.createSession(makeSession('tx5'));
      reactiveDb.commitTransaction();

      expect(events.length).toBe(1);
      expect(events[0].tables.filter((t) => t === 'sessions').length).toBe(1);
    });

    test('per-table change:sessions fires once on commit even with multiple writes', () => {
      const perTableEvents: unknown[] = [];
      reactiveDb.on('change:sessions', () => perTableEvents.push(1));

      reactiveDb.beginTransaction();
      reactiveDb.db.createSession(makeSession('tx6'));
      reactiveDb.db.createSession(makeSession('tx7'));
      reactiveDb.commitTransaction();

      expect(perTableEvents.length).toBe(1);
    });

    test('version increments during transaction even though events are suppressed', () => {
      reactiveDb.beginTransaction();
      reactiveDb.db.createSession(makeSession('tx8'));
      reactiveDb.db.createSession(makeSession('tx9'));
      expect(reactiveDb.getTableVersion('sessions')).toBe(2);
      reactiveDb.commitTransaction();
    });

    test('nested transactions: only outermost commit flushes events', () => {
      const events: unknown[] = [];
      reactiveDb.on('change', () => events.push(1));

      reactiveDb.beginTransaction();
      reactiveDb.beginTransaction();
      reactiveDb.db.createSession(makeSession('nested1'));
      reactiveDb.commitTransaction();
      expect(events.length).toBe(0);
      reactiveDb.commitTransaction();
      expect(events.length).toBe(1);
    });

    test('transaction methods are available on the proxied db facade', () => {
      const events: unknown[] = [];
      reactiveDb.on('change', () => events.push(1));

      reactiveDb.db.beginTransaction?.();
      reactiveDb.db.createSession(makeSession('proxied-tx1'));
      reactiveDb.db.createSession(makeSession('proxied-tx2'));
      expect(events.length).toBe(0);

      reactiveDb.db.commitTransaction?.();
      expect(events.length).toBe(1);
    });
  });

  describe('abortTransaction', () => {
    test('abortTransaction discards pending events — no change event emitted', () => {
      const events: unknown[] = [];
      reactiveDb.on('change', () => events.push(1));

      reactiveDb.beginTransaction();
      reactiveDb.db.createSession(makeSession('abort1'));
      reactiveDb.abortTransaction();

      expect(events.length).toBe(0);
    });

    test('abortTransaction does not emit per-table events', () => {
      const perTableEvents: unknown[] = [];
      reactiveDb.on('change:sessions', () => perTableEvents.push(1));

      reactiveDb.beginTransaction();
      reactiveDb.db.createSession(makeSession('abort2'));
      reactiveDb.abortTransaction();

      expect(perTableEvents.length).toBe(0);
    });

    test('nested abort: only outermost abort clears pending state', () => {
      const events: unknown[] = [];
      reactiveDb.on('change', () => events.push(1));

      reactiveDb.beginTransaction();
      reactiveDb.beginTransaction();
      reactiveDb.db.createSession(makeSession('abort3'));
      reactiveDb.abortTransaction();
      expect(events.length).toBe(0);
      reactiveDb.abortTransaction();
      expect(events.length).toBe(0);
    });

    test('versions are still incremented even on aborted transaction', () => {
      reactiveDb.beginTransaction();
      reactiveDb.db.createSession(makeSession('abort4'));
      const versionDuringTx = reactiveDb.getTableVersion('sessions');
      reactiveDb.abortTransaction();

      expect(versionDuringTx).toBe(1);
    });
  });

  describe('off()', () => {
    test('off() stops listener from receiving future events', () => {
      const events: unknown[] = [];
      const listener = () => events.push(1);

      reactiveDb.on('change', listener);
      reactiveDb.db.createSession(makeSession('off1'));
      expect(events.length).toBe(1);

      reactiveDb.off('change', listener as (...args: unknown[]) => void);
      reactiveDb.db.createSession(makeSession('off2'));
      expect(events.length).toBe(1);
    });
  });

  describe('notifyChange', () => {
    test('emits change event for arbitrary table', () => {
      const events: Array<{ tables: string[]; versions: Record<string, number> }> = [];
      reactiveDb.on('change', (data) => events.push(data));

      reactiveDb.notifyChange('tasks');

      expect(events.length).toBe(1);
      expect(events[0].tables).toContain('tasks');
    });

    test('increments version for notified table', () => {
      expect(reactiveDb.getTableVersion('tasks')).toBe(0);

      reactiveDb.notifyChange('tasks');
      expect(reactiveDb.getTableVersion('tasks')).toBe(1);

      reactiveDb.notifyChange('tasks');
      expect(reactiveDb.getTableVersion('tasks')).toBe(2);
    });

    test('emits change:<table> event with correct version', () => {
      const events: Array<{ table: string; version: number }> = [];
      reactiveDb.on('change:tasks', (data) => events.push(data));

      reactiveDb.notifyChange('tasks');

      expect(events.length).toBe(1);
      expect(events[0].table).toBe('tasks');
      expect(events[0].version).toBe(1);
    });

    test('respects transaction batching — suppressed until commit', () => {
      const events: unknown[] = [];
      reactiveDb.on('change', () => events.push(1));

      reactiveDb.beginTransaction();
      reactiveDb.notifyChange('tasks');

      expect(events.length).toBe(0);

      reactiveDb.commitTransaction();

      expect(events.length).toBe(1);
    });

    test('respects abortTransaction — events are discarded', () => {
      const events: unknown[] = [];
      reactiveDb.on('change', () => events.push(1));

      reactiveDb.beginTransaction();
      reactiveDb.notifyChange('tasks');
      reactiveDb.abortTransaction();

      expect(events.length).toBe(0);
    });

    test('deduplicates with facade writes in transaction', () => {
      db.createSession(makeSession('dedup1'));

      const events: Array<{ tables: string[] }> = [];
      reactiveDb.on('change', (data) => events.push(data));

      reactiveDb.beginTransaction();
      reactiveDb.db.updateSession('dedup1', { title: 'Updated via facade' });
      reactiveDb.notifyChange('sessions');
      reactiveDb.commitTransaction();

      expect(events.length).toBe(1);
      expect(events[0].tables.filter((t) => t === 'sessions').length).toBe(1);
    });

    test('works alongside facade events — each emits its own change event independently', () => {
      const events: Array<{ tables: string[] }> = [];
      reactiveDb.on('change', (data) => events.push(data));

      reactiveDb.notifyChange('tasks');
      reactiveDb.db.createSession(makeSession('alongside1'));

      expect(events.length).toBe(2);
      expect(events[0].tables).toContain('tasks');
      expect(events[1].tables).toContain('sessions');
    });
  });

  describe('transaction edge cases', () => {
    test('commitTransaction without beginTransaction is a no-op — no error, no events', () => {
      const events: unknown[] = [];
      reactiveDb.on('change', () => events.push(1));

      expect(() => reactiveDb.commitTransaction()).not.toThrow();

      expect(events.length).toBe(0);
    });

    test('abortTransaction without beginTransaction is a no-op — no error', () => {
      expect(() => reactiveDb.abortTransaction()).not.toThrow();
    });

    test('begin → begin → abort inner → commit outer: events ARE emitted (inner abort did not reach depth=0)', () => {
      const events: unknown[] = [];
      reactiveDb.on('change', () => events.push(1));

      reactiveDb.beginTransaction();
      reactiveDb.beginTransaction();
      reactiveDb.db.createSession(makeSession('mixed1'));
      reactiveDb.abortTransaction();
      expect(events.length).toBe(0);

      reactiveDb.commitTransaction();

      expect(events.length).toBe(1);
    });

    test('begin → begin → commit inner → abort outer: events are NOT emitted (outer abort clears at depth=0)', () => {
      const events: unknown[] = [];
      reactiveDb.on('change', () => events.push(1));

      reactiveDb.beginTransaction();
      reactiveDb.beginTransaction();
      reactiveDb.db.createSession(makeSession('mixed2'));
      reactiveDb.commitTransaction();
      expect(events.length).toBe(0);

      reactiveDb.abortTransaction();

      expect(events.length).toBe(0);
    });

    test('multiple tables in single transaction — commit emits one event containing both tables', () => {
      const events: Array<{ tables: string[]; versions: Record<string, number> }> = [];
      reactiveDb.on('change', (data) => events.push(data));

      reactiveDb.beginTransaction();
      reactiveDb.db.createSession(makeSession('multi-tx1'));
      reactiveDb.notifyChange('sdk_messages');
      reactiveDb.commitTransaction();

      expect(events.length).toBe(1);
      expect(events[0].tables).toContain('sessions');
      expect(events[0].tables).toContain('sdk_messages');
      expect(events[0].versions).toHaveProperty('sessions');
      expect(events[0].versions).toHaveProperty('sdk_messages');
    });
  });
});
