/**
 * Transactional outbox (task #861 item 2) — atomic save + enqueue.
 *
 * Asserts the core guarantee: a user message and its durable `job_queue`
 * delivery row commit together, so a crash between save and enqueue cannot
 * strand a saved-but-not-enqueued row. Also covers role arbitration (turn vs
 * steer via the partial unique index) and the legacy-owned-turn `forceSteer`.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { MESSAGE_DELIVERY } from '../../../../src/lib/job-queue-constants';
import {
  persistAndEnqueueDelivery,
  enqueueDeliveryRole,
} from '../../../../src/lib/agent/message-delivery-outbox';
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

  it('forceSteer inserts as steer even with no active turn', () => {
    const { role } = persistAndEnqueueDelivery({
      db: db as never,
      sdkMessageRepo: sdkRepo,
      jobQueue,
      sessionId: SESSION,
      message: userMessage('msg-force'),
      sendStatus: 'enqueued',
      delivery: { origin: 'chat' },
      forceSteer: true,
    });
    expect(role).toBe('steer');
    expect(jobPayload(db, SESSION, 'msg-force')?.role).toBe('steer');
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

  it('enqueueDeliveryRole: UNIQUE failure on turn falls back to steer', () => {
    const base = {
      sessionId: SESSION,
      messageUuid: 'u',
      origin: 'chat' as const,
      parentToolUseId: null,
    };
    // Occupy the active-turn slot.
    enqueueDeliveryRole(jobQueue, { ...base, messageUuid: 'turn-owner' }, false);
    // A second turn insert must hit the index and fall back to steer.
    const role = enqueueDeliveryRole(jobQueue, { ...base, messageUuid: 'u' }, false);
    expect(role).toBe('steer');
    expect(jobPayload(db, SESSION, 'u')?.role).toBe('steer');
  });
});
