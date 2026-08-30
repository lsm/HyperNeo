import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { MESSAGE_DELIVERY } from '../../../../src/lib/job-queue-constants';
import {
  activatePrompts,
  ensurePrompt,
  persistAndEnqueueDelivery,
  persistPrompt,
  retryPrompt,
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

  describe('pipeline composition (persist-and-enqueue-delivery)', () => {
    it('persists the same admission-derived columns as saveUserMessageCore', () => {
      const viaOutbox = setup();
      const viaWrapper = setup();

      const { dbMessageId: outboxId } = persistAndEnqueueDelivery({
        db: viaOutbox.db as never,
        sdkMessageRepo: viaOutbox.sdkRepo,
        jobQueue: viaOutbox.jobQueue,
        sessionId: SESSION,
        message: userMessage('parity'),
        sendStatus: 'enqueued',
        delivery: { origin: 'chat' },
      });
      const core = viaWrapper.sdkRepo.saveUserMessageCore(
        SESSION,
        userMessage('parity'),
        'enqueued'
      );

      const projection = `SELECT message_type, message_subtype, send_status, origin, is_renderable,
                          is_terminal, conversation_turn_index, parent_tool_use_id, task_id, sdk_uuid,
                          replacement_metadata_normalized
                          FROM sdk_messages WHERE id = ?`;
      expect(viaOutbox.db.prepare(projection).get(outboxId)).toEqual(
        viaWrapper.db.prepare(projection).get(core.id)
      );
      viaOutbox.db.close();
      viaWrapper.db.close();
    });

    it('carries delivery.parentToolUseId and origin into the enqueued job payload', () => {
      persistAndEnqueueDelivery({
        db: db as never,
        sdkMessageRepo: sdkRepo,
        jobQueue,
        sessionId: SESSION,
        message: userMessage('msg-parent'),
        sendStatus: 'enqueued',
        delivery: { origin: 'space_inject', parentToolUseId: 'toolu_1' },
      });
      const payload = jobPayload(db, SESSION, 'msg-parent');
      expect(payload?.parentToolUseId).toBe('toolu_1');
      expect(payload?.origin).toBe('space_inject');
    });

    it('runs post-save side effects with the committed row id and badge flag', () => {
      const calls: Array<[string, string, boolean]> = [];
      const spyRepo = new Proxy(sdkRepo, {
        get(target, prop) {
          if (prop === 'runPostSaveSideEffects') {
            return (sessionId: string, id: string, countsTowardsBadge: boolean) => {
              calls.push([sessionId, id, countsTowardsBadge]);
            };
          }
          return Reflect.get(target, prop);
        },
      }) as typeof sdkRepo;

      const { dbMessageId } = persistAndEnqueueDelivery({
        db: db as never,
        sdkMessageRepo: spyRepo,
        jobQueue,
        sessionId: SESSION,
        message: userMessage('msg-spy'),
        sendStatus: 'enqueued',
        delivery: { origin: 'chat' },
      });

      expect(calls).toEqual([[SESSION, dbMessageId, false]]);
    });
  });

  describe('canonical producer API (persistPrompt / ensurePrompt / activatePrompts / retryPrompt)', () => {
    function insertStatusRow(uuid: string, sendStatus: string, dbId = `db-${uuid}`): string {
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid, replacement_metadata_normalized)
         VALUES (?, ?, 'user', ?, ?, ?, ?, 1)`
      ).run(
        dbId,
        SESSION,
        JSON.stringify(userMessage(uuid)),
        new Date().toISOString(),
        sendStatus,
        uuid
      );
      return dbId;
    }

    function rowStatus(uuid: string): string | undefined {
      const row = db
        .prepare(`SELECT send_status FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?`)
        .get(SESSION, uuid) as { send_status: string } | undefined;
      return row?.send_status;
    }

    function jobsFor(uuid: string): Array<{
      id: string;
      status: string;
      role: unknown;
      released: number;
      retryCount: number;
    }> {
      return db
        .prepare(
          `SELECT id, status, json_extract(payload, '$.role') AS role,
                  COALESCE(json_extract(payload, '$.released'), 1) AS released, retry_count AS retryCount
             FROM job_queue
            WHERE queue = ?
              AND json_extract(payload, '$.sessionId') = ?
              AND json_extract(payload, '$.messageUuid') = ?
            ORDER BY created_at ASC, rowid ASC`
        )
        .all(MESSAGE_DELIVERY, SESSION, uuid) as Array<{
        id: string;
        status: string;
        role: unknown;
        released: number;
        retryCount: number;
      }>;
    }

    it('persistPrompt immediate saves an enqueued row with a released turn job', () => {
      const result = persistPrompt({
        db: db as never,
        sdkMessageRepo: sdkRepo,
        jobQueue,
        sessionId: SESSION,
        message: userMessage('persist-immediate'),
        delivery: { origin: 'chat' },
      });

      expect(result.released).toBe(true);
      expect(result.role).toBe('turn');
      expect(rowStatus('persist-immediate')).toBe('enqueued');
      expect(jobsFor('persist-immediate')).toHaveLength(1);
      expect(jobsFor('persist-immediate')[0].released).toBe(1);
    });

    it('persistPrompt manual hold saves a deferred row with an unreleased job', () => {
      const result = persistPrompt({
        db: db as never,
        sdkMessageRepo: sdkRepo,
        jobQueue,
        sessionId: SESSION,
        message: userMessage('persist-manual'),
        hold: 'manual',
        delivery: { origin: 'chat' },
      });

      expect(result.released).toBe(false);
      expect(result.role).toBe('turn');
      expect(rowStatus('persist-manual')).toBe('deferred');
      expect(jobsFor('persist-manual')).toHaveLength(1);
      expect(jobsFor('persist-manual')[0].released).toBe(0);
    });

    it('persistAndEnqueueDelivery keeps its shape and marks jobs released', () => {
      const result = persistAndEnqueueDelivery({
        db: db as never,
        sdkMessageRepo: sdkRepo,
        jobQueue,
        sessionId: SESSION,
        message: userMessage('wrapper-parity'),
        sendStatus: 'enqueued',
        delivery: { origin: 'chat' },
      });

      expect(result.dbMessageId).toBeTruthy();
      expect(result.role).toBe('turn');
      expect(jobsFor('wrapper-parity')[0].released).toBe(1);
    });

    it('ensurePrompt replays the same content onto the existing row and revives its job', () => {
      const first = persistPrompt({
        db: db as never,
        sdkMessageRepo: sdkRepo,
        jobQueue,
        sessionId: SESSION,
        message: userMessage('ensure-me'),
        delivery: { origin: 'chat' },
      });
      db.prepare(`UPDATE job_queue SET status = 'completed' WHERE id = ?`).run(
        jobsFor('ensure-me')[0].id
      );

      const replay = ensurePrompt({
        db: db as never,
        sdkMessageRepo: sdkRepo,
        jobQueue,
        sessionId: SESSION,
        message: userMessage('ensure-me'),
        delivery: { origin: 'chat' },
      });

      expect(replay.created).toBe(false);
      expect(replay.dbMessageId).toBe(first.dbMessageId);
      expect(replay.role).toBe('turn');
      expect(replay.released).toBe(true);
      const rows = db
        .prepare(`SELECT COUNT(*) AS c FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?`)
        .get(SESSION, 'ensure-me') as { c: number };
      expect(rows.c).toBe(1);
      const active = jobsFor('ensure-me').filter((job) => job.status === 'pending');
      expect(active).toHaveLength(1);
    });

    it('ensurePrompt errors on conflicting content without touching state', () => {
      persistPrompt({
        db: db as never,
        sdkMessageRepo: sdkRepo,
        jobQueue,
        sessionId: SESSION,
        message: userMessage('ensure-conflict'),
        delivery: { origin: 'chat' },
      });

      expect(() =>
        ensurePrompt({
          db: db as never,
          sdkMessageRepo: sdkRepo,
          jobQueue,
          sessionId: SESSION,
          message: userMessage('ensure-conflict', 'different text'),
          delivery: { origin: 'chat' },
        })
      ).toThrow(/different content/);
      const rows = db
        .prepare(`SELECT COUNT(*) AS c FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ?`)
        .get(SESSION, 'ensure-conflict') as { c: number };
      expect(rows.c).toBe(1);
      expect(jobsFor('ensure-conflict')).toHaveLength(1);
    });

    it('ensurePrompt creates the row and job when nothing exists', () => {
      const outcome = ensurePrompt({
        db: db as never,
        sdkMessageRepo: sdkRepo,
        jobQueue,
        sessionId: SESSION,
        message: userMessage('ensure-fresh', 'fresh'),
        hold: 'manual',
        delivery: { origin: 'chat' },
      });

      expect(outcome.created).toBe(true);
      expect(outcome.role).toBe('turn');
      expect(outcome.released).toBe(false);
      expect(rowStatus('ensure-fresh')).toBe('deferred');
      expect(jobsFor('ensure-fresh')[0].released).toBe(0);
    });

    it('ensurePrompt leaves a consumed row jobless and reports a null role', () => {
      insertStatusRow('ensure-consumed', 'consumed');

      const outcome = ensurePrompt({
        db: db as never,
        sdkMessageRepo: sdkRepo,
        jobQueue,
        sessionId: SESSION,
        message: userMessage('ensure-consumed'),
        delivery: { origin: 'chat' },
      });

      expect(outcome.created).toBe(false);
      expect(outcome.role).toBeNull();
      expect(outcome.released).toBe(true);
      expect(jobsFor('ensure-consumed')).toHaveLength(0);
    });

    it('activatePrompts enqueues several deferred rows in one transaction with FIFO roles', async () => {
      insertStatusRow('act-1', 'deferred');
      insertStatusRow('act-2', 'deferred');
      insertStatusRow('act-3', 'deferred');
      const publishes: Array<{ ids: string[]; jobsAtPublish: number }> = [];

      const { activated } = await activatePrompts({
        db: db as never,
        jobQueue,
        sessionId: SESSION,
        messageUuids: ['act-1', 'act-2', 'act-3', 'act-1'],
        origin: 'recovery',
        publishStatusChanged: (ids) => {
          publishes.push({
            ids: [...ids],
            jobsAtPublish: (
              db
                .prepare(`SELECT COUNT(*) AS c FROM job_queue WHERE queue = ?`)
                .get(MESSAGE_DELIVERY) as { c: number }
            ).c,
          });
        },
      });

      expect(activated.map((entry) => entry.messageUuid)).toEqual(['act-1', 'act-2', 'act-3']);
      expect(activated[0].role).toBe('turn');
      expect(activated.slice(1).map((entry) => entry.role)).toEqual(['steer', 'steer']);
      for (const uuid of ['act-1', 'act-2', 'act-3']) {
        expect(rowStatus(uuid)).toBe('enqueued');
        expect(jobsFor(uuid)[0].released).toBe(1);
      }
      expect(publishes).toEqual([{ ids: activated.map((entry) => entry.dbId), jobsAtPublish: 3 }]);
    });

    it('activatePrompts releases a held job in place instead of inserting a second one', async () => {
      insertStatusRow('held-1', 'deferred');
      jobQueue.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: {
          sessionId: SESSION,
          messageUuid: 'held-1',
          role: 'turn',
          origin: 'chat',
          parentToolUseId: null,
          released: false,
        },
      });
      const heldJob = jobsFor('held-1')[0];
      expect(heldJob.released).toBe(0);

      const { activated } = await activatePrompts({
        db: db as never,
        jobQueue,
        sessionId: SESSION,
        messageUuids: ['held-1'],
        origin: 'recovery',
      });

      expect(activated).toHaveLength(1);
      expect(activated[0].role).toBe('turn');
      expect(rowStatus('held-1')).toBe('enqueued');
      const after = jobsFor('held-1');
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(heldJob.id);
      expect(after[0].released).toBe(1);
    });

    it('activatePrompts leaves rows outside the deferred/enqueued lane untouched', async () => {
      insertStatusRow('skip-consumed', 'consumed');
      insertStatusRow('skip-failed', 'failed');

      const { activated } = await activatePrompts({
        db: db as never,
        jobQueue,
        sessionId: SESSION,
        messageUuids: ['skip-consumed', 'skip-failed', 'missing-uuid'],
        origin: 'recovery',
      });

      expect(activated).toEqual([]);
      expect(rowStatus('skip-consumed')).toBe('consumed');
      expect(rowStatus('skip-failed')).toBe('failed');
      expect(jobsFor('skip-consumed')).toHaveLength(0);
      expect(jobsFor('skip-failed')).toHaveLength(0);
    });

    it('activatePrompts rolls the whole batch back when the enqueue fails', async () => {
      insertStatusRow('rollback-1', 'deferred');
      insertStatusRow('rollback-2', 'deferred');
      const failingQueue = {
        enqueue: () => {
          throw new Error('simulated job_queue transient failure');
        },
      } as unknown as JobQueueRepoType;
      let published = 0;

      await expect(
        activatePrompts({
          db: db as never,
          jobQueue: failingQueue,
          sessionId: SESSION,
          messageUuids: ['rollback-1', 'rollback-2'],
          origin: 'recovery',
          publishStatusChanged: () => {
            published++;
          },
        })
      ).rejects.toThrow(/simulated job_queue transient failure/);

      expect(rowStatus('rollback-1')).toBe('deferred');
      expect(rowStatus('rollback-2')).toBe('deferred');
      const jobCount = db
        .prepare(`SELECT COUNT(*) AS c FROM job_queue WHERE queue = ?`)
        .get(MESSAGE_DELIVERY) as { c: number };
      expect(jobCount.c).toBe(0);
      expect(published).toBe(0);
    });

    it('retryPrompt reopens a failed row with no prior job as a fresh released job', async () => {
      insertStatusRow('retry-fresh', 'failed');
      let publishedIds: string[] | null = null;

      const retried = await retryPrompt({
        db: db as never,
        jobQueue,
        sessionId: SESSION,
        messageUuid: 'retry-fresh',
        origin: 'chat',
        publishStatusChanged: (ids) => {
          publishedIds = [...ids];
        },
      });

      expect(retried?.role).toBe('turn');
      expect(rowStatus('retry-fresh')).toBe('enqueued');
      const jobs = jobsFor('retry-fresh');
      expect(jobs).toHaveLength(1);
      expect(jobs[0].status).toBe('pending');
      expect(jobs[0].released).toBe(1);
      expect(publishedIds).toEqual([retried?.dbId]);
    });

    it('retryPrompt re-pends the SAME dead job with a fresh retry budget', async () => {
      insertStatusRow('retry-dead', 'failed');
      const deadJob = jobQueue.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: {
          sessionId: SESSION,
          messageUuid: 'retry-dead',
          role: 'turn',
          origin: 'chat',
          parentToolUseId: null,
          released: true,
        },
        maxRetries: 8,
      });
      db.prepare(
        `UPDATE job_queue SET status = 'dead', retry_count = 8, error = 'exhausted' WHERE id = ?`
      ).run(deadJob.id);

      const retried = await retryPrompt({
        db: db as never,
        jobQueue,
        sessionId: SESSION,
        messageUuid: 'retry-dead',
        origin: 'chat',
      });

      expect(retried?.role).toBe('turn');
      expect(rowStatus('retry-dead')).toBe('enqueued');
      const jobs = jobsFor('retry-dead');
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(deadJob.id);
      expect(jobs[0].status).toBe('pending');
      expect(jobs[0].retryCount).toBe(0);
      expect(jobs[0].released).toBe(1);
    });

    it('retryPrompt refreshes a pending active job in place with a fresh budget and payload', async () => {
      insertStatusRow('retry-pending', 'failed');
      const staleJob = jobQueue.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: {
          sessionId: SESSION,
          messageUuid: 'retry-pending',
          role: 'turn',
          origin: 'space_inject',
          parentToolUseId: 'toolu_9',
          released: true,
          __parkCount: 4,
        },
        maxRetries: 8,
      });
      db.prepare(`UPDATE job_queue SET retry_count = 7, error = 'boom' WHERE id = ?`).run(
        staleJob.id
      );

      const retried = await retryPrompt({
        db: db as never,
        jobQueue,
        sessionId: SESSION,
        messageUuid: 'retry-pending',
        origin: 'chat',
      });

      expect(retried?.role).toBe('turn');
      expect(rowStatus('retry-pending')).toBe('enqueued');
      const jobs = jobsFor('retry-pending');
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(staleJob.id);
      expect(jobs[0].status).toBe('pending');
      expect(jobs[0].retryCount).toBe(0);
      const payload = jobPayload(db, SESSION, 'retry-pending');
      expect(payload?.origin).toBe('chat');
      expect(payload?.parentToolUseId).toBeNull();
      expect(payload?.batchUuids).toBeUndefined();
      expect(payload?.__parkCount).toBeUndefined();
      expect(payload?.released).toBe(true);
    });

    it('retryPrompt revives as steer when another turn already owns the session', async () => {
      insertStatusRow('retry-steer', 'failed');
      const deadJob = jobQueue.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: {
          sessionId: SESSION,
          messageUuid: 'retry-steer',
          role: 'turn',
          origin: 'chat',
          parentToolUseId: null,
          released: true,
        },
      });
      db.prepare(`UPDATE job_queue SET status = 'dead' WHERE id = ?`).run(deadJob.id);
      jobQueue.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: {
          sessionId: SESSION,
          messageUuid: 'other-active',
          role: 'turn',
          origin: 'chat',
          parentToolUseId: null,
          released: true,
        },
      });

      const retried = await retryPrompt({
        db: db as never,
        jobQueue,
        sessionId: SESSION,
        messageUuid: 'retry-steer',
        origin: 'chat',
      });

      expect(retried?.role).toBe('steer');
      const jobs = jobsFor('retry-steer');
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(deadJob.id);
      expect(jobs[0].role).toBe('steer');
      expect(jobs[0].status).toBe('pending');
    });

    it('retryPrompt returns null for a row that is not failed', async () => {
      insertStatusRow('retry-consumed', 'consumed');

      const retried = await retryPrompt({
        db: db as never,
        jobQueue,
        sessionId: SESSION,
        messageUuid: 'retry-consumed',
        origin: 'chat',
      });

      expect(retried).toBeNull();
      expect(rowStatus('retry-consumed')).toBe('consumed');
      expect(jobsFor('retry-consumed')).toHaveLength(0);
    });

    it('persistAndEnqueueDelivery maps a deferred sendStatus onto the manual hold', () => {
      const result = persistAndEnqueueDelivery({
        db: db as never,
        sdkMessageRepo: sdkRepo,
        jobQueue,
        sessionId: SESSION,
        message: userMessage('wrapper-deferred'),
        sendStatus: 'deferred',
        delivery: { origin: 'chat' },
      });

      expect(result.role).toBe('turn');
      expect(rowStatus('wrapper-deferred')).toBe('deferred');
      expect(jobsFor('wrapper-deferred')[0].released).toBe(0);
    });

    it('activatePrompts transitions exactly one row per uuid when duplicates exist', async () => {
      insertStatusRow('dup-activate', 'deferred', 'db-dup-activate-old');
      await new Promise((resolve) => setTimeout(resolve, 2));
      insertStatusRow('dup-activate', 'deferred', 'db-dup-activate-new');

      const { activated } = await activatePrompts({
        db: db as never,
        jobQueue,
        sessionId: SESSION,
        messageUuids: ['dup-activate'],
        origin: 'recovery',
      });

      expect(activated).toHaveLength(1);
      expect(activated[0].dbId).toBe('db-dup-activate-old');
      const statuses = db
        .prepare(
          `SELECT id, send_status FROM sdk_messages WHERE sdk_uuid = ? ORDER BY timestamp ASC, rowid ASC`
        )
        .all('dup-activate') as Array<{ id: string; send_status: string }>;
      expect(statuses).toEqual([
        { id: 'db-dup-activate-old', send_status: 'enqueued' },
        { id: 'db-dup-activate-new', send_status: 'deferred' },
      ]);
      expect(jobsFor('dup-activate')).toHaveLength(1);
    });

    it('retryPrompt transitions exactly one row per uuid when duplicates exist', async () => {
      insertStatusRow('dup-retry', 'failed', 'db-dup-retry-old');
      await new Promise((resolve) => setTimeout(resolve, 2));
      insertStatusRow('dup-retry', 'failed', 'db-dup-retry-new');

      const retried = await retryPrompt({
        db: db as never,
        jobQueue,
        sessionId: SESSION,
        messageUuid: 'dup-retry',
        origin: 'chat',
      });

      expect(retried?.dbId).toBe('db-dup-retry-old');
      const statuses = db
        .prepare(
          `SELECT id, send_status FROM sdk_messages WHERE sdk_uuid = ? ORDER BY timestamp ASC, rowid ASC`
        )
        .all('dup-retry') as Array<{ id: string; send_status: string }>;
      expect(statuses).toEqual([
        { id: 'db-dup-retry-old', send_status: 'enqueued' },
        { id: 'db-dup-retry-new', send_status: 'failed' },
      ]);
      expect(jobsFor('dup-retry')).toHaveLength(1);
    });

    it('retryPrompt strips park budget, claim token, and batch membership when reviving', async () => {
      insertStatusRow('retry-strip', 'failed');
      const deadJob = jobQueue.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: {
          sessionId: SESSION,
          messageUuid: 'retry-strip',
          role: 'turn',
          origin: 'space_inject',
          parentToolUseId: 'toolu_1',
          released: true,
          __parkCount: 12,
          __claimToken: 'stale-claim',
          batchUuids: ['retry-strip', 'retry-other'],
          droppedBatchUuids: ['retry-dropped'],
        },
        maxRetries: 8,
      });
      db.prepare(
        `UPDATE job_queue SET status = 'dead', retry_count = 8, result = ? WHERE id = ?`
      ).run('{"outcome":"parked"}', deadJob.id);

      await retryPrompt({
        db: db as never,
        jobQueue,
        sessionId: SESSION,
        messageUuid: 'retry-strip',
        origin: 'chat',
      });

      const payload = jobPayload(db, SESSION, 'retry-strip');
      expect(payload?.__parkCount).toBeUndefined();
      expect(payload?.__claimToken).toBeUndefined();
      expect(payload?.batchUuids).toBeUndefined();
      expect(payload?.droppedBatchUuids).toBeUndefined();
      expect(payload?.released).toBe(true);
      expect(payload?.role).toBe('turn');
      expect(payload?.origin).toBe('chat');
      expect(payload?.parentToolUseId).toBeNull();
      const job = jobsFor('retry-strip')[0];
      expect(job.retryCount).toBe(0);
      expect(job.status).toBe('pending');
    });

    it('retryPrompt runs the repo status bookkeeping inside the retry transaction', async () => {
      insertStatusRow('retry-book', 'failed');
      const bookkeeping: Array<[string[], string, string]> = [];
      const spyRepo = {
        updateMessageStatus: (ids: string[], status: string) => {
          const withinJobWrite = db
            .prepare(`SELECT send_status FROM sdk_messages WHERE id = ?`)
            .get(ids[0]) as { send_status: string };
          bookkeeping.push([[...ids], status, withinJobWrite.send_status]);
        },
      } as unknown as SDKMessageRepository;

      await retryPrompt({
        db: db as never,
        jobQueue,
        sdkMessageRepo: spyRepo,
        sessionId: SESSION,
        messageUuid: 'retry-book',
        origin: 'chat',
      });

      expect(bookkeeping).toEqual([[['db-retry-book'], 'enqueued', 'enqueued']]);
    });

    it('activatePrompts requeues a processing held claim in place instead of trusting it', async () => {
      insertStatusRow('claim-held', 'deferred');
      const heldJob = jobQueue.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: {
          sessionId: SESSION,
          messageUuid: 'claim-held',
          role: 'turn',
          origin: 'chat',
          parentToolUseId: null,
          released: false,
          __claimToken: 'live-claim',
          __parkCount: 3,
        },
      });
      db.prepare(`UPDATE job_queue SET status = 'processing' WHERE id = ?`).run(heldJob.id);

      const { activated } = await activatePrompts({
        db: db as never,
        jobQueue,
        sessionId: SESSION,
        messageUuids: ['claim-held'],
        origin: 'recovery',
      });

      expect(activated).toHaveLength(1);
      expect(activated[0].role).toBe('turn');
      expect(rowStatus('claim-held')).toBe('enqueued');
      const jobs = jobsFor('claim-held');
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(heldJob.id);
      expect(jobs[0].status).toBe('pending');
      expect(jobs[0].released).toBe(1);
      const payload = jobPayload(db, SESSION, 'claim-held');
      expect(payload?.__claimToken).toBeUndefined();
      expect(payload?.__parkCount).toBeUndefined();
    });

    it('activatePrompts leaves a released processing claim delivering instead of revoking it', async () => {
      insertStatusRow('claim-released', 'enqueued');
      const liveJob = jobQueue.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: {
          sessionId: SESSION,
          messageUuid: 'claim-released',
          role: 'turn',
          origin: 'chat',
          parentToolUseId: null,
          released: true,
          __claimToken: 'live-claim',
        },
      });
      db.prepare(`UPDATE job_queue SET status = 'processing' WHERE id = ?`).run(liveJob.id);

      await activatePrompts({
        db: db as never,
        jobQueue,
        sessionId: SESSION,
        messageUuids: ['claim-released'],
        origin: 'recovery',
      });

      const jobs = jobsFor('claim-released');
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(liveJob.id);
      expect(jobs[0].status).toBe('processing');
      expect(jobs[0].released).toBe(1);
      expect(jobPayload(db, SESSION, 'claim-released')?.__claimToken).toBe('live-claim');
    });

    it('activatePrompts reuses the active batch job that owns the prompt as a member', async () => {
      insertStatusRow('batch-member', 'deferred');
      const batchJob = jobQueue.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: {
          sessionId: SESSION,
          messageUuid: 'batch-kickoff',
          role: 'turn',
          origin: 'recovery',
          parentToolUseId: null,
          released: true,
          batchUuids: ['batch-kickoff', 'batch-member'],
        },
      });

      const { activated } = await activatePrompts({
        db: db as never,
        jobQueue,
        sessionId: SESSION,
        messageUuids: ['batch-member'],
        origin: 'recovery',
      });

      expect(activated).toHaveLength(1);
      expect(activated[0].role).toBe('turn');
      expect(rowStatus('batch-member')).toBe('enqueued');
      const allJobs = db
        .prepare(`SELECT COUNT(*) AS c FROM job_queue WHERE queue = ?`)
        .get(MESSAGE_DELIVERY) as { c: number };
      expect(allJobs.c).toBe(1);
      expect(jobsFor('batch-kickoff')[0].id).toBe(batchJob.id);
    });

    it('retryPrompt reopens a batch member without disturbing the owning batch job', async () => {
      insertStatusRow('batch-retry', 'failed');
      const batchJob = jobQueue.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: {
          sessionId: SESSION,
          messageUuid: 'batch-retry-kickoff',
          role: 'turn',
          origin: 'recovery',
          parentToolUseId: null,
          released: true,
          batchUuids: ['batch-retry-kickoff', 'batch-retry'],
        },
      });

      const retried = await retryPrompt({
        db: db as never,
        jobQueue,
        sessionId: SESSION,
        messageUuid: 'batch-retry',
        origin: 'chat',
      });

      expect(retried?.role).toBe('turn');
      expect(rowStatus('batch-retry')).toBe('enqueued');
      const allJobs = db
        .prepare(`SELECT COUNT(*) AS c FROM job_queue WHERE queue = ?`)
        .get(MESSAGE_DELIVERY) as { c: number };
      expect(allJobs.c).toBe(1);
      const payload = jobPayload(db, SESSION, 'batch-retry-kickoff');
      expect(jobsFor('batch-retry-kickoff')[0].id).toBe(batchJob.id);
      expect(payload?.batchUuids).toEqual(['batch-retry-kickoff', 'batch-retry']);
    });

    it('retryPrompt revives a released processing claim instead of trusting its skip outcome', async () => {
      insertStatusRow('retry-live', 'failed');
      const liveJob = jobQueue.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: {
          sessionId: SESSION,
          messageUuid: 'retry-live',
          role: 'turn',
          origin: 'chat',
          parentToolUseId: null,
          released: true,
          __claimToken: 'live-claim',
        },
        maxRetries: 8,
      });
      db.prepare(`UPDATE job_queue SET status = 'processing', retry_count = 5 WHERE id = ?`).run(
        liveJob.id
      );

      const retried = await retryPrompt({
        db: db as never,
        jobQueue,
        sessionId: SESSION,
        messageUuid: 'retry-live',
        origin: 'chat',
      });

      expect(retried?.role).toBe('turn');
      expect(rowStatus('retry-live')).toBe('enqueued');
      const jobs = jobsFor('retry-live');
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(liveJob.id);
      expect(jobs[0].status).toBe('pending');
      expect(jobs[0].retryCount).toBe(0);
      expect(jobPayload(db, SESSION, 'retry-live')?.__claimToken).toBeUndefined();
    });

    it('activatePrompts honors an explicit dbId over oldest-row reselection', async () => {
      insertStatusRow('dup-db', 'deferred', 'db-dup-old');
      await new Promise((resolve) => setTimeout(resolve, 2));
      insertStatusRow('dup-db', 'deferred', 'db-dup-picked');

      const { activated } = await activatePrompts({
        db: db as never,
        jobQueue,
        sessionId: SESSION,
        messageUuids: ['dup-db'],
        dbIds: ['db-dup-picked'],
        origin: 'recovery',
      });

      expect(activated).toHaveLength(1);
      expect(activated[0].dbId).toBe('db-dup-picked');
      const statuses = db
        .prepare(
          `SELECT id, send_status FROM sdk_messages WHERE sdk_uuid = ? ORDER BY timestamp ASC, rowid ASC`
        )
        .all('dup-db') as Array<{ id: string; send_status: string }>;
      expect(statuses).toEqual([
        { id: 'db-dup-old', send_status: 'deferred' },
        { id: 'db-dup-picked', send_status: 'enqueued' },
      ]);
    });

    it('activatePrompts ignores an explicit dbId that belongs to a different prompt', async () => {
      insertStatusRow('target-uuid', 'deferred', 'db-target');
      insertStatusRow('other-uuid', 'deferred', 'db-other');

      const { activated } = await activatePrompts({
        db: db as never,
        jobQueue,
        sessionId: SESSION,
        messageUuids: ['target-uuid'],
        dbIds: ['db-other'],
        origin: 'recovery',
      });

      expect(activated).toHaveLength(1);
      expect(activated[0].dbId).toBe('db-target');
      expect(rowStatus('target-uuid')).toBe('enqueued');
      expect(rowStatus('other-uuid')).toBe('deferred');
    });

    it('ensurePrompt replays equivalent content whose object keys were built in a different order', () => {
      persistPrompt({
        db: db as never,
        sdkMessageRepo: sdkRepo,
        jobQueue,
        sessionId: SESSION,
        message: {
          type: 'user',
          uuid: 'order-uuid',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'same words' }],
          },
        } as unknown as SDKMessage,
        delivery: { origin: 'chat' },
      });

      const replay = ensurePrompt({
        db: db as never,
        sdkMessageRepo: sdkRepo,
        jobQueue,
        sessionId: SESSION,
        message: {
          message: {
            content: [{ text: 'same words', type: 'text' }],
            role: 'user',
          },
          uuid: 'order-uuid',
          type: 'user',
        } as unknown as SDKMessage,
        delivery: { origin: 'chat' },
      });

      expect(replay.created).toBe(false);
      expect(replay.role).toBe('turn');
    });

    it('retryPrompt honors an explicit dbId over oldest-row reselection', async () => {
      insertStatusRow('retry-dup', 'failed', 'db-retry-old');
      await new Promise((resolve) => setTimeout(resolve, 2));
      insertStatusRow('retry-dup', 'failed', 'db-retry-picked');

      const retried = await retryPrompt({
        db: db as never,
        jobQueue,
        sessionId: SESSION,
        messageUuid: 'retry-dup',
        dbId: 'db-retry-picked',
        origin: 'chat',
      });

      expect(retried?.dbId).toBe('db-retry-picked');
      const statuses = db
        .prepare(
          `SELECT id, send_status FROM sdk_messages WHERE sdk_uuid = ? ORDER BY timestamp ASC, rowid ASC`
        )
        .all('retry-dup') as Array<{ id: string; send_status: string }>;
      expect(statuses).toEqual([
        { id: 'db-retry-old', send_status: 'failed' },
        { id: 'db-retry-picked', send_status: 'enqueued' },
      ]);
    });

    it('retryPrompt returns null when the explicitly selected row went stale, instead of falling back', async () => {
      insertStatusRow('retry-stale', 'failed', 'db-retry-stale');
      insertStatusRow('retry-stale', 'failed', 'db-retry-other');
      db.prepare(`UPDATE sdk_messages SET send_status = 'enqueued' WHERE id = ?`).run(
        'db-retry-stale'
      );

      const retried = await retryPrompt({
        db: db as never,
        jobQueue,
        sessionId: SESSION,
        messageUuid: 'retry-stale',
        dbId: 'db-retry-stale',
        origin: 'chat',
      });

      expect(retried).toBeNull();
      const statuses = db
        .prepare(`SELECT id, send_status FROM sdk_messages WHERE sdk_uuid = ? ORDER BY rowid ASC`)
        .all('retry-stale') as Array<{ id: string; send_status: string }>;
      expect(statuses).toEqual([
        { id: 'db-retry-stale', send_status: 'enqueued' },
        { id: 'db-retry-other', send_status: 'failed' },
      ]);
    });

    it('activatePrompts skips an explicitly selected row that went stale instead of falling back', async () => {
      insertStatusRow('act-stale', 'deferred', 'db-act-stale');
      insertStatusRow('act-stale', 'deferred', 'db-act-other');
      db.prepare(`UPDATE sdk_messages SET send_status = 'consumed' WHERE id = ?`).run(
        'db-act-stale'
      );

      const { activated } = await activatePrompts({
        db: db as never,
        jobQueue,
        sessionId: SESSION,
        messageUuids: ['act-stale'],
        dbIds: ['db-act-stale'],
        origin: 'recovery',
      });

      expect(activated).toEqual([]);
      const statuses = db
        .prepare(`SELECT id, send_status FROM sdk_messages WHERE sdk_uuid = ? ORDER BY rowid ASC`)
        .all('act-stale') as Array<{ id: string; send_status: string }>;
      expect(statuses).toEqual([
        { id: 'db-act-stale', send_status: 'consumed' },
        { id: 'db-act-other', send_status: 'deferred' },
      ]);
    });
  });
});
