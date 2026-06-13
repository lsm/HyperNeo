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

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { createTables } from '../../../../src/storage/schema';
import { NAMED_QUERY_REGISTRY } from '../../../../src/lib/rpc-handlers/live-query-handlers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): BunDatabase {
  const db = new BunDatabase(':memory:');
  createTables(db);
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
}

function insertSdkMessage(db: BunDatabase, args: InsertSdkMessageArgs): void {
  const parentToolUseId =
    typeof args.sdkMessage.parent_tool_use_id === 'string'
      ? args.sdkMessage.parent_tool_use_id
      : null;
  db.prepare(
    `INSERT INTO sdk_messages
		 (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, origin, parent_tool_use_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    args.id,
    args.sessionId,
    args.messageType,
    args.messageSubtype ?? null,
    JSON.stringify(args.sdkMessage),
    args.timestamp ?? '2024-01-01 00:00:00',
    args.sendStatus ?? 'consumed',
    args.origin ?? null,
    parentToolUseId
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

  test('filters retracted messages before applying the top-level window', () => {
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
    expect(rows.map((r) => r.id)).toEqual(['older-real', 'fallback-notice']);
  });

  test('uses the session timestamp index for the top-level window', () => {
    const plan = queryPlan(db, 's1', 200);
    expect(plan).toContain('idx_sdk_messages_session_timestamp_id');
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
