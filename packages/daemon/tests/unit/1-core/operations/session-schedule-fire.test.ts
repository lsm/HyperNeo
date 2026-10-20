import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { SessionScheduler } from '../../../../src/lib/scheduler/session-schedules';
import { createSessionScheduleFire } from '../../../../src/lib/scheduler/session-schedule-fire';
import type { WorkStatus } from '../../../../src/lib/drivers/types';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import { Database } from '../../../../src/storage/sqlite-compat';
import type { SessionSchedule } from '../../../../src/storage/repositories/session-schedule-repository';

describe('session schedule firing', () => {
  let db: Database;
  let scheduler: SessionScheduler;
  let jobs: JobQueueRepository;
  let status: WorkStatus;
  let digest: string;
  let gone: boolean;
  let deliveries: { id: string; text: string }[];
  let clock: ReturnType<typeof spyOn>;
  let now: number;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    jobs = new JobQueueRepository(db);
    scheduler = new SessionScheduler(db, jobs);
    now = Date.now();
    clock = spyOn(Date, 'now').mockImplementation(() => now);
    status = 'done';
    digest = 'a';
    gone = false;
    deliveries = [];
    scheduler.registerSource({
      kind: 'goal',
      facts: async () => (gone ? null : { digest, summary: 'Goal changed' }),
      message: (_id, change) => (change.nudge ? 'Nothing moved: check in' : change.summary),
    });
  });
  afterEach(() => {
    clock.mockRestore();
    db.close();
  });
  const create = (kind = 'goal', nudgeEvery = 3) =>
    scheduler.create({
      target: { adapter: 'hyperneo', id: 'recipient' },
      sourceKind: kind,
      sourceId: 'source',
      note: 'Read the checklist',
      cadence: { kind: 'every', everyMs: 60000 },
      nudgeEvery,
      createdBySession: null,
    });
  const deps = () => ({
    scheduler,
    status: async () => status,
    deliver: async (_schedule: SessionSchedule, id: string, text: string) => {
      deliveries.push({ id, text });
    },
  });
  const fire = async (id: string) => {
    const row = scheduler.repo.get(id)!;
    now = row.nextRunAt!;
    await createSessionScheduleFire(deps())(jobs.getJob(row.pendingJobId!)!);
    return scheduler.repo.get(id)!;
  };
  test('changed facts fire once, unchanged facts wait until the nudge, and changes fire immediately', async () => {
    const initial = create();
    const first = await fire(initial.id);
    expect(first).toMatchObject({
      lastOutcome: 'fired',
      dueCount: 0,
      factsDigest: 'a',
      lastSkipReason: null,
    });
    expect(deliveries).toEqual([
      { id: `schedule:${initial.id}:${initial.nextRunAt}`, text: 'Goal changed' },
    ]);
    expect(await fire(initial.id)).toMatchObject({ lastOutcome: 'skipped_unchanged', dueCount: 1 });
    await fire(initial.id);
    expect(await fire(initial.id)).toMatchObject({ lastOutcome: 'fired', dueCount: 0 });
    expect(deliveries[1].text).toBe('Nothing moved: check in');
    digest = 'b';
    expect(await fire(initial.id)).toMatchObject({ lastOutcome: 'fired', factsDigest: 'b' });
  });
  test.each(['running', 'queued', 'stopped', 'needs_you'] as const)(
    '%s skips to a future cadence, counts each due, then nudges when idle',
    async (busy) => {
      const row = create();
      await fire(row.id);
      status = busy;
      for (let i = 1; i <= 4; i++) {
        const skipped = await fire(row.id);
        expect(skipped).toMatchObject({
          lastOutcome: busy === 'needs_you' ? 'skipped_needs_you' : 'skipped_busy',
          dueCount: i,
        });
        expect(skipped.nextRunAt).toBe(now + 60000);
      }
      expect(deliveries).toHaveLength(1);
      status = 'done';
      expect(await fire(row.id)).toMatchObject({ lastOutcome: 'fired', dueCount: 0 });
      expect(deliveries).toHaveLength(2);
    }
  );
  test('a reminder delivers its note every due run', async () => {
    const row = create('reminder', 1);
    await fire(row.id);
    await fire(row.id);
    expect(deliveries.map((d) => d.text)).toEqual(['Read the checklist', 'Read the checklist']);
  });
  test('a deleted source completes the schedule without another job', async () => {
    const row = create();
    gone = true;
    expect(await fire(row.id)).toMatchObject({
      status: 'done',
      pendingJobId: null,
      nextRunAt: null,
      lastOutcome: 'source_gone',
    });
    expect(deliveries).toEqual([]);
  });
  test('pause while facts are loading prevents delivery and cannot resurrect the schedule', async () => {
    const row = create();
    scheduler.registerSource({
      kind: 'goal',
      facts: async () => {
        scheduler.pause(scheduler.repo.get(row.id)!);
        return { digest, summary: 'Changed' };
      },
      message: (_id, change) => change.summary,
    });
    expect(await fire(row.id)).toMatchObject({ status: 'paused', pendingJobId: null });
    expect(deliveries).toEqual([]);
  });
  test('retrying a failed delivery counts the due once and keeps the same idempotency key', async () => {
    const row = create();
    const job = jobs.getJob(row.pendingJobId!)!;
    now = row.nextRunAt!;
    const handler = createSessionScheduleFire({
      ...deps(),
      deliver: async () => {
        throw new Error('offline');
      },
    });
    await expect(handler(job)).rejects.toThrow('offline');
    now += 1000;
    await expect(handler(job)).rejects.toThrow('offline');
    expect(scheduler.repo.get(row.id)?.dueCount).toBe(1);
    await createSessionScheduleFire(deps())(job);
    expect(deliveries[0].id).toBe(`schedule:${row.id}:${row.nextRunAt}`);
    await createSessionScheduleFire(deps())(job);
    expect(deliveries).toHaveLength(1);
  });
});
