import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { MESSAGE_DELIVERY } from '../../../../src/lib/job-queue-constants';
import { persistAndEnqueueDelivery } from '../../../../src/lib/agent/message-delivery-outbox';
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
    const row = db
      .prepare(`SELECT send_status FROM sdk_messages WHERE id = ?`)
      .get(dbMessageId) as { send_status: string };
    expect(row.send_status).toBe('enqueued');
    const payload = jobPayload(db, SESSION, uuid);
    expect(payload).not.toBeNull();
    expect(payload?.role).toBe('turn');
    expect(payload?.origin).toBe('chat');
  });

  it('inserts as steer when an active turn already owns the session', () => {
    persistAndEnqueueDelivery({
      db: db as never,
      sdkMessageRepo: sdkRepo,
      jobQueue,
      sessionId: SESSION,
      message: userMessage('msg-turn'),
      sendStatus: 'enqueued',
      delivery: { origin: 'chat' },
    });
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

  describe('role-arbitration call-site characterization (A1b)', () => {
    it('has no same-UUID ownership precheck — a second persist enqueues a duplicate (turn then steer)', () => {
      const first = persistAndEnqueueDelivery({
        db: db as never,
        sdkMessageRepo: sdkRepo,
        jobQueue,
        sessionId: SESSION,
        message: userMessage('dup'),
        sendStatus: 'enqueued',
        delivery: { origin: 'chat' },
      });
      expect(first.role).toBe('turn');
      const second = persistAndEnqueueDelivery({
        db: db as never,
        sdkMessageRepo: sdkRepo,
        jobQueue,
        sessionId: SESSION,
        message: userMessage('dup'),
        sendStatus: 'enqueued',
        delivery: { origin: 'chat' },
      });
      expect(second.role).toBe('steer');
      const jobs = db
        .prepare(`SELECT payload FROM job_queue WHERE queue = ?`)
        .all(MESSAGE_DELIVERY) as Array<{ payload: string }>;
      const dupJobs = jobs.filter(
        (j) => (JSON.parse(j.payload) as { messageUuid?: string }).messageUuid === 'dup'
      );
      expect(dupJobs).toHaveLength(2);
      const roles = dupJobs.map((j) => (JSON.parse(j.payload) as { role: string }).role).sort();
      expect(roles).toEqual(['steer', 'turn']);
      const rows = db
        .prepare(`SELECT COUNT(*) AS c FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?`)
        .get(SESSION, 'dup') as { c: number };
      expect(rows.c).toBe(2);
    });

    it('converts an implicit turn collision to steer inside the transaction — the save COMMITS with the steer (no rollback)', () => {
      jobQueue.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: { sessionId: SESSION, messageUuid: 'anchor', role: 'turn', origin: 'chat' },
      });
      const { role, dbMessageId } = persistAndEnqueueDelivery({
        db: db as never,
        sdkMessageRepo: sdkRepo,
        jobQueue,
        sessionId: SESSION,
        message: userMessage('collide'),
        sendStatus: 'enqueued',
        delivery: { origin: 'chat' },
      });
      expect(role).toBe('steer');
      const saved = db
        .prepare(`SELECT send_status FROM sdk_messages WHERE id = ?`)
        .get(dbMessageId) as { send_status: string } | undefined;
      expect(saved).not.toBeUndefined();
      expect(saved?.send_status).toBe('enqueued');
      expect(jobPayload(db, SESSION, 'collide')?.role).toBe('steer');
    });
  });

  describe('role-arbitration wiring (A3b — Phase 0 transactional ownership)', () => {
    it('rolls back BOTH writes when the steer fallback enqueue also fails — no ownerless row', () => {
      let calls = 0;
      const failingQueue = {
        enqueue: () => {
          calls++;
          throw new Error(
            calls === 1 ? 'UNIQUE constraint failed: job_queue.queue' : 'fallback enqueue exploded'
          );
        },
      } as unknown as JobQueueRepoType;

      expect(() =>
        persistAndEnqueueDelivery({
          db: db as never,
          sdkMessageRepo: sdkRepo,
          jobQueue: failingQueue,
          sessionId: SESSION,
          message: userMessage('msg-fallback-fail'),
          sendStatus: 'enqueued',
          delivery: { origin: 'chat' },
        })
      ).toThrow(/fallback enqueue exploded/);

      expect(calls).toBe(2);
      const sdkCount = db
        .prepare(`SELECT COUNT(*) AS c FROM sdk_messages WHERE session_id = ?`)
        .get(SESSION) as { c: number };
      expect(sdkCount.c).toBe(0);
      const jobCount = db
        .prepare(`SELECT COUNT(*) AS c FROM job_queue WHERE queue = ?`)
        .get(MESSAGE_DELIVERY) as { c: number };
      expect(jobCount.c).toBe(0);
    });

    it('attempts exactly one enqueue when the failure is not a UNIQUE constraint', () => {
      let calls = 0;
      const failingQueue = {
        enqueue: () => {
          calls++;
          throw new Error('simulated job_queue transient failure');
        },
      } as unknown as JobQueueRepoType;

      expect(() =>
        persistAndEnqueueDelivery({
          db: db as never,
          sdkMessageRepo: sdkRepo,
          jobQueue: failingQueue,
          sessionId: SESSION,
          message: userMessage('msg-single-fail'),
          sendStatus: 'enqueued',
          delivery: { origin: 'chat' },
        })
      ).toThrow(/simulated job_queue transient failure/);

      expect(calls).toBe(1);
      const sdkCount = db
        .prepare(`SELECT COUNT(*) AS c FROM sdk_messages WHERE session_id = ?`)
        .get(SESSION) as { c: number };
      expect(sdkCount.c).toBe(0);
    });
  });
});
