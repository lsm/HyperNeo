import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository';
import { createTestSession } from '../../../helpers/database';
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
  let notices: string[];
  let clock: ReturnType<typeof spyOn>;
  let now: number;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    new SessionRepository(db).createSession(createTestSession('recipient'));
    new SessionRepository(db).createSession(createTestSession('foreign'));
    jobs = new JobQueueRepository(db);
    scheduler = new SessionScheduler(db, jobs);
    now = Date.now();
    clock = spyOn(Date, 'now').mockImplementation(() => now);
    status = 'done';
    digest = 'a';
    gone = false;
    deliveries = [];
    notices = [];
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
    notifyIdle: (schedule: SessionSchedule) => {
      notices.push(schedule.id);
    },
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
  test.each(['none', 'human', 'ask', 'todo'])(
    'upgrade with %s history stays quiet across later restarts',
    async (history) => {
      const row = create();
      await fire(row.id);
      if (history === 'human')
        new SDKMessageRepository(db).saveUserMessage(
          'recipient',
          {
            type: 'user',
            uuid: 'old-human',
            inputKind: 'human',
            message: { role: 'user', content: 'Earlier work' },
            parent_tool_use_id: null,
            session_id: 'sdk-old',
          },
          'consumed'
        );
      if (history === 'ask' || history === 'todo') {
        const asks = new NeoAskTodoRepository(db);
        const ask = asks.openAsk({
          id: 'old-ask',
          sessionId: 'recipient',
          originMessageId: null,
          projectId: null,
          title: 'Earlier work',
          request: 'Review',
          createdAt: now,
          goalId: null,
        });
        if (history === 'todo')
          asks.addTodo(
            'old-todo',
            ask.id,
            {
              title: 'Review',
              doneWhen: 'Reviewed',
              check: null,
              instruction: null,
              named: null,
            },
            now
          );
      }
      db.prepare(
        "UPDATE session_schedules SET due_count = 9, last_outcome = 'skipped_busy' WHERE id = ?"
      ).run(row.id);
      db.exec("DELETE FROM migration_markers WHERE key = 'migration_448'");
      runMigrations(db, () => {});
      const first = await fire(row.id);
      expect(first.lastOutcome).toBe('skipped_unchanged');
      expect(first.dueCount).toBe(1);
      expect(first.nextRunAt).toBe(now + 60000);
      runMigrations(db, () => {});
      expect((await fire(row.id)).dueCount).toBe(2);
      expect(notices).toEqual([]);
      expect((await fire(row.id)).dueCount).toBe(3);
      expect(notices).toEqual([row.id]);
      expect(deliveries).toHaveLength(1);
    }
  );
  test('changed facts fire once, quiet wakes back off without turns, and progress resets', async () => {
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
    for (let count = 2; count <= 15; count++) {
      const quiet = await fire(initial.id);
      expect(quiet).toMatchObject({ lastOutcome: 'skipped_unchanged', dueCount: count });
      expect(quiet.nextRunAt).toBe(now + Math.min(60000 * 2 ** Math.max(0, count - 2), 28_800_000));
    }
    expect(deliveries).toHaveLength(1);
    expect(notices).toEqual([initial.id]);
    digest = 'b';
    now += 1;
    await scheduler.refreshProgress();
    expect(scheduler.repo.get(initial.id)).toMatchObject({
      lastOutcome: 'progress',
      dueCount: 0,
      nextRunAt: now + 60000,
    });
    expect(await fire(initial.id)).toMatchObject({ lastOutcome: 'fired', factsDigest: 'b' });
    for (let count = 1; count <= 4; count++) await fire(initial.id);
    expect(notices).toEqual([initial.id, initial.id]);
  });
  test.each(['running', 'queued', 'stopped', 'needs_you'] as const)(
    '%s skips without counting quiet wakes or forcing a turn when idle',
    async (busy) => {
      const row = create();
      await fire(row.id);
      status = busy;
      for (let i = 1; i <= 4; i++) {
        const skipped = await fire(row.id);
        expect(skipped).toMatchObject({
          lastOutcome: busy === 'needs_you' ? 'skipped_needs_you' : 'skipped_busy',
          dueCount: 0,
        });
        expect(skipped.nextRunAt).toBe(now + 60000);
      }
      expect(deliveries).toHaveLength(1);
      status = 'done';
      expect(await fire(row.id)).toMatchObject({ lastOutcome: 'skipped_unchanged', dueCount: 1 });
      expect(deliveries).toHaveLength(1);
    }
  );
  test('a reminder follows the same no-forced-turn rule', async () => {
    const row = create('reminder', 1);
    await fire(row.id);
    await fire(row.id);
    expect(deliveries.map((d) => d.text)).toEqual(['Read the checklist']);
  });
  test('human and task inputs, new asks and todos reset backoff; foreign and system inputs do not', async () => {
    const row = create();
    const messages = new SDKMessageRepository(db);
    const asks = new NeoAskTodoRepository(db);
    await fire(row.id);
    const quiet = async () => {
      for (let i = 0; i < 3; i++) await fire(row.id);
    };
    const reset = async () => {
      now += 1;
      await scheduler.refreshProgress();
      expect(scheduler.repo.get(row.id)).toMatchObject({ dueCount: 0, nextRunAt: now + 60000 });
      await fire(row.id);
    };
    for (const inputKind of ['human', 'task'] as const) {
      await quiet();
      messages.saveUserMessage(
        'recipient',
        {
          type: 'user',
          uuid: `new-${inputKind}`,
          inputKind,
          message: { role: 'user', content: 'New work' },
          parent_tool_use_id: null,
          session_id: 'sdk-fixture',
        },
        'enqueued'
      );
      await reset();
    }
    await quiet();
    const ask = asks.openAsk({
      id: 'new-ask',
      sessionId: 'recipient',
      originMessageId: null,
      projectId: null,
      title: 'New ask',
      request: 'Review this',
      createdAt: now,
      goalId: null,
    });
    await reset();
    await quiet();
    asks.addTodo(
      'new-todo',
      ask.id,
      { title: 'New todo', doneWhen: 'Reviewed', check: null, instruction: null, named: null },
      now
    );
    await reset();
    await quiet();
    const before = scheduler.repo.get(row.id)!;
    for (const [sessionId, inputKind] of [
      ['foreign', 'human'],
      ['recipient', 'system'],
    ] as const)
      messages.saveUserMessage(
        sessionId,
        {
          type: 'user',
          uuid: `ignored-${inputKind}`,
          inputKind,
          message: { role: 'user', content: 'Unrelated note' },
          parent_tool_use_id: null,
          session_id: 'sdk-fixture',
        },
        'enqueued'
      );
    await scheduler.refreshProgress();
    expect(scheduler.repo.get(row.id)).toMatchObject({
      dueCount: before.dueCount,
      nextRunAt: before.nextRunAt,
    });
  });
  test('a paused unchanged schedule cannot publish an idle notice', async () => {
    const row = create();
    await fire(row.id);
    await fire(row.id);
    await fire(row.id);
    scheduler.registerSource({
      kind: 'goal',
      facts: async () => {
        scheduler.pause(scheduler.repo.get(row.id)!);
        return { digest, summary: '' };
      },
      message: () => '',
    });
    await fire(row.id);
    expect(notices).toEqual([]);
    expect(scheduler.repo.get(row.id)?.status).toBe('paused');
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
    expect(scheduler.repo.get(row.id)?.dueCount).toBe(0);
    await createSessionScheduleFire(deps())(job);
    expect(deliveries[0].id).toBe(`schedule:${row.id}:${row.nextRunAt}`);
    await createSessionScheduleFire(deps())(job);
    expect(deliveries).toHaveLength(1);
  });
  test('source baselines commit only with confirmed delivery and a live schedule', async () => {
    let baseline = 'old';
    scheduler.registerSource({
      kind: 'goal',
      facts: async () => ({
        digest: 'new',
        summary: 'Changed',
        commit: () => {
          baseline = 'new';
        },
      }),
      message: (_id, change) => change.summary,
    });
    const row = create();
    const job = jobs.getJob(row.pendingJobId!)!;
    now = row.nextRunAt!;
    await expect(
      createSessionScheduleFire({
        ...deps(),
        deliver: async () => {
          throw new Error('offline');
        },
      })(job)
    ).rejects.toThrow('offline');
    expect(baseline).toBe('old');
    await createSessionScheduleFire({ ...deps(), deliver: async () => 'unconfirmed' as const })(
      job
    );
    expect(baseline).toBe('old');
    await fire(row.id);
    expect(baseline).toBe('new');
    baseline = 'old';
    digest = 'next';
    const stale = scheduler.repo.get(row.id)!;
    scheduler.pause(stale);
    expect(
      scheduler.finishRun(stale, 'fired', 'next', 'm', now, () => {
        baseline = 'next';
      })
    ).toBe(false);
    expect(baseline).toBe('old');
  });
});
