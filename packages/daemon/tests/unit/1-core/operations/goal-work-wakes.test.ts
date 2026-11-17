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
      parentProblem: async () => null,
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

  test('a goal has an independently configured review schedule that follows its lifecycle', async () => {
    const goal = await create({ reviewCadence: { kind: 'every', everyMs: 120_000 } });
    const review = () => scheduler.repo.getBySource('goal_review', goal.id);
    expect(review()).toMatchObject({
      cadence: { kind: 'every', everyMs: 120_000 },
      status: 'active',
    });
    await call('goal.session.update', { goalId: goal.id, status: 'paused' });
    expect(review()?.status).toBe('paused');
    await call('goal.session.update', { goalId: goal.id, status: 'active' });
    expect(review()?.status).toBe('active');
    await call('goal.session.update', { goalId: goal.id, status: 'completed' });
    expect(review()).toBeNull();
    await call('goal.session.update', { goalId: goal.id, status: 'active' });
    expect(review()).toMatchObject({
      cadence: { kind: 'every', everyMs: 120_000 },
      status: 'active',
    });
    await call('goal.session.update', {
      goalId: goal.id,
      reviewCadence: { kind: 'every', everyMs: 180_000 },
    });
    expect(review()?.cadence).toEqual({ kind: 'every', everyMs: 180_000 });
  });

  test('review wakes carry new journal entries and note on every due time', async () => {
    const goal = await create();
    const review = () => scheduler.repo.getBySource('goal_review', goal.id)!;
    expect(review().cadence).toEqual({ kind: 'every', everyMs: 86_400_000 });
    await call('goal.session.update', { goalId: goal.id, worksNote: 'Existing note' });
    await call('goal.journal.append', {
      goalId: goal.id,
      done: 'First work',
      effect: 'Readers',
      worked: 'Examples',
    });
    const fireReview = async () => {
      const row = review();
      now = row.nextRunAt!;
      return createSessionScheduleFire({
        scheduler,
        status: async () => 'done',
        deliver: async (_row, _id, text) => {
          messages.push(text);
        },
      })(jobs.getJob(row.pendingJobId!)!);
    };
    expect(await fireReview()).toEqual({ outcome: 'fired' });
    expect(messages[0]).toContain('First work');
    expect(messages[0]).toContain('Existing note');
    const runId = messages[0].match(/runId (goal-review:[^, ]+)/)![1];
    expect(
      await call('goal.journal.append', {
        goalId: goal.id,
        runId,
        done: 'Review summary',
        effect: 'unclear',
        worked: 'Examples',
      })
    ).toMatchObject({ accepted: false, reason: expect.stringContaining('review_effect_required') });
    await call('goal.journal.append', {
      goalId: goal.id,
      runId,
      done: 'Review summary',
      effect: 'yes',
      worked: 'Examples',
    });
    await call('goal.session.update', { goalId: goal.id, worksNote: 'Updated note' });
    await call('goal.journal.append', {
      goalId: goal.id,
      done: 'Second work',
      effect: 'None',
      worked: 'Try again',
    });
    expect(await fireReview()).toEqual({ outcome: 'fired' });
    expect(messages[1]).toContain('Second work');
    expect(messages[1]).not.toContain('First work');
    expect(messages[1]).toContain('Updated note');
    expect((await call('goal.journal.list', { goalId: goal.id })).entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId, done: 'Review summary', effect: 'yes' }),
      ])
    );
  });

  test('a review wake bounds journal entries and points to earlier pages', async () => {
    const goal = await create();
    for (let i = 0; i < 25; i++)
      await call('goal.journal.append', {
        goalId: goal.id,
        done: `entry-${String(i).padStart(2, '0')}-unique`,
        effect: 'None',
        worked: 'Read',
      });
    const row = scheduler.repo.getBySource('goal_review', goal.id)!;
    now = row.nextRunAt!;
    await createSessionScheduleFire({
      scheduler,
      status: async () => 'done',
      deliver: async (_row, _id, text) => {
        messages.push(text);
      },
    })(jobs.getJob(row.pendingJobId!)!);
    expect(messages[0]).not.toContain('entry-00-unique');
    expect(messages[0]).toContain('entry-05-unique');
    expect(messages[0]).toContain('entry-24-unique');
    expect(messages[0]).toContain('5 earlier');
    expect(messages[0]).toContain('goal.journal.list');
  });

  test('entries added while a review is in flight appear in the next review', async () => {
    const goal = await create();
    await call('goal.journal.append', {
      goalId: goal.id,
      done: 'Before snapshot',
      effect: 'None',
      worked: 'Read',
    });
    const fireReview = async () => {
      const row = scheduler.repo.getBySource('goal_review', goal.id)!;
      now = row.nextRunAt!;
      await createSessionScheduleFire({
        scheduler,
        status: async () => 'running',
        deliver: async (_row, _id, text) => {
          messages.push(text);
        },
      })(jobs.getJob(row.pendingJobId!)!);
    };
    await fireReview();
    const runId = messages[0].match(/runId (goal-review:[^, ]+)/)![1];
    await call('goal.journal.append', {
      goalId: goal.id,
      done: 'During review',
      effect: 'Changed',
      worked: 'Read',
    });
    await call('goal.journal.append', {
      goalId: goal.id,
      runId,
      done: 'Review result',
      effect: 'yes',
      worked: 'Read',
    });
    await fireReview();
    expect(messages[1]).toContain('During review');
    expect(messages[1]).not.toContain('Before snapshot');
    const secondRun = messages[1].match(/runId (goal-review:[^, ]+)/)![1];
    await call('goal.journal.append', {
      goalId: goal.id,
      runId: secondRun,
      done: 'Second review',
      effect: 'yes',
      worked: 'Read',
    });
    await fireReview();
    expect(messages[2]).not.toContain('During review');
    const emptyRun = messages[2].match(/runId (goal-review:[^, ]+)/)![1];
    await call('goal.journal.append', {
      goalId: goal.id,
      runId: emptyRun,
      done: 'Empty review',
      effect: 'no',
      worked: 'Read',
    });
    await fireReview();
    expect(messages[3]).not.toContain('During review');
  });

  test('a due review is delivered to the mailbox while the owner is busy', async () => {
    const goal = await create();
    const row = scheduler.repo.getBySource('goal_review', goal.id)!;
    now = row.nextRunAt!;
    const fire = createSessionScheduleFire({
      scheduler,
      status: async () => 'running',
      deliver: async (_schedule, _messageId, text) => {
        messages.push(text);
      },
    });
    expect(await fire(jobs.getJob(row.pendingJobId!)!)).toEqual({ outcome: 'fired' });
    expect(messages[0]).toContain('Journal entries since the previous review');
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
