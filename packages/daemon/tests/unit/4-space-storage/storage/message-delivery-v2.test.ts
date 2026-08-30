import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import {
  ACP_DELIVERY_CONSUMPTION_TIMEOUT_MS,
  awaitDeliveryConsumption,
  buildBatchedDeliveryContent,
  type DriveTurnOutcome,
  deliverAndMarkQueued,
  deliverBatchAndMarkQueued,
  deliverMessage,
  drainDeliveryWaitersOnTerminalSDKMessage,
  type FeedSteerOutcome,
  flattenDeliveryText,
  isRetryableErrorResultSubtype,
  isTerminalTurnError,
  isUniqueConstraintError,
  MAX_ACP_STEER_PARKS,
  MAX_STEER_PARKS,
  MESSAGE_DELIVERY_PARK_MS,
  type MessageDeliverySession,
  signalDeliveryConsumed,
  waitForDeliveryConsumption,
} from '../../../../src/lib/agent/message-delivery';
import { DeliveryMetrics } from '../../../../src/lib/agent/message-delivery-metrics';
import { createMessageDeliveryHandler } from '../../../../src/lib/job-handlers/message-delivery.handler';
import { MESSAGE_DELIVERY } from '../../../../src/lib/job-queue-constants';
import { JobQueueProcessor } from '../../../../src/storage/job-queue-processor';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { runMigration182 } from '../../../../src/storage/schema/migrations';
import { Database } from '../../../../src/storage/sqlite-compat';

const SESSION = 'sess-conformance';

function setupRepo(): { db: Database; repo: JobQueueRepository } {
  const db = new Database(':memory:');
  db.exec(`
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
    CREATE INDEX idx_job_queue_dequeue ON job_queue(queue, status, priority DESC, run_at ASC);
    CREATE INDEX idx_job_queue_status ON job_queue(status);
    -- Minimal delivery-row projection: narrowActiveDeliveryBatchUuids reads
    -- pending-state membership from sdk_messages (a full schema table in
    -- production).
    CREATE TABLE sdk_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      sdk_uuid TEXT NOT NULL,
      send_status TEXT
    );
  `);
  runMigration182(db as unknown as Parameters<typeof runMigration182>[0]);
  return { db, repo: new JobQueueRepository(db as never) };
}

function jobsFor(repo: JobQueueRepository, sessionId: string): Job[] {
  return repo.listJobs({ queue: MESSAGE_DELIVERY, limit: 100 }).filter((j) => {
    const sid = (j.payload as { sessionId?: string }).sessionId;
    return sid === sessionId;
  });
}

describe('message-delivery v2 — substrate (job_queue)', () => {
  let db: Database;
  let repo: JobQueueRepository;

  beforeEach(() => {
    ({ db, repo } = setupRepo());
  });
  afterEach(() => db.close());

  describe('deliverMessage — atomic role decision (§7, §13: atomic claim)', () => {
    it('first message becomes a turn', () => {
      deliverMessage(repo, SESSION, 'msg-A', { origin: 'chat' });
      const jobs = jobsFor(repo, SESSION);
      expect(jobs).toHaveLength(1);
      expect((jobs[0].payload as { role: string }).role).toBe('turn');
    });

    it('a second message while a turn is active becomes a steer (UNIQUE arbiter)', () => {
      deliverMessage(repo, SESSION, 'msg-A', { origin: 'chat' });
      deliverMessage(repo, SESSION, 'msg-B', { origin: 'chat' });
      const jobs = jobsFor(repo, SESSION);
      expect(jobs).toHaveLength(2);
      const roles = jobs.map((j) => (j.payload as { role: string }).role).sort();
      expect(roles).toEqual(['steer', 'turn']);
    });

    it('steers coexist with the active turn and with each other (excluded from the index)', () => {
      deliverMessage(repo, SESSION, 'turn', { origin: 'chat' });
      deliverMessage(repo, SESSION, 'steer-1', { origin: 'chat' });
      deliverMessage(repo, SESSION, 'steer-2', { origin: 'chat' });
      deliverMessage(repo, SESSION, 'steer-3', { origin: 'chat' });
      const jobs = jobsFor(repo, SESSION);
      const roles = jobs.map((j) => (j.payload as { role: string }).role);
      expect(roles.filter((r) => r === 'turn')).toHaveLength(1);
      expect(roles.filter((r) => r === 'steer')).toHaveLength(3);
    });

    it('a second turn is rejected by the index — not by a check-then-insert', () => {
      repo.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: { sessionId: SESSION, messageUuid: 'existing', role: 'turn', origin: 'chat' },
      });
      expect(() =>
        deliverMessage(repo, SESSION, 'competing', { origin: 'chat', role: 'turn' })
      ).toThrow();
    });

    it('a completed/failed turn frees the slot for a new turn', () => {
      deliverMessage(repo, SESSION, 'turn-1', { origin: 'chat' });
      const job = jobsFor(repo, SESSION)[0];
      repo.dequeue(MESSAGE_DELIVERY, 1)[0];
      repo.complete(job.id, { ok: true });
      deliverMessage(repo, SESSION, 'turn-2', { origin: 'chat' });
      const turns = jobsFor(repo, SESSION).filter(
        (j) => (j.payload as { role: string }).role === 'turn'
      );
      expect(turns).toHaveLength(2);
    });

    it('is idempotent per UUID — a second deliverMessage for the same UUID is a no-op', () => {
      const role1 = deliverMessage(repo, SESSION, 'dup', { origin: 'chat' });
      const role2 = deliverMessage(repo, SESSION, 'dup', { origin: 'chat' });
      expect(role1).toBe('turn');
      expect(role2).toBe('turn');
      const dup = jobsFor(repo, SESSION).filter(
        (j) => (j.payload as { messageUuid: string }).messageUuid === 'dup'
      );
      expect(dup).toHaveLength(1);
    });

    it('idempotency returns the existing steer role, not a fresh insert', () => {
      deliverMessage(repo, SESSION, 'turn', { origin: 'chat' });
      const role1 = deliverMessage(repo, SESSION, 'steer-uuid', { origin: 'chat' });
      expect(role1).toBe('steer');
      const role2 = deliverMessage(repo, SESSION, 'steer-uuid', { origin: 'chat' });
      expect(role2).toBe('steer');
      const steers = jobsFor(repo, SESSION).filter(
        (j) => (j.payload as { messageUuid: string }).messageUuid === 'steer-uuid'
      );
      expect(steers).toHaveLength(1);
    });

    it('isUniqueConstraintError detects SQLite UNIQUE failures', () => {
      expect(isUniqueConstraintError(new Error('UNIQUE constraint failed: job_queue.queue'))).toBe(
        true
      );
      expect(isUniqueConstraintError(new Error('some other error'))).toBe(false);
      expect(isUniqueConstraintError('not an error')).toBe(false);
    });
  });

  describe('deliverMessage — role-arbitration call-site characterization (A1b)', () => {
    function seedActiveJob(uuid: string, role: 'turn' | 'steer'): void {
      repo.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: { sessionId: SESSION, messageUuid: uuid, role, origin: 'chat' },
        maxRetries: 8,
      });
    }

    function jobsForUuid(uuid: string): Job[] {
      return jobsFor(repo, SESSION).filter(
        (j) => (j.payload as { messageUuid?: string }).messageUuid === uuid
      );
    }

    const reuseRows: Array<{
      name: string;
      existingRole: 'turn' | 'steer';
      requested?: 'turn' | 'steer';
    }> = [
      {
        name: 'an active same-UUID turn is reused under an implicit request',
        existingRole: 'turn',
      },
      {
        name: 'an active same-UUID turn wins over a requested turn (no new job, no throw)',
        existingRole: 'turn',
        requested: 'turn',
      },
      {
        name: 'an active same-UUID turn wins over a requested steer',
        existingRole: 'turn',
        requested: 'steer',
      },
      {
        name: 'an active same-UUID steer is reused under an implicit request',
        existingRole: 'steer',
      },
      {
        name: 'an active same-UUID steer wins over a requested turn',
        existingRole: 'steer',
        requested: 'turn',
      },
      {
        name: 'an active same-UUID steer wins over a requested steer',
        existingRole: 'steer',
        requested: 'steer',
      },
    ];

    for (const row of reuseRows) {
      it(row.name, () => {
        seedActiveJob('uuid', row.existingRole);
        const role = deliverMessage(repo, SESSION, 'uuid', {
          origin: 'chat',
          role: row.requested,
        });
        expect(role).toBe(row.existingRole);
        const jobs = jobsForUuid('uuid');
        expect(jobs).toHaveLength(1);
        expect((jobs[0].payload as { role: string }).role).toBe(row.existingRole);
      });
    }

    it('a fresh implicit delivery takes the turn role', () => {
      const role = deliverMessage(repo, SESSION, 'fresh', { origin: 'chat' });
      expect(role).toBe('turn');
      const jobs = jobsForUuid('fresh');
      expect(jobs).toHaveLength(1);
      expect((jobs[0].payload as { role: string }).role).toBe('turn');
    });

    it('an implicit turn collision under an active session turn converts to steer', () => {
      seedActiveJob('blocker', 'turn');
      const role = deliverMessage(repo, SESSION, 'collide', { origin: 'chat' });
      expect(role).toBe('steer');
      const jobs = jobsForUuid('collide');
      expect(jobs).toHaveLength(1);
      expect((jobs[0].payload as { role: string }).role).toBe('steer');
    });

    it('an explicit requested turn succeeds when the session has no active turn', () => {
      const role = deliverMessage(repo, SESSION, 'explicit', { origin: 'chat', role: 'turn' });
      expect(role).toBe('turn');
      const jobs = jobsForUuid('explicit');
      expect(jobs).toHaveLength(1);
      expect((jobs[0].payload as { role: string }).role).toBe('turn');
    });

    it('an explicit requested turn under an active session turn PROPAGATES the UNIQUE failure (no steer fallback)', () => {
      seedActiveJob('blocker', 'turn');
      const before = jobsFor(repo, SESSION).length;
      expect(() =>
        deliverMessage(repo, SESSION, 'rejected', { origin: 'chat', role: 'turn' })
      ).toThrow();
      expect(jobsFor(repo, SESSION)).toHaveLength(before);
      expect(jobsForUuid('rejected')).toHaveLength(0);
    });

    it('an explicit requested steer succeeds even under an active session turn (steer is unconstrained)', () => {
      seedActiveJob('blocker', 'turn');
      const role = deliverMessage(repo, SESSION, 'steer-explicit', {
        origin: 'chat',
        role: 'steer',
      });
      expect(role).toBe('steer');
      const jobs = jobsForUuid('steer-explicit');
      expect(jobs).toHaveLength(1);
      expect((jobs[0].payload as { role: string }).role).toBe('steer');
    });

    it('an active batch membership is reused — a member uuid dedups to the batch turn', () => {
      repo.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: {
          sessionId: SESSION,
          messageUuid: 'kickoff',
          role: 'turn',
          origin: 'recovery',
          parentToolUseId: null,
          batchUuids: ['kickoff', 'member-a'],
        },
        maxRetries: 8,
      });
      const role = deliverMessage(repo, SESSION, 'member-a', { origin: 'chat' });
      expect(role).toBe('turn');
      expect(jobsForUuid('member-a')).toHaveLength(0);
      expect(jobsFor(repo, SESSION)).toHaveLength(1);
    });
  });

  describe('deliverMessage — role-arbitration wiring (A3b)', () => {
    it('propagates when the steer fallback enqueue fails too — exactly two attempts, no third', () => {
      let calls = 0;
      const stub = {
        getActiveDeliveryRole: () => null,
        enqueue: () => {
          calls++;
          throw new Error(
            calls === 1 ? 'UNIQUE constraint failed: job_queue.queue' : 'steer insert exploded'
          );
        },
      } as unknown as JobQueueRepository;
      expect(() => deliverMessage(stub, SESSION, 'fallback-fail', { origin: 'chat' })).toThrow(
        /steer insert exploded/
      );
      expect(calls).toBe(2);
    });

    it('rethrows a non-UNIQUE enqueue failure without attempting the steer fallback', () => {
      let calls = 0;
      const stub = {
        getActiveDeliveryRole: () => null,
        enqueue: () => {
          calls++;
          throw new Error('disk I/O error');
        },
      } as unknown as JobQueueRepository;
      expect(() => deliverMessage(stub, SESSION, 'io-fail', { origin: 'chat' })).toThrow(
        /disk I\/O error/
      );
      expect(calls).toBe(1);
    });
  });

  describe('deliverAndMarkQueued — role arbitration', () => {
    it('classifies as a turn when no active turn exists (idle session)', async () => {
      const { repo } = setupRepo();
      await deliverAndMarkQueued({
        jobQueue: repo,
        stateManager: {
          getState: () => ({ status: 'idle' }),
          setQueuedIfIdle: async () => false,
        },
        sessionId: SESSION,
        messageUuid: 'msg-idle',
        origin: 'chat',
      });
      const jobs = jobsFor(repo, SESSION);
      expect((jobs[0].payload as { role: string }).role).toBe('turn');
    });
  });

  describe('dequeue — FIFO within a session (§15: created_at tiebreaker)', () => {
    it('orders exact same-millisecond ties by rowid ASC', () => {
      const now = Date.now();
      for (const uuid of ['first', 'second', 'third']) {
        repo.enqueue({
          queue: MESSAGE_DELIVERY,
          payload: { sessionId: SESSION, messageUuid: uuid, role: 'steer', origin: 'chat' },
          runAt: now,
        });
      }
      db.prepare(`UPDATE job_queue SET priority = 0, run_at = ?, created_at = ?`).run(now, now);
      const claimed = repo.dequeueExempt(MESSAGE_DELIVERY, { path: '$.role', equals: 'steer' }, 3);
      expect(claimed.map((j) => j.payload.messageUuid)).toEqual(['first', 'second', 'third']);
    });

    it('orders same-priority/run_at jobs by created_at ASC', () => {
      const now = Date.now();
      for (const uuid of ['first', 'second', 'third']) {
        repo.enqueue({
          queue: MESSAGE_DELIVERY,
          payload: { sessionId: SESSION, messageUuid: uuid, role: 'steer', origin: 'chat' },
          runAt: now,
        });
      }
      const claimed = repo.dequeue(MESSAGE_DELIVERY, 3);
      expect(claimed.map((j) => (j.payload as { messageUuid: string }).messageUuid)).toEqual([
        'first',
        'second',
        'third',
      ]);
    });
  });

  describe('requeue — park a blocked turn (§8: runAt, no retry bump)', () => {
    it('returns a processing job to pending with runAt without touching retry_count', () => {
      deliverMessage(repo, SESSION, 'parked', { origin: 'chat' });
      const [job] = repo.dequeue(MESSAGE_DELIVERY, 1);
      const retryAt = Date.now() + 5_000;
      repo.requeue(job.id, retryAt);
      const after = repo.getJob(job.id);
      expect(after?.status).toBe('pending');
      expect(after?.runAt).toBe(retryAt);
      expect(after?.startedAt).toBeNull();
      expect(after?.retryCount).toBe(0);
    });

    it('no-ops (returns null) when the job is no longer processing', () => {
      deliverMessage(repo, SESSION, 'gone', { origin: 'chat' });
      const [job] = repo.dequeue(MESSAGE_DELIVERY, 1);
      repo.complete(job.id, { ok: true });
      expect(repo.requeue(job.id, Date.now() + 5_000)).toBeNull();
    });
  });

  describe('reclaimStale — crash mid-delivery → redelivered (§10, §13)', () => {
    it('returns a long-processing job to pending (the durable redelivery)', () => {
      deliverMessage(repo, SESSION, 'crashed', { origin: 'chat' });
      const [job] = repo.dequeue(MESSAGE_DELIVERY, 1);
      const staleStartedAt = Date.now() - 10 * 60 * 1000;
      db.prepare(`UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?`).run(
        staleStartedAt,
        staleStartedAt,
        job.id
      );
      const reclaimed = repo.reclaimStale(Date.now() - 5 * 60 * 1000);
      expect(reclaimed).toHaveLength(1);
      const after = repo.getJob(job.id);
      expect(after?.status).toBe('pending');
      expect(after?.startedAt).toBeNull();
      const [reclaimedJob] = repo.dequeue(MESSAGE_DELIVERY, 1);
      expect(reclaimedJob.claimToken).not.toBe(job.claimToken);
      expect(repo.isClaimCurrent(job.id, job.claimToken)).toBe(false);
      expect(repo.isClaimCurrent(reclaimedJob.id, reclaimedJob.claimToken)).toBe(true);
      expect(repo.heartbeat(job.id, job.claimToken)).toBe(false);
      expect(repo.requeue(job.id, Date.now(), job.claimToken)).toBeNull();
    });
  });

  describe('atomic claim — no double-delivery (§13 headline)', () => {
    it('a claimed (processing) job is NOT re-claimed by a second dequeue', () => {
      deliverMessage(repo, SESSION, 'msg-once', { origin: 'chat' });
      const first = repo.dequeue(MESSAGE_DELIVERY, 1);
      expect(first).toHaveLength(1);
      expect(first[0].status).toBe('processing');
      expect(repo.dequeue(MESSAGE_DELIVERY, 1)).toHaveLength(0);
    });

    it('dequeue(limit > 1) claims a pending job exactly once', () => {
      deliverMessage(repo, SESSION, 'msg-once2', { origin: 'chat' });
      const claimed = repo.dequeue(MESSAGE_DELIVERY, 10);
      expect(claimed).toHaveLength(1);
      expect(claimed[0].status).toBe('processing');
    });
  });

  describe('requeueAs — atomic promote (no second job)', () => {
    it('converts a processing steer to a pending turn in place', () => {
      deliverMessage(repo, SESSION, 'turn-anchor', { origin: 'chat' });
      deliverMessage(repo, SESSION, 'the-steer', { origin: 'chat' });
      const [turn] = repo.dequeue(MESSAGE_DELIVERY, 1);
      repo.complete(turn.id, { ok: true });
      const [steer] = repo.dequeue(MESSAGE_DELIVERY, 1);
      expect((steer.payload as { role: string }).role).toBe('steer');
      const before = repo.listJobs({ queue: MESSAGE_DELIVERY, limit: 50 }).length;
      repo.requeueAs(steer.id, 'turn', 123);
      const after = repo.getJob(steer.id);
      expect(after?.status).toBe('pending');
      expect((after?.payload as { role: string }).role).toBe('turn');
      expect(after?.runAt).toBe(123);
      expect(after?.retryCount).toBe(0);
      expect(repo.listJobs({ queue: MESSAGE_DELIVERY, limit: 50 }).length).toBe(before);
    });

    it('no-ops (returns null) when the job is no longer processing', () => {
      deliverMessage(repo, SESSION, 'gone-as', { origin: 'chat' });
      const [job] = repo.dequeue(MESSAGE_DELIVERY, 1);
      repo.complete(job.id, { ok: true });
      expect(repo.requeueAs(job.id, 'turn', Date.now())).toBeNull();
    });
  });

  describe('heartbeat — processing claim lease', () => {
    it('advances heartbeat_at without changing started_at and fends off reclaimStale', () => {
      deliverMessage(repo, SESSION, 'live-turn', { origin: 'chat' });
      const [job] = repo.dequeue(MESSAGE_DELIVERY, 1);
      const stale = Date.now() - 10 * 60 * 1000;
      db.prepare(`UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?`).run(
        stale,
        stale,
        job.id
      );

      expect(repo.heartbeat(job.id, job.claimToken)).toBe(true);
      const afterHeartbeat = repo.getJob(job.id);
      expect(afterHeartbeat?.startedAt).toBe(stale);
      expect(afterHeartbeat?.heartbeatAt).toBeGreaterThan(stale);
      expect(repo.reclaimStale(Date.now() - 5 * 60 * 1000)).toHaveLength(0);
      expect(repo.getJob(job.id)?.status).toBe('processing');
    });

    it('is fenced by claim token and clears on ownership exit', () => {
      deliverMessage(repo, SESSION, 'fenced-turn', { origin: 'chat' });
      const [job] = repo.dequeue(MESSAGE_DELIVERY, 1);
      expect(repo.heartbeat(job.id, 'wrong-token')).toBe(false);
      expect(repo.complete(job.id, { ok: true }, job.claimToken)?.heartbeatAt).toBeNull();
    });
  });

  describe('activeDeliveryMessageUuids — legacy-replay guard', () => {
    it('lists UUIDs with an active (pending/processing) v2 job; empty when none', () => {
      expect(repo.activeDeliveryMessageUuids(SESSION)).toEqual(new Set());
      deliverMessage(repo, SESSION, 'msg-a', { origin: 'chat' });
      deliverMessage(repo, SESSION, 'msg-b', { origin: 'chat' });
      expect(repo.activeDeliveryMessageUuids(SESSION)).toEqual(new Set(['msg-a', 'msg-b']));
      const [turn] = repo.dequeue(MESSAGE_DELIVERY, 1);
      repo.complete(turn.id, { ok: true });
      expect(repo.activeDeliveryMessageUuids(SESSION)).toEqual(new Set(['msg-b']));
    });

    it('includes batchUuids members of an active batched turn (batch-aware)', () => {
      repo.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: {
          sessionId: SESSION,
          messageUuid: 'batch-kickoff',
          role: 'turn',
          origin: 'recovery',
          parentToolUseId: null,
          batchUuids: ['batch-kickoff', 'batch-member-2', 'batch-member-3'],
        },
      });
      expect(repo.activeDeliveryMessageUuids(SESSION)).toEqual(
        new Set(['batch-kickoff', 'batch-member-2', 'batch-member-3'])
      );
    });
  });

  describe('batched flush content helpers', () => {
    it('flattenDeliveryText flattens strings and text-only arrays; rejects non-text', () => {
      expect(flattenDeliveryText('hello')).toBe('hello');
      expect(flattenDeliveryText('')).toBeNull();
      expect(
        flattenDeliveryText([
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ])
      ).toBe('a\nb');
      expect(flattenDeliveryText([{ type: 'text', text: 'a' }, { type: 'image' }])).toBeNull();
      expect(flattenDeliveryText([])).toBeNull();
    });

    it('buildBatchedDeliveryContent numbers and delimits every message', () => {
      expect(buildBatchedDeliveryContent(['one', 'two'])).toBe(
        '--- message 1 of 2 ---\none\n\n--- message 2 of 2 ---\ntwo'
      );
    });
  });

  describe('batched flush — ownership + lookup guards', () => {
    it('getActiveDeliveryBatchUuids resolves the active batch payload (null when none)', () => {
      expect(repo.getActiveDeliveryBatchUuids(SESSION, 'kickoff')).toBeNull();
      repo.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: {
          sessionId: SESSION,
          messageUuid: 'kickoff',
          role: 'turn',
          origin: 'recovery',
          parentToolUseId: null,
          batchUuids: ['kickoff', 'member-a'],
        },
      });
      expect(repo.getActiveDeliveryBatchUuids(SESSION, 'kickoff')).toEqual(['kickoff', 'member-a']);
    });

    it('narrowActiveDeliveryBatchUuids shrinks the payload to the admitted set', () => {
      repo.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: {
          sessionId: SESSION,
          messageUuid: 'kickoff',
          role: 'turn',
          origin: 'recovery',
          parentToolUseId: null,
          batchUuids: ['kickoff', 'admitted-a', 'over-budget-tail', 'user-deferred-tail'],
        },
      });
      db.prepare(
        `INSERT INTO sdk_messages (id, session_id, sdk_uuid, send_status)
         VALUES ('m1', ?, 'over-budget-tail', 'enqueued'),
                ('m2', ?, 'user-deferred-tail', 'deferred')`
      ).run(SESSION, SESSION);
      expect(
        repo.narrowActiveDeliveryBatchUuids(SESSION, 'kickoff', ['kickoff', 'admitted-a'])
      ).toBe(true);
      expect(repo.getActiveDeliveryBatchUuids(SESSION, 'kickoff')).toEqual([
        'kickoff',
        'admitted-a',
      ]);
      expect(repo.activeDeliveryMessageUuids(SESSION)).toEqual(new Set(['kickoff', 'admitted-a']));
      const job = repo.listJobs({ queue: MESSAGE_DELIVERY, limit: 10 })[0];
      expect((job.payload as { droppedBatchUuids?: string[] }).droppedBatchUuids).toEqual([
        'over-budget-tail',
      ]);
      const cancelled = repo.cancelForSessionWithMessages(SESSION);
      expect(cancelled).toEqual(
        expect.arrayContaining(['kickoff', 'admitted-a', 'over-budget-tail'])
      );
      expect(cancelled).not.toContain('user-deferred-tail');
      expect(repo.narrowActiveDeliveryBatchUuids(SESSION, 'kickoff', ['kickoff'])).toBe(false);
    });

    it('getActiveDeliveryRole recognizes a batch member (promote dedup)', () => {
      repo.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: {
          sessionId: SESSION,
          messageUuid: 'kickoff',
          role: 'turn',
          origin: 'recovery',
          parentToolUseId: null,
          batchUuids: ['kickoff', 'member-a'],
        },
      });
      expect(repo.getActiveDeliveryRole(SESSION, 'kickoff')).toBe('turn');
      expect(repo.getActiveDeliveryRole(SESSION, 'member-a')).toBe('turn');
      expect(repo.getActiveDeliveryRole(SESSION, 'not-a-member')).toBeNull();
    });

    it('deliverBatchAndMarkQueued returns false when ANY member already owns an active job', async () => {
      deliverMessage(repo, SESSION, 'turn-anchor', { origin: 'chat' });
      deliverMessage(repo, SESSION, 'uuid-old', { origin: 'chat' });
      const batched = await deliverBatchAndMarkQueued({
        jobQueue: repo,
        sessionId: SESSION,
        messageUuids: ['uuid-old', 'uuid-mid', 'uuid-new'],
        origin: 'recovery',
      });
      expect(batched).toBe(false);
      const uuids = repo
        .listJobs({ queue: MESSAGE_DELIVERY, limit: 50 })
        .map((j) => (j.payload as { messageUuid: string }).messageUuid);
      expect(uuids.sort()).toEqual(['turn-anchor', 'uuid-old']);
    });
  });

  describe('isProcessingDelivery — terminal-idle turn-end marker gate', () => {
    it('true only for a job currently processing; false when pending or absent', () => {
      deliverMessage(repo, SESSION, 'proc', { origin: 'chat' });
      const [job] = repo.dequeue(MESSAGE_DELIVERY, 1);
      expect(repo.isProcessingDelivery(SESSION, 'proc')).toBe(true);
      repo.requeue(job.id, Date.now(), job.claimToken);
      expect(repo.isProcessingDelivery(SESSION, 'proc')).toBe(false);
      expect(repo.isProcessingDelivery(SESSION, 'absent')).toBe(false);
    });
  });
});

class MockSession implements MessageDeliverySession {
  driveResult: DriveTurnOutcome = { outcome: 'completed' };
  feedResult: FeedSteerOutcome = { outcome: 'consumed' };
  driveOutcomeByUuid?: Record<string, DriveTurnOutcome>;
  shouldThrow = false;
  driveCalls = 0;
  feedCalls = 0;
  settleCalls: string[] = [];
  lastUuid?: string;
  lastContent?: unknown;
  lastParentToolUseId?: string | null;
  lastAlreadyConsumed = false;
  lastBatchUuids?: string[];
  waitingForInput = false;

  async driveDeliveryTurn(
    uuid: string,
    content: unknown,
    parentToolUseId?: string | null,
    alreadyConsumed = false,
    _claimGuard?: () => boolean,
    batchUuids?: string[]
  ): Promise<DriveTurnOutcome> {
    this.driveCalls++;
    this.lastUuid = uuid;
    this.lastContent = content;
    this.lastParentToolUseId = parentToolUseId;
    this.lastAlreadyConsumed = alreadyConsumed;
    this.lastBatchUuids = batchUuids;
    if (this.shouldThrow) throw new Error('turn exploded');
    if (this.driveOutcomeByUuid && uuid in this.driveOutcomeByUuid) {
      return this.driveOutcomeByUuid[uuid];
    }
    return this.driveResult;
  }

  async feedDeliverySteer(
    uuid: string,
    content: unknown,
    parentToolUseId?: string | null
  ): Promise<FeedSteerOutcome> {
    this.feedCalls++;
    this.lastUuid = uuid;
    this.lastContent = content;
    this.lastParentToolUseId = parentToolUseId;
    return this.feedResult;
  }

  async settleSkippedDelivery(uuid: string): Promise<void> {
    this.settleCalls.push(uuid);
  }

  isWaitingForInput(): boolean {
    return this.waitingForInput;
  }
}

function turnJob(repo: JobQueueRepository, uuid: string): Job {
  deliverMessage(repo, SESSION, uuid, { origin: 'chat' });
  const [job] = repo.dequeue(MESSAGE_DELIVERY, 1);
  return job!;
}

function steerJob(repo: JobQueueRepository, uuid: string): Job {
  deliverMessage(repo, SESSION, `${uuid}-turn-anchor`, { origin: 'chat' });
  deliverMessage(repo, SESSION, uuid, { origin: 'chat' });
  const [turn] = repo.dequeue(MESSAGE_DELIVERY, 1);
  repo.complete(turn.id, { ok: true });
  const [steer] = repo.dequeue(MESSAGE_DELIVERY, 1);
  return steer!;
}

describe('message-delivery v2 — handler (conformance)', () => {
  let db: Database;
  let repo: JobQueueRepository;

  beforeEach(() => {
    ({ db, repo } = setupRepo());
  });
  afterEach(() => db.close());

  it('turn completed → handler returns completed outcome', async () => {
    const session = new MockSession();
    const job = turnJob(repo, 'msg-turn');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'hello', sendStatus: 'enqueued' }),
    });
    const result = await handler(job);
    expect(result).toEqual({ outcome: 'completed' });
    expect(session.driveCalls).toBe(1);
  });

  it('batched turn job → combines member contents into one delimited prompt + passes batchUuids', async () => {
    const session = new MockSession();
    repo.enqueue({
      queue: MESSAGE_DELIVERY,
      payload: {
        sessionId: SESSION,
        messageUuid: 'kickoff',
        role: 'turn',
        origin: 'recovery',
        parentToolUseId: null,
        batchUuids: ['kickoff', 'member-2', 'member-3'],
      },
    });
    const [job] = repo.dequeue(MESSAGE_DELIVERY, 1);
    const contents: Record<string, string> = {
      kickoff: 'first text',
      'member-2': 'second text',
      'member-3': 'third text',
    };
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: (_sid, uuid) => ({
        content: contents[uuid] ?? '',
        sendStatus: 'enqueued',
      }),
    });
    const result = await handler(job);
    expect(result).toEqual({ outcome: 'completed' });
    expect(session.lastContent).toBe(
      '--- message 1 of 3 ---\nfirst text\n\n--- message 2 of 3 ---\nsecond text\n\n--- message 3 of 3 ---\nthird text'
    );
    expect(session.lastBatchUuids).toEqual(['kickoff', 'member-2', 'member-3']);
  });

  it('batched turn job → skips members whose row is gone or user-deferred', async () => {
    const session = new MockSession();
    repo.enqueue({
      queue: MESSAGE_DELIVERY,
      payload: {
        sessionId: SESSION,
        messageUuid: 'kickoff',
        role: 'turn',
        origin: 'recovery',
        parentToolUseId: null,
        batchUuids: ['kickoff', 'deleted-member', 'deferred-member'],
      },
    });
    const [job] = repo.dequeue(MESSAGE_DELIVERY, 1);
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: (_sid, uuid) => {
        if (uuid === 'kickoff') return { content: 'only one left', sendStatus: 'enqueued' };
        if (uuid === 'deferred-member') {
          return { content: 'deferred', sendStatus: 'deferred' };
        }
        return null;
      },
    });
    await handler(job);
    expect(session.lastContent).toBe('only one left');
    expect(session.lastBatchUuids).toEqual(['kickoff', 'deleted-member', 'deferred-member']);
  });

  it('blocked startup → parks (requeue) and the job stays pending (§13: blocked→parked, not failed)', async () => {
    const session = new MockSession();
    session.driveResult = { outcome: 'blocked', retryAt: 12345 };
    const job = turnJob(repo, 'msg-blocked');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'hello', sendStatus: 'enqueued' }),
    });
    const result = await handler(job);
    expect(result).toMatchObject({ parked: 'sdk_resume_choice', retryAt: 12345 });
    expect(repo.getJob(job.id)?.status).toBe('pending');
    expect(repo.getJob(job.id)?.runAt).toBe(12345);
  });

  it('drive throws → handler rejects so the processor fails the job (§13: double-fault survives)', async () => {
    const session = new MockSession();
    session.shouldThrow = true;
    const job = turnJob(repo, 'msg-fault');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'hello', sendStatus: 'enqueued' }),
    });
    await expect(handler(job)).rejects.toThrow('turn exploded');
    expect(repo.getJob(job.id)?.status).toBe('processing');
  });

  it('steer consumed → handler returns consumed (§9: completion = SDK consume)', async () => {
    const session = new MockSession();
    const job = steerJob(repo, 'msg-steer');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'steer-content', sendStatus: 'enqueued' }),
    });
    const result = await handler(job);
    expect(result).toEqual({ outcome: 'consumed' });
    expect(session.feedCalls).toBe(1);
    expect((job.payload as { role: string }).role).toBe('steer');
  });

  it('steer whose turn ended → promoted to a fresh turn (§8: promote)', async () => {
    const session = new MockSession();
    session.feedResult = { outcome: 'promote' };
    const job = steerJob(repo, 'msg-promote');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'steer-content', sendStatus: 'enqueued' }),
    });
    const result = await handler(job);
    expect(result).toMatchObject({ outcome: 'superseded', promoted: 'turn' });
    const after = repo.getJob(job.id);
    expect(after?.status).toBe('pending');
    expect((after?.payload as { role: string }).role).toBe('turn');
    expect(
      jobsFor(repo, SESSION).filter(
        (j) => (j.payload as { messageUuid: string }).messageUuid === 'msg-promote'
      )
    ).toHaveLength(1);
  });

  it('session gone → handler rejects (so reclaimStale/processor re-drives it)', async () => {
    const job = turnJob(repo, 'msg-gone');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => null,
      getMessageContent: () => ({ content: 'hello', sendStatus: 'enqueued' }),
    });
    await expect(handler(job)).rejects.toThrow('not found');
  });

  it('content missing → completes (no_content) instead of spinning', async () => {
    const session = new MockSession();
    const job = turnJob(repo, 'msg-rewound');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => null,
    });
    const result = await handler(job);
    expect(result).toEqual({ outcome: 'no_content' });
    expect(session.driveCalls).toBe(0);
  });
});

describe('handler — status-aware delivery (§8)', () => {
  let db: Database;
  let repo: JobQueueRepository;

  beforeEach(() => {
    ({ db, repo } = setupRepo());
  });
  afterEach(() => db.close());

  it('consumed kickoff is NOT re-fed — turn driven with alreadyConsumed (#2592)', async () => {
    const session = new MockSession();
    const job = turnJob(repo, 'msg-consumed');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'hello', sendStatus: 'consumed' }),
    });
    const result = await handler(job);
    expect(result).toEqual({ outcome: 'completed' });
    expect(session.driveCalls).toBe(1);
    expect(session.lastAlreadyConsumed).toBe(true);
  });

  it('a consumed turn whose turn already terminated is completed, not re-driven', async () => {
    const session = new MockSession();
    session.driveResult = { outcome: 'turn_terminated' };
    const metrics = new DeliveryMetrics();
    const job = turnJob(repo, 'msg-terminated');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'hello', sendStatus: 'consumed' }),
      metrics,
    });
    const result = await handler(job);
    expect(result).toEqual({ outcome: 'completed', skipped: 'turn_terminated' });
    expect(session.driveCalls).toBe(1);
    expect(session.settleCalls).toEqual(['msg-terminated']);
    expect(metrics.snapshot().reclaimSkips.turn_terminated).toBe(1);
  });

  it('end-to-end: stale reclaimed consumed-turn with terminal result unblocks a parked steer', async () => {
    const session = new MockSession();
    session.feedResult = { outcome: 'promote' };
    const statuses: Record<string, string> = { 'zombie-turn': 'consumed' };
    session.driveOutcomeByUuid = { 'zombie-turn': { outcome: 'turn_terminated' } };
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: (_s, uuid) => ({
        content: 'hi',
        sendStatus: statuses[uuid] ?? 'enqueued',
      }),
    });

    deliverMessage(repo, SESSION, 'zombie-turn', { origin: 'chat' });
    const [zombie] = repo.dequeue(MESSAGE_DELIVERY, 1);
    const staleLease = Date.now() - 10 * 60 * 1000;
    db.prepare(`UPDATE job_queue SET started_at = ?, heartbeat_at = ? WHERE id = ?`).run(
      staleLease,
      staleLease,
      zombie.id
    );

    deliverMessage(repo, SESSION, 'new-msg', { origin: 'chat' });
    const steerRow = repo
      .listJobs({ queue: MESSAGE_DELIVERY, limit: 50 })
      .find((j) => (j.payload as { messageUuid: string }).messageUuid === 'new-msg');
    expect((steerRow?.payload as { role: string }).role).toBe('steer');

    expect(repo.reclaimStale(Date.now() - 5 * 60 * 1000)).toHaveLength(1);

    const [reclaimed] = repo.dequeue(MESSAGE_DELIVERY, 1);
    expect((reclaimed.payload as { role: string }).role).toBe('turn');
    const zombieResult = await handler(reclaimed);
    expect(zombieResult).toEqual({ outcome: 'completed', skipped: 'turn_terminated' });
    expect(session.driveCalls).toBe(1);
    expect(session.settleCalls).toContain('zombie-turn');
    repo.complete(reclaimed.id, { ok: true });

    const [steer] = repo.dequeue(MESSAGE_DELIVERY, 1);
    expect((steer.payload as { role: string }).role).toBe('steer');
    const steerResult = await handler(steer);
    expect(steerResult).toMatchObject({ outcome: 'superseded', promoted: 'turn' });
    expect(repo.getJob(steer.id)?.status).toBe('pending');
    expect((repo.getJob(steer.id)?.payload as { role: string }).role).toBe('turn');
    const active = repo.activeDeliveryMessageUuids(SESSION);
    expect(active.has('zombie-turn')).toBe(false);
    expect(active.has('new-msg')).toBe(true);

    const [promoted] = repo.dequeue(MESSAGE_DELIVERY, 1);
    const promotedResult = await handler(promoted);
    expect(promotedResult).toEqual({ outcome: 'completed' });
    expect(session.driveCalls).toBe(2);
  });

  it('records reclaim-skip counters via the injected metrics sink (review P2.2a)', async () => {
    const session = new MockSession();
    const metrics = new DeliveryMetrics();
    const job = turnJob(repo, 'msg-consumed-m');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'hello', sendStatus: 'consumed' }),
      metrics,
    });
    await handler(job);
    expect(metrics.snapshot().reclaimSkips.alreadyConsumed).toBe(1);
    expect(metrics.snapshot().feedsObserved).toBe(0);
  });

  it('a submitted row re-claimed records alreadySubmitted + skips (review P2.2a)', async () => {
    const session = new MockSession();
    const metrics = new DeliveryMetrics();
    const job = turnJob(repo, 'msg-submitted-m');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'hello', sendStatus: 'submitted' }),
      metrics,
    });
    const result = await handler(job);
    expect(result).toMatchObject({ outcome: 'skipped', sendStatus: 'submitted' });
    expect(metrics.snapshot().reclaimSkips.alreadySubmitted).toBe(1);
  });

  it('a submitted ACP STEER keeps parking until accepted (not skip-completed)', async () => {
    const session = new MockSession();
    const job = steerJob(repo, 'msg-submitted-steer');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'steer', sendStatus: 'submitted' }),
    });
    const before = Date.now();
    const result = await handler(job);
    expect(result).toMatchObject({ parked: 'acp_awaiting_acceptance' });
    const after = repo.getJob(job.id);
    expect(after?.status).toBe('pending');
    expect(after?.runAt ?? 0).toBeGreaterThan(before);
    expect(session.feedCalls).toBe(0);
  });

  it('deferred message is skipped, not force-fed into the turn (#2597)', async () => {
    const session = new MockSession();
    const job = turnJob(repo, 'msg-deferred');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'hello', sendStatus: 'deferred' }),
    });
    const result = await handler(job);
    expect(result).toMatchObject({ outcome: 'skipped', sendStatus: 'deferred' });
    expect(session.driveCalls).toBe(0);
  });

  it('failed message is skipped (terminal)', async () => {
    const session = new MockSession();
    const job = turnJob(repo, 'msg-failed');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'hello', sendStatus: 'failed' }),
    });
    const result = await handler(job);
    expect(result).toMatchObject({ outcome: 'skipped', sendStatus: 'failed' });
    expect(session.driveCalls).toBe(0);
  });

  it('consumed steer is not re-fed (already_consumed)', async () => {
    const session = new MockSession();
    const job = steerJob(repo, 'msg-steer-consumed');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'steer', sendStatus: 'consumed' }),
    });
    const result = await handler(job);
    expect(result).toEqual({ outcome: 'already_consumed' });
    expect(session.feedCalls).toBe(0);
  });

  it('archived session is rejected, terminalized, and not driven (#3742616723/#3744225587)', async () => {
    const session = new MockSession();
    const job = turnJob(repo, 'msg-archived');
    const markFailed = mock(() => {});
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'hello', sendStatus: 'enqueued' }),
      isSessionArchived: () => true,
      markDeliveryFailed: markFailed,
    });
    const result = await handler(job);
    expect(result).toEqual({ outcome: 'archived' });
    expect(markFailed).toHaveBeenCalledWith(SESSION, 'msg-archived');
    expect(session.driveCalls).toBe(0);
  });

  it('a steer whose owning turn is parked (queued) is PARKED with a delay, not hot-looped (#3683)', async () => {
    const session = new MockSession();
    session.feedResult = { outcome: 'park' };
    const job = steerJob(repo, 'msg-park');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'steer', sendStatus: 'enqueued' }),
    });
    const before = Date.now();
    const result = await handler(job);
    expect(result).toMatchObject({ parked: 'turn_blocked' });
    const after = repo.getJob(job.id);
    expect(after?.status).toBe('pending');
    expect(after?.runAt ?? 0).toBeGreaterThan(before);
  });

  it('an ACP steer awaiting acceptance is PARKED (kept alive), not auto-completed', async () => {
    const session = new MockSession();
    session.feedResult = { outcome: 'awaiting_acceptance' };
    const job = steerJob(repo, 'msg-acp-accept');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'steer', sendStatus: 'enqueued' }),
    });
    const before = Date.now();
    const result = await handler(job);
    expect(result).toMatchObject({ parked: 'acp_awaiting_acceptance' });
    const after = repo.getJob(job.id);
    expect(after?.status).toBe('pending');
    expect(after?.runAt ?? 0).toBeGreaterThan(before);
    expect(session.feedCalls).toBe(1);
  });

  it('turn aborted (archive/removePending at feed time) → completes without feeding (#3742774841/#3696)', async () => {
    const session = new MockSession();
    session.driveResult = { outcome: 'aborted' };
    const job = turnJob(repo, 'msg-abort-turn');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'hello', sendStatus: 'enqueued' }),
    });
    const result = await handler(job);
    expect(result).toEqual({ outcome: 'aborted' });
    expect(session.driveCalls).toBe(1);
    expect(session.settleCalls).toEqual(['msg-abort-turn']);
  });

  it('steer aborted (archive/removePending at feed time) → completes without feeding (#3742774841/#3696)', async () => {
    const session = new MockSession();
    session.feedResult = { outcome: 'aborted' };
    const job = steerJob(repo, 'msg-abort-steer');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'steer', sendStatus: 'enqueued' }),
    });
    const result = await handler(job);
    expect(result).toEqual({ outcome: 'aborted' });
    expect(session.feedCalls).toBe(1);
    expect(session.settleCalls).toEqual(['msg-abort-steer']);
  });
});

describe('repo — exempt dequeue + requeueAllProcessing (#2587/#2593)', () => {
  let db: Database;
  let repo: JobQueueRepository;

  beforeEach(() => {
    ({ db, repo } = setupRepo());
  });
  afterEach(() => db.close());

  it('dequeue(exclude) claims turns but leaves steers; dequeueExempt claims steers', () => {
    const steerSpec = { path: '$.role', equals: 'steer' };
    deliverMessage(repo, SESSION, 'turn-1', { origin: 'chat' });
    deliverMessage(repo, SESSION, 'steer-1', { origin: 'chat' });
    const capped = repo.dequeue(MESSAGE_DELIVERY, 10, steerSpec);
    expect(capped).toHaveLength(1);
    expect((capped[0].payload as { role: string }).role).toBe('turn');
    const exempt = repo.dequeueExempt(MESSAGE_DELIVERY, steerSpec, 10);
    expect(exempt).toHaveLength(1);
    expect((exempt[0].payload as { role: string }).role).toBe('steer');
  });

  it('dequeue(exclude) is a no-op filter for lanes without an exempt spec', () => {
    deliverMessage(repo, SESSION, 'a', { origin: 'chat' });
    deliverMessage(repo, SESSION, 'b', { origin: 'chat' });
    const claimed = repo.dequeue(MESSAGE_DELIVERY, 10);
    expect(claimed).toHaveLength(2);
  });

  it('requeueAllProcessing returns every processing job to pending (runAt, no heartbeat) (#2593)', () => {
    deliverMessage(repo, SESSION, 'a', { origin: 'chat' });
    deliverMessage(repo, SESSION, 'b', { origin: 'chat' });
    deliverMessage(repo, 'other-session', 'c', { origin: 'chat' });
    repo.dequeue(MESSAGE_DELIVERY, 10);
    const runAt = Date.now();
    const requeued = repo.requeueAllProcessing(MESSAGE_DELIVERY, runAt);
    expect(requeued).toHaveLength(3);
    const all = repo.listJobs({ queue: MESSAGE_DELIVERY, limit: 50 });
    expect(
      all.every((j) => j.status === 'pending' && j.runAt === runAt && j.startedAt === null)
    ).toBe(true);
  });

  it('cancelForSession deletes pending+processing jobs for the session, leaves others (#3672)', () => {
    deliverMessage(repo, SESSION, 'a', { origin: 'chat' });
    deliverMessage(repo, SESSION, 'b', { origin: 'chat' });
    deliverMessage(repo, 'other-session', 'c', { origin: 'chat' });
    repo.dequeue(MESSAGE_DELIVERY, 1);
    const n = repo.cancelForSession(SESSION);
    expect(n).toBe(2);
    const remaining = repo.listJobs({ queue: MESSAGE_DELIVERY, limit: 10 });
    expect(remaining).toHaveLength(1);
    expect((remaining[0].payload as { sessionId: string }).sessionId).toBe('other-session');
  });

  it('cancelForSessionWithMessages returns cancelled UUIDs and cancelDelivery is scoped', () => {
    deliverMessage(repo, SESSION, 'a', { origin: 'chat' });
    deliverMessage(repo, SESSION, 'b', { origin: 'chat' });
    expect(repo.cancelDelivery(SESSION, 'b')).toBe(true);
    expect(repo.cancelDelivery(SESSION, 'b')).toBe(false);
    expect(repo.cancelForSessionWithMessages(SESSION)).toEqual(['a']);
    expect(repo.activeDeliveryMessageUuids(SESSION)).toEqual(new Set());
  });
});

describe('processor — exempt pass + onDead (#2587/#2595)', () => {
  let db: Database;
  let repo: JobQueueRepository;

  beforeEach(() => {
    ({ db, repo } = setupRepo());
  });
  afterEach(() => db.close());

  it('exempt steers run even when the single capped slot is held (maxConcurrent=1)', async () => {
    const ran: string[] = [];
    let releaseTurn!: () => void;
    const turnBlocked = new Promise<void>((r) => {
      releaseTurn = r;
    });
    const processor = new JobQueueProcessor(repo, { maxConcurrent: 1, pollIntervalMs: 999_999 });
    processor.register(
      MESSAGE_DELIVERY,
      async (job) => {
        const role = (job.payload as { role: string }).role;
        ran.push(role);
        if (role === 'turn') await turnBlocked;
        return { ok: true };
      },
      { exemptJobs: { path: '$.role', equals: 'steer' } }
    );

    deliverMessage(repo, SESSION, 't', { origin: 'chat' });
    deliverMessage(repo, SESSION, 's', { origin: 'chat' });
    await processor.tick();
    expect(ran).toEqual(['turn', 'steer']);
    releaseTurn();
    await processor.stop();
  });

  it('onDead fires (with the dead job) when a lane job exhausts retries (#2595)', async () => {
    const dead: Job[] = [];
    const processor = new JobQueueProcessor(repo, { maxConcurrent: 1, pollIntervalMs: 999_999 });
    processor.register(
      MESSAGE_DELIVERY,
      async () => {
        throw new Error('boom');
      },
      { onDead: (job) => dead.push(job) }
    );
    repo.enqueue({
      queue: MESSAGE_DELIVERY,
      payload: { sessionId: SESSION, messageUuid: 'd', role: 'turn', origin: 'chat' },
      maxRetries: 0,
    });
    await processor.tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(dead).toHaveLength(1);
    expect(dead[0].status).toBe('dead');
    await processor.stop();
  });
});

describe('delivery consumption signal (long-horizon delivered = consumed)', () => {
  it('waitForDeliveryConsumption resolves when signalDeliveryConsumed fires for the UUID', async () => {
    let resolved = false;
    const handle = waitForDeliveryConsumption('sess', 'consume-1');
    void handle.promise.then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    signalDeliveryConsumed('sess', 'consume-1');
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it('cancel() removes the waiter so a later signal does not resolve it', async () => {
    let resolved = false;
    const handle = waitForDeliveryConsumption('sess', 'consume-2');
    void handle.promise.then(() => {
      resolved = true;
    });
    handle.cancel();
    signalDeliveryConsumed('sess', 'consume-2');
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it('signalDeliveryConsumed is a no-op when no waiter is armed (e.g. consumption before any caller registers)', () => {
    expect(() => signalDeliveryConsumed('sess', 'consume-orphan')).not.toThrow();
  });

  it('multiple waiters for the same UUID all resolve on one signal', async () => {
    let a = false;
    let b = false;
    void waitForDeliveryConsumption('sess', 'consume-3').promise.then(() => {
      a = true;
    });
    void waitForDeliveryConsumption('sess', 'consume-3').promise.then(() => {
      b = true;
    });
    signalDeliveryConsumed('sess', 'consume-3');
    await Promise.resolve();
    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  it('a waiter for (sess-A, uuid-X) stays PENDING when sess-B signals the same UUID (cross-session scoping)', async () => {
    let aResolved = false;
    let bResolved = false;
    void waitForDeliveryConsumption('sess-A', 'shared-uuid').promise.then(() => {
      aResolved = true;
    });
    void waitForDeliveryConsumption('sess-B', 'shared-uuid').promise.then(() => {
      bResolved = true;
    });

    signalDeliveryConsumed('sess-B', 'shared-uuid');
    await Promise.resolve();

    expect(bResolved).toBe(true);
    expect(aResolved).toBe(false);

    signalDeliveryConsumed('sess-A', 'shared-uuid');
    await Promise.resolve();
    expect(aResolved).toBe(true);
  });
});

describe('drainDeliveryWaitersOnTerminalSDKMessage (handleSDKMessage-catch gating)', () => {
  it('calls setIdle (drains) when the throwing message is the final result', async () => {
    const setIdle = mock(async () => {});
    await drainDeliveryWaitersOnTerminalSDKMessage({ setIdle }, { type: 'result' } as SDKMessage);
    expect(setIdle).toHaveBeenCalledTimes(1);
  });

  it('does NOT call setIdle for a nested subagent result throw', async () => {
    const setIdle = mock(async () => {});
    await drainDeliveryWaitersOnTerminalSDKMessage({ setIdle }, {
      type: 'result',
      parent_tool_use_id: 'outer-agent-tool-use',
    } as SDKMessage);
    expect(setIdle).not.toHaveBeenCalled();
  });

  it('does NOT call setIdle for a non-terminal (assistant) message throw', async () => {
    const setIdle = mock(async () => {});
    await drainDeliveryWaitersOnTerminalSDKMessage({ setIdle }, {
      type: 'assistant',
    } as SDKMessage);
    expect(setIdle).not.toHaveBeenCalled();
  });

  it('does NOT call setIdle for a stream_event / non-result message', async () => {
    const setIdle = mock(async () => {});
    await drainDeliveryWaitersOnTerminalSDKMessage({ setIdle }, {
      type: 'stream_event',
    } as SDKMessage);
    expect(setIdle).not.toHaveBeenCalled();
  });
});

describe('awaitDeliveryConsumption — terminalize a fresh job on timeout (no-stable-id dedup)', () => {
  const prev = process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS;
  beforeAll(() => {
    process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = '20';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS;
    else process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = prev;
  });

  it('calls terminalizeOnTimeout + rejects when consumption is not signalled (fresh job)', async () => {
    const deliver = mock(async () => {});
    const terminalize = mock(() => {});
    await expect(
      awaitDeliveryConsumption({
        sessionId: 'sess',
        messageUuid: 'fresh-timeout',
        deliver,
        terminalizeOnTimeout: terminalize,
      })
    ).rejects.toThrow('not consumed within timeout');
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(terminalize).toHaveBeenCalledTimes(1);
  });

  it('does NOT call terminalizeOnTimeout when consumption is signalled in time', async () => {
    const deliver = mock(async () => {
      signalDeliveryConsumed('sess', 'fresh-consumed');
    });
    const terminalize = mock(() => {});
    await awaitDeliveryConsumption({
      sessionId: 'sess',
      messageUuid: 'fresh-consumed',
      deliver,
      terminalizeOnTimeout: terminalize,
    });
    expect(terminalize).not.toHaveBeenCalled();
  });
});

describe('awaitDeliveryConsumption — lost wakeup (persisted sendStatus re-check)', () => {
  it('resolves from getSendStatus when the consumption signal fired before waiter registration', async () => {
    signalDeliveryConsumed('sess', 'gap-consumed');
    await awaitDeliveryConsumption({
      sessionId: 'sess',
      messageUuid: 'gap-consumed',
      deliver: async () => {},
      getSendStatus: () => 'consumed',
      timeoutMs: 25,
    });
  });

  it('still rejects and terminalizes when getSendStatus never reports consumed', async () => {
    const terminalize = mock(() => {});
    await expect(
      awaitDeliveryConsumption({
        sessionId: 'sess',
        messageUuid: 'gap-stuck',
        deliver: async () => {},
        getSendStatus: () => 'enqueued',
        timeoutMs: 25,
        terminalizeOnTimeout: terminalize,
      })
    ).rejects.toThrow('not consumed within timeout');
    expect(terminalize).toHaveBeenCalledTimes(1);
  });
});

describe('message-delivery v2 — steer park bound (dead-letter after MAX_STEER_PARKS)', () => {
  let db: Database;
  let repo: JobQueueRepository;

  beforeEach(() => {
    ({ db, repo } = setupRepo());
  });
  afterEach(() => db.close());

  it('parks up to the budget, then throws DeadLetterImmediatelyError', async () => {
    const session = new MockSession();
    session.feedResult = { outcome: 'park' };
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'steer', sendStatus: 'enqueued' }),
    });

    let current = steerJob(repo, 'msg-park-bound');

    for (let i = 0; i < MAX_STEER_PARKS; i++) {
      const result = await handler(current);
      expect(result).toMatchObject({ parked: 'turn_blocked' });
      expect(repo.getJob(current.id)?.retryCount).toBe(0);
      db.prepare(`UPDATE job_queue SET run_at = 0 WHERE id = ?`).run(current.id);
      const [next] = repo.dequeue(MESSAGE_DELIVERY, 1);
      expect(next).toBeTruthy();
      current = next!;
    }
    expect(repo.getParkCount(current.id)).toBeGreaterThanOrEqual(MAX_STEER_PARKS);

    await expect(handler(current)).rejects.toThrow(/parked past its budget/);
  });

  it('ACP awaiting-acceptance parks up to the budget, then dead-letters', async () => {
    expect(MAX_ACP_STEER_PARKS * MESSAGE_DELIVERY_PARK_MS).toBeGreaterThanOrEqual(
      ACP_DELIVERY_CONSUMPTION_TIMEOUT_MS
    );
    const session = new MockSession();
    session.feedResult = { outcome: 'awaiting_acceptance' };
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'steer', sendStatus: 'enqueued' }),
    });

    let current = steerJob(repo, 'msg-acp-accept-bound');
    for (let i = 0; i < MAX_ACP_STEER_PARKS; i++) {
      const result = await handler(current);
      expect(result).toMatchObject({ parked: 'acp_awaiting_acceptance' });
      expect(repo.getJob(current.id)?.retryCount).toBe(0);
      db.prepare(`UPDATE job_queue SET run_at = 0 WHERE id = ?`).run(current.id);
      const [next] = repo.dequeue(MESSAGE_DELIVERY, 1);
      expect(next).toBeTruthy();
      current = next!;
    }
    expect(repo.getParkCount(current.id)).toBeGreaterThanOrEqual(MAX_ACP_STEER_PARKS);
    await expect(handler(current)).rejects.toThrow(/awaited acceptance past its budget/);
  });

  it('a persisted-submitted ACP steer parks to the same acceptance-sized budget, then dead-letters', async () => {
    const session = new MockSession();
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'steer', sendStatus: 'submitted' }),
    });

    let current = steerJob(repo, 'msg-acp-submitted-bound');
    for (let i = 0; i < MAX_ACP_STEER_PARKS; i++) {
      const result = await handler(current);
      expect(result).toMatchObject({ parked: 'acp_awaiting_acceptance' });
      expect(session.feedCalls).toBe(0);
      db.prepare(`UPDATE job_queue SET run_at = 0 WHERE id = ?`).run(current.id);
      const [next] = repo.dequeue(MESSAGE_DELIVERY, 1);
      current = next!;
    }
    expect(repo.getParkCount(current.id)).toBeGreaterThanOrEqual(MAX_ACP_STEER_PARKS);
    await expect(handler(current)).rejects.toThrow(/awaited acceptance past its budget/);
  });

  it('a steer parked behind an OPEN human gate keeps parking past the budget (Codex #11)', async () => {
    const session = new MockSession();
    session.feedResult = { outcome: 'park' };
    session.waitingForInput = true;
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'steer', sendStatus: 'enqueued' }),
    });

    let current = steerJob(repo, 'msg-gate-open');
    for (let i = 0; i < MAX_STEER_PARKS + 5; i++) {
      const result = await handler(current);
      expect(result).toMatchObject({ parked: 'turn_blocked_gate_open' });
      expect(repo.getJob(current.id)?.retryCount).toBe(0);
      expect(repo.getParkCount(current.id)).toBe(0);
      db.prepare(`UPDATE job_queue SET run_at = 0 WHERE id = ?`).run(current.id);
      const [next] = repo.dequeue(MESSAGE_DELIVERY, 1);
      expect(next).toBeTruthy();
      current = next!;
    }
    session.waitingForInput = false;
    for (let i = 0; i < MAX_STEER_PARKS; i++) {
      const result = await handler(current);
      expect(result).toMatchObject({ parked: 'turn_blocked' });
      db.prepare(`UPDATE job_queue SET run_at = 0 WHERE id = ?`).run(current.id);
      const [next] = repo.dequeue(MESSAGE_DELIVERY, 1);
      current = next!;
    }
    await expect(handler(current)).rejects.toThrow(/parked past its budget/);
  });
});

describe('isTerminalTurnError — auth failures dead-letter immediately (Codex #2)', () => {
  it('auth categories are terminal even when flagged recoverable', () => {
    expect(isTerminalTurnError({ recoverable: true, category: 'authentication' })).toBe(true);
    expect(isTerminalTurnError({ recoverable: true, category: 'provider_auth_error' })).toBe(true);
  });

  it('non-recoverable is terminal regardless of category', () => {
    expect(isTerminalTurnError({ recoverable: false, category: 'permission' })).toBe(true);
    expect(isTerminalTurnError({ recoverable: false })).toBe(true);
  });

  it('recoverable non-auth errors retry', () => {
    expect(isTerminalTurnError({ recoverable: true, category: 'system' })).toBe(false);
    expect(isTerminalTurnError({ recoverable: true, category: 'connection' })).toBe(false);
    expect(isTerminalTurnError({ recoverable: true })).toBe(false);
  });
});

describe('isRetryableErrorResultSubtype — persisted error-result classification', () => {
  it('transient execution failures and turn-cap exhaustion retry', () => {
    expect(isRetryableErrorResultSubtype('error_during_execution')).toBe(true);
    expect(isRetryableErrorResultSubtype('error_max_turns')).toBe(true);
  });

  it('cost / structured-output exhaustion dead-letter (retrying repeats spend)', () => {
    expect(isRetryableErrorResultSubtype('error_max_budget_usd')).toBe(false);
    expect(isRetryableErrorResultSubtype('error_max_structured_output_retries')).toBe(false);
    expect(isRetryableErrorResultSubtype(null)).toBe(false);
  });
});
