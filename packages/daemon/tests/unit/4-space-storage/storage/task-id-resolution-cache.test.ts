import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Database } from '../../../../src/storage/index';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
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

const TASK_RESOLUTION_SQL = /\$\.taskId/;

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

  function taskIdsOf(sessionId: string): Array<{ task_id: string | null }> {
    return bunDb
      .prepare('SELECT task_id FROM sdk_messages WHERE session_id = ? ORDER BY timestamp')
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
});
