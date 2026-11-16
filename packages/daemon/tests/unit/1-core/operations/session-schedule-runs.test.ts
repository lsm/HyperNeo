import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { createTestSession } from '../../../helpers/database';
import { SessionScheduler } from '../../../../src/lib/scheduler/session-schedules';
import { createSessionScheduleFire } from '../../../../src/lib/scheduler/session-schedule-fire';
import { createSessionScheduleOperations } from '../../../../src/lib/scheduler/operations';
import { NEO_RARE_OPERATION_NAMES } from '../../../../src/lib/operations/neo-discovery';
import type { WorkStatus } from '../../../../src/lib/drivers/types';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import { Database } from '../../../../src/storage/sqlite-compat';

describe('schedule.session.runs', () => {
  let db: Database;
  let scheduler: SessionScheduler;
  let jobs: JobQueueRepository;
  let status: WorkStatus | 'not_found';
  let gone: boolean;
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
    gone = false;
    scheduler.registerSource({
      kind: 'goal',
      facts: async () => (gone ? null : { digest: 'a', summary: 'Goal changed' }),
      message: (_id, change) => change.summary,
    });
  });
  afterEach(() => {
    clock.mockRestore();
    db.close();
  });
  const create = (sourceId: string) =>
    scheduler.create({
      target: { adapter: 'hyperneo', id: 'recipient' },
      sourceKind: 'goal',
      sourceId,
      note: 'Read the checklist',
      cadence: { kind: 'every', everyMs: 60000 },
      nudgeEvery: 1,
      createdBySession: null,
    });
  const fire = async (id: string) => {
    const row = scheduler.repo.get(id)!;
    now = row.nextRunAt!;
    await createSessionScheduleFire({
      scheduler,
      status: async () => status,
      deliver: async () => {},
    })(jobs.getJob(row.pendingJobId!)!);
    return row.nextRunAt!;
  };
  const runs = async (scheduleId: string) => {
    const op = createSessionScheduleOperations(scheduler).find(
      (operation) => operation.name === 'schedule.session.runs'
    );
    return op?.execute({ scheduleId }, { source: 'internal', role: 'neo' });
  };

  test('every firing leaves one run with its outcome, newest first', async () => {
    const row = create('kept');
    const fired = await fire(row.id);
    const unchanged = await fire(row.id);
    status = 'running';
    const busy = await fire(row.id);
    status = 'needs_you';
    const needsYou = await fire(row.id);
    status = 'not_found';
    const targetGone = await fire(row.id);

    expect(await runs(row.id)).toEqual({
      ok: true,
      runs: [
        {
          dueAt: targetGone,
          firedAt: targetGone,
          outcome: 'target_gone',
          skipReason: null,
          messageId: null,
        },
        {
          dueAt: needsYou,
          firedAt: needsYou,
          outcome: 'skipped_needs_you',
          skipReason: 'needs_you',
          messageId: null,
        },
        {
          dueAt: busy,
          firedAt: busy,
          outcome: 'skipped_busy',
          skipReason: 'busy',
          messageId: null,
        },
        {
          dueAt: unchanged,
          firedAt: unchanged,
          outcome: 'skipped_unchanged',
          skipReason: 'unchanged',
          messageId: null,
        },
        {
          dueAt: fired,
          firedAt: fired,
          outcome: 'fired',
          skipReason: null,
          messageId: `schedule:${row.id}:${fired}`,
        },
      ],
    });
  });

  test('a firing whose source is gone leaves a run', async () => {
    const row = create('removed');
    gone = true;
    const due = await fire(row.id);

    expect(await runs(row.id)).toEqual({
      ok: true,
      runs: [
        { dueAt: due, firedAt: due, outcome: 'source_gone', skipReason: null, messageId: null },
      ],
    });
  });

  test('an unknown schedule is refused', async () => {
    expect(await runs('missing')).toEqual({ ok: false, reason: 'not_found: no such schedule.' });
  });

  test('the Neo catalog names the operation', () => {
    expect(NEO_RARE_OPERATION_NAMES as readonly string[]).toContain('schedule.session.runs');
  });
});
