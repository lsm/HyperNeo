import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createSessionGoalOperations } from '../../../../src/lib/goals/session-goal-operations.ts';
import { SessionGoalSchedules } from '../../../../src/lib/goals/session-goal-schedules.ts';
import { SessionScheduler } from '../../../../src/lib/scheduler/session-schedules.ts';
import { createSessionScheduleFire } from '../../../../src/lib/scheduler/session-schedule-fire.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { SessionGoalRepository } from '../../../../src/storage/repositories/session-goal-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const neo: OperationCaller = { source: 'mcp', sessionId: 'neo:root', role: 'neo' };

describe('goal work wakes', () => {
  let db: Database;
  let scheduler: SessionScheduler;
  let jobs: JobQueueRepository;
  let now: number;
  let clock: ReturnType<typeof spyOn>;
  let messages: string[];
  let call: (name: string, input: unknown) => Promise<Record<string, any>>;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    jobs = new JobQueueRepository(db);
    scheduler = new SessionScheduler(db, jobs);
    const goals = new SessionGoalRepository(db);
    const schedules = new SessionGoalSchedules(
      goals,
      new NeoAskTodoRepository(db),
      scheduler,
      () => [],
      () => false
    );
    scheduler.registerSource(schedules);
    const ops = createSessionGoalOperations({
      goals,
      schedules,
      sessionExists: (sessionId) => sessionId === 'neo:root',
      isChildSession: () => false,
      canReturn: () => false,
      releaseSession: async () => {},
      startSession: () => {
        throw new Error('work-wake tests never start a goal session');
      },
      audit: () => {},
    });
    call = (name, input) => {
      const op = ops.find((item) => item.name === name)!;
      return op.execute(op.inputSchema.parse(input), neo) as Promise<Record<string, any>>;
    };
    now = Date.now();
    clock = spyOn(Date, 'now').mockImplementation(() => now);
    messages = [];
  });
  afterEach(() => {
    clock.mockRestore();
    db.close();
  });
  const create = async (input: Record<string, unknown> = {}) =>
    (
      await call('goal.session.create', {
        title: 'Explore the guide',
        doneTest: 'Published',
        cadence: { kind: 'every', everyMs: 60_000 },
        ...input,
      })
    ).goal as { id: string; dailyRunLimit: number };
  const fire = async (goalId: string) => {
    const schedule = scheduler.repo.getBySource('goal', goalId)!;
    now = schedule.nextRunAt!;
    return createSessionScheduleFire({
      scheduler,
      status: async () => 'done',
      deliver: async (_schedule, _messageId, text) => {
        messages.push(text);
      },
    })(jobs.getJob(schedule.pendingJobId!)!);
  };

  test('unchanged facts still get a work wake at every due time', async () => {
    const goal = await create();
    expect(await fire(goal.id)).toEqual({ outcome: 'fired' });
    expect(await fire(goal.id)).toEqual({ outcome: 'fired' });
    expect(await fire(goal.id)).toEqual({ outcome: 'fired' });
    expect(messages).toHaveLength(3);
    expect(messages[1]).toContain('Nothing moved; check what can advance.');
  });

  test('the 25th due time in a day is skipped for the budget and the owner is told once', async () => {
    const goal = await create();
    expect(goal.dailyRunLimit).toBe(24);
    for (let run = 1; run <= 24; run++) expect(await fire(goal.id)).toEqual({ outcome: 'fired' });
    expect(await fire(goal.id)).toEqual({ outcome: 'skipped_budget' });
    expect(await fire(goal.id)).toEqual({ outcome: 'skipped_budget' });
    expect(messages).toHaveLength(25);
    expect(messages[24]).toContain('daily run limit of 24');
    expect(scheduler.repo.getBySource('goal', goal.id)).toMatchObject({
      status: 'active',
      lastSkipReason: 'budget',
    });
  });

  test('the limit is set on the goal', async () => {
    const goal = await create({ dailyRunLimit: 2 });
    expect(
      (await call('goal.session.update', { goalId: goal.id, dailyRunLimit: 1 })).goal
    ).toMatchObject({ dailyRunLimit: 1 });
    expect(await fire(goal.id)).toEqual({ outcome: 'fired' });
    expect(await fire(goal.id)).toEqual({ outcome: 'skipped_budget' });
  });

  test('silent budget skips do not hold back the next day notice', async () => {
    const goal = await create({
      dailyRunLimit: 1,
      cadence: { kind: 'every', everyMs: 14_400_000 },
    });
    const outcomes = [];
    for (let run = 0; run < 8; run++) outcomes.push((await fire(goal.id)).outcome);
    expect(outcomes).toEqual([
      'fired',
      'skipped_budget',
      'skipped_budget',
      'skipped_budget',
      'skipped_budget',
      'skipped_budget',
      'fired',
      'skipped_budget',
    ]);
    expect(messages).toHaveLength(4);
    expect(messages[1]).toContain('daily run limit of 1');
    expect(messages[3]).toContain('daily run limit of 1');
  });

  test('completing and reactivating a goal keeps its runs in the daily limit until they age out', async () => {
    const goal = await create({ dailyRunLimit: 1 });
    expect(await fire(goal.id)).toEqual({ outcome: 'fired' });
    const firedAt = now;
    await call('goal.session.update', { goalId: goal.id, status: 'completed' });
    expect(scheduler.repo.getBySource('goal', goal.id)).toBeNull();
    await call('goal.session.update', { goalId: goal.id, status: 'active' });

    expect(await fire(goal.id)).toEqual({ outcome: 'skipped_budget' });
    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain('daily run limit of 1');

    await call('goal.session.update', { goalId: goal.id, status: 'archived' });
    now = firedAt + 86_400_000;
    await call('goal.session.update', { goalId: goal.id, status: 'active' });
    expect(await fire(goal.id)).toEqual({ outcome: 'fired' });
    expect(messages).toHaveLength(3);
  });
});
