import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { Database } from '../../../../src/storage/index';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { LiveQueryEngine } from '../../../../src/storage/live-query';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';
import type { QueryDiff } from '../../../../src/storage/live-query';
import type { Session, SessionConfig, SessionMetadata } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';

function makeTempDbPath(): string {
  return join(tmpdir(), `live-query-int-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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
    workspacePath: '/workspace/integration-test',
    createdAt: now,
    lastActiveAt: now,
    status: 'active',
    config,
    metadata,
    ...overrides,
  };
}

function makeUserMessage(uuid: string, content: string): SDKMessage {
  return {
    type: 'user',
    uuid,
    message: {
      role: 'user',
      content: [{ type: 'text', text: content }],
    },
  } as SDKMessage;
}

interface SessionRow {
  id: string;
  title: string;
  status: string;
}

describe('LiveQuery Integration (Database + ReactiveDatabase + LiveQueryEngine)', () => {
  let dbPath: string;
  let db: Database;
  let bunDb: BunDatabase;
  let reactiveDb: ReactiveDatabase;
  let engine: LiveQueryEngine;

  const SESSIONS_SQL =
    "SELECT id, title, status FROM sessions WHERE status != 'archived' ORDER BY id";

  beforeEach(async () => {
    dbPath = makeTempDbPath();
    db = new Database(dbPath);
    reactiveDb = createReactiveDatabase(db);
    await db.initialize(reactiveDb);

    bunDb = db.getDatabase();
    engine = new LiveQueryEngine(bunDb, reactiveDb);
  });

  afterEach(() => {
    engine.dispose();
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

  describe('initial snapshot', () => {
    test('snapshot is empty when no sessions exist', () => {
      const diffs: QueryDiff<SessionRow>[] = [];
      engine.subscribe(SESSIONS_SQL, [], (diff) => diffs.push(diff));

      expect(diffs.length).toBe(1);
      expect(diffs[0].type).toBe('snapshot');
      expect(diffs[0].rows).toEqual([]);
    });

    test('snapshot contains pre-existing sessions', () => {
      db.createSession(makeSession('pre1'));
      db.createSession(makeSession('pre2'));

      const diffs: QueryDiff<SessionRow>[] = [];
      engine.subscribe(SESSIONS_SQL, [], (diff) => diffs.push(diff));

      expect(diffs[0].rows.length).toBe(2);
      const ids = diffs[0].rows.map((r) => r.id).sort();
      expect(ids).toEqual(['pre1', 'pre2']);
    });
  });

  describe('session insert', () => {
    test('createSession via proxied db triggers added delta', async () => {
      const diffs: QueryDiff<SessionRow>[] = [];
      engine.subscribe(SESSIONS_SQL, [], (diff) => diffs.push(diff));

      reactiveDb.db.createSession(makeSession('ins1'));
      await Promise.resolve();

      expect(diffs.length).toBe(2);
      const delta = diffs[1];
      expect(delta.type).toBe('delta');
      expect(delta.added?.length).toBe(1);
      expect(delta.added?.[0].id).toBe('ins1');
    });

    test('delta rows contains inserted session', async () => {
      const diffs: QueryDiff<SessionRow>[] = [];
      engine.subscribe(SESSIONS_SQL, [], (diff) => diffs.push(diff));

      reactiveDb.db.createSession(makeSession('ins2', { title: 'My New Session' }));
      await Promise.resolve();

      const delta = diffs[1];
      expect(delta.rows.length).toBe(1);
      expect(delta.rows[0].title).toBe('My New Session');
    });

    test('multiple inserts accumulate in handle.get()', async () => {
      const handle = engine.subscribe(SESSIONS_SQL, [], () => {});

      reactiveDb.db.createSession(makeSession('ins3'));
      await Promise.resolve();

      reactiveDb.db.createSession(makeSession('ins4'));
      await Promise.resolve();

      expect(handle.get().length).toBe(2);
    });
  });

  describe('session update', () => {
    test('updateSession via proxied db triggers updated delta', async () => {
      reactiveDb.db.createSession(makeSession('upd1'));
      await Promise.resolve();

      const diffs: QueryDiff<SessionRow>[] = [];
      engine.subscribe(SESSIONS_SQL, [], (diff) => diffs.push(diff));

      reactiveDb.db.updateSession('upd1', { title: 'Updated Title' });
      await Promise.resolve();

      const delta = diffs[1];
      expect(delta.type).toBe('delta');
      expect(delta.updated?.length).toBe(1);
      expect(delta.updated?.[0].id).toBe('upd1');
    });

    test('updated row reflects new title', async () => {
      reactiveDb.db.createSession(makeSession('upd2', { title: 'Original' }));
      await Promise.resolve();

      const diffs: QueryDiff<SessionRow>[] = [];
      engine.subscribe(SESSIONS_SQL, [], (diff) => diffs.push(diff));

      reactiveDb.db.updateSession('upd2', { title: 'Renamed' });
      await Promise.resolve();

      expect(diffs[1].updated?.[0].title).toBe('Renamed');
    });

    test('archiving a session removes it from the non-archived query', async () => {
      reactiveDb.db.createSession(makeSession('upd3'));
      await Promise.resolve();

      const diffs: QueryDiff<SessionRow>[] = [];
      engine.subscribe(SESSIONS_SQL, [], (diff) => diffs.push(diff));

      reactiveDb.db.updateSession('upd3', { status: 'archived' });
      await Promise.resolve();

      const delta = diffs[1];
      expect(delta.rows.length).toBe(0);
      expect(delta.removed?.length).toBe(1);
      expect(delta.removed?.[0].id).toBe('upd3');
    });
  });

  describe('session delete', () => {
    test('deleteSession via proxied db triggers removed delta', async () => {
      reactiveDb.db.createSession(makeSession('del1'));
      await Promise.resolve();

      const diffs: QueryDiff<SessionRow>[] = [];
      engine.subscribe(SESSIONS_SQL, [], (diff) => diffs.push(diff));

      reactiveDb.db.deleteSession('del1');
      await Promise.resolve();

      const delta = diffs[1];
      expect(delta.type).toBe('delta');
      expect(delta.removed?.length).toBe(1);
      expect(delta.removed?.[0].id).toBe('del1');
    });

    test('rows is empty after the only session is deleted', async () => {
      reactiveDb.db.createSession(makeSession('del2'));
      await Promise.resolve();

      const diffs: QueryDiff<SessionRow>[] = [];
      engine.subscribe(SESSIONS_SQL, [], (diff) => diffs.push(diff));

      reactiveDb.db.deleteSession('del2');
      await Promise.resolve();

      expect(diffs[1].rows).toEqual([]);
    });
  });

  describe('transaction batching', () => {
    test('beginTransaction + multiple creates + commit = single delta', async () => {
      const diffs: QueryDiff<SessionRow>[] = [];
      engine.subscribe(SESSIONS_SQL, [], (diff) => diffs.push(diff));

      reactiveDb.beginTransaction();
      reactiveDb.db.createSession(makeSession('batch1'));
      reactiveDb.db.createSession(makeSession('batch2'));
      reactiveDb.db.createSession(makeSession('batch3'));
      reactiveDb.commitTransaction();

      await Promise.resolve();

      expect(diffs.length).toBe(2);
      expect(diffs[1].type).toBe('delta');
      expect(diffs[1].rows.length).toBe(3);
    });

    test('abortTransaction suppresses delta emission', async () => {
      const diffs: QueryDiff<SessionRow>[] = [];
      engine.subscribe(SESSIONS_SQL, [], (diff) => diffs.push(diff));

      reactiveDb.beginTransaction();
      reactiveDb.db.createSession(makeSession('abort1'));
      reactiveDb.abortTransaction();

      await Promise.resolve();

      expect(diffs.length).toBe(1);
    });
  });

  describe('sdk_messages query', () => {
    const MESSAGES_SQL =
      'SELECT id, session_id, message_type FROM sdk_messages WHERE session_id = ? ORDER BY timestamp';

    test('initial snapshot for sdk_messages is empty', () => {
      const diffs: QueryDiff<{ id: string; session_id: string; message_type: string }>[] = [];
      engine.subscribe(MESSAGES_SQL, ['session-x'], (diff) => diffs.push(diff));

      expect(diffs[0].type).toBe('snapshot');
      expect(diffs[0].rows).toEqual([]);
    });

    test('saveSDKMessage via proxied db triggers added delta', async () => {
      reactiveDb.db.createSession(makeSession('msg-session'));
      await Promise.resolve();

      const diffs: QueryDiff<{ id: string; session_id: string; message_type: string }>[] = [];
      engine.subscribe(MESSAGES_SQL, ['msg-session'], (diff) => diffs.push(diff));

      reactiveDb.db.saveSDKMessage('msg-session', makeUserMessage(crypto.randomUUID(), 'Hello!'));
      await Promise.resolve();

      expect(diffs.length).toBe(2);
      const delta = diffs[1];
      expect(delta.type).toBe('delta');
      expect(delta.added?.length).toBe(1);
      expect(delta.added?.[0].session_id).toBe('msg-session');
      expect(delta.added?.[0].message_type).toBe('user');
    });

    test('message for different session_id does not appear in parameterised query', async () => {
      reactiveDb.db.createSession(makeSession('sess-a'));
      reactiveDb.db.createSession(makeSession('sess-b'));
      await Promise.resolve();

      const diffs: QueryDiff<{ id: string; session_id: string; message_type: string }>[] = [];
      engine.subscribe(MESSAGES_SQL, ['sess-a'], (diff) => diffs.push(diff));

      reactiveDb.db.saveSDKMessage('sess-b', makeUserMessage(crypto.randomUUID(), 'Other session'));
      await Promise.resolve();

      expect(diffs.length).toBe(1);
    });

    test('multiple messages for same session accumulate', async () => {
      reactiveDb.db.createSession(makeSession('multi-msg'));
      await Promise.resolve();

      const handle = engine.subscribe(MESSAGES_SQL, ['multi-msg'], () => {});

      reactiveDb.db.saveSDKMessage('multi-msg', makeUserMessage(crypto.randomUUID(), 'First'));
      await Promise.resolve();

      reactiveDb.db.saveSDKMessage('multi-msg', makeUserMessage(crypto.randomUUID(), 'Second'));
      await Promise.resolve();

      expect(handle.get().length).toBe(2);
    });
  });

  describe('cross-table isolation', () => {
    test('change to sessions table does not trigger sdk_messages query callback', async () => {
      const MESSAGES_SQL_ISO =
        'SELECT id FROM sdk_messages WHERE session_id = ? ORDER BY timestamp';

      const msgDiffs: QueryDiff<{ id: string }>[] = [];
      engine.subscribe(MESSAGES_SQL_ISO, ['iso-session'], (diff) => msgDiffs.push(diff));

      reactiveDb.db.createSession(makeSession('iso-session'));
      await Promise.resolve();

      expect(msgDiffs.length).toBe(1);
    });

    test('two subscriptions to different tables update independently', async () => {
      const MESSAGES_SQL_CROSS =
        'SELECT id FROM sdk_messages WHERE session_id = ? ORDER BY timestamp';

      const sessionDiffs: QueryDiff<SessionRow>[] = [];
      const msgDiffs: QueryDiff<{ id: string }>[] = [];

      engine.subscribe(SESSIONS_SQL, [], (diff) => sessionDiffs.push(diff));
      engine.subscribe(MESSAGES_SQL_CROSS, ['cross-session'], (diff) => msgDiffs.push(diff));

      reactiveDb.db.createSession(makeSession('cross-session'));
      await Promise.resolve();

      expect(sessionDiffs.length).toBe(2);
      expect(msgDiffs.length).toBe(1);
    });
  });

  describe('version tracking', () => {
    test('snapshot version is 0 before any writes', () => {
      const diffs: QueryDiff<SessionRow>[] = [];
      engine.subscribe(SESSIONS_SQL, [], (diff) => diffs.push(diff));

      expect(diffs[0].version).toBe(0);
    });

    test('delta version matches reactiveDb.getTableVersion after write', async () => {
      const diffs: QueryDiff<SessionRow>[] = [];
      engine.subscribe(SESSIONS_SQL, [], (diff) => diffs.push(diff));

      reactiveDb.db.createSession(makeSession('ver1'));
      await Promise.resolve();

      const expectedVersion = reactiveDb.getTableVersion('sessions');
      expect(diffs[1].version).toBe(expectedVersion);
    });

    test('version increments with each successive write', async () => {
      const diffs: QueryDiff<SessionRow>[] = [];
      engine.subscribe(SESSIONS_SQL, [], (diff) => diffs.push(diff));

      reactiveDb.db.createSession(makeSession('ver2'));
      await Promise.resolve();

      reactiveDb.db.createSession(makeSession('ver3'));
      await Promise.resolve();

      expect(diffs[2].version).toBeGreaterThan(diffs[1].version);
    });
  });

  describe('processing state and context info', () => {
    test('processing state update triggers live query', async () => {
      reactiveDb.db.createSession(makeSession('ps1'));
      await new Promise((resolve) => setTimeout(resolve, 10));

      const diffs: QueryDiff<{ id: string; processing_state: string | null }>[] = [];
      engine.subscribe('SELECT id, processing_state FROM sessions WHERE id = ?', ['ps1'], (diff) =>
        diffs.push(diff)
      );

      reactiveDb.db.updateSession('ps1', {
        processingState: JSON.stringify({ status: 'processing', phase: 'streaming' }),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(diffs.length).toBe(2);
      const delta = diffs[1];
      expect(delta.type).toBe('delta');
      expect(delta.updated?.length).toBe(1);
      expect(delta.updated?.[0].id).toBe('ps1');
      const state = JSON.parse(delta.updated?.[0].processing_state ?? 'null');
      expect(state.status).toBe('processing');
      expect(state.phase).toBe('streaming');
    });

    test('context info update triggers live query', async () => {
      const initialMetadata = {
        messageCount: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
        toolCallCount: 0,
      };
      reactiveDb.db.createSession(makeSession('ci1', { metadata: initialMetadata }));
      await new Promise((resolve) => setTimeout(resolve, 10));

      const diffs: QueryDiff<{ id: string; metadata: string }>[] = [];
      engine.subscribe('SELECT id, metadata FROM sessions WHERE id = ?', ['ci1'], (diff) =>
        diffs.push(diff)
      );

      reactiveDb.db.updateSession('ci1', {
        metadata: {
          ...initialMetadata,
          lastContextInfo: {
            model: 'claude-3',
            totalUsed: 1000,
            totalCapacity: 200000,
            percentUsed: 0.5,
          },
        } as typeof initialMetadata & { lastContextInfo: unknown },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(diffs.length).toBe(2);
      const delta = diffs[1];
      expect(delta.type).toBe('delta');
      expect(delta.updated?.length).toBe(1);
      const metadata = JSON.parse(delta.updated?.[0].metadata ?? '{}');
      expect(metadata.lastContextInfo).toBeDefined();
      expect(metadata.lastContextInfo.model).toBe('claude-3');
      expect(metadata.lastContextInfo.totalCapacity).toBe(200000);
    });

    test('multiple rapid processing state updates coalesce into one callback', async () => {
      reactiveDb.db.createSession(makeSession('ps2'));
      await new Promise((resolve) => setTimeout(resolve, 10));

      const diffs: QueryDiff<{ id: string; processing_state: string | null }>[] = [];
      engine.subscribe('SELECT id, processing_state FROM sessions WHERE id = ?', ['ps2'], (diff) =>
        diffs.push(diff)
      );

      reactiveDb.db.updateSession('ps2', {
        processingState: JSON.stringify({ status: 'processing', phase: 'streaming' }),
      });
      reactiveDb.db.updateSession('ps2', {
        processingState: JSON.stringify({ status: 'processing', phase: 'tool_use' }),
      });
      reactiveDb.db.updateSession('ps2', {
        processingState: JSON.stringify({ status: 'idle' }),
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(diffs.length).toBe(2);
      const delta = diffs[1];
      expect(delta.type).toBe('delta');
      const finalState = JSON.parse(delta.updated?.[0].processing_state ?? 'null');
      expect(finalState.status).toBe('idle');
    });
  });
});
