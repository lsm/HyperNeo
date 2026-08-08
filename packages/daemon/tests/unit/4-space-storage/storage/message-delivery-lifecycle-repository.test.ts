/**
 * MessageDeliveryLifecycleRepository unit tests
 *
 * Covers the durable delivery-lifecycle ledger (task #859):
 *   - record + getTimeline: append-only ordered timeline + detail parsing
 *   - getLatestStage: "where did this message stop?"
 *   - getDiagnostics: totalsByLatestStage, unclaimed, stale, inter-stage latency
 *
 * Uses the real in-memory facade DB (createTestDb) so the table, migration 173,
 * FK to sessions, and indexes are exercised exactly as in production.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { generateUUID } from '@hyperneo/shared';
import { createTestDb, createTestSession } from '../../../helpers/database';
import type { Database } from '../../../../src/storage';
import type { MessageDeliveryStage } from '../../../../src/storage/repositories/message-delivery-lifecycle-repository';

let db: Database;
const SESSION_ID = 'sess-lifecycle-1';

/** Insert a lifecycle row with an explicit timestamp (bypasses record()'s Date.now). */
function insertEvent(
  sessionId: string,
  messageId: string,
  stage: MessageDeliveryStage,
  createdAt: number,
  detail?: Record<string, unknown>
): void {
  db.getDatabase()
    .prepare(
      `INSERT INTO message_delivery_lifecycle (id, session_id, message_id, stage, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      generateUUID(),
      sessionId,
      messageId,
      stage,
      detail ? JSON.stringify(detail) : null,
      createdAt
    );
}

beforeEach(async () => {
  db = await createTestDb();
  db.createSession(createTestSession(SESSION_ID));
});

describe('MessageDeliveryLifecycleRepository.record + getTimeline', () => {
  test('records an ordered timeline and parses detail', () => {
    const messageId = generateUUID();
    const repo = db.messageDeliveryLifecycle;

    repo.record(SESSION_ID, messageId, 'persisted', { sendStatus: 'enqueued' });
    repo.record(SESSION_ID, messageId, 'wake_requested', { queryStart: 'started' });
    repo.record(SESSION_ID, messageId, 'accepted');
    repo.record(SESSION_ID, messageId, 'consumed');

    const timeline = repo.getTimeline(messageId);
    expect(timeline.map((e) => e.stage)).toEqual([
      'persisted',
      'wake_requested',
      'accepted',
      'consumed',
    ]);
    expect(timeline[0].detail).toEqual({ sendStatus: 'enqueued' });
    expect(timeline[1].detail).toEqual({ queryStart: 'started' });
    expect(timeline[2].detail).toBeNull();
    expect(timeline.every((e) => e.messageId === messageId && e.sessionId === SESSION_ID)).toBe(
      true
    );
  });

  test('record is a no-op for empty ids and never throws', () => {
    const repo = db.messageDeliveryLifecycle;
    repo.record('', 'm1', 'persisted');
    repo.record(SESSION_ID, '', 'persisted');
    // Bad stage would violate the CHECK constraint — record() must swallow it.
    repo.record(SESSION_ID, 'm1', 'bogus' as MessageDeliveryStage);
    expect(repo.getTimeline('m1')).toEqual([]);
  });

  test('getTimeline returns [] for an unknown message', () => {
    expect(db.messageDeliveryLifecycle.getTimeline(generateUUID())).toEqual([]);
  });
});

describe('MessageDeliveryLifecycleRepository.getLatestStage', () => {
  test('returns the most recent stage, tiebreaking by row id', () => {
    const messageId = generateUUID();
    const base = Date.now();
    // Same created_at for two stages — the later-inserted row (higher rowid) wins.
    insertEvent(SESSION_ID, messageId, 'persisted', base);
    insertEvent(SESSION_ID, messageId, 'consumed', base);

    const latest = db.messageDeliveryLifecycle.getLatestStage(messageId);
    expect(latest?.stage).toBe('consumed');
  });

  test('returns null for an unknown message', () => {
    expect(db.messageDeliveryLifecycle.getLatestStage(generateUUID())).toBeNull();
  });
});

describe('MessageDeliveryLifecycleRepository.getDiagnostics', () => {
  test('totalsByLatestStage counts messages by their latest stage', () => {
    const repo = db.messageDeliveryLifecycle;
    const now = Date.now();

    // msgA: completed (terminal)
    const msgA = generateUUID();
    insertEvent(SESSION_ID, msgA, 'persisted', now);
    insertEvent(SESSION_ID, msgA, 'completed', now + 5);

    // msgB: failed (terminal)
    const msgB = generateUUID();
    insertEvent(SESSION_ID, msgB, 'persisted', now);
    insertEvent(SESSION_ID, msgB, 'failed', now + 5);

    // msgC: stuck at accepted (non-terminal)
    const msgC = generateUUID();
    insertEvent(SESSION_ID, msgC, 'persisted', now);
    insertEvent(SESSION_ID, msgC, 'accepted', now + 5);

    const diag = repo.getDiagnostics({ sessionId: SESSION_ID, staleMs: 60_000 });
    expect(diag.totalsByLatestStage['completed']).toBe(1);
    expect(diag.totalsByLatestStage['failed']).toBe(1);
    expect(diag.totalsByLatestStage['accepted']).toBe(1);
  });

  test('unclaimed lists messages persisted but never accepted', () => {
    const repo = db.messageDeliveryLifecycle;
    const now = Date.now();

    // Stranded at persisted: never wake-acknowledged nor accepted.
    const stranded = generateUUID();
    insertEvent(SESSION_ID, stranded, 'persisted', now);

    // Healthy: persisted then accepted then completed.
    const healthy = generateUUID();
    insertEvent(SESSION_ID, healthy, 'persisted', now);
    insertEvent(SESSION_ID, healthy, 'accepted', now + 1);
    insertEvent(SESSION_ID, healthy, 'completed', now + 2);

    const diag = repo.getDiagnostics({ sessionId: SESSION_ID });
    const unclaimedIds = diag.unclaimed.map((u) => u.messageId);
    expect(unclaimedIds).toContain(stranded);
    expect(unclaimedIds).not.toContain(healthy);
  });

  test('stale lists non-terminal messages older than the threshold', () => {
    const repo = db.messageDeliveryLifecycle;
    const now = Date.now();
    const staleMs = 5_000;

    // Old, non-terminal (stuck at consumed with no result).
    const stale = generateUUID();
    insertEvent(SESSION_ID, stale, 'persisted', now - staleMs - 1_000);
    insertEvent(SESSION_ID, stale, 'consumed', now - staleMs - 500);

    // Old but terminal (completed) — not stale.
    const done = generateUUID();
    insertEvent(SESSION_ID, done, 'persisted', now - staleMs - 1_000);
    insertEvent(SESSION_ID, done, 'completed', now - staleMs - 500);

    // Recent, non-terminal — not stale.
    const fresh = generateUUID();
    insertEvent(SESSION_ID, fresh, 'persisted', now);

    const diag = repo.getDiagnostics({ sessionId: SESSION_ID, staleMs });
    const staleIds = diag.stale.map((s) => s.messageId);
    expect(staleIds).toContain(stale);
    expect(staleIds).not.toContain(done);
    expect(staleIds).not.toContain(fresh);
  });

  test('latency summaries compute inter-stage deltas', () => {
    const repo = db.messageDeliveryLifecycle;
    const base = Date.now();

    const msg = generateUUID();
    insertEvent(SESSION_ID, msg, 'wake_requested', base); // wake
    insertEvent(SESSION_ID, msg, 'accepted', base + 10); // wake->accept = 10
    insertEvent(SESSION_ID, msg, 'consumed', base + 40); // accept->consumed = 30
    insertEvent(SESSION_ID, msg, 'first_progress', base + 90); // accept->first_progress = 80

    const diag = repo.getDiagnostics({ sessionId: SESSION_ID, sinceMs: 60 * 60 * 1000 });
    expect(diag.latency.wakeToAccept).toEqual({ count: 1, avgMs: 10, maxMs: 10 });
    expect(diag.latency.acceptToConsumed).toEqual({ count: 1, avgMs: 30, maxMs: 30 });
    expect(diag.latency.acceptToFirstProgress).toEqual({ count: 1, avgMs: 80, maxMs: 80 });
  });

  test('latency ignores messages missing the from/to stage', () => {
    const repo = db.messageDeliveryLifecycle;
    const base = Date.now();
    // Only persisted — no wake/accepted/first_progress pairs.
    insertEvent(SESSION_ID, generateUUID(), 'persisted', base);

    const diag = repo.getDiagnostics({ sessionId: SESSION_ID });
    expect(diag.latency.wakeToAccept.count).toBe(0);
    expect(diag.latency.acceptToFirstProgress.count).toBe(0);
  });

  test('intentionally-deferred messages are excluded from unclaimed/stale (F12)', () => {
    const repo = db.messageDeliveryLifecycle;
    const old = Date.now() - 100_000;
    // Deferred (manual mode / busy / rate-limited) — expected to sit at persisted.
    const deferred = generateUUID();
    insertEvent(SESSION_ID, deferred, 'persisted', old, { sendStatus: 'deferred' });
    // Enqueued but never claimed — genuinely unclaimed/stranded.
    const enqueued = generateUUID();
    insertEvent(SESSION_ID, enqueued, 'persisted', old, { sendStatus: 'enqueued' });

    const diag = repo.getDiagnostics({ sessionId: SESSION_ID, staleMs: 1 });
    const unclaimedIds = diag.unclaimed.map((u) => u.messageId);
    const staleIds = diag.stale.map((s) => s.messageId);

    // The deferred message is intentionally not-yet-delivered — exclude it.
    expect(unclaimedIds).not.toContain(deferred);
    expect(staleIds).not.toContain(deferred);
    // The enqueued one is a real strand.
    expect(unclaimedIds).toContain(enqueued);
    expect(staleIds).toContain(enqueued);
  });

  test('can be scoped daemon-wide when sessionId is omitted', () => {
    db.createSession(createTestSession('sess-2'));
    const now = Date.now();
    insertEvent('sess-2', generateUUID(), 'persisted', now);

    const scoped = db.messageDeliveryLifecycle.getDiagnostics({ sessionId: SESSION_ID });
    const broad = db.messageDeliveryLifecycle.getDiagnostics({});
    expect(scoped.unclaimed.length).toBe(0);
    expect(broad.unclaimed.length).toBeGreaterThanOrEqual(1);
  });

  test('scanWindowMs bounds the stuck-message scan (F7)', () => {
    const repo = db.messageDeliveryLifecycle;
    const now = Date.now();

    // An old unclaimed message outside the default 24h window.
    const old = generateUUID();
    insertEvent(SESSION_ID, old, 'persisted', now - 25 * 60 * 60 * 1000);
    // A recent unclaimed message inside the window.
    const recent = generateUUID();
    insertEvent(SESSION_ID, recent, 'persisted', now);

    const defaultDiag = repo.getDiagnostics({ sessionId: SESSION_ID });
    expect(defaultDiag.scanWindowMs).toBe(24 * 60 * 60 * 1000);
    expect(defaultDiag.unclaimed.map((u) => u.messageId)).toContain(recent);
    expect(defaultDiag.unclaimed.map((u) => u.messageId)).not.toContain(old);

    // Widening the window surfaces the old one too.
    const wide = repo.getDiagnostics({ sessionId: SESSION_ID, scanWindowMs: 48 * 60 * 60 * 1000 });
    expect(wide.unclaimed.map((u) => u.messageId)).toContain(old);
  });
});

describe('MessageDeliveryLifecycleRepository retention (F3/F7)', () => {
  test('deleteForMessage removes all rows for a UUID (cancelled message)', () => {
    const repo = db.messageDeliveryLifecycle;
    const messageId = generateUUID();
    repo.record(SESSION_ID, messageId, 'persisted');
    repo.record(SESSION_ID, messageId, 'wake_requested');
    expect(repo.getTimeline(messageId).length).toBe(2);

    repo.deleteForMessage(messageId);

    expect(repo.getTimeline(messageId)).toEqual([]);
    expect(repo.getLatestStage(messageId)).toBeNull();
    // No longer surfaces as unclaimed.
    const diag = repo.getDiagnostics({ sessionId: SESSION_ID });
    expect(diag.unclaimed.map((u) => u.messageId)).not.toContain(messageId);
  });

  test('deleteOlderThan sweeps rows before the cutoff and reports the count', () => {
    const repo = db.messageDeliveryLifecycle;
    const now = Date.now();
    const old = generateUUID();
    const recent = generateUUID();
    insertEvent(SESSION_ID, old, 'persisted', now - 10_000);
    insertEvent(SESSION_ID, recent, 'persisted', now);

    const deleted = repo.deleteOlderThan(now - 5_000);
    expect(deleted).toBe(1);
    expect(repo.getLatestStage(old)).toBeNull();
    expect(repo.getLatestStage(recent)?.stage).toBe('persisted');
  });

  test('deleteOlderThan preserves terminal evidence for still-consumed rows', () => {
    const repo = db.messageDeliveryLifecycle;
    const now = Date.now();

    // A delivered-and-completed message whose sdk_messages row REMAINS
    // send_status='consumed' (send_status has no delivered/finished value).
    // MessageRecoveryHandler relies on this ledger's terminal record to avoid
    // re-orphaning it after a restart; retention must not prune that evidence.
    // Insert the sdk_messages row directly (not via saveUserMessage, which would
    // add a live `persisted` event at NOW and mask the preserved terminal state).
    const deliveredId = generateUUID();
    db.getDatabase()
      .prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, sdk_uuid, send_status)
         VALUES (?, ?, 'user', ?, ?, ?, 'consumed')`
      )
      .run(
        generateUUID(),
        SESSION_ID,
        JSON.stringify({ type: 'user', uuid: deliveredId, message: { role: 'user', content: [] } }),
        new Date(now - 11_000).toISOString(),
        deliveredId
      );
    insertEvent(SESSION_ID, deliveredId, 'persisted', now - 10_000);
    insertEvent(SESSION_ID, deliveredId, 'consumed', now - 9_000);
    insertEvent(SESSION_ID, deliveredId, 'completed', now - 8_000);

    // An unrelated old non-terminal row the sweep should still remove.
    const other = generateUUID();
    insertEvent(SESSION_ID, other, 'persisted', now - 10_000);

    // Sweeps the non-terminal rows (deliveredId's persisted+consumed and other),
    // but preserves the terminal `completed` evidence for the consumed row.
    const deleted = repo.deleteOlderThan(now - 5_000);
    expect(deleted).toBe(3);
    // Terminal evidence preserved even though older than the cutoff…
    expect(repo.getLatestStage(deliveredId)?.stage).toBe('completed');
    // …while the non-terminal rows are swept, so recovery still sees a genuine gap.
    expect(repo.getLatestStage(other)).toBeNull();
  });
});
