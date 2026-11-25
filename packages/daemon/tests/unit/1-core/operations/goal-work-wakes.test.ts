import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createSessionGoalOperations } from '../../../../src/lib/goals/session-goal-operations.ts';
import { SessionGoalSchedules } from '../../../../src/lib/goals/session-goal-schedules.ts';
import { SessionScheduler } from '../../../../src/lib/scheduler/session-schedules.ts';
import { createSessionScheduleFire } from '../../../../src/lib/scheduler/session-schedule-fire.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { proposalQuestionId } from '../../../../src/lib/neo/proposal.ts';
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

  test('consecutive reviews without effect pause the goal and open one human question', async () => {
    const goal = await create();
    const asks = new NeoAskTodoRepository(db);
    const review = async (run: number, effect: 'yes' | 'no') =>
      call('goal.journal.append', {
        goalId: goal.id,
        runId: `goal-review:synthetic:${run}`,
        done: 'Reviewed the outcome',
        effect,
        worked: 'Keep exploring',
      });
    await review(1, 'no');
    await review(2, 'no');
    expect(scheduler.repo.getBySource('goal', goal.id)?.status).toBe('active');
    expect(asks.listGoalAsks(goal.id)).toHaveLength(0);
    await review(3, 'yes');
    await review(4, 'no');
    await review(5, 'no');
    expect(scheduler.repo.getBySource('goal', goal.id)?.status).toBe('active');
    await review(6, 'no');
    expect((await call('goal.session.get', { goalId: goal.id })).goal.status).toBe('paused');
    expect(scheduler.repo.getBySource('goal', goal.id)?.status).toBe('paused');
    expect(scheduler.repo.getBySource('goal_review', goal.id)?.status).toBe('paused');
    const goalAsks = asks.listGoalAsks(goal.id);
    expect(goalAsks).toHaveLength(1);
    expect(asks.listQuestions(goalAsks[0]!.id)).toEqual([
      expect.objectContaining({ state: 'open', text: expect.stringContaining('effect') }),
    ]);
    expect(await call('goal.session.update', { goalId: goal.id, status: 'active' })).toMatchObject({
      accepted: false,
      reason: expect.stringContaining('review_question_open'),
    });
    const question = asks.listQuestions(goalAsks[0]!.id)[0]!;
    asks.answerQuestion(question, 'Try a new audience', 'button', now);
    expect(
      await call('goal.session.update', {
        goalId: goal.id,
        status: 'active',
        nextSteps: ['Try a new audience'],
      })
    ).toMatchObject({ accepted: true });
    expect(await fire(goal.id)).toEqual({ outcome: 'fired' });
    expect(messages.at(-1)).toContain('Try a new audience');
    await review(7, 'no');
    expect(scheduler.repo.getBySource('goal', goal.id)?.status).toBe('active');
    expect(asks.listGoalAsks(goal.id)).toHaveLength(1);
  });

  test('the no-effect question shows the metric, recent reviews and work in flight, with answer buttons', async () => {
    const goal = await create({
      noEffectReviewLimit: 2,
      metric: { name: 'Failed runs per day', target: 5, direction: 'decrease', baseline: 40 },
    });
    const asks = new NeoAskTodoRepository(db);
    asks.openAsk({
      id: 'synthetic-ask',
      goalId: goal.id,
      sessionId: 'neo:root',
      projectId: null,
      originMessageId: null,
      title: 'Fix the retry loop',
      request: 'Fix the retry loop',
      createdAt: now,
    });
    asks.addTodo(
      'synthetic-todo',
      'synthetic-ask',
      {
        title: 'Ship the retry fix',
        doneWhen: 'Merged',
        check: null,
        instruction: 'Continue',
        named: null,
      },
      now
    );
    const schedule = scheduler.repo.getBySource('goal_review', goal.id)!;
    for (const [run, value, done] of [
      [1, 38, 'Rolling count still high'],
      [2, 37, 'Fix deployed; 24h window still includes old failures'],
    ] as const) {
      scheduler.repo.recordRun({ ...schedule, nextRunAt: run }, 'fired', `message-${run}`, run);
      expect(
        await call('goal.journal.append', {
          goalId: goal.id,
          runId: `goal-review:${schedule.id}:${run}:none`,
          done,
          effect: 'no',
          worked: 'Explore',
          metricPoint: { value, evidence: 'synthetic' },
        })
      ).toMatchObject({ accepted: true });
    }
    const [question] = asks.listGoalAsks(goal.id).flatMap((ask) => asks.listQuestions(ask.id));
    expect(question).toMatchObject({
      kind: 'choice',
      options: ['Continue as is', 'Stop the goal'],
      text: expect.stringContaining('2 reviews'),
    });
    for (const fact of [
      'Failed runs per day',
      'baseline 40',
      'latest 37',
      'target 5',
      'Rolling count still high',
      'Fix deployed; 24h window still includes old failures',
      'Ship the retry fix',
    ])
      expect(question.document).toContain(fact);
  });

  test('the no-effect review threshold is configurable on the goal', async () => {
    const goal = await create({ noEffectReviewLimit: 2 });
    expect((await call('goal.session.get', { goalId: goal.id })).goal.noEffectReviewLimit).toBe(2);
    await call('goal.session.update', { goalId: goal.id, noEffectReviewLimit: 1 });
    expect((await call('goal.session.get', { goalId: goal.id })).goal.noEffectReviewLimit).toBe(1);
    await call('goal.journal.append', {
      goalId: goal.id,
      runId: 'goal-review:synthetic:1',
      done: 'Reviewed',
      effect: 'no',
      worked: 'Explore',
    });
    expect(scheduler.repo.getBySource('goal', goal.id)?.status).toBe('paused');
  });

  const goalAsk = (id: string) => {
    db.exec(
      "INSERT INTO neo_concerns (id,title,summary,context,revision,created_at,updated_at) VALUES ('synthetic-project','Guide','','',1,1,1)"
    );
    return new NeoAskTodoRepository(db).openAsk({
      id,
      projectId: 'synthetic-project',
      sessionId: 'neo:root',
      originMessageId: null,
      title: 'Grow the guide',
      topic: '研究',
      request: 'Grow the guide',
      createdAt: 1,
    });
  };
  const noEffect = (goalId: string, run = 1) =>
    call('goal.journal.append', {
      goalId,
      runId: `goal-review:synthetic:${run}`,
      done: 'Reviewed',
      effect: 'no',
      worked: 'Explore',
    });
  const openCards = (askId: string) =>
    new NeoAskTodoRepository(db).listQuestions(askId).filter(({ state }) => state === 'open');

  test('the no-effect question goes on the ask that created the goal and holds none of its work', async () => {
    const asks = new NeoAskTodoRepository(db);
    const ask = goalAsk('goal-ask');
    asks.addTodo(
      'queued',
      ask.id,
      { title: 'Draft', doneWhen: 'Drafted', check: null, instruction: 'Draft', named: null },
      1
    );
    const goal = await create({ askId: ask.id, noEffectReviewLimit: 1 });
    await noEffect(goal.id);
    expect(asks.listGoalAsks(goal.id).map(({ id }) => id)).toEqual([ask.id]);
    expect(openCards(ask.id)).toEqual([
      expect.objectContaining({ options: ['Continue as is', 'Stop the goal'], todos: [] }),
    ]);
  });

  test('with the goal ask settled, the question opens a new ask with its topic and project', async () => {
    const asks = new NeoAskTodoRepository(db);
    const ask = goalAsk('goal-ask');
    const goal = await create({ askId: ask.id, noEffectReviewLimit: 1 });
    asks.settleAsk(asks.getAsk(ask.id)!, 'done', 'Closed', now);
    await noEffect(goal.id);
    const opened = asks.listGoalAsks(goal.id).find(({ id }) => id !== ask.id)!;
    expect(opened).toMatchObject({
      status: 'open',
      topic: '研究',
      projectId: 'synthetic-project',
    });
    expect(openCards(opened.id)).toHaveLength(1);
    expect(openCards(ask.id)).toEqual([]);
  });

  test('the question does not join a goal ask whose proposal the human has not answered', async () => {
    const asks = new NeoAskTodoRepository(db);
    const ask = goalAsk('goal-ask');
    const goal = await create({ askId: ask.id, noEffectReviewLimit: 1 });
    const proposal = proposalQuestionId(ask.id);
    asks.askQuestion(
      proposal,
      ask.id,
      {
        text: 'Start it?',
        kind: 'yesno',
        options: null,
        multiple: false,
        noLabel: null,
        yesLabel: null,
      },
      now
    );
    await noEffect(goal.id);
    expect(openCards(ask.id).map(({ id }) => id)).toEqual([proposal]);
    const opened = asks.listGoalAsks(goal.id).filter(({ id }) => id !== ask.id);
    expect(opened).toHaveLength(1);
    expect(openCards(opened[0]!.id)).toHaveLength(1);
  });

  test('a retired question reopens on the goal ask', async () => {
    const asks = new NeoAskTodoRepository(db);
    const ask = goalAsk('goal-ask');
    const goal = await create({ askId: ask.id, noEffectReviewLimit: 1 });
    await noEffect(goal.id);
    asks.retireQuestion(openCards(ask.id)[0]!, 'No longer current', null, now);
    await call('goal.session.update', { goalId: goal.id, status: 'active' });
    expect(asks.listGoalAsks(goal.id).map(({ id }) => id)).toEqual([ask.id]);
    expect(openCards(ask.id)).toEqual([expect.objectContaining({ todos: [] })]);
  });

  test('a failed human question rolls back the review and keeps the schedules active', async () => {
    const goal = await create({ noEffectReviewLimit: 1 });
    const open = spyOn(NeoAskTodoRepository.prototype, 'openAsk').mockImplementationOnce(() => {
      throw new Error('question storage unavailable');
    });
    try {
      await expect(
        call('goal.journal.append', {
          goalId: goal.id,
          runId: 'goal-review:synthetic:1',
          done: 'Reviewed',
          effect: 'no',
          worked: 'Explore',
        })
      ).rejects.toThrow('question storage unavailable');
      expect((await call('goal.journal.list', { goalId: goal.id })).entries).toEqual([]);
      expect(scheduler.repo.getBySource('goal', goal.id)?.status).toBe('active');
      expect(scheduler.repo.getBySource('goal_review', goal.id)?.status).toBe('active');
      expect(new NeoAskTodoRepository(db).listGoalAsks(goal.id)).toEqual([]);
    } finally {
      open.mockRestore();
    }
  });

  test.each(['retired', 'settled', 'replaced'] as const)(
    'an escalation question that is %s does not strand the goal',
    async (state) => {
      const goal = await create({ noEffectReviewLimit: 1 });
      await call('goal.journal.append', {
        goalId: goal.id,
        runId: 'goal-review:synthetic:1',
        done: 'Reviewed',
        effect: 'no',
        worked: 'Explore',
      });
      const asks = new NeoAskTodoRepository(db);
      const ask = asks.listGoalAsks(goal.id)[0]!;
      const original = asks.listQuestions(ask.id)[0]!;
      if (state === 'settled') asks.settleAsk(ask, 'done', 'Closed', now);
      else if (state === 'retired') asks.retireQuestion(original, 'No longer current', null, now);
      else
        asks.replaceQuestion(
          original,
          'replacement',
          {
            text: 'What should change?',
            kind: 'reply',
            options: null,
            multiple: false,
            noLabel: null,
            yesLabel: null,
          },
          now
        );
      expect(
        await call('goal.session.update', { goalId: goal.id, status: 'active' })
      ).toMatchObject({ accepted: false, reason: expect.stringContaining('review_question_open') });
      const open = asks
        .listGoalAsks(goal.id)
        .flatMap((item) => asks.listQuestions(item.id))
        .filter((question) => question.state === 'open');
      expect(open).toHaveLength(1);
      asks.answerQuestion(open[0]!, 'Try a new audience', 'button', now);
      expect(
        await call('goal.session.update', {
          goalId: goal.id,
          status: 'active',
          nextSteps: ['Try a new audience'],
        })
      ).toMatchObject({ accepted: true });
      expect(scheduler.repo.getBySource('goal', goal.id)?.status).toBe('active');
    }
  );

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

  test('an empty review wake does not suggest paging with an empty cursor', async () => {
    const goal = await create();
    const row = scheduler.repo.getBySource('goal_review', goal.id)!;
    now = row.nextRunAt!;
    await createSessionScheduleFire({
      scheduler,
      status: async () => 'done',
      deliver: async (_row, _id, text) => {
        messages.push(text);
      },
    })(jobs.getJob(row.pendingJobId!)!);
    expect(messages[0]).toContain('Journal entries since the previous review');
    expect(messages[0]).not.toContain('goal.journal.list');
    expect(messages[0]).not.toContain('before: ""');
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
