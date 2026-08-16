/**
 * Tests for the longHorizonAgentReminder.fire scanner handler.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  backfillLongHorizonAgentReminderNextRunAt,
  enqueueLongHorizonAgentReminderScanIfMissing,
  handleLongHorizonAgentReminderFire,
  type ReminderOccurrenceDeliveryState,
} from '../../../../src/lib/job-handlers/long-horizon-agent-reminder-fire.handler';
import { LONG_HORIZON_AGENT_REMINDER_FIRE } from '../../../../src/lib/job-queue-constants';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

interface DeliverArgs {
  spaceId: string;
  agentId: string;
  message: string;
  idempotencyKey: string;
}

function makeJob(): Job {
  return {
    id: 'job-1',
    queue: LONG_HORIZON_AGENT_REMINDER_FIRE,
    status: 'processing',
    payload: {},
    result: null,
    error: null,
    priority: 0,
    maxRetries: 3,
    retryCount: 0,
    runAt: Date.now(),
    createdAt: Date.now(),
    startedAt: Date.now(),
    completedAt: null,
  };
}

function recordingDeliver() {
  const calls: DeliverArgs[] = [];
  const fn = async (args: DeliverArgs): Promise<{ delivered: boolean }> => {
    calls.push(args);
    return { delivered: true };
  };
  return { calls, fn };
}

describe('handleLongHorizonAgentReminderFire', () => {
  let db: Database;
  let reminderRepo: SpaceLongHorizonAgentRepository;
  let spaceRepo: SpaceRepository;
  let jobQueue: JobQueueRepository;
  let spaceId: string;
  let agentId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    // job_queue is not created by createSpaceTables.
    db.exec(`
			CREATE TABLE IF NOT EXISTS job_queue (
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
			CREATE INDEX IF NOT EXISTS idx_job_queue_dequeue ON job_queue(queue, status, priority DESC, run_at ASC);
		`);

    spaceRepo = new SpaceRepository(db as never);
    reminderRepo = new SpaceLongHorizonAgentRepository(db);
    jobQueue = new JobQueueRepository(db as never);

    const space = spaceRepo.createSpace({
      slug: 'test',
      workspacePath: '/workspace/test',
      name: 'Test',
      description: 'Test space',
    });
    spaceId = space.id;
    const agent = reminderRepo.create({ spaceId, handle: 'steward', displayName: 'Steward' });
    agentId = agent.id;
  });

  afterEach(() => {
    db.close();
  });

  function makeDeps(
    deliver: (args: DeliverArgs) => Promise<{ delivered: boolean }>,
    getOccurrenceDeliveryState?: (
      spaceId: string,
      agentId: string,
      idempotencyKey: string
    ) => ReminderOccurrenceDeliveryState,
    deliveryTimeoutMs?: number
  ) {
    return {
      reminderRepo,
      spaceRepo,
      jobQueue,
      deliver,
      getOccurrenceDeliveryState,
      deliveryTimeoutMs,
    };
  }

  it('fires a due one-shot reminder, delivers the body, and marks it fired', async () => {
    const now = Date.now();
    const reminder = reminderRepo.createReminder({
      spaceId,
      agentId,
      title: 'Review goals',
      body: 'Check their statuses.',
      triggerType: 'at',
      runAt: now - 1000,
      nextRunAt: now - 1000,
    });

    const deliver = recordingDeliver();
    const result = await handleLongHorizonAgentReminderFire(makeJob(), makeDeps(deliver.fn));

    expect(result.fired).toBe(1);
    expect(result.scanned).toBe(1);
    expect(deliver.calls).toHaveLength(1);
    expect(deliver.calls[0].agentId).toBe(agentId);
    expect(deliver.calls[0].message).toContain('Review goals');
    expect(deliver.calls[0].message).toContain('Check their statuses.');
    expect(deliver.calls[0].idempotencyKey).toBe(`reminder:${reminder.id}:${now - 1000}`);

    const after = reminderRepo.getReminder(reminder.id)!;
    expect(after.status).toBe('fired');
    expect(after.nextRunAt).toBeNull();
    expect(after.lastFiredAt).not.toBeNull();
  });

  it('advances a cron reminder next_run_at and re-fires when it next comes due', async () => {
    const before = Date.now();
    const reminder = reminderRepo.createReminder({
      spaceId,
      agentId,
      title: 'Weekly review',
      triggerType: 'cron',
      cronExpression: '0 9 * * 1',
      nextRunAt: before - 1000,
    });

    const deliver = recordingDeliver();
    const r1 = await handleLongHorizonAgentReminderFire(makeJob(), makeDeps(deliver.fn));
    expect(r1.fired).toBe(1);

    const after1 = reminderRepo.getReminder(reminder.id)!;
    expect(after1.status).toBe('active');
    expect(after1.nextRunAt).not.toBeNull();
    expect(after1.nextRunAt!).toBeGreaterThan(before);

    // next_run_at is now in the future -> not due, does not re-fire.
    deliver.calls.length = 0;
    const r2 = await handleLongHorizonAgentReminderFire(makeJob(), makeDeps(deliver.fn));
    expect(r2.fired).toBe(0);
    expect(deliver.calls).toHaveLength(0);

    // Simulate time passing: next_run_at laps into the past -> fires again.
    db.prepare('UPDATE space_long_horizon_agent_reminders SET next_run_at = ? WHERE id = ?').run(
      Date.now() - 1000,
      reminder.id
    );
    const r3 = await handleLongHorizonAgentReminderFire(makeJob(), makeDeps(deliver.fn));
    expect(r3.fired).toBe(1);
    expect(deliver.calls).toHaveLength(1);
  });

  it('skips a paused agent reminder without delivering', async () => {
    const now = Date.now();
    const pausedAgent = reminderRepo.create({
      spaceId,
      handle: 'paused',
      displayName: 'Paused',
      status: 'paused',
    });
    reminderRepo.createReminder({
      spaceId,
      agentId: pausedAgent.id,
      title: 'should not fire',
      triggerType: 'at',
      runAt: now - 1000,
      nextRunAt: now - 1000,
    });

    const deliver = recordingDeliver();
    const result = await handleLongHorizonAgentReminderFire(makeJob(), makeDeps(deliver.fn));

    // The due-query filters paused owners out, so it is never selected.
    expect(result.scanned).toBe(0);
    expect(result.fired).toBe(0);
    expect(deliver.calls).toHaveLength(0);
  });

  it('does not advance when delivery reports not delivered', async () => {
    const now = Date.now();
    const reminder = reminderRepo.createReminder({
      spaceId,
      agentId,
      title: 'maybe paused',
      triggerType: 'cron',
      cronExpression: '0 9 * * 1',
      nextRunAt: now - 1000,
    });
    const noDeliver = async (): Promise<{ delivered: boolean }> => ({ delivered: false });

    const result = await handleLongHorizonAgentReminderFire(makeJob(), makeDeps(noDeliver));

    expect(result.skipped).toBe(1);
    expect(result.fired).toBe(0);
    // Stays active and still due — fires when the agent is active again.
    const after = reminderRepo.getReminder(reminder.id)!;
    expect(after.status).toBe('active');
    expect(after.nextRunAt).toBe(now - 1000);
    expect(after.lastFiredAt).toBeNull();
  });

  it('does not double-fire when a previous scan already advanced the reminder', async () => {
    const now = Date.now();
    const reminder = reminderRepo.createReminder({
      spaceId,
      agentId,
      title: 'race',
      triggerType: 'cron',
      cronExpression: '0 9 * * 1',
      nextRunAt: now - 1000,
    });

    const deliver = recordingDeliver();
    await handleLongHorizonAgentReminderFire(makeJob(), makeDeps(deliver.fn));
    expect(deliver.calls).toHaveLength(1);
    const advancedNext = reminderRepo.getReminder(reminder.id)!.nextRunAt!;
    expect(advancedNext).toBeGreaterThan(now);

    // A retried scan sees the reminder no longer due (next_run_at moved forward).
    deliver.calls.length = 0;
    const r2 = await handleLongHorizonAgentReminderFire(makeJob(), makeDeps(deliver.fn));
    expect(r2.fired).toBe(0);
    expect(deliver.calls).toHaveLength(0);
  });

  it('does not double-deliver when two scans overlap (in-process lock)', async () => {
    const now = Date.now();
    reminderRepo.createReminder({
      spaceId,
      agentId,
      title: 'contended',
      triggerType: 'at',
      runAt: now - 1000,
      nextRunAt: now - 1000,
    });

    const deliver = recordingDeliver();
    // Two scan jobs running concurrently (the processor has >1 slot).
    const [, r2] = await Promise.all([
      handleLongHorizonAgentReminderFire(makeJob(), makeDeps(deliver.fn)),
      handleLongHorizonAgentReminderFire(makeJob(), makeDeps(deliver.fn)),
    ]);

    // Only one scan delivers; the loser re-reads the advanced row and skips.
    expect(deliver.calls).toHaveLength(1);
    expect(r2.fired + r2.skipped).toBeGreaterThanOrEqual(1);
  });

  it('advances without re-injecting when the occurrence is already consumed', async () => {
    const now = Date.now();
    const reminder = reminderRepo.createReminder({
      spaceId,
      agentId,
      title: 'already-consumed',
      triggerType: 'at',
      runAt: now - 1000,
      nextRunAt: now - 1000,
    });

    const deliver = recordingDeliver();
    // Simulate a prior attempt whose message the SDK already consumed.
    const result = await handleLongHorizonAgentReminderFire(
      makeJob(),
      makeDeps(deliver.fn, () => 'consumed')
    );

    // Did not re-inject, but did advance (the occurrence was delivered).
    expect(deliver.calls).toHaveLength(0);
    expect(result.fired).toBe(1);
    const after = reminderRepo.getReminder(reminder.id)!;
    expect(after.status).toBe('fired');
    expect(after.nextRunAt).toBeNull();
  });

  it('bounds a stuck delivery with a per-call timeout (no slot deadlock)', async () => {
    const now = Date.now();
    const reminder = reminderRepo.createReminder({
      spaceId,
      agentId,
      title: 'stuck-sdk',
      triggerType: 'at',
      runAt: now - 1000,
      nextRunAt: now - 1000,
    });
    // A deliver that never settles — simulates a stuck SDK whose enqueueWithId
    // never resolves (onSent never fires after a wedged `for await`).
    const neverDeliver = (): Promise<{ delivered: boolean }> => new Promise(() => {});
    const start = Date.now();
    const result = await handleLongHorizonAgentReminderFire(
      makeJob(),
      makeDeps(neverDeliver, undefined, 50)
    );

    // Bounded by the 50ms timeout, not the 35s default — the lock and job slot
    // release, so the scanner can't be pinned.
    expect(Date.now() - start).toBeLessThan(2000);
    expect(result.failed).toBe(1);
    expect(result.fired).toBe(0);
    // Not advanced; stays due for retry next scan.
    const after = reminderRepo.getReminder(reminder.id)!;
    expect(after.status).toBe('active');
    expect(after.nextRunAt).toBe(now - 1000);
  });

  it('does not stack a second delivery while one is in flight (no amplification)', async () => {
    const now = Date.now();
    const reminder = reminderRepo.createReminder({
      spaceId,
      agentId,
      title: 'inflight',
      triggerType: 'at',
      runAt: now - 1000,
      nextRunAt: now - 1000,
    });
    // First scan: deliver never settles (stuck before persisting); the handler
    // times out (50ms) and returns failed, but the delivery stays registered.
    const neverDeliver = (): Promise<{ delivered: boolean }> => new Promise(() => {});
    const r1 = await handleLongHorizonAgentReminderFire(
      makeJob(),
      makeDeps(neverDeliver, undefined, 50)
    );
    expect(r1.failed).toBe(1);

    // Second scan: the prior delivery is still in flight -> skip without
    // starting another deliver (no stacking / amplification).
    const deliver2 = recordingDeliver();
    const r2 = await handleLongHorizonAgentReminderFire(
      makeJob(),
      makeDeps(deliver2.fn, undefined, 50)
    );
    expect(r2.skipped).toBe(1);
    expect(deliver2.calls).toHaveLength(0);
  });

  it('a rejecting deliver returns failed without an unhandled rejection (no daemon crash)', async () => {
    const now = Date.now();
    const reminder = reminderRepo.createReminder({
      spaceId,
      agentId,
      title: 'rejects',
      triggerType: 'at',
      runAt: now - 1000,
      nextRunAt: now - 1000,
    });
    // The daemon treats unhandled rejections as fatal (process.exit(1) in
    // main.ts). The in-flight cleanup must attach a rejection handler so a
    // rejecting deliver doesn't surface as one.
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const rejectDeliver = async (): Promise<{ delivered: boolean }> => {
        throw new Error('deliver boom');
      };
      const result = await handleLongHorizonAgentReminderFire(
        makeJob(),
        makeDeps(rejectDeliver, undefined, 5000)
      );
      expect(result.failed).toBe(1);
      // Drain the microtask/macrotask queue so any unhandled rejection surfaces.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('defers (skips without advancing) when the occurrence is enqueued but not consumed', async () => {
    const now = Date.now();
    const reminder = reminderRepo.createReminder({
      spaceId,
      agentId,
      title: 'stuck-enqueued',
      triggerType: 'at',
      runAt: now - 1000,
      nextRunAt: now - 1000,
    });

    const deliver = recordingDeliver();
    // Prior attempt persisted the row but the SDK hasn't consumed it (e.g. a
    // stuck session that timed out on enqueue).
    const result = await handleLongHorizonAgentReminderFire(
      makeJob(),
      makeDeps(deliver.fn, () => 'enqueued')
    );

    // No re-inject (no duplicate) AND no advance (one-shot not marked fired
    // before delivery). Stays due for the next scan to re-check.
    expect(deliver.calls).toHaveLength(0);
    expect(result.fired).toBe(0);
    expect(result.skipped).toBe(1);
    const after = reminderRepo.getReminder(reminder.id)!;
    expect(after.status).toBe('active');
    expect(after.nextRunAt).toBe(now - 1000);
  });

  it('skips a reminder whose owning space is paused', async () => {
    const now = Date.now();
    reminderRepo.createReminder({
      spaceId,
      agentId,
      title: 'paused-space',
      triggerType: 'at',
      runAt: now - 1000,
      nextRunAt: now - 1000,
    });
    // Pause the space after creation.
    db.prepare('UPDATE spaces SET paused = 1 WHERE id = ?').run(spaceId);

    const deliver = recordingDeliver();
    const result = await handleLongHorizonAgentReminderFire(makeJob(), makeDeps(deliver.fn));

    // Filtered at the due-query (not even selected) and skipped at delivery.
    expect(result.scanned).toBe(0);
    expect(result.fired).toBe(0);
    expect(deliver.calls).toHaveLength(0);
  });

  it('skips when the space is stopped between select and fire', async () => {
    const now = Date.now();
    reminderRepo.createReminder({
      spaceId,
      agentId,
      title: 'stop-mid-scan',
      triggerType: 'at',
      runAt: now - 1000,
      nextRunAt: now - 1000,
    });

    // The deliver hook stops the space right before injection, exercising the
    // handler-level space recheck (the due-query already passed).
    const stopAndDeny = async (): Promise<{ delivered: boolean }> => {
      db.prepare('UPDATE spaces SET stopped = 1 WHERE id = ?').run(spaceId);
      return { delivered: false };
    };
    const result = await handleLongHorizonAgentReminderFire(makeJob(), makeDeps(stopAndDeny));

    expect(result.fired).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it('self-schedules the next scan job', async () => {
    const deliver = recordingDeliver();
    const result = await handleLongHorizonAgentReminderFire(makeJob(), makeDeps(deliver.fn));
    expect(result.nextScanAt).toBeGreaterThan(Date.now());
    const pending = jobQueue.listJobs({
      queue: LONG_HORIZON_AGENT_REMINDER_FIRE,
      status: 'pending',
      limit: 5,
    });
    expect(pending.length).toBeGreaterThanOrEqual(1);
  });
});

describe('enqueueLongHorizonAgentReminderScanIfMissing', () => {
  let db: Database;
  let jobQueue: JobQueueRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    db.exec(`
			CREATE TABLE IF NOT EXISTS job_queue (
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
			CREATE INDEX IF NOT EXISTS idx_job_queue_dequeue ON job_queue(queue, status, priority DESC, run_at ASC);
		`);
    jobQueue = new JobQueueRepository(db as never);
  });

  afterEach(() => {
    db.close();
  });

  it('is idempotent — does not enqueue a second pending scan', () => {
    enqueueLongHorizonAgentReminderScanIfMissing(jobQueue, Date.now() + 1000);
    enqueueLongHorizonAgentReminderScanIfMissing(jobQueue, Date.now() + 2000);
    const pending = jobQueue.listJobs({
      queue: LONG_HORIZON_AGENT_REMINDER_FIRE,
      status: 'pending',
      limit: 5,
    });
    expect(pending).toHaveLength(1);
  });
});

describe('backfillLongHorizonAgentReminderNextRunAt', () => {
  let db: Database;
  let reminderRepo: SpaceLongHorizonAgentRepository;
  let spaceId: string;
  let agentId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    const spaceRepo = new SpaceRepository(db as never);
    reminderRepo = new SpaceLongHorizonAgentRepository(db);
    const space = spaceRepo.createSpace({
      slug: 'test',
      workspacePath: '/workspace/test',
      name: 'Test',
      description: 'Test space',
    });
    spaceId = space.id;
    agentId = reminderRepo.create({ spaceId, handle: 'steward', displayName: 'Steward' }).id;
  });

  afterEach(() => {
    db.close();
  });

  it('seeds next_run_at for pre-existing reminders with a NULL value', () => {
    const past = Date.now() - 60_000;
    // 'at' reminder created before the seed fix (NULL next_run_at).
    const atReminder = reminderRepo.createReminder({
      spaceId,
      agentId,
      title: 'legacy-at',
      triggerType: 'at',
      runAt: past,
    });
    // cron reminder created before the seed fix (NULL next_run_at).
    const cronReminder = reminderRepo.createReminder({
      spaceId,
      agentId,
      title: 'legacy-cron',
      triggerType: 'cron',
      cronExpression: '0 9 * * 1',
    });
    expect(atReminder.nextRunAt).toBeNull();
    expect(cronReminder.nextRunAt).toBeNull();

    const count = backfillLongHorizonAgentReminderNextRunAt(reminderRepo);

    expect(count).toBe(2);
    const atAfter = reminderRepo.getReminder(atReminder.id)!;
    const cronAfter = reminderRepo.getReminder(cronReminder.id)!;
    expect(atAfter.nextRunAt).toBe(past); // 'at' falls back to run_at
    expect(cronAfter.nextRunAt).not.toBeNull();
    expect(cronAfter.nextRunAt!).toBeGreaterThan(Date.now()); // next cron occurrence

    // Both are now schedulable (the 'at' one is immediately due).
    const due = reminderRepo.listDueReminders(past + 1000).map((r) => r.id);
    expect(due).toContain(atReminder.id);
  });

  it('is idempotent — no-op when no NULL rows remain', () => {
    reminderRepo.createReminder({
      spaceId,
      agentId,
      title: 'already-seeded',
      triggerType: 'at',
      runAt: Date.now() - 1000,
      nextRunAt: Date.now() - 1000,
    });
    expect(backfillLongHorizonAgentReminderNextRunAt(reminderRepo)).toBe(0);
  });

  it('backfills paused-agent reminders too (gated at fire time, not backfill)', () => {
    const pausedAgent = reminderRepo.create({
      spaceId,
      handle: 'paused',
      displayName: 'Paused',
      status: 'paused',
    });
    const reminder = reminderRepo.createReminder({
      spaceId,
      agentId: pausedAgent.id,
      title: 'paused-owner',
      triggerType: 'at',
      runAt: Date.now() - 1000,
    });
    expect(reminder.nextRunAt).toBeNull();

    const count = backfillLongHorizonAgentReminderNextRunAt(reminderRepo);

    expect(count).toBe(1);
    expect(reminderRepo.getReminder(reminder.id)!.nextRunAt).not.toBeNull();
  });

  it('skips unschedulable reminders instead of firing them immediately', () => {
    // Legacy cron reminder with no expression, and a legacy 'at' with no
    // run_at — both unschedulable. Must be left NULL, not defaulted to `now`.
    const cronNoExpr = reminderRepo.createReminder({
      spaceId,
      agentId,
      title: 'cron-no-expr',
      triggerType: 'cron',
    });
    const atNoRunAt = reminderRepo.createReminder({
      spaceId,
      agentId,
      title: 'at-no-runat',
      triggerType: 'at',
    });
    expect(cronNoExpr.nextRunAt).toBeNull();
    expect(atNoRunAt.nextRunAt).toBeNull();

    const count = backfillLongHorizonAgentReminderNextRunAt(reminderRepo);

    expect(count).toBe(0);
    expect(reminderRepo.getReminder(cronNoExpr.id)!.nextRunAt).toBeNull();
    expect(reminderRepo.getReminder(atNoRunAt.id)!.nextRunAt).toBeNull();
  });
});
