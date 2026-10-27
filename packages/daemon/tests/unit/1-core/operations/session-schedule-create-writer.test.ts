import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createSessionScheduleOperations } from '../../../../src/lib/scheduler/operations';
import { SessionScheduler } from '../../../../src/lib/scheduler/session-schedules';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import {
  type SessionScheduleCadence,
  SessionScheduleRepository,
} from '../../../../src/storage/repositories/session-schedule-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database as SQLite } from '../../../../src/storage/sqlite-compat';

describe('ordinary session reminder writer', () => {
  let main: SQLite;
  let writer: SQLite;
  let gateway: DbGateway;
  let scheduler: SessionScheduler;
  let mainSql: number;
  const target = { adapter: 'hyperneo', id: 'synthetic-recipient' };
  const input = {
    target,
    cadence: { kind: 'every' as const, everyMs: 3_600_000 },
    note: 'Check progress',
  };

  beforeEach(() => {
    main = new SQLite(':memory:');
    writer = new SQLite(':memory:');
    runMigrations(writer, () => {});
    createTables(writer);
    gateway = new DbGateway(':memory:', writer);
    bindGateway(main, gateway);
    scheduler = new SessionScheduler(main, new JobQueueRepository(main));
    mainSql = 0;
    main.prepare = () => {
      mainSql++;
      throw new Error('schedule creation SQL reached main');
    };
  });

  afterEach(async () => {
    await gateway.close();
    main.close();
    writer.close();
  });

  const call = (draft: unknown = input, local = true) =>
    invokeOperation(
      createOperationRegistry(createSessionScheduleOperations(scheduler)),
      'schedule.session.create',
      draft,
      local ? { source: 'rpc', principal: 'local' } : { source: 'mcp', sessionId: 'worker' }
    );

  test('the operation receipt contains a committed schedule and matching wake without main SQL', async () => {
    const outcome = await call();
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') throw new Error(outcome.message);
    const { schedule } = outcome.value as {
      schedule: { id: string; pendingJobId: string; nextRunAt: number };
    };
    expect(new SessionScheduleRepository(writer).get(schedule.id)).toMatchObject({
      target,
      note: input.note,
      status: 'active',
      pendingJobId: schedule.pendingJobId,
    });
    expect(new JobQueueRepository(writer).getJob(schedule.pendingJobId)).toMatchObject({
      queue: 'sessionSchedule.fire',
      status: 'pending',
      payload: { scheduleId: schedule.id },
      runAt: schedule.nextRunAt,
    });
    expect(mainSql).toBe(0);
  });

  test('a failed wake insertion rolls the whole schedule back without a main fallback', async () => {
    writer.exec(`CREATE TRIGGER reject_schedule_wake BEFORE INSERT ON job_queue
      WHEN NEW.queue = 'sessionSchedule.fire'
      BEGIN SELECT RAISE(ABORT, 'synthetic schedule enqueue failure'); END`);
    expect(await call()).toMatchObject({
      kind: 'failed',
      code: 'execution_failed',
      message: expect.stringContaining('synthetic schedule enqueue failure'),
    });
    expect(new SessionScheduleRepository(writer).list()).toEqual([]);
    expect(mainSql).toBe(0);
  });

  test('invalid cadence is refused before writer admission', async () => {
    expect(await call({ ...input, cadence: { kind: 'every', everyMs: 1000 } })).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: expect.stringContaining('invalid_cadence') },
    });
    expect(new SessionScheduleRepository(writer).list()).toEqual([]);
    expect(mainSql).toBe(0);
  });

  test('ordinary workers cannot create reminder schedules', async () => {
    expect(await call(input, false)).toMatchObject({
      kind: 'completed',
      value: { ok: false, reason: 'This action belongs to Neo or the user.' },
    });
    expect(new SessionScheduleRepository(writer).list()).toEqual([]);
    expect(mainSql).toBe(0);
  });

  test('the async command reuses one existing source without enqueuing duplicate wakes', async () => {
    const draft = {
      ...input,
      sourceKind: 'reminder',
      sourceId: 'stable-source',
      nudgeEvery: 1,
      createdBySession: null,
    };
    const [first, second] = await Promise.all([
      scheduler.createAsync(draft),
      scheduler.createAsync(draft),
    ]);
    expect(second).toEqual(first);
    expect(new SessionScheduleRepository(writer).list()).toHaveLength(1);
    expect(new JobQueueRepository(writer).listJobs({ queue: 'sessionSchedule.fire' })).toHaveLength(
      1
    );
    expect(mainSql).toBe(0);
  });

  test('cron reminder receipts retain their timezone and queued due time', async () => {
    const outcome = await call({
      ...input,
      cadence: { kind: 'cron', cron: '0 * * * *', timezone: 'UTC' },
    });
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') throw new Error(outcome.message);
    const { schedule } = outcome.value as {
      schedule: { pendingJobId: string; nextRunAt: number; cadence: unknown };
    };
    expect(schedule.cadence).toEqual({ kind: 'cron', cron: '0 * * * *', timezone: 'UTC' });
    expect(new Date(schedule.nextRunAt).getUTCMinutes()).toBe(0);
    expect(new JobQueueRepository(writer).getJob(schedule.pendingJobId)?.runAt).toBe(
      schedule.nextRunAt
    );
    expect(mainSql).toBe(0);
  });

  const cadenceCases: { label: string; cadence: SessionScheduleCadence; next: string }[] = [
    {
      label: 'interval',
      cadence: { kind: 'every', everyMs: 3_600_000 },
      next: '2026-03-08T07:30:00Z',
    },
    {
      label: 'UTC cron',
      cadence: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
      next: '2026-03-08T09:00:00Z',
    },
    {
      label: 'DST cron',
      cadence: { kind: 'cron', cron: '0 9 * * *', timezone: 'America/New_York' },
      next: '2026-03-08T13:00:00Z',
    },
  ];

  for (const { label, cadence, next } of cadenceCases) {
    test(`sync and writer creation commit the same ${label} due time`, async () => {
      const now = Date.parse('2026-03-08T06:30:00Z');
      const draft = {
        ...input,
        cadence,
        sourceKind: 'reminder',
        nudgeEvery: 1,
        createdBySession: null,
      };
      const sync = new SessionScheduler(writer, new JobQueueRepository(writer)).create(
        { ...draft, sourceId: `sync-${label}` },
        now
      );
      const async = await scheduler.createAsync({ ...draft, sourceId: `async-${label}` }, now);
      for (const schedule of [sync, async]) {
        expect(schedule.nextRunAt).toBe(Date.parse(next));
        expect(new JobQueueRepository(writer).getJob(schedule.pendingJobId!)?.runAt).toBe(
          Date.parse(next)
        );
      }
      expect(mainSql).toBe(0);
    });
  }
});
