/**
 * Delivery-status reactive-pipeline integration tests (task #862).
 *
 * End-to-end through Database facade → ReactiveDatabase → LiveQueryEngine:
 * a `send_status` transition on a user message must emit an UPDATED delta on
 * the SAME row (never a duplicate ADD), so a retry / state change updates the
 * one visible message rather than adding another. This is the guarantee that
 * lets the widened `messages.bySession` feed show queued → processing →
 * delivered without producing duplicate user bubbles.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { Database } from '../../../../src/storage/index';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { LiveQueryEngine } from '../../../../src/storage/live-query';
import { NAMED_QUERY_REGISTRY } from '../../../../src/lib/rpc-handlers/live-query-handlers';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';
import type { QueryDiff } from '../../../../src/storage/live-query';
import type { SDKMessage } from '@hyperneo/shared/sdk';

interface MessageRow {
  id: string;
  sendStatus: string | null;
  /** Raw `json_object('count','runAt','max')` from the active delivery job, or null. */
  deliveryRetryInfo: string | null;
}

function makeTempDbPath(): string {
  return join(
    tmpdir(),
    `live-query-delivery-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
}

function makeUserMessage(uuid: string, content: string): SDKMessage {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'text', text: content }] },
  } as SDKMessage;
}

/** Insert a message_delivery job_queue row (task #862 retry-signal tests). */
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

describe('messages.bySession delivery-status reactive pipeline', () => {
  let dbPath: string;
  let db: Database;
  let bunDb: BunDatabase;
  let reactiveDb: ReactiveDatabase;
  let engine: LiveQueryEngine;
  const sessionId = 'sess-delivery';

  // The registered query SQL (params: sessionId, limit). Subscribing at this
  // layer yields raw rows (id / sendStatus / deliveryRetryInfo); the send_status
  // → deliveryStatus mapping is covered by the unit tests.
  const SQL = NAMED_QUERY_REGISTRY.get('messages.bySession')!.sql;

  beforeEach(async () => {
    dbPath = makeTempDbPath();
    db = new Database(dbPath);
    reactiveDb = createReactiveDatabase(db);
    await db.initialize(reactiveDb);
    bunDb = db.getDatabase();
    engine = new LiveQueryEngine(bunDb, reactiveDb);

    bunDb
      .prepare(
        `INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata)
         VALUES (?, ?, datetime('now'), datetime('now'), 'active', '{}', '{}')`
      )
      .run(sessionId, 'Delivery Session');
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

  /** Flush the LiveQueryEngine microtask so pending deltas are emitted. */
  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  test('a send_status transition emits an UPDATED delta on the same row (no duplicate)', async () => {
    const diffs: QueryDiff<MessageRow>[] = [];
    engine.subscribe<MessageRow>(SQL, [sessionId, 100], (diff) => diffs.push(diff));
    await flush();
    expect(diffs[0].type).toBe('snapshot');
    expect(diffs[0].rows).toHaveLength(0);

    // 1) Save enqueued (via the reactive proxy so it notifies) — added row.
    const rowId = reactiveDb.db.saveUserMessage(
      sessionId,
      makeUserMessage('u-1', 'hello'),
      'enqueued'
    );
    await flush();

    const addedDelta = diffs[1];
    expect(addedDelta.type).toBe('delta');
    expect(addedDelta.added?.length).toBe(1);
    expect(addedDelta.added?.[0].id).toBe(rowId);
    expect(addedDelta.added?.[0].sendStatus).toBe('enqueued');

    // 2) Flip to submitted — same row id, UPDATED (not a second added row).
    bunDb.prepare(`UPDATE sdk_messages SET send_status = 'submitted' WHERE id = ?`).run(rowId);
    reactiveDb.notifyChange('sdk_messages');
    await flush();

    const submittedDelta = diffs[2];
    expect(submittedDelta.type).toBe('delta');
    expect(submittedDelta.updated?.length).toBe(1);
    expect(submittedDelta.updated?.[0].id).toBe(rowId);
    expect(submittedDelta.updated?.[0].sendStatus).toBe('submitted');
    expect(submittedDelta.added ?? []).toHaveLength(0);

    // 3) Flip to consumed — same row id again, UPDATED.
    bunDb.prepare(`UPDATE sdk_messages SET send_status = 'consumed' WHERE id = ?`).run(rowId);
    reactiveDb.notifyChange('sdk_messages');
    await flush();

    const consumedDelta = diffs[3];
    expect(consumedDelta.updated?.length).toBe(1);
    expect(consumedDelta.updated?.[0].id).toBe(rowId);
    expect(consumedDelta.updated?.[0].sendStatus).toBe('consumed');
    expect(consumedDelta.added ?? []).toHaveLength(0);

    // Across the whole lifecycle exactly one row id was ever added — the
    // transitions updated it in place rather than producing duplicate bubbles.
    const allAddedIds = diffs
      .filter((d) => d.type === 'delta')
      .flatMap((d) => (d.added ?? []).map((r) => r.id));
    expect(allAddedIds).toEqual([rowId]);
  });

  test('the snapshot after a reconnect reconciles to the latest send_status (single row)', async () => {
    // Persist a message and advance it to consumed before any subscription
    // (state landed while the client was disconnected).
    const rowId = reactiveDb.db.saveUserMessage(
      sessionId,
      makeUserMessage('u-2', 'reconcile'),
      'enqueued'
    );
    bunDb.prepare(`UPDATE sdk_messages SET send_status = 'consumed' WHERE id = ?`).run(rowId);

    // Now subscribe (reconnect) — the snapshot reflects the final state.
    const diffs: QueryDiff<MessageRow>[] = [];
    engine.subscribe<MessageRow>(SQL, [sessionId, 100], (diff) => diffs.push(diff));
    await flush();

    expect(diffs[0].type).toBe('snapshot');
    const rows = diffs[0].rows!;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(rowId);
    expect(rows[0].sendStatus).toBe('consumed');
  });

  test('a job_queue retry transition re-evaluates the feed (job_queue is a feed dependency)', async () => {
    // The "retrying" state comes from an EXISTS vs job_queue. The query's table
    // extraction must register job_queue as a dependency so a job transition
    // (notified by messageDeliveryProcessor → reactiveDb.notifyChange('job_queue'))
    // re-evaluates messages.bySession and emits a delta on the matching message.
    const rowId = reactiveDb.db.saveUserMessage(
      sessionId,
      makeUserMessage('u-job', 'retry me'),
      'enqueued'
    );

    const diffs: QueryDiff<MessageRow>[] = [];
    engine.subscribe<MessageRow>(SQL, [sessionId, 100], (diff) => diffs.push(diff));
    await flush();
    expect(diffs[0].type).toBe('snapshot');
    // No active delivery job yet → the raw retry-info scalar is null.
    expect(diffs[0].rows![0].deliveryRetryInfo).toBeNull();

    // A reclaim re-drove the message — active job, retry_count > 0.
    insertDeliveryJob(bunDb, {
      id: 'job-retry',
      sessionId,
      messageUuid: 'u-job',
      status: 'pending',
      retryCount: 1,
    });
    // Simulate messageDeliveryProcessor.setChangeNotifier → notifyChange('job_queue').
    reactiveDb.notifyChange('job_queue');
    await flush();

    const retryDelta = diffs[1];
    expect(retryDelta.type).toBe('delta');
    expect(retryDelta.updated?.length).toBe(1);
    expect(retryDelta.updated?.[0].id).toBe(rowId);
    // deliveryRetryInfo is a raw json_object('count','runAt','max') from the
    // now-active job — count reflects retry_count=1.
    const info = JSON.parse(retryDelta.updated?.[0].deliveryRetryInfo ?? 'null');
    expect(info?.count).toBe(1);
    // The same row was updated, not duplicated.
    expect(retryDelta.added ?? []).toHaveLength(0);
  });
});
