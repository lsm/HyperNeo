import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createSessionScheduleOperations } from '../../../../src/lib/scheduler/operations';
import { SessionGoalSchedules } from '../../../../src/lib/goals/session-goal-schedules';
import { SessionGoalRepository } from '../../../../src/storage/repositories/session-goal-repository';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository';
import { SessionScheduler } from '../../../../src/lib/scheduler/session-schedules';
import { SESSION_SCHEDULE_FIRE } from '../../../../src/lib/job-queue-constants';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import { Database } from '../../../../src/storage/sqlite-compat';

const neo: OperationCaller = { source: 'mcp', sessionId: 'neo:root', role: 'neo' };
const human: OperationCaller = { source: 'rpc', principal: 'local' };
const worker: OperationCaller = { source: 'mcp', sessionId: 'worker-1' };
const target = { adapter: 'hyperneo', id: 'worker-1' };
const hourly = { kind: 'every', everyMs: 3_600_000 };

describe('session schedules', () => {
  let db: Database;
  let jobs: JobQueueRepository;
  let scheduler: SessionScheduler;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    jobs = new JobQueueRepository(db);
    scheduler = new SessionScheduler(db, jobs);
  });
  afterEach(() => db.close());

  const call = async (name: string, input: unknown, caller = neo) => {
    const outcome = await invokeOperation(
      createOperationRegistry(createSessionScheduleOperations(scheduler)),
      name,
      input,
      caller
    );
    return outcome.kind === 'completed' ? outcome.value : outcome;
  };
  const pending = () =>
    jobs.listJobs({ queue: SESSION_SCHEDULE_FIRE, status: ['pending'] }).map((job) => ({
      scheduleId: (job.payload as { scheduleId: string }).scheduleId,
      runAt: job.runAt,
    }));

  test('Neo schedules an hourly reminder for a session, and one wake is queued for the next hour', async () => {
    const before = Date.now();
    const created = (await call('schedule.session.create', {
      target,
      cadence: hourly,
      note: 'Check the release checklist.',
    })) as { ok: true; schedule: { id: string; status: string; nextRunAt: number } };
    expect(created).toMatchObject({
      ok: true,
      schedule: { status: 'active', note: 'Check the release checklist.', target },
    });
    expect(created.schedule.nextRunAt).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(pending()).toEqual([
      { scheduleId: created.schedule.id, runAt: created.schedule.nextRunAt },
    ]);
    expect(await call('schedule.session.list', { target })).toMatchObject({
      ok: true,
      schedules: [{ id: created.schedule.id }],
    });
    expect(
      await call('schedule.session.list', { target: { adapter: 'hyperneo', id: 'other' } })
    ).toEqual({ ok: true, schedules: [] });
  });

  test('the target list exposes the current goal title without collecting or committing facts', async () => {
    const goals = new SessionGoalRepository(db);
    const source = new SessionGoalSchedules(
      goals,
      new NeoAskTodoRepository(db),
      scheduler,
      () => []
    );
    scheduler.registerSource(source);
    const goal = goals.create(
      'worker-1',
      { title: 'Ship the guide', doneTest: 'Published' },
      'human',
      Date.now()
    );
    source.sync(goal);
    const facts = spyOn(source, 'facts');
    const storedBefore = scheduler.repo.list(target);
    expect(await call('schedule.session.list', { target }, human)).toMatchObject({
      ok: true,
      schedules: [{ sourceKind: 'goal', sourceId: goal.id, sourceLabel: 'Ship the guide' }],
    });
    goals.update(goal, { title: 'Publish the guide' }, 'human', Date.now());
    expect(await call('schedule.session.list', { target }, human)).toMatchObject({
      schedules: [{ sourceLabel: 'Publish the guide' }],
    });
    expect(facts).not.toHaveBeenCalled();
    expect(scheduler.repo.list(target)).toEqual(storedBefore);
    expect(goals.factState(goal.id).lines).toEqual([]);
  });

  test('labels use reminder text and leave an unavailable source unlabeled', async () => {
    await call('schedule.session.create', { target, cadence: hourly, note: 'Check the release.' });
    scheduler.create({
      target,
      sourceKind: 'removed-pack',
      sourceId: 'old-source',
      note: null,
      cadence: { kind: 'every', everyMs: 3_600_000 },
      nudgeEvery: 4,
      createdBySession: null,
    });
    expect(await call('schedule.session.list', { target }, human)).toMatchObject({
      ok: true,
      schedules: expect.arrayContaining([
        expect.objectContaining({ sourceKind: 'reminder', sourceLabel: 'Check the release.' }),
        expect.objectContaining({ sourceKind: 'removed-pack', sourceLabel: null }),
      ]),
    });
  });

  test('a cadence under a minute or a cron with no next run is refused', async () => {
    expect(
      await call('schedule.session.create', {
        target,
        cadence: { kind: 'every', everyMs: 1000 },
        note: 'x',
      })
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/^invalid_cadence/) });
    expect(
      await call('schedule.session.create', {
        target,
        cadence: { kind: 'cron', cron: 'not cron' },
        note: 'x',
      })
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/^invalid_cadence/) });
    expect(pending()).toEqual([]);
  });

  test('only Neo or the local user manages schedules', async () => {
    expect(
      await call('schedule.session.create', { target, cadence: hourly, note: 'x' }, worker)
    ).toEqual({ ok: false, reason: 'This action belongs to Neo or the user.' });
    expect(
      await call('schedule.session.create', { target, cadence: hourly, note: 'x' }, human)
    ).toMatchObject({ ok: true });
  });

  test('pause drops the queued wake, resume queues one from now, delete removes both', async () => {
    const { schedule } = (await call('schedule.session.create', {
      target,
      cadence: hourly,
      note: 'x',
    })) as { schedule: { id: string } };
    const scheduleId = schedule.id;
    expect(await call('schedule.session.pause', { scheduleId })).toMatchObject({
      schedule: { status: 'paused', pendingJobId: null },
    });
    expect(pending()).toEqual([]);
    expect(await call('schedule.session.pause', { scheduleId })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^wrong_status/),
    });
    expect(await call('schedule.session.resume', { scheduleId })).toMatchObject({
      schedule: { status: 'active' },
    });
    expect(pending()).toHaveLength(1);
    expect(await call('schedule.session.delete', { scheduleId })).toMatchObject({ ok: true });
    expect(pending()).toEqual([]);
    expect(await call('schedule.session.list', {})).toEqual({ ok: true, schedules: [] });
  });

  test('a source that asks for a cron with no future run is refused, and nothing is queued', () => {
    expect(() =>
      scheduler.create({
        target,
        sourceKind: 'goal',
        sourceId: 'g-past',
        note: null,
        cadence: { kind: 'cron', cron: '0 0 1 1 * 2001', timezone: 'UTC' },
        nudgeEvery: 4,
        createdBySession: null,
      })
    ).toThrow(/invalid_cadence/);
    expect(pending()).toEqual([]);
    expect(scheduler.repo.list()).toEqual([]);
  });

  test('a pause that loses the race with a fire reports busy and leaves the schedule active', () => {
    const read = scheduler.create({
      target,
      sourceKind: 'goal',
      sourceId: 'g-race',
      note: null,
      cadence: { kind: 'every', everyMs: 3_600_000 },
      nudgeEvery: 4,
      createdBySession: null,
    });
    const refired = jobs.enqueue({
      queue: SESSION_SCHEDULE_FIRE,
      payload: { scheduleId: read.id },
      runAt: Date.now() + 7_200_000,
    });
    scheduler.repo.setPending(read.id, read.pendingJobId, refired.id, refired.runAt);
    expect(scheduler.pause(read)).toBeNull();
    expect(scheduler.repo.get(read.id)).toMatchObject({
      status: 'active',
      pendingJobId: refired.id,
    });
  });

  test('startup recovery queues a wake for an active schedule whose job is gone, once', () => {
    const created = scheduler.create({
      target,
      sourceKind: 'goal',
      sourceId: 'g-1',
      note: null,
      cadence: { kind: 'every', everyMs: 3_600_000 },
      nudgeEvery: 4,
      createdBySession: null,
    });
    expect(
      scheduler.create({
        target,
        sourceKind: 'goal',
        sourceId: 'g-1',
        note: null,
        cadence: { kind: 'every', everyMs: 60_000 },
        nudgeEvery: 4,
        createdBySession: null,
      }).id
    ).toBe(created.id);
    jobs.deleteJob(created.pendingJobId as string);
    expect(pending()).toEqual([]);
    expect(scheduler.recover()).toBe(1);
    expect(scheduler.recover()).toBe(0);
    expect(pending()).toEqual([{ scheduleId: created.id, runAt: created.nextRunAt }]);
  });
});
