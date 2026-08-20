import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import type { MessageHub } from '@hyperneo/shared';
import { createTables } from '../../../../src/storage/schema';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { LiveQueryEngine } from '../../../../src/storage/live-query';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import {
  BACKGROUND_TASK_METADATA_SQL,
  NAMED_QUERY_REGISTRY,
  setupLiveQueryHandlers,
} from '../../../../src/lib/rpc-handlers/live-query-handlers';

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
  timestamp?: string;
  sendStatus?: 'deferred' | 'enqueued' | 'submitted' | 'consumed' | 'failed';
  origin?: 'human' | 'system' | null;
  taskId?: string | null;
}

function insertSdkMessage(db: BunDatabase, args: InsertSdkMessageArgs): void {
  const parentToolUseId =
    typeof args.sdkMessage.parent_tool_use_id === 'string'
      ? args.sdkMessage.parent_tool_use_id
      : null;
  const sdkUuid = typeof args.sdkMessage.uuid === 'string' ? args.sdkMessage.uuid : null;
  db.prepare(
    `INSERT INTO sdk_messages
		 (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin, parent_tool_use_id, task_id, sdk_uuid)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    args.taskId ?? null,
    sdkUuid
  );
}

function insertDeliveryJob(
  db: BunDatabase,
  args: {
    id: string;
    sessionId: string;
    messageUuid: string;
    status?: 'pending' | 'processing' | 'completed' | 'failed' | 'dead';
    retryCount?: number;
    role?: 'turn' | 'steer';
  }
): void {
  db.prepare(
    `INSERT INTO job_queue
       (id, queue, status, payload, retry_count, max_retries, run_at, created_at)
     VALUES (?, 'message_delivery', ?, ?, ?, 8, ?, ?)`
  ).run(
    args.id,
    args.status ?? 'pending',
    JSON.stringify({
      sessionId: args.sessionId,
      messageUuid: args.messageUuid,
      role: args.role ?? 'turn',
      origin: 'chat',
    }),
    args.retryCount ?? 0,
    Date.now(),
    Date.now()
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
      sendToClient: mock(() => true),
      sendToClientDetailed: mock((_clientId: string, message: unknown) => {
        sentMessages.push({
          message: message as { method: string; data: Record<string, unknown> },
        });
        return { ok: true } as const;
      }),
      checkSubscriptionCapacity: mock(() => ({ ok: true })),
      addClientSubscription: mock(() => {}),
      releaseClientSubscription: mock(() => {}),
      getClientSubscriptionCount: mock(() => 0),
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

  test('surfaces every user-message delivery state (queued/processing/delivered/failed)', () => {
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
      id: 'm-submitted',
      sessionId: 's1',
      messageType: 'user',
      sdkMessage: { type: 'user', uuid: 'u5', message: { content: 'submitted' } },
      timestamp: '2024-01-01 00:00:04',
      sendStatus: 'submitted',
    });
    insertSdkMessage(db, {
      id: 'm-failed',
      sessionId: 's1',
      messageType: 'user',
      sdkMessage: { type: 'user', uuid: 'u4', message: { content: 'failed' } },
      timestamp: '2024-01-01 00:00:05',
      sendStatus: 'failed',
    });

    const rows = query(db, 's1', 100);
    const byUuid = new Map(rows.map((r) => [r.uuid as string, r]));
    expect([...byUuid.keys()].sort()).toEqual(['u1', 'u2', 'u3', 'u4', 'u5']);
    expect(byUuid.get('u1')!.deliveryStatus).toBe('delivered');
    expect(byUuid.get('u2')!.deliveryStatus).toBe('queued');
    expect(byUuid.get('u3')!.deliveryStatus).toBe('queued');
    expect(byUuid.get('u5')!.deliveryStatus).toBe('processing');
    expect(byUuid.get('u4')!.deliveryStatus).toBe('failed');
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
      timestamp: '2024-01-01 00:00:02',
    });

    const rows = query(db, 's1', 100);
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  test('limit applies to top-level rows only; keeps most recent N', () => {
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
    expect(plan).toMatch(/idx_sdk_messages_session(_timestamp_id)?\b/);
    expect(plan).not.toContain('SCAN sdk_messages USING');
  });

  test('uses the materialised parent_tool_use_id index for subagent lookups', () => {
    const plan = queryPlan(db, 's1', 200);
    expect(plan).toContain('idx_sdk_messages_parent_tool_use_id');
  });

  test('background-task sidecar subtype filter is sargable via message_subtype_norm', () => {
    for (const subtype of ['task_started', 'task_updated', 'task_notification']) {
      insertSdkMessage(db, {
        id: `bg-${subtype}`,
        sessionId: 's1',
        messageType: 'system',
        messageSubtype: subtype,
        sdkMessage: { type: 'system', subtype, uuid: `${subtype}-uuid`, session_id: 's1' },
        timestamp: '2024-01-01 00:00:01',
      });
    }
    insertSdkMessage(db, {
      id: 'null-subtype',
      sessionId: 's1',
      messageType: 'system',
      messageSubtype: null,
      sdkMessage: { type: 'system', uuid: 'null-uuid', session_id: 's1' },
      timestamp: '2024-01-01 00:00:00',
    });

    const planRows = db
      .prepare(`EXPLAIN QUERY PLAN ${BACKGROUND_TASK_METADATA_SQL}`)
      .all('s1', 's1', 's1', 's1', 's1') as Array<{ detail: string }>;
    const plan = planRows.map((row) => row.detail).join('\n');
    expect(plan).toContain('idx_sdk_messages_session_subtype_parent');
    expect(plan).toContain('message_subtype_norm');
    expect(plan).toContain('SEARCH');
  });

  test('message_subtype_norm equals COALESCE(message_subtype, "") for every row', () => {
    insertSdkMessage(db, {
      id: 'null',
      sessionId: 's1',
      messageType: 'system',
      messageSubtype: null,
      sdkMessage: { type: 'system', uuid: 'n', session_id: 's1' },
    });
    insertSdkMessage(db, {
      id: 'progress',
      sessionId: 's1',
      messageType: 'system',
      messageSubtype: 'task_progress',
      sdkMessage: { type: 'system', uuid: 'p', session_id: 's1' },
    });

    const drift = db
      .prepare(
        `SELECT COUNT(*) AS n FROM sdk_messages
          WHERE message_subtype_norm != COALESCE(message_subtype, '')`
      )
      .get() as { n: number };
    expect(drift.n).toBe(0);
  });

  test('includes subagent messages whose parent_tool_use_id matches a top-level tool_use', () => {
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
      sdkMessage: { type: 'assistant', message: { content: [] } },
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

  test('attaches deliveryStatus for user messages mapped from send_status', () => {
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
    expect(okRow.deliveryStatus).toBe('delivered');
    expect(failRow.deliveryStatus).toBe('failed');
  });

  test('marks a non-terminal user message "retrying" when its delivery job has retry_count > 0', () => {
    insertSdkMessage(db, {
      id: 'm-enq',
      sessionId: 's1',
      messageType: 'user',
      sdkMessage: { type: 'user', uuid: 'u-enq', message: { content: 'enqueued' } },
      timestamp: '2024-01-01 00:00:01',
      sendStatus: 'enqueued',
    });
    insertSdkMessage(db, {
      id: 'm-sub',
      sessionId: 's1',
      messageType: 'user',
      sdkMessage: { type: 'user', uuid: 'u-sub', message: { content: 'submitted' } },
      timestamp: '2024-01-01 00:00:02',
      sendStatus: 'submitted',
    });

    let byUuid = new Map(query(db, 's1', 10).map((r) => [r.uuid as string, r]));
    expect(byUuid.get('u-enq')!.deliveryStatus).toBe('queued');
    expect(byUuid.get('u-sub')!.deliveryStatus).toBe('processing');

    insertDeliveryJob(db, {
      id: 'job-enq',
      sessionId: 's1',
      messageUuid: 'u-enq',
      status: 'pending',
      retryCount: 1,
    });
    insertDeliveryJob(db, {
      id: 'job-sub',
      sessionId: 's1',
      messageUuid: 'u-sub',
      status: 'processing',
      retryCount: 2,
      role: 'steer',
    });

    byUuid = new Map(query(db, 's1', 10).map((r) => [r.uuid as string, r]));
    expect(byUuid.get('u-enq')!.deliveryStatus).toBe('retrying');
    expect(byUuid.get('u-sub')!.deliveryStatus).toBe('retrying');
  });

  test('a delivery job with retry_count 0 does not mark the message retrying', () => {
    insertSdkMessage(db, {
      id: 'm-fresh',
      sessionId: 's1',
      messageType: 'user',
      sdkMessage: { type: 'user', uuid: 'u-fresh', message: { content: 'fresh' } },
      timestamp: '2024-01-01 00:00:01',
      sendStatus: 'enqueued',
    });
    insertDeliveryJob(db, {
      id: 'job-fresh',
      sessionId: 's1',
      messageUuid: 'u-fresh',
      status: 'pending',
      retryCount: 0,
    });

    const [row] = query(db, 's1', 10);
    expect(row.deliveryStatus).toBe('queued');
  });
});

describe('messages.bySession — content replacement rewrite', () => {
  let db: BunDatabase;

  beforeEach(() => {
    db = makeDb();
    insertSession(db, { id: 's1' });
  });

  afterEach(() => {
    db.close();
  });

  test('registry supplies a rowFingerprint so the engine skips full payload hashing', () => {
    const entry = NAMED_QUERY_REGISTRY.get('messages.bySession')!;
    expect(typeof entry.rowFingerprint).toBe('function');
  });

  test('a content rewrite through the repository replacement path emits an updated diff', async () => {
    const entry = NAMED_QUERY_REGISTRY.get('messages.bySession')!;
    const reactiveDb = createReactiveDatabase({ getDatabase: () => db } as never);
    const engine = new LiveQueryEngine(db, reactiveDb);
    const diffs: Array<{ added?: unknown[]; removed?: unknown[]; updated?: unknown[] }> = [];
    engine.subscribe(entry.sql, ['s1', 100], (diff) => diffs.push(diff), {
      debounceMs: 0,
      rowFingerprint: entry.rowFingerprint,
    });
    expect(diffs).toHaveLength(1);

    insertSdkMessage(db, {
      id: 'action-1',
      sessionId: 's1',
      messageType: 'hyperneo_action',
      messageSubtype: 'sdk_resume_choice',
      sdkMessage: {
        type: 'hyperneo_action',
        uuid: 'u-action',
        session_id: 's1',
        action: 'sdk_resume_choice',
        resolved: false,
        chosenOption: 'start_fresh',
        timestamp: 1,
      },
      timestamp: '2024-01-01 00:00:01',
    });
    reactiveDb.notifyChange('sdk_messages', { sessionId: 's1' });
    await Promise.resolve();
    await Promise.resolve();
    expect(diffs).toHaveLength(2);
    expect(diffs[1].added).toHaveLength(1);

    const repo = new SDKMessageRepository(db, reactiveDb);
    repo.updateHyperNeoActionMessage('action-1', {
      type: 'hyperneo_action',
      uuid: 'u-action',
      session_id: 's1',
      action: 'sdk_resume_choice',
      resolved: false,
      chosenOption: 'leave_as_is',
      timestamp: 1,
    });

    reactiveDb.notifyChange('sdk_messages', { sessionId: 's1' });
    await Promise.resolve();
    await Promise.resolve();

    expect(diffs).toHaveLength(3);
    const updated = diffs[2].updated as Array<{ id: string; content: string }>;
    expect(updated.map((row) => row.id)).toContain('action-1');
    const rewritten = updated.find((row) => row.id === 'action-1');
    expect(rewritten?.content).toContain('"chosenOption":"leave_as_is"');

    engine.dispose();
  });
});
