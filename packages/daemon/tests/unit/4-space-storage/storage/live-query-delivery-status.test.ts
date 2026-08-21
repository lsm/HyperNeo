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

function insertDeliveryJob(
  db: BunDatabase,
  args: {
    id: string;
    sessionId: string;
    messageUuid: string;
    status?: 'pending' | 'processing' | 'completed' | 'failed' | 'dead';
    retryCount?: number;
    maxRetries?: number;
    runAt?: number;
    role?: 'turn' | 'steer';
  }
): void {
  db.prepare(
    `INSERT INTO job_queue
       (id, queue, status, payload, retry_count, max_retries, run_at, created_at)
     VALUES (?, 'message_delivery', ?, ?, ?, ?, ?, ?)`
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
    args.maxRetries ?? 8,
    args.runAt ?? Date.now(),
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
    } catch {}
    try {
      rmSync(dbPath, { force: true });
      rmSync(dbPath + '-wal', { force: true });
      rmSync(dbPath + '-shm', { force: true });
    } catch {}
  });

  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  test('a send_status transition emits an UPDATED delta on the same row (no duplicate)', async () => {
    const diffs: QueryDiff<MessageRow>[] = [];
    engine.subscribe<MessageRow>(SQL, [sessionId, 100], (diff) => diffs.push(diff), {
      rowFingerprint: NAMED_QUERY_REGISTRY.get('messages.bySession')!.rowFingerprint,
    });
    await flush();
    expect(diffs[0].type).toBe('snapshot');
    expect(diffs[0].rows).toHaveLength(0);

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

    bunDb.prepare(`UPDATE sdk_messages SET send_status = 'submitted' WHERE id = ?`).run(rowId);
    reactiveDb.notifyChange('sdk_messages');
    await flush();

    const submittedDelta = diffs[2];
    expect(submittedDelta.type).toBe('delta');
    expect(submittedDelta.updated?.length).toBe(1);
    expect(submittedDelta.updated?.[0].id).toBe(rowId);
    expect(submittedDelta.updated?.[0].sendStatus).toBe('submitted');
    expect(submittedDelta.added ?? []).toHaveLength(0);

    bunDb.prepare(`UPDATE sdk_messages SET send_status = 'consumed' WHERE id = ?`).run(rowId);
    reactiveDb.notifyChange('sdk_messages');
    await flush();

    const consumedDelta = diffs[3];
    expect(consumedDelta.updated?.length).toBe(1);
    expect(consumedDelta.updated?.[0].id).toBe(rowId);
    expect(consumedDelta.updated?.[0].sendStatus).toBe('consumed');
    expect(consumedDelta.added ?? []).toHaveLength(0);

    const allAddedIds = diffs
      .filter((d) => d.type === 'delta')
      .flatMap((d) => (d.added ?? []).map((r) => r.id));
    expect(allAddedIds).toEqual([rowId]);
  });

  test('the snapshot after a reconnect reconciles to the latest send_status (single row)', async () => {
    const rowId = reactiveDb.db.saveUserMessage(
      sessionId,
      makeUserMessage('u-2', 'reconcile'),
      'enqueued'
    );
    bunDb.prepare(`UPDATE sdk_messages SET send_status = 'consumed' WHERE id = ?`).run(rowId);

    const diffs: QueryDiff<MessageRow>[] = [];
    engine.subscribe<MessageRow>(SQL, [sessionId, 100], (diff) => diffs.push(diff), {
      rowFingerprint: NAMED_QUERY_REGISTRY.get('messages.bySession')!.rowFingerprint,
    });
    await flush();

    expect(diffs[0].type).toBe('snapshot');
    const rows = diffs[0].rows!;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(rowId);
    expect(rows[0].sendStatus).toBe('consumed');
  });

  test('a job_queue retry transition re-evaluates the feed (job_queue is a feed dependency)', async () => {
    const rowId = reactiveDb.db.saveUserMessage(
      sessionId,
      makeUserMessage('u-job', 'retry me'),
      'enqueued'
    );

    const diffs: QueryDiff<MessageRow>[] = [];
    engine.subscribe<MessageRow>(SQL, [sessionId, 100], (diff) => diffs.push(diff), {
      rowFingerprint: NAMED_QUERY_REGISTRY.get('messages.bySession')!.rowFingerprint,
    });
    await flush();
    expect(diffs[0].type).toBe('snapshot');
    expect(diffs[0].rows![0].deliveryRetryInfo).toBeNull();

    insertDeliveryJob(bunDb, {
      id: 'job-retry',
      sessionId,
      messageUuid: 'u-job',
      status: 'pending',
      retryCount: 1,
      maxRetries: 6,
      runAt: 1_700_000_000_001,
    });
    reactiveDb.notifyChange('job_queue');
    await flush();

    const retryDelta = diffs[1];
    expect(retryDelta.type).toBe('delta');
    expect(retryDelta.updated?.length).toBe(1);
    expect(retryDelta.updated?.[0].id).toBe(rowId);
    expect(JSON.parse(retryDelta.updated?.[0].deliveryRetryInfo ?? 'null')).toEqual({
      count: 1,
      runAt: 1_700_000_000_001,
      max: 6,
    });
    expect(retryDelta.added ?? []).toHaveLength(0);

    bunDb
      .prepare(`UPDATE job_queue SET retry_count = 2, run_at = ? WHERE id = 'job-retry'`)
      .run(1_700_000_000_002);
    reactiveDb.notifyChange('job_queue');
    await flush();

    const countdownDelta = diffs[2];
    expect(countdownDelta.updated?.length).toBe(1);
    expect(JSON.parse(countdownDelta.updated?.[0].deliveryRetryInfo ?? 'null')).toEqual({
      count: 2,
      runAt: 1_700_000_000_002,
      max: 6,
    });
    expect(countdownDelta.added ?? []).toHaveLength(0);
  });
});
