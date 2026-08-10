/**
 * Message Delivery v2 — conformance harness.
 *
 * Each test is a case lifted from the 28 phase-1 review rounds that the new
 * design must pass BY CONSTRUCTION (one durable job_queue claim, atomic role,
 * reclaimStale redelivery). Cases that become "untestable by design" under v2
 * (in-memory-vs-store disagreement: consumed-then-clear races, ledger/send_status
 * drift) are noted in comments — they cannot be expressed because there is no
 * second source of truth to diverge.
 *
 * See docs/features/message-delivery-v2.md §13.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { runMigration182 } from '../../../../src/storage/schema/migrations';
import { MESSAGE_DELIVERY } from '../../../../src/lib/job-queue-constants';
import {
  deliverMessage,
  isUniqueConstraintError,
  signalDeliveryConsumed,
  waitForDeliveryConsumption,
  type MessageDeliverySession,
  type DriveTurnOutcome,
  type FeedSteerOutcome,
} from '../../../../src/lib/agent/message-delivery';
import { createMessageDeliveryHandler } from '../../../../src/lib/job-handlers/message-delivery.handler';
import { JobQueueProcessor } from '../../../../src/storage/job-queue-processor';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository';

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
      completed_at INTEGER
    );
    CREATE INDEX idx_job_queue_dequeue ON job_queue(queue, status, priority DESC, run_at ASC);
    CREATE INDEX idx_job_queue_status ON job_queue(status);
  `);
  // The atomic role arbiter — the v2 substrate.
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
      // Pre-insert a pending turn so the next turn insert hits the UNIQUE guard.
      repo.enqueue({
        queue: MESSAGE_DELIVERY,
        payload: { sessionId: SESSION, messageUuid: 'existing', role: 'turn', origin: 'chat' },
      });
      // Calling deliverMessage with an explicit role:'turn' bypasses the arbiter
      // and surfaces the raw UNIQUE error — proving the index is the guard.
      expect(() =>
        deliverMessage(repo, SESSION, 'competing', { origin: 'chat', role: 'turn' })
      ).toThrow();
    });

    it('a completed/failed turn frees the slot for a new turn', () => {
      deliverMessage(repo, SESSION, 'turn-1', { origin: 'chat' });
      const job = jobsFor(repo, SESSION)[0];
      repo.dequeue(MESSAGE_DELIVERY, 1)[0]; // claim
      repo.complete(job.id, { ok: true }); // turn finished → slot freed
      deliverMessage(repo, SESSION, 'turn-2', { origin: 'chat' });
      const turns = jobsFor(repo, SESSION).filter(
        (j) => (j.payload as { role: string }).role === 'turn'
      );
      expect(turns).toHaveLength(2);
    });

    it('is idempotent per UUID — a second deliverMessage for the same UUID is a no-op', () => {
      // The reset path can persist + deliver the same UUID twice (the replacement
      // session is created before the old one is cleaned up). Without the
      // getActiveDeliveryRole guard, the second call would insert a steer for the
      // UUID the first inserted as a turn → the prompt reaches the SDK twice.
      const role1 = deliverMessage(repo, SESSION, 'dup', { origin: 'chat' });
      const role2 = deliverMessage(repo, SESSION, 'dup', { origin: 'chat' });
      expect(role1).toBe('turn');
      expect(role2).toBe('turn'); // returns the existing role, no second insert
      const dup = jobsFor(repo, SESSION).filter(
        (j) => (j.payload as { messageUuid: string }).messageUuid === 'dup'
      );
      expect(dup).toHaveLength(1);
    });

    it('idempotency returns the existing steer role, not a fresh insert', () => {
      deliverMessage(repo, SESSION, 'turn', { origin: 'chat' });
      // 'steer-uuid' becomes a steer because a turn is active.
      const role1 = deliverMessage(repo, SESSION, 'steer-uuid', { origin: 'chat' });
      expect(role1).toBe('steer');
      // A second call for the same steer UUID must return 'steer', not insert again.
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
      // Force every documented sort key to tie; rowid must preserve insertion order.
      db.prepare(`UPDATE job_queue SET priority = 0, run_at = ?, created_at = ?`).run(now, now);
      const claimed = repo.dequeueExempt(MESSAGE_DELIVERY, { path: '$.role', equals: 'steer' }, 3);
      expect(claimed.map((j) => j.payload.messageUuid)).toEqual(['first', 'second', 'third']);
    });

    it('orders same-priority/run_at jobs by created_at ASC', () => {
      const now = Date.now();
      // Enqueue three jobs with identical priority + runAt but distinct created_at.
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
      const [job] = repo.dequeue(MESSAGE_DELIVERY, 1); // claim → processing
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
      // Simulate a daemon crash: the job is `processing` with a stale started_at.
      const staleStartedAt = Date.now() - 10 * 60 * 1000;
      db.prepare(`UPDATE job_queue SET started_at = ? WHERE id = ?`).run(staleStartedAt, job.id);
      const reclaimed = repo.reclaimStale(Date.now() - 5 * 60 * 1000);
      expect(reclaimed).toBe(1);
      const after = repo.getJob(job.id);
      expect(after?.status).toBe('pending');
      expect(after?.startedAt).toBeNull();
      // And it can be claimed again (redelivered) with a fresh claim token.
      const [reclaimedJob] = repo.dequeue(MESSAGE_DELIVERY, 1);
      expect(reclaimedJob.claimToken).not.toBe(job.claimToken);
      expect(repo.isClaimCurrent(job.id, job.claimToken)).toBe(false);
      expect(repo.isClaimCurrent(reclaimedJob.id, reclaimedJob.claimToken)).toBe(true);
      // The predecessor cannot heartbeat or requeue the replacement attempt.
      expect(repo.touchStartedAt(job.id, job.claimToken)).toBe(false);
      expect(repo.requeue(job.id, Date.now(), job.claimToken)).toBeNull();
    });
  });

  describe('atomic claim — no double-delivery (§13 headline)', () => {
    it('a claimed (processing) job is NOT re-claimed by a second dequeue', () => {
      deliverMessage(repo, SESSION, 'msg-once', { origin: 'chat' });
      const first = repo.dequeue(MESSAGE_DELIVERY, 1);
      expect(first).toHaveLength(1);
      expect(first[0].status).toBe('processing');
      // The atomic dequeue transaction moved it pending→processing, so a second
      // dequeue finds nothing — the message cannot be double-delivered.
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
      deliverMessage(repo, SESSION, 'the-steer', { origin: 'chat' }); // → steer
      const [turn] = repo.dequeue(MESSAGE_DELIVERY, 1);
      repo.complete(turn.id, { ok: true }); // free the active-turn slot
      const [steer] = repo.dequeue(MESSAGE_DELIVERY, 1);
      expect((steer.payload as { role: string }).role).toBe('steer');
      const before = repo.listJobs({ queue: MESSAGE_DELIVERY, limit: 50 }).length;
      repo.requeueAs(steer.id, 'turn', 123);
      const after = repo.getJob(steer.id);
      expect(after?.status).toBe('pending');
      expect((after?.payload as { role: string }).role).toBe('turn');
      expect(after?.runAt).toBe(123);
      expect(after?.retryCount).toBe(0); // no retry bump
      // Same job count — converted in place, no second job.
      expect(repo.listJobs({ queue: MESSAGE_DELIVERY, limit: 50 }).length).toBe(before);
    });

    it('no-ops (returns null) when the job is no longer processing', () => {
      deliverMessage(repo, SESSION, 'gone-as', { origin: 'chat' });
      const [job] = repo.dequeue(MESSAGE_DELIVERY, 1);
      repo.complete(job.id, { ok: true });
      expect(repo.requeueAs(job.id, 'turn', Date.now())).toBeNull();
    });
  });

  describe('touchStartedAt — lease heartbeat (live turn not reclaimed)', () => {
    it('refreshes started_at without changing status (fends off reclaimStale)', () => {
      deliverMessage(repo, SESSION, 'live-turn', { origin: 'chat' });
      const [job] = repo.dequeue(MESSAGE_DELIVERY, 1);
      const stale = Date.now() - 10 * 60 * 1000;
      db.prepare(`UPDATE job_queue SET started_at = ? WHERE id = ?`).run(stale, job.id);
      repo.touchStartedAt(job.id);
      // After the heartbeat, the job is NOT reclaimed (started_at is fresh)...
      expect(repo.reclaimStale(Date.now() - 5 * 60 * 1000)).toBe(0);
      expect(repo.getJob(job.id)?.status).toBe('processing');
    });
  });

  describe('activeDeliveryMessageUuids — legacy-replay guard', () => {
    it('lists UUIDs with an active (pending/processing) v2 job; empty when none', () => {
      expect(repo.activeDeliveryMessageUuids(SESSION)).toEqual(new Set());
      deliverMessage(repo, SESSION, 'msg-a', { origin: 'chat' }); // pending turn
      deliverMessage(repo, SESSION, 'msg-b', { origin: 'chat' }); // pending steer
      expect(repo.activeDeliveryMessageUuids(SESSION)).toEqual(new Set(['msg-a', 'msg-b']));
      // Completed jobs drop out.
      const [turn] = repo.dequeue(MESSAGE_DELIVERY, 1);
      repo.complete(turn.id, { ok: true });
      expect(repo.activeDeliveryMessageUuids(SESSION)).toEqual(new Set(['msg-b']));
    });
  });
});

// ── Handler-level conformance ──────────────────────────────────────────────
// The session is mocked; the job_queue + index are real.

class MockSession implements MessageDeliverySession {
  driveResult: DriveTurnOutcome = { outcome: 'completed' };
  feedResult: FeedSteerOutcome = { outcome: 'consumed' };
  shouldThrow = false;
  driveCalls = 0;
  feedCalls = 0;
  settleCalls: string[] = [];
  lastUuid?: string;
  lastContent?: unknown;
  lastParentToolUseId?: string | null;
  lastAlreadyConsumed = false;

  async driveDeliveryTurn(
    uuid: string,
    content: unknown,
    parentToolUseId?: string | null,
    alreadyConsumed = false
  ): Promise<DriveTurnOutcome> {
    this.driveCalls++;
    this.lastUuid = uuid;
    this.lastContent = content;
    this.lastParentToolUseId = parentToolUseId;
    this.lastAlreadyConsumed = alreadyConsumed;
    if (this.shouldThrow) throw new Error('turn exploded');
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
}

function turnJob(repo: JobQueueRepository, uuid: string): Job {
  deliverMessage(repo, SESSION, uuid, { origin: 'chat' });
  const [job] = repo.dequeue(MESSAGE_DELIVERY, 1);
  return job!;
}

function steerJob(repo: JobQueueRepository, uuid: string): Job {
  // A turn existed when the steer was enqueued (forcing role:'steer'), but it
  // ended before the steer was claimed — the promote condition. Claim + complete
  // the anchor turn so the slot is free when the steer is processed.
  deliverMessage(repo, SESSION, `${uuid}-turn-anchor`, { origin: 'chat' });
  deliverMessage(repo, SESSION, uuid, { origin: 'chat' }); // → steer
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
    // The job is back to pending (parked), NOT completed.
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
    // The processor would then fail() → backoff. The job stays processing here
    // (the processor owns the fail()).
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
    // The SAME job was converted to a pending turn IN PLACE (requeueAs) — no
    // second job, so no crash-window double-deliver.
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

// ── Status-aware delivery (§8: #2592 consumed-kickoff, #2597 defer, #3742616723 archive) ─

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
    expect(session.lastAlreadyConsumed).toBe(true); // ← the guard: no re-feed
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
    expect(after?.status).toBe('pending'); // parked, not completed
    // Delayed runAt (not Date.now()) — this is what breaks the every-poll hot loop.
    expect(after?.runAt ?? 0).toBeGreaterThan(before);
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

// ── Repo: exempt dequeue + shutdown requeue (#2587 / #2593) ─────────────────

describe('repo — exempt dequeue + requeueAllProcessing (#2587/#2593)', () => {
  let db: Database;
  let repo: JobQueueRepository;

  beforeEach(() => {
    ({ db, repo } = setupRepo());
  });
  afterEach(() => db.close());

  it('dequeue(exclude) claims turns but leaves steers; dequeueExempt claims steers', () => {
    const steerSpec = { path: '$.role', equals: 'steer' };
    deliverMessage(repo, SESSION, 'turn-1', { origin: 'chat' }); // turn
    deliverMessage(repo, SESSION, 'steer-1', { origin: 'chat' }); // steer
    // Capped dequeue excludes steers → claims only the turn.
    const capped = repo.dequeue(MESSAGE_DELIVERY, 10, steerSpec);
    expect(capped).toHaveLength(1);
    expect((capped[0].payload as { role: string }).role).toBe('turn');
    // Exempt dequeue claims the steer that was left behind.
    const exempt = repo.dequeueExempt(MESSAGE_DELIVERY, steerSpec, 10);
    expect(exempt).toHaveLength(1);
    expect((exempt[0].payload as { role: string }).role).toBe('steer');
  });

  it('dequeue(exclude) is a no-op filter for lanes without an exempt spec', () => {
    // No exclude → claims everything (backward compatible).
    deliverMessage(repo, SESSION, 'a', { origin: 'chat' });
    deliverMessage(repo, SESSION, 'b', { origin: 'chat' });
    const claimed = repo.dequeue(MESSAGE_DELIVERY, 10);
    expect(claimed).toHaveLength(2);
  });

  it('requeueAllProcessing returns every processing job to pending (runAt, no heartbeat) (#2593)', () => {
    deliverMessage(repo, SESSION, 'a', { origin: 'chat' });
    deliverMessage(repo, SESSION, 'b', { origin: 'chat' });
    deliverMessage(repo, 'other-session', 'c', { origin: 'chat' });
    repo.dequeue(MESSAGE_DELIVERY, 10); // claim all → processing
    const runAt = Date.now();
    const n = repo.requeueAllProcessing(MESSAGE_DELIVERY, runAt);
    expect(n).toBe(3);
    const all = repo.listJobs({ queue: MESSAGE_DELIVERY, limit: 50 });
    expect(
      all.every((j) => j.status === 'pending' && j.runAt === runAt && j.startedAt === null)
    ).toBe(true);
  });

  it('cancelForSession deletes pending+processing jobs for the session, leaves others (#3672)', () => {
    deliverMessage(repo, SESSION, 'a', { origin: 'chat' }); // turn (pending)
    deliverMessage(repo, SESSION, 'b', { origin: 'chat' }); // steer (pending)
    deliverMessage(repo, 'other-session', 'c', { origin: 'chat' }); // other session
    repo.dequeue(MESSAGE_DELIVERY, 1); // claim the turn 'a' → processing
    const n = repo.cancelForSession(SESSION);
    expect(n).toBe(2); // 'a' (processing) + 'b' (pending)
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

// ── Processor: exempt pass + dead-letter hook (#2587 / #2595) ───────────────

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
        if (role === 'turn') await turnBlocked; // hold the one capped slot
        return { ok: true };
      },
      { exemptJobs: { path: '$.role', equals: 'steer' } }
    );

    deliverMessage(repo, SESSION, 't', { origin: 'chat' }); // turn
    deliverMessage(repo, SESSION, 's', { origin: 'chat' }); // steer (turn active)
    await processor.tick();
    // Both handlers were invoked during tick: the turn holds the sole capped
    // slot, yet the steer STILL ran via the exempt pass — the #2587 headline.
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
    await new Promise((r) => setTimeout(r, 5)); // let the fire-and-forget fail + onDead fire
    expect(dead).toHaveLength(1);
    expect(dead[0].status).toBe('dead');
    await processor.stop();
  });
});

describe('delivery consumption signal (long-horizon delivered = consumed)', () => {
  it('waitForDeliveryConsumption resolves when signalDeliveryConsumed fires for the UUID', async () => {
    let resolved = false;
    const handle = waitForDeliveryConsumption('consume-1');
    void handle.promise.then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    signalDeliveryConsumed('consume-1');
    await Promise.resolve(); // flush the resolution microtask
    expect(resolved).toBe(true);
  });

  it('cancel() removes the waiter so a later signal does not resolve it', async () => {
    let resolved = false;
    const handle = waitForDeliveryConsumption('consume-2');
    void handle.promise.then(() => {
      resolved = true;
    });
    handle.cancel();
    signalDeliveryConsumed('consume-2'); // no waiter left — must not resolve
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it('signalDeliveryConsumed is a no-op when no waiter is armed (e.g. consumption before any caller registers)', () => {
    expect(() => signalDeliveryConsumed('consume-orphan')).not.toThrow();
  });

  it('multiple waiters for the same UUID all resolve on one signal', async () => {
    let a = false;
    let b = false;
    void waitForDeliveryConsumption('consume-3').promise.then(() => {
      a = true;
    });
    void waitForDeliveryConsumption('consume-3').promise.then(() => {
      b = true;
    });
    signalDeliveryConsumed('consume-3');
    await Promise.resolve();
    expect(a).toBe(true);
    expect(b).toBe(true);
  });
});
