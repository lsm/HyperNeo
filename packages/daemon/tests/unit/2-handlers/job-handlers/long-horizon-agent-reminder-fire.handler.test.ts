/**
 * Tests for the longHorizonAgentReminder.fire scanner handler.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  enqueueLongHorizonAgentReminderScanIfMissing,
  handleLongHorizonAgentReminderFire,
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

  function makeDeps(deliver: (args: DeliverArgs) => Promise<{ delivered: boolean }>) {
    return { reminderRepo, spaceRepo, jobQueue, deliver };
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
