import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Database } from '../../../../src/storage/index';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import type { ReactiveDatabase, TableChangeEvent } from '../../../../src/storage/reactive-database';
import type {
  Session,
  SessionConfig,
  SessionContext,
  SessionMetadata,
  SessionType,
} from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';

function makeTempDbPath(): string {
  return join(tmpdir(), `task-id-cache-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeSession(id: string, type: SessionType, context?: SessionContext): Session {
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

function assistantMessage(text: string): SDKMessage {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as unknown as SDKMessage;
}

function userMessage(text: string, uuid: string): SDKMessage {
  return {
    type: 'user',
    uuid,
    session_id: 'unused',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as unknown as SDKMessage;
}

const TASK_RESOLUTION_SQL = /SELECT task_id, type FROM sessions/;

describe('resolveTaskIdForSession memoization (per-save query dedup)', () => {
  let dbPath: string;
  let db: Database;
  let reactiveDb: ReactiveDatabase;
  let bunDb: ReturnType<Database['getDatabase']>;
  let taskResolutions: number;

  beforeEach(async () => {
    dbPath = makeTempDbPath();
    db = new Database(dbPath);
    reactiveDb = createReactiveDatabase(db);
    await db.initialize(reactiveDb);
    bunDb = db.getDatabase();
    taskResolutions = 0;
    const originalPrepare = bunDb.prepare.bind(bunDb);
    bunDb.prepare = ((sql: string, ...rest: unknown[]) => {
      if (TASK_RESOLUTION_SQL.test(sql)) taskResolutions++;
      return originalPrepare(sql, ...rest);
    }) as typeof bunDb.prepare;
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(dbPath, { force: true });
      rmSync(dbPath + '-wal', { force: true });
      rmSync(dbPath + '-shm', { force: true });
    } catch {}
  });

  function taskIdsOf(sessionId: string): Array<{ task_id: string | null }> {
    return bunDb
      .prepare('SELECT task_id FROM sdk_messages WHERE session_id = ? ORDER BY timestamp, rowid')
      .all(sessionId) as Array<{ task_id: string | null }>;
  }

  test('saveSDKMessage resolves the session taskId once, then reuses the cache', () => {
    reactiveDb.db.createSession(makeSession('s-task', 'worker', { taskId: 'task-1' }));

    reactiveDb.db.saveSDKMessage('s-task', assistantMessage('one'));
    expect(taskResolutions).toBe(1);

    reactiveDb.db.saveSDKMessage('s-task', assistantMessage('two'));
    reactiveDb.db.saveSDKMessage('s-task', assistantMessage('three'));
    expect(taskResolutions).toBe(1);
  });

  test('saveUserMessage resolves once and reuses the cache too', () => {
    reactiveDb.db.createSession(makeSession('s-task', 'worker', { taskId: 'task-1' }));

    reactiveDb.db.saveUserMessage('s-task', userMessage('hello', 'u1'), 'consumed');
    expect(taskResolutions).toBe(1);

    reactiveDb.db.saveUserMessage('s-task', userMessage('again', 'u2'), 'consumed');
    expect(taskResolutions).toBe(1);
  });

  test('task_id attribution is unchanged for task and non-task sessions', () => {
    reactiveDb.db.createSession(makeSession('s-worker', 'worker', { taskId: 'task-1' }));
    reactiveDb.db.createSession(makeSession('s-agent', 'space_task_agent', { taskId: 'task-2' }));
    reactiveDb.db.createSession(makeSession('s-plain', 'worker'));
    reactiveDb.db.createSession(makeSession('s-lobby', 'lobby', { taskId: 'task-ghost' }));

    reactiveDb.db.saveSDKMessage('s-worker', assistantMessage('w'));
    reactiveDb.db.saveSDKMessage('s-agent', assistantMessage('a'));
    reactiveDb.db.saveSDKMessage('s-plain', assistantMessage('p'));
    reactiveDb.db.saveSDKMessage('s-lobby', assistantMessage('l'));

    const rows = bunDb
      .prepare('SELECT session_id, task_id FROM sdk_messages ORDER BY session_id')
      .all() as Array<{ session_id: string; task_id: string | null }>;
    expect(rows).toEqual([
      { session_id: 's-agent', task_id: 'task-2' },
      { session_id: 's-lobby', task_id: null },
      { session_id: 's-plain', task_id: null },
      { session_id: 's-worker', task_id: 'task-1' },
    ]);
  });

  test('sdk_messages change scope carries taskId for task sessions', () => {
    const events: TableChangeEvent[] = [];
    reactiveDb.on('change', (data) => events.push(data));

    reactiveDb.db.createSession(makeSession('s-task', 'worker', { taskId: 'task-1' }));
    reactiveDb.db.saveSDKMessage('s-task', assistantMessage('one'));

    const sdkEvent = events.find((e) => e.tables.includes('sdk_messages'));
    expect(sdkEvent!.scope).toEqual({ sessionId: 's-task', taskId: 'task-1' });
  });

  test('sdk_messages change scope omits taskId for non-task sessions', () => {
    const events: TableChangeEvent[] = [];
    reactiveDb.on('change', (data) => events.push(data));

    reactiveDb.db.createSession(makeSession('s-plain', 'worker'));
    reactiveDb.db.saveSDKMessage('s-plain', assistantMessage('one'));

    const sdkEvent = events.find((e) => e.tables.includes('sdk_messages'));
    expect(sdkEvent!.scope).toEqual({ sessionId: 's-plain' });
  });

  test('session update touching context invalidates the cached taskId', () => {
    reactiveDb.db.createSession(makeSession('s-task', 'worker', { taskId: 'task-1' }));
    reactiveDb.db.saveSDKMessage('s-task', assistantMessage('one'));
    expect(taskResolutions).toBe(1);

    reactiveDb.db.updateSession('s-task', { title: 'renamed' });
    reactiveDb.db.saveSDKMessage('s-task', assistantMessage('two'));
    expect(taskResolutions).toBe(1);

    reactiveDb.db.updateSession('s-task', {
      context: { spaceId: 'space-1', taskId: 'task-2' },
    });
    reactiveDb.db.saveSDKMessage('s-task', assistantMessage('three'));
    expect(taskResolutions).toBe(2);
    expect(taskIdsOf('s-task')).toEqual([
      { task_id: 'task-1' },
      { task_id: 'task-1' },
      { task_id: 'task-2' },
    ]);
  });

  test('session type change invalidates the cached taskId', () => {
    reactiveDb.db.createSession(makeSession('s-task', 'worker', { taskId: 'task-1' }));
    reactiveDb.db.saveSDKMessage('s-task', assistantMessage('one'));
    expect(taskResolutions).toBe(1);

    reactiveDb.db.updateSession('s-task', { type: 'lobby' });
    reactiveDb.db.saveSDKMessage('s-task', assistantMessage('two'));
    expect(taskResolutions).toBe(2);
    expect(taskIdsOf('s-task')).toEqual([{ task_id: 'task-1' }, { task_id: null }]);
  });

  test('deleteSession invalidates the cached taskId', () => {
    reactiveDb.db.createSession(makeSession('s-task', 'worker', { taskId: 'task-1' }));
    reactiveDb.db.saveSDKMessage('s-task', assistantMessage('one'));
    expect(taskResolutions).toBe(1);

    reactiveDb.db.deleteSession('s-task');
    reactiveDb.db.createSession(makeSession('s-task', 'worker', { taskId: 'task-2' }));
    reactiveDb.db.saveSDKMessage('s-task', assistantMessage('two'));
    expect(taskResolutions).toBe(2);
    expect(taskIdsOf('s-task')).toEqual([{ task_id: 'task-2' }]);
  });

  test('abortTransaction clears the cached taskId', () => {
    reactiveDb.db.createSession(makeSession('s-task', 'worker', { taskId: 'task-1' }));
    reactiveDb.db.saveSDKMessage('s-task', assistantMessage('one'));
    expect(taskResolutions).toBe(1);

    reactiveDb.beginTransaction();
    reactiveDb.db.updateSession('s-task', { context: { taskId: 'task-2' } });
    reactiveDb.db.saveSDKMessage('s-task', assistantMessage('two'));
    expect(taskResolutions).toBe(2);
    reactiveDb.abortTransaction();

    reactiveDb.db.saveSDKMessage('s-task', assistantMessage('three'));
    expect(taskResolutions).toBe(3);
  });

  test('a transient resolution failure is not memoized', () => {
    reactiveDb.db.createSession(makeSession('s-task', 'worker', { taskId: 'task-1' }));
    reactiveDb.db.saveSDKMessage('s-task', assistantMessage('one'));
    expect(taskResolutions).toBe(1);

    reactiveDb.db.updateSession('s-task', { context: { spaceId: 'space-1', taskId: 'task-1' } });

    const countingPrepare = bunDb.prepare.bind(bunDb);
    let failOnce = true;
    bunDb.prepare = ((sql: string, ...rest: unknown[]) => {
      if (failOnce && TASK_RESOLUTION_SQL.test(sql)) {
        failOnce = false;
        throw new Error('simulated resolution failure');
      }
      return countingPrepare(sql, ...rest);
    }) as typeof bunDb.prepare;

    reactiveDb.db.saveSDKMessage('s-task', assistantMessage('two'));
    expect(taskIdsOf('s-task')).toEqual([{ task_id: 'task-1' }, { task_id: null }]);

    bunDb.prepare = countingPrepare;
    reactiveDb.db.saveSDKMessage('s-task', assistantMessage('three'));
    expect(taskIdsOf('s-task')).toEqual([
      { task_id: 'task-1' },
      { task_id: null },
      { task_id: 'task-1' },
    ]);
  });

  test('a failing session write still invalidates the cached taskId', () => {
    reactiveDb.db.createSession(makeSession('s-task', 'worker', { taskId: 'task-1' }));
    reactiveDb.db.saveSDKMessage('s-task', assistantMessage('one'));
    expect(taskResolutions).toBe(1);

    const countingPrepare = bunDb.prepare.bind(bunDb);
    let failOnce = true;
    bunDb.prepare = ((sql: string, ...rest: unknown[]) => {
      if (failOnce && /UPDATE sessions/.test(sql)) {
        failOnce = false;
        throw new Error('simulated session write failure');
      }
      return countingPrepare(sql, ...rest);
    }) as typeof bunDb.prepare;

    expect(() =>
      reactiveDb.db.updateSession('s-task', { context: { taskId: 'task-2' } })
    ).toThrow();

    bunDb.prepare = countingPrepare;
    reactiveDb.db.saveSDKMessage('s-task', assistantMessage('two'));
    expect(taskResolutions).toBe(2);
    expect(taskIdsOf('s-task')).toEqual([{ task_id: 'task-1' }, { task_id: 'task-1' }]);
  });
});

describe('saveUserMessageCore / runPostSaveSideEffects composition contract', () => {
  let dbPath: string;
  let db: Database;
  let reactiveDb: ReactiveDatabase;
  let bunDb: ReturnType<Database['getDatabase']>;
  let repo: SDKMessageRepository;
  let events: TableChangeEvent[];

  beforeEach(async () => {
    dbPath = makeTempDbPath();
    db = new Database(dbPath);
    reactiveDb = createReactiveDatabase(db);
    await db.initialize(reactiveDb);
    bunDb = db.getDatabase();
    repo = new SDKMessageRepository(bunDb, reactiveDb);
    events = [];
    reactiveDb.on('change', (data) => events.push(data));
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      rmSync(dbPath, { force: true });
      rmSync(dbPath + '-wal', { force: true });
      rmSync(dbPath + '-shm', { force: true });
    } catch {}
  });

  function messageCount(): number {
    return (bunDb.prepare('SELECT COUNT(*) AS n FROM sdk_messages').get() as { n: number }).n;
  }

  function badgeOf(sessionId: string): number {
    return (
      bunDb
        .prepare(`SELECT visible_message_count AS n FROM sessions WHERE id = ?`)
        .get(sessionId) as { n: number }
    ).n;
  }

  test('core writes the row and bumps the badge but emits no reactive notifications', () => {
    reactiveDb.db.createSession(makeSession('s-comp', 'worker', { taskId: 'task-comp' }));
    events.length = 0;

    const core = repo.saveUserMessageCore('s-comp', userMessage('sent', 'u-core'), 'consumed');

    expect(core.countsTowardsBadge).toBe(true);
    expect(events).toEqual([]);
    expect(messageCount()).toBe(1);
    expect(badgeOf('s-comp')).toBe(1);
  });

  test('runPostSaveSideEffects notifies sdk_messages always, sessions only for badge rows', () => {
    reactiveDb.db.createSession(makeSession('s-comp', 'worker', { taskId: 'task-comp' }));
    events.length = 0;

    const visible = repo.saveUserMessageCore('s-comp', userMessage('sent', 'u-vis'), 'consumed');
    repo.runPostSaveSideEffects('s-comp', visible.id, visible.countsTowardsBadge);
    const pending = repo.saveUserMessageCore('s-comp', userMessage('queued', 'u-pend'), 'deferred');
    repo.runPostSaveSideEffects('s-comp', pending.id, pending.countsTowardsBadge);

    expect(events.map((event) => event.tables)).toEqual([
      ['sdk_messages'],
      ['sessions'],
      ['sdk_messages'],
    ]);
    expect(events[0].scope).toEqual({ sessionId: 's-comp' });
    expect(events[1].scope).toEqual({ sessionId: 's-comp' });
  });

  test('saveUserMessage composes transaction(core) then post-commit side effects', () => {
    reactiveDb.db.createSession(makeSession('s-comp', 'worker', { taskId: 'task-comp' }));
    events.length = 0;

    let inTransactionAtNotify: boolean | null = null;
    reactiveDb.on('change', (event) => {
      if (inTransactionAtNotify === null && event.tables.includes('sdk_messages')) {
        try {
          bunDb.exec('BEGIN');
          bunDb.exec('ROLLBACK');
          inTransactionAtNotify = false;
        } catch {
          inTransactionAtNotify = true;
        }
      }
    });

    const id = repo.saveUserMessage('s-comp', userMessage('hello', 'u-wrap'), 'consumed');

    expect(
      (bunDb.prepare('SELECT id FROM sdk_messages WHERE id = ?').get(id) as { id: string }).id
    ).toBe(id);
    expect(badgeOf('s-comp')).toBe(1);
    expect(events.map((event) => event.tables)).toEqual([['sdk_messages'], ['sessions']]);
    expect(inTransactionAtNotify).toBe(false);
  });

  test('a composed transaction that throws rolls back the row and the badge bump', () => {
    reactiveDb.db.createSession(makeSession('s-comp', 'worker', { taskId: 'task-comp' }));
    events.length = 0;

    expect(() =>
      bunDb.transaction(() => {
        repo.saveUserMessageCore('s-comp', userMessage('doomed', 'u-abort'), 'consumed');
        throw new Error('compose-abort');
      })()
    ).toThrow('compose-abort');

    expect(messageCount()).toBe(0);
    expect(badgeOf('s-comp')).toBe(0);
    expect(events).toEqual([]);
  });

  test('proxied saveUserMessage notifies sdk_messages exactly once per save', () => {
    reactiveDb.db.createSession(makeSession('s-comp', 'worker', { taskId: 'task-comp' }));
    events.length = 0;

    reactiveDb.db.saveUserMessage('s-comp', userMessage('hello', 'u-px'), 'consumed');

    const sdkEvents = events.filter((event) => event.tables.includes('sdk_messages'));
    expect(sdkEvents).toHaveLength(1);
    expect(sdkEvents[0].scope).toEqual({ sessionId: 's-comp', taskId: 'task-comp' });
    expect(reactiveDb.getTableVersion('sdk_messages')).toBe(1);
    expect(events.filter((event) => event.tables.includes('sessions'))).toHaveLength(1);
  });

  test('proxied saveUserMessage without badge emits only the sdk_messages change', () => {
    reactiveDb.db.createSession(makeSession('s-comp', 'worker', { taskId: 'task-comp' }));
    events.length = 0;

    reactiveDb.db.saveUserMessage('s-comp', userMessage('queued', 'u-pxd'), 'deferred');

    expect(events.map((event) => event.tables)).toEqual([['sdk_messages']]);
    expect(reactiveDb.getTableVersion('sdk_messages')).toBe(1);
  });

  test('a failing proxied save does not suppress later explicit notifies', () => {
    reactiveDb.db.createSession(makeSession('s-comp', 'worker', { taskId: 'task-comp' }));
    events.length = 0;

    const countingPrepare = bunDb.prepare.bind(bunDb);
    let failOnce = true;
    bunDb.prepare = ((sql: string, ...rest: unknown[]) => {
      if (failOnce && /INSERT INTO sdk_messages/.test(sql)) {
        failOnce = false;
        throw new Error('simulated insert failure');
      }
      return countingPrepare(sql, ...rest);
    }) as typeof bunDb.prepare;

    expect(() =>
      reactiveDb.db.saveUserMessage('s-comp', userMessage('doomed', 'u-pxf'), 'consumed')
    ).toThrow('simulated insert failure');

    bunDb.prepare = countingPrepare;
    repo.saveUserMessage('s-comp', userMessage('recovered', 'u-pxr'), 'consumed');

    expect(events.map((event) => event.tables)).toEqual([['sdk_messages'], ['sessions']]);
    expect(messageCount()).toBe(1);
  });
});
