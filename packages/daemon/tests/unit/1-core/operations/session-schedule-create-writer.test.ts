import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createSessionScheduleOperations } from '../../../../src/lib/scheduler/operations';
import { SessionScheduler } from '../../../../src/lib/scheduler/session-schedules';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { SessionScheduleRepository } from '../../../../src/storage/repositories/session-schedule-repository';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { Database as SQLite } from '../../../../src/storage/sqlite-compat';

describe('ordinary session reminder writer', () => {
  let main: SQLite;
  let writer: SQLite;
  let gateway: DbGateway;
  let scheduler: SessionScheduler;
  let mainSql: number;
  const target = { adapter: 'hyperneo', id: 'synthetic-recipient' };
  const input = { target, cadence: { kind: 'every', everyMs: 3_600_000 }, note: 'Check progress' };

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
});
