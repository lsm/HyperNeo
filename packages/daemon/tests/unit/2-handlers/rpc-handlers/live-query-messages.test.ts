/**
 * Unit tests for the `messages.bySession` named query in NAMED_QUERY_REGISTRY.
 *
 * Covers:
 *  - Registry entry exists with the expected paramCount.
 *  - Ordering (timestamp ASC, id ASC).
 *  - LIMIT applied to top-level rows only, with subagent rows included
 *    regardless of whether their parent was inside the limit.
 *  - Filtering of user messages by send_status (deferred/enqueued excluded).
 *  - `mapMessageRow` parses the JSON blob, injects id / timestamp / origin,
 *    and forwards `sendStatus` only when the DB row is 'failed'.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import type { MessageHub } from '@hyperneo/shared';
import { createTables } from '../../../../src/storage/schema';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { LiveQueryEngine } from '../../../../src/storage/live-query';
import {
  NAMED_QUERY_REGISTRY,
  setupLiveQueryHandlers,
} from '../../../../src/lib/rpc-handlers/live-query-handlers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  createTables(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS spaces (
      id TEXT PRIMARY KEY,
      slug TEXT,
      workspace_path TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return db;
}

interface InsertSessionArgs {
  id: string;
  title?: string;
}

function insertSession(db: BunDatabase, args: InsertSessionArgs): void {
  db.prepare(
    `INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata)
		 VALUES (?, ?, datetime('now'), datetime('now'), 'active', '{}', '{}')`
  ).run(args.id, args.title ?? 'Test Session');
}

interface InsertSdkMessageArgs {
  id: string;
  sessionId: string;
  messageType: string;
  messageSubtype?: string | null;
  sdkMessage: Record<string, unknown>;
  /** ISO timestamp (stored TEXT). Default is a fixed known value. */
  timestamp?: string;
  sendStatus?: 'deferred' | 'enqueued' | 'consumed' | 'failed';
  origin?: 'human' | 'system' | null;
  taskId?: string | null;
}

function insertSdkMessage(db: BunDatabase, args: InsertSdkMessageArgs): void {
  const parentToolUseId =
    typeof args.sdkMessage.parent_tool_use_id === 'string'
      ? args.sdkMessage.parent_tool_use_id
      : null;
  db.prepare(
    `INSERT INTO sdk_messages
		 (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin, parent_tool_use_id, task_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    args.id,
    args.sessionId,
    args.messageType,
    args.messageSubtype ?? null,
    JSON.stringify(args.sdkMessage),
    args.timestamp ?? '2024-01-01 00:00:00',
    args.sendStatus ?? 'consumed',
    args.origin ?? null,
    parentToolUseId,
    args.taskId ?? null
  );
}

function query(db: BunDatabase, sessionId: string, limit: number): Record<string, unknown>[] {
  const entry = NAMED_QUERY_REGISTRY.get('messages.bySession')!;
  const rows = db.prepare(entry.sql).all(sessionId, limit) as Record<string, unknown>[];
  return entry.mapRow ? rows.map(entry.mapRow) : rows;
}

function queryPlan(db: BunDatabase, sessionId: string, limit: number): string {
  const entry = NAMED_QUERY_REGISTRY.get('messages.bySession')!;
  const planRows = db.prepare(`EXPLAIN QUERY PLAN ${entry.sql}`).all(sessionId, limit) as Array<{
    detail: string;
  }>;
  return planRows.map((row) => row.detail).join('\n');
}

type RequestHandler = (data: unknown, context: { clientId?: string; sessionId: string }) => unknown;

function createMockHub() {
  const handlers = new Map<string, RequestHandler>();
  const sentMessages: Array<{
    message: { method: string; data: Record<string, unknown> };
  }> = [];

  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
    getRouter: mock(() => ({
      sendToClient: mock((_clientId: string, message: unknown) => {
        sentMessages.push({
          message: message as { method: string; data: Record<string, unknown> },
        });
        return true;
      }),
    })),
    onClientDisconnect: mock(() => () => {}),
  } as unknown as MessageHub;

  return {
    hub,
    sentMessages,
    subscribe: (sessionId: string, limit = 100) => {
      const handler = handlers.get('liveQuery.subscribe');
      if (!handler) throw new Error('liveQuery.subscribe handler not registered');
      return handler(
        { queryName: 'messages.bySession', params: [sessionId, limit], subscriptionId: 'sub-1' },
        { clientId: 'client-1', sessionId: 'global' }
      );
    },
  };
}

function subscribeMessagesBySession(db: BunDatabase, sessionId: string, limit = 100) {
  const reactiveDb = createReactiveDatabase({ getDatabase: () => db } as never);
  const engine = new LiveQueryEngine(db, reactiveDb);
  const setup = createMockHub();
  const cleanup = setupLiveQueryHandlers(setup.hub, engine, db);

  setup.subscribe(sessionId, limit);
  const snapshot = setup.sentMessages[0]?.message.data;

  cleanup();
  engine.dispose();

  return snapshot;
}

// ---------------------------------------------------------------------------
// Registry metadata
// ---------------------------------------------------------------------------

describe('messages.bySession — registry metadata', () => {
  test('registry contains messages.bySession entry', () => {
    expect(NAMED_QUERY_REGISTRY.has('messages.bySession')).toBe(true);
  });

  test('messages.bySession paramCount is 2', () => {
    expect(NAMED_QUERY_REGISTRY.get('messages.bySession')!.paramCount).toBe(2);
  });

  test('messages.bySession has a mapRow function', () => {
    expect(typeof NAMED_QUERY_REGISTRY.get('messages.bySession')!.mapRow).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// SQL behavior
// ---------------------------------------------------------------------------

describe('messages.bySession — SQL behavior', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = makeDb();
    insertSession(db, { id: 's1' });
    insertSession(db, { id: 's2' });
  });

  afterEach(() => {
    db.close();
  });

  test('returns empty array on fresh session', () => {
    expect(query(db, 's1', 100)).toEqual([]);
  });

  test('returns only messages for the requested session', () => {
    insertSdkMessage(db, {
      id: 'm1',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: { type: 'assistant', uuid: 'u1', message: { content: [] } },
      timestamp: '2024-01-01 00:00:01',
    });
    insertSdkMessage(db, {
      id: 'm2',
      sessionId: 's2',
      messageType: 'assistant',
      sdkMessage: { type: 'assistant', uuid: 'u2', message: { content: [] } },
      timestamp: '2024-01-01 00:00:02',
    });

    const rows = query(db, 's1', 100);
    expect(rows).toHaveLength(1);
    expect(rows[0].uuid).toBe('u1');
  });

  test('excludes user messages with send_status deferred or enqueued', () => {
    insertSdkMessage(db, {
      id: 'm-consumed',
      sessionId: 's1',
      messageType: 'user',
      sdkMessage: { type: 'user', uuid: 'u1', message: { content: 'ok' } },
      timestamp: '2024-01-01 00:00:01',
      sendStatus: 'consumed',
    });
    insertSdkMessage(db, {
      id: 'm-deferred',
      sessionId: 's1',
      messageType: 'user',
      sdkMessage: { type: 'user', uuid: 'u2', message: { content: 'deferred' } },
      timestamp: '2024-01-01 00:00:02',
      sendStatus: 'deferred',
    });
    insertSdkMessage(db, {
      id: 'm-enqueued',
      sessionId: 's1',
      messageType: 'user',
      sdkMessage: { type: 'user', uuid: 'u3', message: { content: 'enqueued' } },
      timestamp: '2024-01-01 00:00:03',
      sendStatus: 'enqueued',
    });
    insertSdkMessage(db, {
      id: 'm-failed',
      sessionId: 's1',
      messageType: 'user',
      sdkMessage: { type: 'user', uuid: 'u4', message: { content: 'failed' } },
      timestamp: '2024-01-01 00:00:04',
      sendStatus: 'failed',
    });

    const rows = query(db, 's1', 100);
    const uuids = rows.map((r) => r.uuid as string).sort();
    // consumed and failed are kept; deferred and enqueued are dropped.
    expect(uuids).toEqual(['u1', 'u4']);
  });

  test('orders by timestamp ASC, id ASC', () => {
    insertSdkMessage(db, {
      id: 'b',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: { type: 'assistant', uuid: 'u-b', message: { content: [] } },
      timestamp: '2024-01-01 00:00:02',
    });
    insertSdkMessage(db, {
      id: 'a',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: { type: 'assistant', uuid: 'u-a', message: { content: [] } },
      timestamp: '2024-01-01 00:00:01',
    });
    insertSdkMessage(db, {
      id: 'c',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: { type: 'assistant', uuid: 'u-c', message: { content: [] } },
      timestamp: '2024-01-01 00:00:02', // same timestamp as 'b'
    });

    const rows = query(db, 's1', 100);
    const ids = rows.map((r) => r.id);
    // 'a' comes first (earliest timestamp); 'b' and 'c' share a timestamp
    // and must order by id ASC.
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  test('limit applies to top-level rows only; keeps most recent N', () => {
    // Insert 5 top-level assistant messages; set limit to 3.
    for (let i = 1; i <= 5; i++) {
      insertSdkMessage(db, {
        id: `t${i}`,
        sessionId: 's1',
        messageType: 'assistant',
        sdkMessage: { type: 'assistant', uuid: `u${i}`, message: { content: [] } },
        timestamp: `2024-01-01 00:00:0${i}`,
      });
    }

    const rows = query(db, 's1', 3);
    const ids = rows.map((r) => r.id);
    // With LIMIT=3, only the 3 most recent top-level rows should be included,
    // and returned in ascending order (t3, t4, t5).
    expect(ids).toEqual(['t3', 't4', 't5']);
  });

  test('includes retracted messages in the top-level window', () => {
    insertSdkMessage(db, {
      id: 'older-real',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: { type: 'assistant', uuid: 'older-real-uuid', message: { content: [] } },
      timestamp: '2024-01-01 00:00:01',
    });
    insertSdkMessage(db, {
      id: 'row-retracted',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: { type: 'assistant', uuid: 'sdk-retracted', message: { content: [] } },
      timestamp: '2024-01-01 00:00:02',
    });
    insertSdkMessage(db, {
      id: 'fallback-notice',
      sessionId: 's1',
      messageType: 'system',
      messageSubtype: 'model_refusal_fallback',
      sdkMessage: {
        type: 'system',
        subtype: 'model_refusal_fallback',
        retracted_message_uuids: ['sdk-retracted'],
      },
      timestamp: '2024-01-01 00:00:03',
    });

    const rows = query(db, 's1', 2);
    expect(rows.map((r) => r.id)).toEqual(['row-retracted', 'fallback-notice']);
  });

  test('includes superseded messages in the top-level window', () => {
    insertSdkMessage(db, {
      id: 'older-real',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: { type: 'assistant', uuid: 'older-real-uuid', message: { content: [] } },
      timestamp: '2024-01-01 00:00:01',
    });
    insertSdkMessage(db, {
      id: 'row-superseded',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: { type: 'assistant', uuid: 'sdk-superseded', message: { content: [] } },
      timestamp: '2024-01-01 00:00:02',
    });
    insertSdkMessage(db, {
      id: 'replacement',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: {
        type: 'assistant',
        uuid: 'replacement-uuid',
        supersedes: ['sdk-superseded'],
        message: { content: [] },
      },
      timestamp: '2024-01-01 00:00:03',
    });

    const rows = query(db, 's1', 2);
    expect(rows.map((r) => r.id)).toEqual(['row-superseded', 'replacement']);
  });

  test('filters info-level informational rows before applying the top-level limit', () => {
    insertSdkMessage(db, {
      id: 'older-visible',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: { type: 'assistant', uuid: 'older-visible-uuid', message: { content: [] } },
      timestamp: '2024-01-01 00:00:01',
    });
    insertSdkMessage(db, {
      id: 'hidden-info',
      sessionId: 's1',
      messageType: 'system',
      messageSubtype: 'informational',
      sdkMessage: {
        type: 'system',
        subtype: 'informational',
        uuid: 'hidden-info-uuid',
        session_id: 's1',
        level: 'info',
        content: 'transcript-only',
      },
      timestamp: '2024-01-01 00:00:02',
    });
    insertSdkMessage(db, {
      id: 'visible-notice',
      sessionId: 's1',
      messageType: 'system',
      messageSubtype: 'informational',
      sdkMessage: {
        type: 'system',
        subtype: 'informational',
        uuid: 'visible-notice-uuid',
        session_id: 's1',
        level: 'notice',
        content: 'visible notice',
      },
      timestamp: '2024-01-01 00:00:03',
    });

    const rows = query(db, 's1', 2);
    expect(rows.map((r) => r.id)).toEqual(['older-visible', 'visible-notice']);
  });

  test('filters stale worker shutdown rows before applying the top-level limit', () => {
    insertSdkMessage(db, {
      id: 'older-visible',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: { type: 'assistant', uuid: 'older-visible-uuid', message: { content: [] } },
      timestamp: '2024-01-01 00:00:01',
    });
    insertSdkMessage(db, {
      id: 'stale-shutdown',
      sessionId: 's1',
      messageType: 'system',
      messageSubtype: 'worker_shutting_down',
      sdkMessage: {
        type: 'system',
        subtype: 'worker_shutting_down',
        uuid: 'stale-shutdown-uuid',
        session_id: 's1',
        reason: 'host_exit',
      },
      timestamp: '2024-01-01 00:00:02',
    });
    insertSdkMessage(db, {
      id: 'newer-visible',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: { type: 'assistant', uuid: 'newer-visible-uuid', message: { content: [] } },
      timestamp: '2024-01-01 00:00:03',
    });

    const rows = query(db, 's1', 2);
    expect(rows.map((r) => r.id)).toEqual(['older-visible', 'newer-visible']);
  });

  test('keeps worker shutdown rows when they are the top-level live tail', () => {
    insertSdkMessage(db, {
      id: 'visible',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: { type: 'assistant', uuid: 'visible-uuid', message: { content: [] } },
      timestamp: '2024-01-01 00:00:01',
    });
    insertSdkMessage(db, {
      id: 'tail-shutdown',
      sessionId: 's1',
      messageType: 'system',
      messageSubtype: 'worker_shutting_down',
      sdkMessage: {
        type: 'system',
        subtype: 'worker_shutting_down',
        uuid: 'tail-shutdown-uuid',
        session_id: 's1',
        reason: 'host_exit',
      },
      timestamp: '2024-01-01 00:00:02',
    });

    const rows = query(db, 's1', 2);
    expect(rows.map((r) => r.id)).toEqual(['visible', 'tail-shutdown']);
  });

  test('filters render-only hidden system subtypes before applying the top-level limit', () => {
    insertSdkMessage(db, {
      id: 'visible',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: { type: 'assistant', uuid: 'visible-uuid', message: { content: [] } },
      timestamp: '2024-01-01 00:00:01',
    });
    for (const subtype of ['session_state_changed', 'commands_changed', 'task_progress']) {
      insertSdkMessage(db, {
        id: `hidden-${subtype}`,
        sessionId: 's1',
        messageType: 'system',
        messageSubtype: subtype,
        sdkMessage: {
          type: 'system',
          subtype,
          uuid: `${subtype}-uuid`,
          session_id: 's1',
        },
        timestamp: '2024-01-01 00:00:02',
      });
    }

    const rows = query(db, 's1', 2);
    expect(rows.map((r) => r.id)).toEqual(['visible']);
  });

  test('includes background task metadata in LiveQuery metadata outside the transcript rows', () => {
    for (const subtype of ['task_started', 'task_updated', 'task_notification']) {
      insertSdkMessage(db, {
        id: `metadata-${subtype}`,
        sessionId: 's1',
        messageType: 'system',
        messageSubtype: subtype,
        sdkMessage: {
          type: 'system',
          subtype,
          uuid: `${subtype}-uuid`,
          session_id: 's1',
          task_id: 'task-1',
          status: subtype === 'task_notification' ? 'completed' : undefined,
        },
        timestamp: '2024-01-01 00:00:02',
      });
    }
    insertSdkMessage(db, {
      id: 'visible',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: { type: 'assistant', uuid: 'visible-uuid', message: { content: [] } },
      timestamp: '2024-01-01 00:00:03',
    });

    const snapshot = subscribeMessagesBySession(db, 's1', 2);
    const rows = snapshot?.rows as Array<{ id: string }>;
    const metadata = snapshot?.metadata as { backgroundTaskMessages: Array<{ id: string }> };

    expect(rows.map((r) => r.id)).toEqual(['metadata-task_notification', 'visible']);
    expect(metadata.backgroundTaskMessages.map((r) => r.id).sort()).toEqual(
      ['metadata-task_notification', 'metadata-task_started', 'metadata-task_updated'].sort()
    );
  });

  test('includes task start rows when LiveQuery background task metadata is capped', () => {
    insertSdkMessage(db, {
      id: 'task-started',
      sessionId: 's1',
      messageType: 'system',
      messageSubtype: 'task_started',
      sdkMessage: {
        type: 'system',
        subtype: 'task_started',
        uuid: 'task-started-uuid',
        session_id: 's1',
        task_id: 'task-1',
      },
      timestamp: '2024-01-01 00:00:01',
    });
    for (let i = 0; i < 301; i++) {
      insertSdkMessage(db, {
        id: `task-updated-${i}`,
        sessionId: 's1',
        messageType: 'system',
        messageSubtype: 'task_updated',
        sdkMessage: {
          type: 'system',
          subtype: 'task_updated',
          uuid: `task-updated-${i}-uuid`,
          session_id: 's1',
          task_id: 'task-1',
          patch: { is_backgrounded: true, status: 'running' },
        },
        timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, i + 1)).toISOString(),
      });
    }

    const snapshot = subscribeMessagesBySession(db, 's1', 1);
    const metadata = snapshot?.metadata as { backgroundTaskMessages: Array<{ id: string }> };

    expect(metadata.backgroundTaskMessages.some((message) => message.id === 'task-started')).toBe(
      true
    );
    expect(metadata.backgroundTaskMessages.at(-1)?.id).toBe('task-updated-300');
  });

  test('matches LiveQuery task starts by SDK task id before session task id', () => {
    insertSdkMessage(db, {
      id: 'old-task-started',
      sessionId: 's1',
      messageType: 'system',
      messageSubtype: 'task_started',
      taskId: 'space-task-1',
      sdkMessage: {
        type: 'system',
        subtype: 'task_started',
        uuid: 'old-task-started-uuid',
        session_id: 's1',
        task_id: 'old-sdk-task',
      },
      timestamp: '2024-01-01 00:00:00',
    });
    insertSdkMessage(db, {
      id: 'current-task-started',
      sessionId: 's1',
      messageType: 'system',
      messageSubtype: 'task_started',
      taskId: 'space-task-1',
      sdkMessage: {
        type: 'system',
        subtype: 'task_started',
        uuid: 'current-task-started-uuid',
        session_id: 's1',
        task_id: 'current-sdk-task',
      },
      timestamp: '2024-01-01 00:00:01',
    });
    for (let i = 0; i < 301; i++) {
      insertSdkMessage(db, {
        id: `current-task-updated-${i}`,
        sessionId: 's1',
        messageType: 'system',
        messageSubtype: 'task_updated',
        taskId: 'space-task-1',
        sdkMessage: {
          type: 'system',
          subtype: 'task_updated',
          uuid: `current-task-updated-${i}-uuid`,
          session_id: 's1',
          task_id: 'current-sdk-task',
          patch: { is_backgrounded: true, status: 'running' },
        },
        timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, i + 1)).toISOString(),
      });
    }

    const snapshot = subscribeMessagesBySession(db, 's1', 1);
    const metadata = snapshot?.metadata as { backgroundTaskMessages: Array<{ task_id: string }> };
    const sdkTaskIds = metadata.backgroundTaskMessages.map((message) => message.task_id);

    expect(sdkTaskIds).not.toContain('old-sdk-task');
    expect(sdkTaskIds).toContain('current-sdk-task');
  });

  test('preserves LiveQuery background task metadata order on timestamp ties', () => {
    insertSdkMessage(db, {
      id: 'b-started',
      sessionId: 's1',
      messageType: 'system',
      messageSubtype: 'task_started',
      sdkMessage: {
        type: 'system',
        subtype: 'task_started',
        uuid: 'b-started-uuid',
        session_id: 's1',
        task_id: 'task-1',
      },
      timestamp: '2024-01-01 00:00:00',
    });
    insertSdkMessage(db, {
      id: 'a-updated',
      sessionId: 's1',
      messageType: 'system',
      messageSubtype: 'task_updated',
      sdkMessage: {
        type: 'system',
        subtype: 'task_updated',
        uuid: 'a-updated-uuid',
        session_id: 's1',
        task_id: 'task-1',
        patch: { is_backgrounded: true, status: 'running' },
      },
      timestamp: '2024-01-01 00:00:00',
    });

    const snapshot = subscribeMessagesBySession(db, 's1', 1);
    const metadata = snapshot?.metadata as { backgroundTaskMessages: Array<{ id: string }> };

    expect(metadata.backgroundTaskMessages.map((message) => message.id)).toEqual([
      'b-started',
      'a-updated',
    ]);
  });

  test('does not let background task metadata rows displace visible rows', () => {
    insertSdkMessage(db, {
      id: 'older-visible',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: { type: 'assistant', uuid: 'older-visible-uuid', message: { content: [] } },
      timestamp: '2024-01-01 00:00:01',
    });
    for (let i = 0; i < 20; i++) {
      const subtype = i === 0 ? 'task_started' : 'task_updated';
      insertSdkMessage(db, {
        id: `metadata-${i}`,
        sessionId: 's1',
        messageType: 'system',
        messageSubtype: subtype,
        sdkMessage: {
          type: 'system',
          subtype,
          uuid: `metadata-${i}-uuid`,
          session_id: 's1',
          task_id: 'task-1',
        },
        timestamp: `2024-01-01 00:00:${String(i + 2).padStart(2, '0')}`,
      });
    }
    insertSdkMessage(db, {
      id: 'newer-visible',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: { type: 'assistant', uuid: 'newer-visible-uuid', message: { content: [] } },
      timestamp: '2024-01-01 00:01:00',
    });

    const rows = query(db, 's1', 2);

    expect(rows.map((row) => row.id)).toEqual(['older-visible', 'newer-visible']);
  });

  test('does not throw when an informational row has malformed JSON', () => {
    insertSdkMessage(db, {
      id: 'malformed-info',
      sessionId: 's1',
      messageType: 'system',
      messageSubtype: 'informational',
      sdkMessage: {
        type: 'system',
        subtype: 'informational',
        uuid: 'malformed-info-uuid',
        session_id: 's1',
        level: 'notice',
        content: 'will be corrupted',
      },
      timestamp: '2024-01-01 00:00:01',
    });
    db.exec('PRAGMA ignore_check_constraints = ON');
    db.exec('DROP INDEX IF EXISTS idx_sdk_messages_uuid_status');
    db.prepare(
      `UPDATE sdk_messages
       SET sdk_message = ?
       WHERE id = ?`
    ).run('{not-json', 'malformed-info');
    db.exec('PRAGMA ignore_check_constraints = OFF');

    const rows = query(db, 's1', 10);
    expect(rows.map((r) => r.id)).toEqual(['malformed-info']);
    expect(rows[0].type).toBe('unknown');
  });

  test('ignores malformed JSON rows while scanning retractions and supersedes', () => {
    insertSdkMessage(db, {
      id: 'malformed-ref',
      sessionId: 's1',
      messageType: 'system',
      messageSubtype: 'model_refusal_fallback',
      sdkMessage: {
        type: 'system',
        subtype: 'model_refusal_fallback',
        parent_tool_use_id: 'unreferenced-tool',
      },
      timestamp: '2024-01-01 00:00:01',
    });
    db.exec('PRAGMA ignore_check_constraints = ON');
    db.exec('DROP INDEX IF EXISTS idx_sdk_messages_uuid_status');
    db.prepare(
      `UPDATE sdk_messages
       SET sdk_message = ?
       WHERE id = ?`
    ).run('{not-json', 'malformed-ref');
    db.exec('PRAGMA ignore_check_constraints = OFF');
    insertSdkMessage(db, {
      id: 'normal',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: { type: 'assistant', uuid: 'normal-uuid', message: { content: [] } },
      timestamp: '2024-01-01 00:00:02',
    });

    const rows = query(db, 's1', 10);
    expect(rows.map((r) => r.id)).toEqual(['normal']);
  });

  test('uses the session timestamp index for the top-level window', () => {
    const plan = queryPlan(db, 's1', 200);
    // The top-level window is session-scoped, so it must use a session index
    // (either the composite idx_sdk_messages_session_timestamp_id or the
    // shorter idx_sdk_messages_session) and never a full table scan. The cap
    // orders by (timestamp, rowid) for correct same-ms hook-phase ordering, so
    // the planner may pick the shorter index + a bounded temp sort.
    expect(plan).toMatch(/idx_sdk_messages_session(_timestamp_id)?\b/);
    expect(plan).not.toContain('SCAN sdk_messages USING');
  });

  test('uses the materialised parent_tool_use_id index for subagent lookups', () => {
    const plan = queryPlan(db, 's1', 200);
    expect(plan).toContain('idx_sdk_messages_parent_tool_use_id');
  });

  test('includes subagent messages whose parent_tool_use_id matches a top-level tool_use', () => {
    // Top-level assistant row with a tool_use in its content.
    insertSdkMessage(db, {
      id: 'parent',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: {
        type: 'assistant',
        uuid: 'u-parent',
        message: {
          content: [
            { type: 'text', text: 'calling tool' },
            { type: 'tool_use', id: 'tool-use-1', name: 'sub', input: {} },
          ],
        },
      },
      timestamp: '2024-01-01 00:00:01',
    });

    // Subagent row keyed by parent_tool_use_id matching that tool_use.id.
    insertSdkMessage(db, {
      id: 'child',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: {
        type: 'assistant',
        uuid: 'u-child',
        parent_tool_use_id: 'tool-use-1',
        message: { content: [{ type: 'text', text: 'sub result' }] },
      },
      timestamp: '2024-01-01 00:00:02',
    });

    // Unrelated subagent row whose parent_tool_use_id does NOT match.
    insertSdkMessage(db, {
      id: 'stranger',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: {
        type: 'assistant',
        uuid: 'u-stranger',
        parent_tool_use_id: 'not-a-real-tool-use',
        message: { content: [] },
      },
      timestamp: '2024-01-01 00:00:03',
    });

    const rows = query(db, 's1', 100);
    const uuids = rows.map((r) => r.uuid as string).sort();
    expect(uuids).toEqual(['u-child', 'u-parent']);
  });
});

// ---------------------------------------------------------------------------
// mapRow — inflation + field extraction
// ---------------------------------------------------------------------------

describe('messages.bySession — mapRow', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = makeDb();
    insertSession(db, { id: 's1' });
  });

  afterEach(() => {
    db.close();
  });

  test('parses the sdk_message JSON blob and spreads its fields', () => {
    insertSdkMessage(db, {
      id: 'm1',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: {
        type: 'assistant',
        uuid: 'u1',
        message: { content: [{ type: 'text', text: 'hello' }] },
      },
      timestamp: '2024-01-01 00:00:01',
    });

    const [row] = query(db, 's1', 10);
    expect(row.type).toBe('assistant');
    expect(row.uuid).toBe('u1');
    expect(row.message).toEqual({ content: [{ type: 'text', text: 'hello' }] });
  });

  test('attaches DB id for stable diffing', () => {
    insertSdkMessage(db, {
      id: 'stable-id-42',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: { type: 'assistant', message: { content: [] } }, // no uuid
      timestamp: '2024-01-01 00:00:01',
    });

    const [row] = query(db, 's1', 10);
    expect(row.id).toBe('stable-id-42');
  });

  test('computes timestamp as epoch millis from TEXT column', () => {
    insertSdkMessage(db, {
      id: 'm1',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: { type: 'assistant', uuid: 'u1', message: { content: [] } },
      timestamp: '2024-01-01 00:00:00',
    });

    const [row] = query(db, 's1', 10);
    expect(typeof row.timestamp).toBe('number');
    // `2024-01-01 00:00:00` UTC → epoch ms
    expect(row.timestamp).toBe(new Date('2024-01-01T00:00:00Z').getTime());
  });

  test('overrides origin with DB column (string) — stripping nested SDK-level origin', () => {
    insertSdkMessage(db, {
      id: 'm1',
      sessionId: 's1',
      messageType: 'user',
      sdkMessage: {
        type: 'user',
        uuid: 'u1',
        origin: { kind: 'sdk-something' },
        message: { content: 'hi' },
      },
      timestamp: '2024-01-01 00:00:01',
      origin: 'human',
    });

    const [row] = query(db, 's1', 10);
    expect(row.origin).toBe('human');
  });

  test('sets origin to undefined when DB column is NULL', () => {
    insertSdkMessage(db, {
      id: 'm1',
      sessionId: 's1',
      messageType: 'assistant',
      sdkMessage: {
        type: 'assistant',
        uuid: 'u1',
        origin: { kind: 'sdk-something' },
        message: { content: [] },
      },
      timestamp: '2024-01-01 00:00:01',
      origin: null,
    });

    const [row] = query(db, 's1', 10);
    expect(row.origin).toBeUndefined();
  });

  test('attaches sendStatus only when DB column is "failed"', () => {
    insertSdkMessage(db, {
      id: 'm-ok',
      sessionId: 's1',
      messageType: 'user',
      sdkMessage: { type: 'user', uuid: 'u-ok', message: { content: 'ok' } },
      timestamp: '2024-01-01 00:00:01',
      sendStatus: 'consumed',
    });
    insertSdkMessage(db, {
      id: 'm-fail',
      sessionId: 's1',
      messageType: 'user',
      sdkMessage: { type: 'user', uuid: 'u-fail', message: { content: 'fail' } },
      timestamp: '2024-01-01 00:00:02',
      sendStatus: 'failed',
    });

    const rows = query(db, 's1', 10);
    const okRow = rows.find((r) => r.uuid === 'u-ok')!;
    const failRow = rows.find((r) => r.uuid === 'u-fail')!;
    expect('sendStatus' in okRow).toBe(false);
    expect(failRow.sendStatus).toBe('failed');
  });
});
