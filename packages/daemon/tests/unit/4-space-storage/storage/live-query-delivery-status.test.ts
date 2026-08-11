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
  deliveryRetry: number;
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

describe('messages.bySession delivery-status reactive pipeline', () => {
  let dbPath: string;
  let db: Database;
  let bunDb: BunDatabase;
  let reactiveDb: ReactiveDatabase;
  let engine: LiveQueryEngine;
  const sessionId = 'sess-delivery';

  // The registered query SQL (params: sessionId, limit). Subscribing at this
  // layer yields raw rows (id / sendStatus / deliveryRetry); the send_status →
  // deliveryStatus mapping is covered by the unit tests.
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
});
