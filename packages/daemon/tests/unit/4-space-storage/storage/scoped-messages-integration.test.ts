import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { Database } from '../../../../src/storage/index';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';
import { LiveQueryEngine } from '../../../../src/storage/live-query';
import type { QueryDiff } from '../../../../src/storage/live-query';
import type { Session, SessionConfig, SessionMetadata } from '@hyperneo/shared';

function makeTempDbPath(): string {
  return join(tmpdir(), `scoped-integ-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeSession(id: string): Session {
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
  };
}

describe('Scoped invalidation — sdk_messages integration', () => {
  let dbPath: string;
  let db: Database;
  let bunDb: BunDatabase;
  let reactiveDb: ReactiveDatabase;
  let engine: LiveQueryEngine;

  const SQL = `
		SELECT id, sdk_message AS content
		FROM sdk_messages
		WHERE session_id = ?1
			AND parent_tool_use_id IS NULL
			AND (message_type != 'user' OR COALESCE(send_status, 'consumed') IN ('consumed', 'failed'))
		ORDER BY timestamp ASC
	`.trim();

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

  test('writing message for sess-B does NOT trigger delta for sess-A subscription', async () => {
    reactiveDb.db.createSession(makeSession('sess-A'));
    reactiveDb.db.createSession(makeSession('sess-B'));

    const diffsA: QueryDiff<Record<string, unknown>>[] = [];
    engine.subscribe(SQL, ['sess-A'], (diff) => diffsA.push(diff), {
      debounceMs: 0,
      scopeFilter: (scope) => {
        if (!scope.sessionId) return true;
        return scope.sessionId === 'sess-A';
      },
    });

    expect(diffsA.length).toBe(1);

    for (let i = 0; i < 5; i++) {
      reactiveDb.db.saveSDKMessage('sess-B', {
        type: 'assistant',
        uuid: `b-msg-${i}`,
        session_id: 'sess-B',
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'text', text: `B ${i}` }] },
      } as any);
    }

    await Promise.resolve();

    expect(diffsA.length).toBe(1);
  });

  test('writing message for sess-A DOES trigger delta for sess-A subscription', async () => {
    reactiveDb.db.createSession(makeSession('sess-A'));

    const diffsA: QueryDiff<Record<string, unknown>>[] = [];
    engine.subscribe(SQL, ['sess-A'], (diff) => diffsA.push(diff), {
      debounceMs: 0,
      scopeFilter: (scope) => {
        if (!scope.sessionId) return true;
        return scope.sessionId === 'sess-A';
      },
    });

    expect(diffsA.length).toBe(1);

    reactiveDb.db.saveSDKMessage('sess-A', {
      type: 'assistant',
      uuid: 'a-msg-1',
      session_id: 'sess-A',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
    } as any);

    await Promise.resolve();

    expect(diffsA.length).toBe(2);
    expect(diffsA[1].type).toBe('delta');
    expect(diffsA[1].added?.length).toBe(1);
  });

  test('unscoped change (updateMessageStatus) re-evaluates all queries', async () => {
    reactiveDb.db.createSession(makeSession('sess-A'));
    reactiveDb.db.createSession(makeSession('sess-B'));

    const msgId = reactiveDb.db.saveUserMessage(
      'sess-A',
      {
        type: 'user',
        uuid: 'a-user-1',
        session_id: 'sess-A',
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      } as any,
      'enqueued'
    );

    const diffsA: QueryDiff<Record<string, unknown>>[] = [];
    const diffsB: QueryDiff<Record<string, unknown>>[] = [];
    engine.subscribe(SQL, ['sess-A'], (diff) => diffsA.push(diff), {
      debounceMs: 0,
      scopeFilter: (scope) => !scope.sessionId || scope.sessionId === 'sess-A',
    });
    engine.subscribe(SQL, ['sess-B'], (diff) => diffsB.push(diff), {
      debounceMs: 0,
      scopeFilter: (scope) => !scope.sessionId || scope.sessionId === 'sess-B',
    });

    expect(diffsA.length).toBe(1);

    reactiveDb.db.updateMessageStatus([msgId], 'consumed');

    await Promise.resolve();

    expect(diffsA.length).toBe(2);
    expect(diffsB.length).toBe(1);
  });

  test('concurrent sessions with scope filters have independent feeds', async () => {
    reactiveDb.db.createSession(makeSession('sess-A'));
    reactiveDb.db.createSession(makeSession('sess-B'));

    const diffsA: QueryDiff<Record<string, unknown>>[] = [];
    const diffsB: QueryDiff<Record<string, unknown>>[] = [];

    engine.subscribe(SQL, ['sess-A'], (diff) => diffsA.push(diff), {
      debounceMs: 0,
      scopeFilter: (scope) => !scope.sessionId || scope.sessionId === 'sess-A',
    });
    engine.subscribe(SQL, ['sess-B'], (diff) => diffsB.push(diff), {
      debounceMs: 0,
      scopeFilter: (scope) => !scope.sessionId || scope.sessionId === 'sess-B',
    });

    reactiveDb.db.saveSDKMessage('sess-A', {
      type: 'assistant',
      uuid: 'a1',
      session_id: 'sess-A',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'A1' }] },
    } as any);

    reactiveDb.db.saveSDKMessage('sess-B', {
      type: 'assistant',
      uuid: 'b1',
      session_id: 'sess-B',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'B1' }] },
    } as any);

    reactiveDb.db.saveSDKMessage('sess-A', {
      type: 'assistant',
      uuid: 'a2',
      session_id: 'sess-A',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'A2' }] },
    } as any);

    await Promise.resolve();

    expect(diffsA.length).toBe(2);
    expect(diffsA[1].added?.length).toBe(2);

    expect(diffsB.length).toBe(2);
    expect(diffsB[1].added?.length).toBe(1);
  });
});
