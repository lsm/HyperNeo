import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { createTestSession } from '../../../helpers/database';
import { SessionScheduler } from '../../../../src/lib/scheduler/session-schedules';
import { createSessionScheduleFire } from '../../../../src/lib/scheduler/session-schedule-fire';
import { createSessionScheduleOperations } from '../../../../src/lib/scheduler/operations';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import type { WorkStatus } from '../../../../src/lib/drivers/types';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('one-shot reminder cadence', () => {
  let db: Database;
  let scheduler: SessionScheduler;
  let jobs: JobQueueRepository;
  let status: WorkStatus;
  let sent: string[];
  let clock: ReturnType<typeof spyOn>;
  let now: number;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    new SessionRepository(db).createSession(createTestSession('recipient'));
    jobs = new JobQueueRepository(db);
    scheduler = new SessionScheduler(db, jobs);
    now = Date.now();
    clock = spyOn(Date, 'now').mockImplementation(() => now);
    status = 'done';
    sent = [];
  });
  afterEach(() => {
    clock.mockRestore();
    db.close();
  });
  const operations = () => createSessionScheduleOperations(scheduler);
  const create = async (at: number) => {
    const outcome = await invokeOperation(
      createOperationRegistry(operations()),
      'schedule.session.create',
      {
        target: { adapter: 'hyperneo', id: 'recipient' },
        cadence: { kind: 'once', at },
        note: 'Call the venue',
      },
      { source: 'internal', role: 'neo' }
    );
    return (outcome.kind === 'completed' ? outcome.value : outcome) as Record<string, any>;
  };
  const fire = async (id: string) => {
    const row = scheduler.repo.get(id)!;
    now = row.nextRunAt!;
    return createSessionScheduleFire({
      scheduler,
      status: async () => status,
      deliver: async (_schedule, _messageId, text) => {
        sent.push(text);
      },
    })(jobs.getJob(row.pendingJobId!)!);
  };
  const pending = (id: string) =>
    jobs.listActiveByPayload('sessionSchedule.fire', { scheduleId: id }).map((job) => job.id);

  test('delivers exactly one message at its time and then the schedule is done', async () => {
    const at = now + 3_600_000;
    const created = await create(at);
    expect(created).toMatchObject({ ok: true, schedule: { nextRunAt: at } });
    const id = created.schedule.id;
    const due = pending(id);

    expect(await fire(id)).toEqual({ outcome: 'fired' });

    expect(sent).toEqual(['Call the venue']);
    expect(scheduler.repo.get(id)).toMatchObject({
      status: 'done',
      pendingJobId: null,
      nextRunAt: null,
    });
    expect(pending(id)).toEqual(due);
  });

  test('a busy target gets the reminder once it is free, not dropped', async () => {
    const created = await create(now + 60_000);
    const id = created.schedule.id;
    status = 'running';

    expect(await fire(id)).toEqual({ outcome: 'skipped_busy' });
    expect(scheduler.repo.get(id)).toMatchObject({ status: 'active' });
    expect(sent).toEqual([]);

    status = 'done';
    expect(await fire(id)).toEqual({ outcome: 'fired' });
    expect(sent).toEqual(['Call the venue']);
    expect(scheduler.repo.get(id)?.status).toBe('done');
  });

  test('a time in the past is refused', async () => {
    expect(await create(now - 1)).toEqual({
      ok: false,
      reason: 'invalid_cadence: a one-shot time must be in the future.',
    });
  });

  test('the description says which cadences are fact-driven and which always fire', () => {
    const description = operations().find(
      (operation) => operation.name === 'schedule.session.create'
    )?.description;
    expect(description).toContain('every and cron are fact-driven');
    expect(description).toContain('once always fires');
  });
});
