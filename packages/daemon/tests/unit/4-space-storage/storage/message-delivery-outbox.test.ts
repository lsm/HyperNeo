/**
 * Transactional outbox (task #861 item 2) — atomic save + enqueue.
 *
 * Asserts the core guarantee: a user message and its durable `job_queue`
 * delivery row commit together, so a crash between save and enqueue cannot
 * strand a saved-but-not-enqueued row. Also covers role arbitration (turn vs
 * steer via the partial unique index) and that a post-commit side-effect
 * failure (e.g. FTS) does not reject the send (which would cause a duplicate
 * on client retry).
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { MESSAGE_DELIVERY } from '../../../../src/lib/job-queue-constants';
import { persistAndEnqueueDelivery } from '../../../../src/lib/agent/message-delivery-outbox';
import { reconcileStrandedDeliveries } from '../../../../src/lib/agent/message-delivery';
import type { JobQueueRepository as JobQueueRepoType } from '../../../../src/storage/repositories/job-queue-repository';
import type { SDKMessage } from '@hyperneo/shared/sdk';

const SESSION = 'sess-outbox';

function userMessage(uuid: string, text = 'hello'): SDKMessage {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as SDKMessage;
}

function setup() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sdk_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      message_subtype TEXT,
      sdk_message TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      send_status TEXT,
      origin TEXT,
      is_renderable INTEGER NOT NULL DEFAULT 1,
      is_terminal INTEGER NOT NULL DEFAULT 0,
      conversation_turn_index INTEGER,
      parent_tool_use_id TEXT,
      task_id TEXT,
      sdk_uuid TEXT,
      replacement_metadata_normalized INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE sdk_message_replacements (
      source_message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      task_id TEXT,
      target_uuid TEXT NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (source_message_id, target_uuid, kind)
    );
    CREATE TABLE sessions (id TEXT PRIMARY KEY, visible_message_count INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX idx_sdk_messages_session ON sdk_messages(session_id);

    CREATE TABLE job_queue (
      id TEXT PRIMARY KEY,
      queue TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
      payload TEXT NOT NULL DEFAULT '{}',
      result TEXT,
      error TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      retry_count INTEGER NOT NULL DEFAULT 0,
      run_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      heartbeat_at INTEGER,
      completed_at INTEGER
    );
  `);
  // The atomic role arbiter — must match the production migration exactly.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_message_delivery_active_turn
      ON job_queue (queue, json_extract(payload, '$.sessionId'))
      WHERE queue = 'message_delivery'
        AND json_extract(payload, '$.role') = 'turn'
        AND status IN ('pending', 'processing');
  `);
  const sdkRepo = new SDKMessageRepository(db as never);
  const jobQueue = new JobQueueRepository(db as never);
  return { db, sdkRepo, jobQueue };
}

function jobPayload(db: Database, sessionId: string, messageUuid: string) {
  const row = db
    .prepare(
      `SELECT payload FROM job_queue
        WHERE queue = ? AND json_extract(payload, '$.sessionId') = ?
          AND json_extract(payload, '$.messageUuid') = ? LIMIT 1`
    )
    .get(MESSAGE_DELIVERY, sessionId, messageUuid) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as Record<string, unknown>) : null;
}

describe('transactional outbox (persistAndEnqueueDelivery)', () => {
  let db: Database;
  let sdkRepo: SDKMessageRepository;
  let jobQueue: JobQueueRepository;

  beforeEach(() => {
    ({ db, sdkRepo, jobQueue } = setup());
  });
  afterEach(() => db.close());

  it('saves the user message AND enqueues a turn delivery job atomically', () => {
    const uuid = 'msg-1';
    const { dbMessageId, role } = persistAndEnqueueDelivery({
      db: db as never,
      sdkMessageRepo: sdkRepo,
      jobQueue,
      sessionId: SESSION,
      message: userMessage(uuid),
      sendStatus: 'enqueued',
      delivery: { origin: 'chat' },
    });

    expect(role).toBe('turn');
    // sdk_messages row persisted as enqueued.
    const row = db
      .prepare(`SELECT send_status FROM sdk_messages WHERE id = ?`)
      .get(dbMessageId) as { send_status: string };
    expect(row.send_status).toBe('enqueued');
    // job_queue row enqueued as a turn.
    const payload = jobPayload(db, SESSION, uuid);
    expect(payload).not.toBeNull();
    expect(payload?.role).toBe('turn');
    expect(payload?.origin).toBe('chat');
  });

  it('inserts as steer when an active turn already owns the session', () => {
    // First message claims the active-turn slot as a turn.
    persistAndEnqueueDelivery({
      db: db as never,
      sdkMessageRepo: sdkRepo,
      jobQueue,
      sessionId: SESSION,
      message: userMessage('msg-turn'),
      sendStatus: 'enqueued',
      delivery: { origin: 'chat' },
    });
    // A second message, while the turn is active, must become a steer.
    const { role } = persistAndEnqueueDelivery({
      db: db as never,
      sdkMessageRepo: sdkRepo,
      jobQueue,
      sessionId: SESSION,
      message: userMessage('msg-steer'),
      sendStatus: 'enqueued',
      delivery: { origin: 'chat' },
    });
    expect(role).toBe('steer');
    expect(jobPayload(db, SESSION, 'msg-steer')?.role).toBe('steer');
  });

  it('rolls back BOTH writes when the enqueue fails (no stranded row)', () => {
    // Simulate a transient job_queue failure by stubbing enqueue to throw a
    // non-UNIQUE error. The outbox transaction must roll back the sdk_messages
    // insert too — otherwise the row is saved-but-not-enqueued (the exact gap
    // item 2 closes).
    const failingQueue = {
      enqueue: () => {
        throw new Error('simulated job_queue transient failure');
      },
    } as unknown as JobQueueRepoType;

    expect(() =>
      persistAndEnqueueDelivery({
        db: db as never,
        sdkMessageRepo: sdkRepo,
        jobQueue: failingQueue,
        sessionId: SESSION,
        message: userMessage('msg-fail'),
        sendStatus: 'enqueued',
        delivery: { origin: 'chat' },
      })
    ).toThrow(/simulated job_queue transient failure/);

    // No sdk_messages row, no job_queue row — nothing stranded.
    const sdkCount = db
      .prepare(`SELECT COUNT(*) AS c FROM sdk_messages WHERE session_id = ?`)
      .get(SESSION) as { c: number };
    expect(sdkCount.c).toBe(0);
    const jobCount = db
      .prepare(`SELECT COUNT(*) AS c FROM job_queue WHERE queue = ?`)
      .get(MESSAGE_DELIVERY) as { c: number };
    expect(jobCount.c).toBe(0);
  });

  it('does NOT reject when a post-commit side effect throws (no duplicate on retry)', () => {
    // The outbox tx commits both the user row + the delivery job; a subsequent
    // side-effect throw (e.g. fallible FTS index) must NOT propagate — else the
    // client retries with a fresh UUID and the prompt is delivered twice.
    // (Codex review.)
    const sdkMessageRepo = new Proxy(sdkRepo, {
      get(target, prop) {
        if (prop === 'runPostSaveSideEffects') {
          return () => {
            throw new Error('FTS index exploded');
          };
        }
        return Reflect.get(target, prop);
      },
    }) as typeof sdkRepo;

    const result = persistAndEnqueueDelivery({
      db: db as never,
      sdkMessageRepo,
      jobQueue,
      sessionId: SESSION,
      message: userMessage('msg-sideeffect'),
      sendStatus: 'enqueued',
      delivery: { origin: 'chat' },
    });

    // Both writes committed and the call resolved despite the side-effect throw.
    expect(result.role).toBe('turn');
    expect(jobPayload(db, SESSION, 'msg-sideeffect')).not.toBeNull();
    const row = db
      .prepare(`SELECT send_status FROM sdk_messages WHERE id = ?`)
      .get(result.dbMessageId) as { send_status: string };
    expect(row.send_status).toBe('enqueued');
  });

  it('throws when the message carries no uuid (cannot key the job)', () => {
    const noUuid = { type: 'user', message: { role: 'user', content: [] } } as SDKMessage;
    expect(() =>
      persistAndEnqueueDelivery({
        db: db as never,
        sdkMessageRepo: sdkRepo,
        jobQueue,
        sessionId: SESSION,
        message: noUuid,
        sendStatus: 'enqueued',
        delivery: { origin: 'chat' },
      })
    ).toThrow(/no uuid/);
  });
});

describe('reconcileStrandedDeliveries (task #861 item 4 — orphan reconciler)', () => {
  let db: Database;
  let sdkRepo: SDKMessageRepository;
  let jobQueue: JobQueueRepository;

  beforeEach(() => {
    ({ db, sdkRepo, jobQueue } = setup());
  });
  afterEach(() => db.close());

  function persistEnqueued(uuid: string): void {
    sdkRepo.saveUserMessage(SESSION, userMessage(uuid), 'enqueued');
  }
  function activeJobCount(): number {
    return (
      db.prepare(`SELECT COUNT(*) AS c FROM job_queue WHERE queue = 'message_delivery'`).get() as {
        c: number;
      }
    ).c;
  }

  it('re-enqueues an enqueued message with no active durable job (the #856 shape)', async () => {
    persistEnqueued('stranded-1');
    expect(activeJobCount()).toBe(0);

    const count = await reconcileStrandedDeliveries({ sessionId: SESSION, db: sdkRepo, jobQueue });

    expect(count).toBe(1);
    expect(jobPayload(db, SESSION, 'stranded-1')).not.toBeNull();
    expect(jobPayload(db, SESSION, 'stranded-1')?.role).toBe('turn');
  });

  it('does NOT re-enqueue a message that already has an active durable job', async () => {
    persistEnqueued('owned-1');
    // Simulate the durable owner: enqueue a job for it.
    jobQueue.enqueue({
      queue: MESSAGE_DELIVERY,
      payload: { sessionId: SESSION, messageUuid: 'owned-1', role: 'turn', origin: 'chat' },
      maxRetries: 8,
    });
    expect(activeJobCount()).toBe(1);

    const count = await reconcileStrandedDeliveries({ sessionId: SESSION, db: sdkRepo, jobQueue });

    expect(count).toBe(0);
    expect(activeJobCount()).toBe(1); // no duplicate job
  });

  it('is idempotent: a second run after re-enqueue is a no-op', async () => {
    persistEnqueued('once-1');
    expect(await reconcileStrandedDeliveries({ sessionId: SESSION, db: sdkRepo, jobQueue })).toBe(
      1
    );
    // Second run: the message now has an active job → 0 re-enqueued, no dup.
    expect(await reconcileStrandedDeliveries({ sessionId: SESSION, db: sdkRepo, jobQueue })).toBe(
      0
    );
    expect(activeJobCount()).toBe(1);
  });

  it('reloads content from storage — never inserts a second user row', async () => {
    persistEnqueued('content-1');
    await reconcileStrandedDeliveries({ sessionId: SESSION, db: sdkRepo, jobQueue });
    // Exactly one sdk_messages row for the uuid (no duplicate payload).
    const rows = db
      .prepare(`SELECT COUNT(*) AS c FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?`)
      .get(SESSION, 'content-1') as { c: number };
    expect(rows.c).toBe(1);
  });

  it('re-enqueues multiple stranded messages, first as turn and the rest as steer', async () => {
    persistEnqueued('s-a');
    persistEnqueued('s-b');
    persistEnqueued('s-c');
    const count = await reconcileStrandedDeliveries({ sessionId: SESSION, db: sdkRepo, jobQueue });
    expect(count).toBe(3);
    const roles = ['s-a', 's-b', 's-c'].map((u) => jobPayload(db, SESSION, u)?.role);
    expect(roles.filter((r) => r === 'turn')).toHaveLength(1);
    expect(roles.filter((r) => r === 'steer')).toHaveLength(2);
  });

  it('returns 0 when there are no enqueued messages', async () => {
    expect(await reconcileStrandedDeliveries({ sessionId: SESSION, db: sdkRepo, jobQueue })).toBe(
      0
    );
  });

  it('concurrent reconciles never double-enqueue one message (review: concurrent reconcilers)', async () => {
    // Two reconcilers racing for the same stranded message (e.g. the idle
    // callback firing alongside the 60s timer). The per-session lock must
    // serialize them so exactly ONE durable job is created — not a turn + a
    // duplicate steer for the same UUID.
    persistEnqueued('race-1');
    const results = await Promise.all([
      reconcileStrandedDeliveries({ sessionId: SESSION, db: sdkRepo, jobQueue }),
      reconcileStrandedDeliveries({ sessionId: SESSION, db: sdkRepo, jobQueue }),
      reconcileStrandedDeliveries({ sessionId: SESSION, db: sdkRepo, jobQueue }),
    ]);
    // Only one of the racing passes re-enqueued; the others saw the active job.
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(activeJobCount()).toBe(1); // exactly one job, no duplicate
    expect(jobPayload(db, SESSION, 'race-1')).not.toBeNull();
  });
});
