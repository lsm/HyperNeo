import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import {
  ACP_DELIVERY_CONSUMPTION_TIMEOUT_MS,
  awaitDeliveryConsumption,
  deliveryConsumptionTimeoutOrDefault,
  type DriveTurnOutcome,
  deliverAndMarkQueued,
  deliverMessage,
  drainDeliveryWaitersOnTerminalSDKMessage,
  flattenDeliveryText,
  isRetryableErrorResultSubtype,
  isTerminalTurnError,
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
import { runMigration221 } from '../../../../src/storage/schema/m221-drop-message-delivery-active-turn-index';
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
    CREATE TABLE sdk_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      sdk_uuid TEXT NOT NULL,
      send_status TEXT
    );
  `);
  runMigration182(db as unknown as Parameters<typeof runMigration182>[0]);
  runMigration221(db as unknown as Parameters<typeof runMigration221>[0]);
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

  describe('deliverMessage — plain enqueue (§7: durable insertion)', () => {
    it('enqueues a role-free FIFO payload', () => {
      deliverMessage(repo, SESSION, 'msg-A', { origin: 'chat' });
      const jobs = jobsFor(repo, SESSION);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].payload).toEqual({
        sessionId: SESSION,
        messageUuid: 'msg-A',
        origin: 'chat',
        parentToolUseId: null,
      });
      expect(jobs[0].maxRetries).toBeGreaterThan(0);
    });

    it('a second message enqueues alongside the first — FIFO orders them, no arbiter', () => {
      deliverMessage(repo, SESSION, 'msg-A', { origin: 'chat' });
      deliverMessage(repo, SESSION, 'msg-B', { origin: 'chat' });
      const jobs = jobsFor(repo, SESSION);
      expect(jobs).toHaveLength(2);
      const [head] = repo.dequeueSessionFifo(MESSAGE_DELIVERY, 2);
      expect(head?.payload.messageUuid).toBe('msg-A');
      repo.complete(head!.id, { ok: true });
      const [tail] = repo.dequeueSessionFifo(MESSAGE_DELIVERY, 2);
      expect(tail?.payload.messageUuid).toBe('msg-B');
    });

    it('propagates enqueue failures to the caller', () => {
      const stub = {
        enqueue: () => {
          throw new Error('disk I/O error');
        },
      } as unknown as JobQueueRepository;
      expect(() => deliverMessage(stub, SESSION, 'io-fail', { origin: 'chat' })).toThrow(
        /disk I\/O error/
      );
    });
  });

  describe('deliverAndMarkQueued — admission completion', () => {
    it('enqueues the job and marks the session queued when idle', async () => {
      const { repo: fresh } = setupRepo();
      const setQueuedIfIdle = mock(async () => false);
      await deliverAndMarkQueued({
        jobQueue: fresh,
        stateManager: {
          getState: () => ({ status: 'idle' }),
          setQueuedIfIdle,
        },
        sessionId: SESSION,
        messageUuid: 'msg-idle',
        origin: 'chat',
      });
      const jobs = fresh.listJobs({ queue: MESSAGE_DELIVERY, limit: 10 });
      expect(jobs).toHaveLength(1);
      expect(setQueuedIfIdle).toHaveBeenCalledWith('msg-idle');
    });
  });

  describe('dequeue — FIFO within a session (§15: created_at tiebreaker)', () => {
    it('orders exact same-millisecond ties by rowid ASC', () => {
      const now = Date.now();
      for (const uuid of ['first', 'second', 'third']) {
        repo.enqueue({
          queue: MESSAGE_DELIVERY,
          payload: { sessionId: SESSION, messageUuid: uuid, origin: 'chat' },
          runAt: now,
        });
      }
      db.prepare(`UPDATE job_queue SET priority = 0, run_at = ?, created_at = ?`).run(now, now);
      const claimed: string[] = [];
      for (let i = 0; i < 3; i++) {
        const [head] = repo.dequeueSessionFifo(MESSAGE_DELIVERY, 3);
        claimed.push(head!.payload.messageUuid as string);
        repo.complete(head!.id, { ok: true });
      }
      expect(claimed).toEqual(['first', 'second', 'third']);
    });

    it('orders same-priority/run_at jobs by created_at ASC', () => {
      const now = Date.now();
      for (const uuid of ['first', 'second', 'third']) {
        repo.enqueue({
          queue: MESSAGE_DELIVERY,
          payload: { sessionId: SESSION, messageUuid: uuid, origin: 'chat' },
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

    it('a running-but-unconsumed predecessor blocks the session lane until it settles', () => {
      deliverMessage(repo, SESSION, 'head', { origin: 'chat' });
      deliverMessage(repo, SESSION, 'tail', { origin: 'chat' });
      const [head] = repo.dequeueSessionFifo(MESSAGE_DELIVERY, 1);
      expect(head?.payload.messageUuid).toBe('head');
      expect(repo.dequeueSessionFifo(MESSAGE_DELIVERY, 5)).toHaveLength(0);
      repo.complete(head!.id, { ok: true });
      const [tail] = repo.dequeueSessionFifo(MESSAGE_DELIVERY, 5);
      expect(tail?.payload.messageUuid).toBe('tail');
    });

    it('an unreleased held job blocks the lane and releases unblock it', () => {
      deliverMessage(repo, SESSION, 'held', { origin: 'chat' });
      db.prepare(
        `UPDATE job_queue SET payload = json_set(payload, '$.released', json('false'))`
      ).run();
      deliverMessage(repo, SESSION, 'next', { origin: 'chat' });
      expect(repo.dequeueSessionFifo(MESSAGE_DELIVERY, 5, { releasedPath: '$.released' })).toEqual(
        []
      );
      db.prepare(
        `UPDATE job_queue SET payload = json_set(payload, '$.released', json('true'))`
      ).run();
      const [claimed] = repo.dequeueSessionFifo(MESSAGE_DELIVERY, 5, {
        releasedPath: '$.released',
      });
      expect(claimed?.payload.messageUuid).toBe('held');
    });
  });

  describe('requeue — park a blocked delivery (§8: runAt, no retry bump)', () => {
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
      expect(reclaimed[0].messageUuid).toBe('crashed');
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
      const [first] = repo.dequeue(MESSAGE_DELIVERY, 1);
      repo.complete(first.id, { ok: true });
      expect(repo.activeDeliveryMessageUuids(SESSION)).toEqual(new Set(['msg-b']));
    });
  });

  describe('delivery content helpers', () => {
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

  describe('hasActiveDeliveryJob — ownership probe for the ack path', () => {
    it('is true while a pending or processing job carries the message', () => {
      deliverMessage(repo, SESSION, 'owned', { origin: 'chat' });
      expect(repo.hasActiveDeliveryJob(SESSION, 'owned')).toBe(true);
      const [job] = repo.dequeue(MESSAGE_DELIVERY, 1);
      expect(repo.hasActiveDeliveryJob(SESSION, 'owned')).toBe(true);
      repo.complete(job.id, { ok: true });
      expect(repo.hasActiveDeliveryJob(SESSION, 'owned')).toBe(false);
    });
  });
});

class MockSession implements MessageDeliverySession {
  driveResult: DriveTurnOutcome = { outcome: 'completed' };
  driveOutcomeByUuid?: Record<string, DriveTurnOutcome>;
  shouldThrow = false;
  driveCalls = 0;
  settleCalls: string[] = [];
  lastUuid?: string;
  lastContent?: unknown;

  async driveDeliveryTurn(
    uuid: string,
    content: unknown,
    _parentToolUseId?: string | null,
    _alreadyConsumed = false,
    _claimGuard?: () => boolean
  ): Promise<DriveTurnOutcome> {
    this.driveCalls++;
    this.lastUuid = uuid;
    this.lastContent = content;
    if (this.shouldThrow) throw new Error('turn exploded');
    if (this.driveOutcomeByUuid && uuid in this.driveOutcomeByUuid) {
      return this.driveOutcomeByUuid[uuid];
    }
    return this.driveResult;
  }

  async settleSkippedDelivery(uuid: string): Promise<void> {
    this.settleCalls.push(uuid);
  }

  isWaitingForInput(): boolean {
    return false;
  }
}

function turnJob(repo: JobQueueRepository, uuid: string): Job {
  deliverMessage(repo, SESSION, uuid, { origin: 'chat' });
  const [job] = repo.dequeue(MESSAGE_DELIVERY, 1);
  return job!;
}

describe('message-delivery v2 — handler (conformance)', () => {
  let db: Database;
  let repo: JobQueueRepository;

  beforeEach(() => {
    ({ db, repo } = setupRepo());
  });
  afterEach(() => db.close());

  it('admission completed → handler returns completed outcome', async () => {
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

  it('a legacy queued payload carrying role and batchUuids still processes (unknown fields ignored)', async () => {
    const session = new MockSession();
    repo.enqueue({
      queue: MESSAGE_DELIVERY,
      payload: {
        sessionId: SESSION,
        messageUuid: 'legacy',
        role: 'steer',
        origin: 'recovery',
        parentToolUseId: null,
        batchUuids: ['legacy', 'legacy-member'],
      },
    });
    const [job] = repo.dequeue(MESSAGE_DELIVERY, 1);
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'legacy content', sendStatus: 'enqueued' }),
    });
    const result = await handler(job);
    expect(result).toEqual({ outcome: 'completed' });
    expect(session.driveCalls).toBe(1);
    expect(session.lastContent).toBe('legacy content');
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

  it('a consumed row completes without re-feeding the SDK (#2592)', async () => {
    const session = new MockSession();
    const job = turnJob(repo, 'msg-consumed');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'hello', sendStatus: 'consumed' }),
    });
    const result = await handler(job);
    expect(result).toEqual({ outcome: 'completed' });
    expect(session.driveCalls).toBe(0);
  });

  it('end-to-end: stale reclaimed consumed delivery completes without driving, then the successor drives', async () => {
    const session = new MockSession();
    const statuses: Record<string, string> = { 'zombie-turn': 'consumed' };
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

    expect(repo.reclaimStale(Date.now() - 5 * 60 * 1000)).toHaveLength(1);

    const [reclaimed] = repo.dequeue(MESSAGE_DELIVERY, 1);
    expect((reclaimed.payload as { messageUuid: string }).messageUuid).toBe('zombie-turn');
    const zombieResult = await handler(reclaimed);
    expect(zombieResult).toEqual({ outcome: 'completed' });
    expect(session.driveCalls).toBe(0);
    repo.complete(reclaimed.id, { ok: true });

    const [successor] = repo.dequeue(MESSAGE_DELIVERY, 1);
    expect((successor.payload as { messageUuid: string }).messageUuid).toBe('new-msg');
    const successorResult = await handler(successor);
    expect(successorResult).toEqual({ outcome: 'completed' });
    expect(session.driveCalls).toBe(1);
    const active = repo.activeDeliveryMessageUuids(SESSION);
    expect(active.has('zombie-turn')).toBe(false);
  });

  it('a consumed row observes no feed through the injected metrics sink (review P2.2a)', async () => {
    const session = new MockSession();
    const metrics = new DeliveryMetrics();
    const job = turnJob(repo, 'msg-consumed-m');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'hello', sendStatus: 'consumed' }),
      metrics,
    });
    const result = await handler(job);
    expect(result).toEqual({ outcome: 'completed' });
    expect(session.driveCalls).toBe(0);
    expect(metrics.snapshot().feedsObserved).toBe(0);
  });

  it('a submitted row is re-admitted, not skipped (review P2.2a)', async () => {
    const session = new MockSession();
    const job = turnJob(repo, 'msg-submitted-m');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'hello', sendStatus: 'submitted' }),
    });
    const result = await handler(job);
    expect(result).toEqual({ outcome: 'completed' });
    expect(session.driveCalls).toBe(1);
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

  it('a blocked delivery is requeued with a delay, not hot-looped (#3683)', async () => {
    const session = new MockSession();
    const sessionRetryAt = Date.now() + 60_000;
    session.driveResult = {
      outcome: 'blocked',
      retryAt: sessionRetryAt,
      reason: 'sdk_resume_choice',
    };
    const job = turnJob(repo, 'msg-park');
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'hello', sendStatus: 'enqueued' }),
    });
    const result = await handler(job);
    expect(result).toMatchObject({ parked: 'sdk_resume_choice', retryAt: sessionRetryAt });
    const after = repo.getJob(job.id);
    expect(after?.status).toBe('pending');
    expect(after?.runAt).toBe(sessionRetryAt);
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
});

describe('repo — payload-match dequeue + requeueAllProcessing (#2587/#2593)', () => {
  let db: Database;
  let repo: JobQueueRepository;

  beforeEach(() => {
    ({ db, repo } = setupRepo());
  });
  afterEach(() => db.close());

  it('dequeue(exclude) skips payloads matching the spec; dequeueExempt claims them', () => {
    const exemptSpec = { path: '$.lane', equals: 'urgent' };
    repo.enqueue({
      queue: MESSAGE_DELIVERY,
      payload: { sessionId: SESSION, messageUuid: 'plain-1', lane: 'normal', origin: 'chat' },
    });
    repo.enqueue({
      queue: MESSAGE_DELIVERY,
      payload: { sessionId: SESSION, messageUuid: 'urgent-1', lane: 'urgent', origin: 'chat' },
    });
    const capped = repo.dequeue(MESSAGE_DELIVERY, 10, exemptSpec);
    expect(capped).toHaveLength(1);
    expect((capped[0].payload as { messageUuid: string }).messageUuid).toBe('plain-1');
    const exempt = repo.dequeueExempt(MESSAGE_DELIVERY, exemptSpec, 10);
    expect(exempt).toHaveLength(1);
    expect((exempt[0].payload as { messageUuid: string }).messageUuid).toBe('urgent-1');
  });

  it('dequeue without an exclude spec is a no-op filter', () => {
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

describe('processor — onDead (#2595)', () => {
  let db: Database;
  let repo: JobQueueRepository;

  beforeEach(() => {
    ({ db, repo } = setupRepo());
  });
  afterEach(() => db.close());

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
      payload: { sessionId: SESSION, messageUuid: 'd', origin: 'chat' },
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

describe('message-delivery v2 — blocked delivery requeue bound', () => {
  let db: Database;
  let repo: JobQueueRepository;

  beforeEach(() => {
    ({ db, repo } = setupRepo());
  });
  afterEach(() => db.close());

  it('a blocked delivery requeues as pending at the session retryAt without burning retries', async () => {
    const session = new MockSession();
    session.driveResult = { outcome: 'blocked', retryAt: 4321, reason: 'sdk_resume_choice' };
    const handler = createMessageDeliveryHandler({
      jobQueue: repo,
      getSession: () => session,
      getMessageContent: () => ({ content: 'hello', sendStatus: 'enqueued' }),
    });

    let current = turnJob(repo, 'msg-blocked-bound');
    for (let i = 0; i < 3; i++) {
      const result = await handler(current);
      expect(result).toMatchObject({ parked: 'sdk_resume_choice', retryAt: 4321 });
      expect(repo.getJob(current.id)?.retryCount).toBe(0);
      expect(repo.getJob(current.id)?.status).toBe('pending');
      db.prepare(`UPDATE job_queue SET run_at = 0 WHERE id = ?`).run(current.id);
      const [next] = repo.dequeue(MESSAGE_DELIVERY, 1);
      expect(next).toBeTruthy();
      current = next!;
    }
  });
});

describe('deliveryConsumptionTimeoutOrDefault — timeout validation', () => {
  const prev = process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS;

  afterEach(() => {
    if (prev === undefined) delete process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS;
    else process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = prev;
  });

  it('defaults to 30s when unset', () => {
    delete process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS;
    expect(deliveryConsumptionTimeoutOrDefault()).toBe(30_000);
  });

  it('honors a positive explicit value', () => {
    expect(deliveryConsumptionTimeoutOrDefault(1234)).toBe(1234);
    process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = '5000';
    expect(deliveryConsumptionTimeoutOrDefault()).toBe(5000);
  });

  it('rejects negative, zero, and non-finite values and falls back to 30s', () => {
    process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = '-5';
    expect(deliveryConsumptionTimeoutOrDefault()).toBe(30_000);
    process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = '0';
    expect(deliveryConsumptionTimeoutOrDefault()).toBe(30_000);
    process.env.HYPERNEO_DELIVERY_CONSUMPTION_TIMEOUT_MS = 'not-a-number';
    expect(deliveryConsumptionTimeoutOrDefault()).toBe(30_000);
    expect(deliveryConsumptionTimeoutOrDefault(-1)).toBe(30_000);
    expect(deliveryConsumptionTimeoutOrDefault(Number.NaN)).toBe(30_000);
  });

  it('exposes the ACP consumption timeout constant for ACP providers', () => {
    expect(ACP_DELIVERY_CONSUMPTION_TIMEOUT_MS).toBe(12 * 60 * 1000);
    expect(MESSAGE_DELIVERY_PARK_MS).toBe(5_000);
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
