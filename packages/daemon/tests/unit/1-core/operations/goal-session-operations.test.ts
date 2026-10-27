import { describe, expect, spyOn, test } from 'bun:test';
import { NEO_GOAL_CYCLE } from '@hyperneo/prompts';
import { createSessionGoalOperations } from '../../../../src/lib/goals/session-goal-operations.ts';
import { SessionGoalSchedules } from '../../../../src/lib/goals/session-goal-schedules.ts';
import { SessionScheduler } from '../../../../src/lib/scheduler/session-schedules.ts';
import { createSessionScheduleFire } from '../../../../src/lib/scheduler/session-schedule-fire.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import type { NeoPack } from '../../../../src/lib/neo/pack-contract.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { SessionGoalRepository } from '../../../../src/storage/repositories/session-goal-repository.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import { SpaceGoalRepository } from '../../../../src/storage/repositories/space-goal-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { runMigration420 } from '../../../../src/storage/schema/m420-neo-ask-goal.ts';

const neo: OperationCaller = { source: 'mcp', sessionId: 'neo:root', role: 'neo' };
const human: OperationCaller = { source: 'rpc' };

describe('ask goal-link upgrade', () => {
  test('old asks survive reruns and deleting a goal leaves its asks unlinked', () => {
    const db = new Database(':memory:');
    db.exec(
      "PRAGMA foreign_keys = ON; CREATE TABLE space_goals(id TEXT PRIMARY KEY); CREATE TABLE neo_asks(id TEXT PRIMARY KEY); INSERT INTO neo_asks VALUES ('old'); INSERT INTO space_goals VALUES ('goal')"
    );
    runMigration420(db);
    runMigration420(db);
    expect(db.prepare('SELECT wake_schedule FROM space_goals').get()).toEqual({
      wake_schedule: null,
    });
    expect(db.prepare('SELECT * FROM neo_asks').all()).toEqual([{ id: 'old', goal_id: null }]);
    db.exec("UPDATE neo_asks SET goal_id = 'goal'; DELETE FROM space_goals WHERE id = 'goal'");
    expect(db.prepare('SELECT goal_id FROM neo_asks').get()).toEqual({ goal_id: null });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });
});

function setup(
  packs: NeoPack[] = [],
  mandateChange?: (ref: string, revision: string | null) => Promise<string | null>
) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const audited: string[] = [];
  const goals = new SessionGoalRepository(db);
  const scheduler = new SessionScheduler(db, new JobQueueRepository(db));
  const schedules = new SessionGoalSchedules(
    goals,
    new NeoAskTodoRepository(db),
    scheduler,
    () => packs,
    mandateChange
  );
  scheduler.registerSource(schedules);
  const ops = createSessionGoalOperations({
    goals,
    schedules,
    sessionExists: (sessionId) => ['neo:root', 'neo:other'].includes(sessionId),
    audit: (_caller, toolName) => audited.push(toolName),
  });
  const call = (name: string, input: unknown, caller: OperationCaller = neo) => {
    const op = ops.find((item) => item.name === name)!;
    return op.execute(op.inputSchema.parse(input), caller) as Promise<Record<string, any>>;
  };
  return { db, call, audited, scheduler, goals, schedules };
}

describe('session goal detail reads', () => {
  test('get and list project the persisted what-works note without changing it', async () => {
    const { db, call } = setup();
    try {
      const created = await call('goal.session.create', {
        title: 'Publish guide',
        doneTest: 'Public',
      });
      expect(created.goal.worksNote).toBeNull();
      db.prepare('UPDATE neo_goals SET works_note = ? WHERE id = ?').run(
        'Concrete examples work',
        created.goal.id
      );
      expect((await call('goal.session.get', { goalId: created.goal.id })).goal.worksNote).toBe(
        'Concrete examples work'
      );
      expect((await call('goal.session.list', {})).goals[0].worksNote).toBe(
        'Concrete examples work'
      );
      expect(
        db.prepare('SELECT works_note FROM neo_goals WHERE id = ?').get(created.goal.id)
      ).toEqual({ works_note: 'Concrete examples work' });
    } finally {
      db.close();
    }
  });
});

describe('goal mandate reconciliation facts', () => {
  test('changed mandates remain read-only until the owner reconciles the returned revision', async () => {
    const seen: { ref: string; revision: string | null }[] = [];
    const revision = 'confirmed-home-commit';
    const { db, call } = setup([], async (ref, base) => {
      seen.push({ ref, revision: base });
      return base === revision ? null : revision;
    });
    try {
      const goal = (
        await call('goal.session.create', {
          title: 'Guide',
          doneTest: 'Published',
          mandateRef: 'projects/guide/mandate.md#readers',
          mandateRev: 'old-home-commit',
        })
      ).goal;
      const first = await call('goal.facts', { goalId: goal.id });
      expect(
        first.facts.lines.some(
          (line: string) => line.startsWith('Mandate changed:') && line.includes(revision)
        )
      ).toBe(true);
      expect(await call('goal.facts', { goalId: goal.id })).toEqual(first);
      expect((await call('goal.session.get', { goalId: goal.id })).goal.mandateRev).toBe(
        'old-home-commit'
      );
      expect(seen).toEqual([
        { ref: goal.mandateRef, revision: 'old-home-commit' },
        { ref: goal.mandateRef, revision: 'old-home-commit' },
      ]);
      await call('goal.session.update', { goalId: goal.id, mandateRev: revision });
      const after = await call('goal.facts', { goalId: goal.id });
      expect(after.facts.digest).not.toBe(first.facts.digest);
      expect(after.facts.lines.some((line: string) => line.startsWith('Mandate changed:'))).toBe(
        false
      );
      expect(db.prepare('SELECT facts_lines FROM neo_goals WHERE id=?').get(goal.id)).toEqual({
        facts_lines: null,
      });
    } finally {
      db.close();
    }
  });
});

describe('goal what-works compaction', () => {
  test('ten new journal entries request compaction; rewriting the note advances its cursor without deleting history', async () => {
    const { db, call, schedules } = setup();
    try {
      const goal = (await call('goal.session.create', { title: 'Guide', doneTest: 'Published' }))
        .goal;
      const append = (runId: string) =>
        call('goal.journal.append', {
          goalId: goal.id,
          runId,
          done: runId,
          effect: 'A reader tried it',
          worked: 'Concrete examples',
        });
      for (let i = 0; i < 9; i++) await append(`cycle-${i}`);
      const before = await call('goal.facts', { goalId: goal.id });
      expect(schedules.message(goal.id, { summary: 'changed', nudge: false })).not.toContain(
        'rewrite'
      );
      await append('cycle-9');
      const due = await call('goal.facts', { goalId: goal.id });
      expect(due.facts.digest).not.toBe(before.facts.digest);
      expect(due.facts.lines).toContain('What-works compaction due');
      expect(await call('goal.facts', { goalId: goal.id })).toEqual(due);
      expect(schedules.message(goal.id, { summary: 'changed', nudge: false })).toContain(
        'goal.session.update'
      );
      expect(schedules.message(goal.id, { summary: 'changed', nudge: false })).toContain(
        'worksNote'
      );
      db.exec('UPDATE goal_journal SET created_at=5');
      expect(
        await call('goal.session.update', {
          goalId: goal.id,
          worksNote: 'Small examples bring readers',
        })
      ).toMatchObject({ accepted: true, goal: { worksNote: 'Small examples bring readers' } });
      expect(
        db.prepare('SELECT works_note_through FROM neo_goals WHERE id=?').get(goal.id)
      ).toEqual({ works_note_through: 10 });
      const events = db
        .prepare(
          "SELECT source,new_state FROM space_goal_events WHERE goal_id=? AND event_type='journal_compacted'"
        )
        .all(goal.id) as { source: string; new_state: string }[];
      expect(events).toEqual([]);
      expect((await call('goal.journal.list', { goalId: goal.id })).entries).toHaveLength(10);
      expect((await call('goal.facts', { goalId: goal.id })).facts.lines).not.toContain(
        'What-works compaction due'
      );
      expect(schedules.message(goal.id, { summary: 'changed', nudge: false })).toContain(
        'Small examples bring readers'
      );
      expect(schedules.message(goal.id, { summary: 'changed', nudge: false })).not.toContain(
        'rewrite'
      );
      await append('cycle-9');
      for (let i = 10; i < 19; i++) await append(`cycle-${i}`);
      expect(schedules.message(goal.id, { summary: 'changed', nudge: false })).not.toContain(
        'rewrite'
      );
      await append('cycle-19');
      expect(schedules.message(goal.id, { summary: 'changed', nudge: false })).toContain('rewrite');
    } finally {
      db.close();
    }
  });
  test('a nudge requests a rewrite even without ten entries and other sessions may compact', async () => {
    const { db, call, schedules } = setup();
    try {
      const goal = (await call('goal.session.create', { title: 'Guide', doneTest: 'Published' }))
        .goal;
      expect(schedules.message(goal.id, { summary: '', nudge: true })).toContain('rewrite');
      expect(
        await call(
          'goal.session.update',
          { goalId: goal.id, worksNote: 'Not mine' },
          { source: 'mcp', role: 'neo', sessionId: 'neo:other' }
        )
      ).toMatchObject({ accepted: true });
      expect((await call('goal.session.get', { goalId: goal.id })).goal.worksNote).toBe('Not mine');
    } finally {
      db.close();
    }
  });
  test('cursor write failure rolls the note and cursor back together', async () => {
    const { db, call } = setup();
    try {
      const goal = (await call('goal.session.create', { title: 'Guide', doneTest: 'Published' }))
        .goal;
      await call('goal.journal.append', {
        goalId: goal.id,
        done: 'Read',
        effect: 'Learned',
        worked: 'Examples',
      });
      db.exec(
        "CREATE TRIGGER refuse_compaction BEFORE UPDATE OF works_note_through ON neo_goals BEGIN SELECT RAISE(ABORT,'synthetic cursor failure'); END"
      );
      await expect(
        call('goal.session.update', { goalId: goal.id, worksNote: 'Examples help' })
      ).rejects.toThrow('synthetic cursor failure');
      expect(
        db.prepare('SELECT works_note,works_note_through FROM neo_goals WHERE id=?').get(goal.id)
      ).toEqual({ works_note: null, works_note_through: null });
      expect((await call('goal.journal.list', { goalId: goal.id })).entries).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe('goal-owned schedules', () => {
  test('puts the full cycle only in goal wake content, preserving cadence and identity', async () => {
    const { db, call, scheduler, schedules } = setup();
    try {
      const goal = (
        await call('goal.session.create', {
          title: 'Standing outcome',
          doneTest: 'Measured outcome',
          cadence: { kind: 'every', everyMs: 900000 },
          nudgeEvery: 2,
        })
      ).goal;
      const row = scheduler.repo.getBySource('goal', goal.id)!;
      expect(row).toMatchObject({ cadence: { kind: 'every', everyMs: 900000 }, nudgeEvery: 2 });
      for (const nudge of [false, true]) {
        const message = schedules.message(goal.id, { summary: 'A measured change', nudge });
        expect(message?.startsWith(`${NEO_GOAL_CYCLE}\n\nGoal`)).toBe(true);
        expect(message).toContain(`goalId ${goal.id}`);
        expect(message).toContain(`runId schedule:${row.id}:${row.nextRunAt}`);
      }
      expect(
        scheduler
          .source('reminder')!
          .message('reminder', { summary: 'Only this reminder', nudge: false })
      ).toBe('Only this reminder');
    } finally {
      db.close();
    }
  });

  test.each(['completed', 'archived', 'schedule_deleted', 'goal_deleted'] as const)(
    '%s during fact collection retires the wake without a failed delivery',
    async (change) => {
      const { db, call, scheduler, schedules } = setup();
      const goal = (await call('goal.session.create', { title: 'Ship', doneTest: 'Released' }))
        .goal;
      const row = scheduler.repo.getBySource('goal', goal.id)!;
      const jobs = new JobQueueRepository(db);
      const job = jobs.getJob(row.pendingJobId!)!;
      const clock = spyOn(Date, 'now').mockReturnValue(row.nextRunAt!);
      const deliveries: string[] = [];
      scheduler.registerSource({
        kind: 'goal',
        facts: async (id) => {
          const facts = await schedules.facts(id);
          if (change === 'schedule_deleted') scheduler.delete(scheduler.repo.get(row.id)!);
          else if (change === 'goal_deleted')
            db.prepare('DELETE FROM neo_goals WHERE id = ?').run(id);
          else await call('goal.session.update', { goalId: id, status: change });
          return facts;
        },
        message: (id, change) => schedules.message(id, change),
      });
      try {
        const handler = createSessionScheduleFire({
          scheduler,
          status: async () => 'done',
          deliver: async (_schedule, _messageId, text) => {
            deliveries.push(text);
          },
        });
        expect(await handler(job)).toEqual({ outcome: 'source_gone' });
        expect(deliveries).toEqual([]);
        if (change === 'goal_deleted')
          expect(scheduler.repo.get(row.id)).toMatchObject({ status: 'done', pendingJobId: null });
        else {
          expect(scheduler.repo.get(row.id)).toBeNull();
          expect(db.prepare('SELECT facts_lines FROM neo_goals WHERE id = ?').get(goal.id)).toEqual(
            {
              facts_lines: null,
            }
          );
        }
      } finally {
        clock.mockRestore();
        db.close();
      }
    }
  );
  test.each([false, true])(
    'reactivating after target_gone restores wakes (pause first: %s)',
    async (pauseFirst) => {
      const { db, call, scheduler } = setup();
      const jobs = new JobQueueRepository(db);
      let now = Date.now();
      const clock = spyOn(Date, 'now').mockImplementation(() => now);
      let available = false;
      const messages: string[] = [];
      try {
        const cadence = { kind: 'every', everyMs: 120000 };
        const goal = (
          await call('goal.session.create', {
            title: 'Return to the guide',
            doneTest: 'Published',
            cadence,
            nudgeEvery: 7,
          })
        ).goal;
        const handler = createSessionScheduleFire({
          scheduler,
          status: async () => (available ? 'done' : 'not_open'),
          deliver: async (_schedule, _messageId, text) => {
            messages.push(text);
          },
        });
        const fire = () => {
          const schedule = scheduler.repo.getBySource('goal', goal.id)!;
          now = schedule.nextRunAt!;
          return handler(jobs.getJob(schedule.pendingJobId!)!);
        };
        const before = scheduler.repo.getBySource('goal', goal.id)!;
        expect(await fire()).toEqual({ outcome: 'target_gone' });
        expect(scheduler.repo.get(before.id)?.status).toBe('done');
        expect(messages).toEqual([]);
        available = true;
        if (pauseFirst) await call('goal.session.update', { goalId: goal.id, status: 'paused' });
        await call('goal.session.update', { goalId: goal.id, status: 'active' });
        const after = scheduler.repo.getBySource('goal', goal.id)!;
        expect(after).toMatchObject({ status: 'active', cadence, nudgeEvery: 7 });
        expect(after.pendingJobId).not.toBeNull();
        expect(await fire()).toEqual({ outcome: 'fired' });
        expect(messages).toHaveLength(1);
        expect(messages[0]).toContain('Return to the guide');
      } finally {
        clock.mockRestore();
        db.close();
      }
    }
  );
  test.each(['completed', 'archived'] as const)(
    'reopening a %s goal preserves its configured cadence and nudge interval',
    async (status) => {
      const { db, call, scheduler } = setup();
      const cadence = { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' };
      const goal = (
        await call('goal.session.create', {
          title: 'Daily guide',
          doneTest: 'Published',
          cadence,
          nudgeEvery: 7,
        })
      ).goal;
      const before = scheduler.repo.getBySource('goal', goal.id)!;
      await call('goal.session.update', { goalId: goal.id, status });
      expect(scheduler.repo.get(before.id)).toBeNull();
      await call('goal.session.update', { goalId: goal.id, status: 'active' });
      const after = scheduler.repo.getBySource('goal', goal.id)!;
      expect(after.id).not.toBe(before.id);
      expect(after).toMatchObject({ cadence, nudgeEvery: 7, status: 'active' });
      db.close();
    }
  );
  test('reads, busy skips and failed delivery preserve facts_lines until a confirmed wake', async () => {
    const { db, call, scheduler } = setup();
    const jobs = new JobQueueRepository(db);
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    let busy = false;
    let failed = false;
    try {
      const goal = (await call('goal.session.create', { title: 'Ship', doneTest: 'Released' }))
        .goal;
      const handler = createSessionScheduleFire({
        scheduler,
        status: async () => (busy ? 'running' : 'done'),
        deliver: async () => {
          if (failed) throw new Error('offline');
        },
      });
      const fire = () => {
        const schedule = scheduler.repo.getBySource('goal', goal.id)!;
        now = schedule.nextRunAt!;
        return handler(jobs.getJob(schedule.pendingJobId!)!);
      };
      const stored = () =>
        (
          db.prepare('SELECT facts_lines FROM neo_goals WHERE id = ?').get(goal.id) as {
            facts_lines: string | null;
          }
        ).facts_lines;
      await call('goal.facts', { goalId: goal.id });
      expect(stored()).toBeNull();
      await fire();
      const baseline = stored();
      expect(JSON.parse(baseline!)).toContain('Progress: 0');
      await call('goal.session.update', { goalId: goal.id, progress: 20 });
      const delta = (await call('goal.facts', { goalId: goal.id })).facts;
      expect(delta.summary).toBe('- Progress: 0\n+ Progress: 20');
      expect(stored()).toBe(baseline);
      busy = true;
      expect(await fire()).toEqual({ outcome: 'skipped_busy' });
      expect(stored()).toBe(baseline);
      busy = false;
      failed = true;
      await expect(fire()).rejects.toThrow('offline');
      expect(stored()).toBe(baseline);
      expect((await call('goal.facts', { goalId: goal.id })).facts).toEqual(delta);
      failed = false;
      expect(await fire()).toEqual({ outcome: 'fired' });
      expect(JSON.parse(stored()!)).toContain('Progress: 20');
      expect((await call('goal.facts', { goalId: goal.id })).facts.summary).toBe('');
    } finally {
      clock.mockRestore();
      db.close();
    }
  });
  test('linked asks, todos, pack PRs and answered questions change the same facts Neo reads', async () => {
    let state = 'open';
    const { db, call, schedules } = setup([
      {
        id: 'coding',
        describe: 'Coding',
        instructions: () => null,
        snapshotRows: () => [
          { todoId: 'linked', pr: 'verify/demo#8', state },
          { todoId: 'unrelated', pr: 'verify/demo#9', state },
        ],
      },
    ]);
    const goal = (await call('goal.session.create', { title: 'Ship', doneTest: 'Released' })).goal;
    const asks = new NeoAskTodoRepository(db);
    asks.openAsk({
      id: 'ask',
      goalId: goal.id,
      projectId: null,
      sessionId: 'neo:root',
      originMessageId: null,
      title: 'Release',
      request: 'Ship',
      createdAt: 1,
    });
    asks.addTodo(
      'linked',
      'ask',
      { title: 'Merge', doneWhen: 'Merged', check: null, instruction: null, named: null },
      1
    );
    const question = asks.askQuestion(
      'q',
      'ask',
      {
        text: 'Ship now?',
        kind: 'yesno',
        options: null,
        multiple: false,
        noLabel: 'No',
        yesLabel: 'Yes',
        startTodos: null,
      },
      1
    );
    const before = (await call('goal.facts', { goalId: goal.id })).facts;
    expect(before.lines).toContain('Ask ask "Release": open');
    expect(before.lines).toContain('Todo linked "Merge": todo');
    expect(before.summary).toContain('verify/demo#8');
    expect(before.summary).not.toContain('verify/demo#9');
    expect(before.summary).not.toContain('Ship now?');
    (await schedules.facts(goal.id))!.commit();
    state = 'merged';
    asks.answerQuestion(question, 'yes', 'button', 2);
    const after = (await call('goal.facts', { goalId: goal.id })).facts;
    expect(after.digest).not.toBe(before.digest);
    expect(after.summary).toContain('"state":"merged"');
    expect(after.summary).toContain('Answer q "Ship now?": "yes"');
    expect(after.summary).not.toContain('Todo linked');
    db.close();
  });
  test('one schedule follows pause, resume, completion and reopening', async () => {
    const { db, call, scheduler, schedules } = setup();
    const goal = (await call('goal.session.create', { title: 'Ship', doneTest: 'Released' })).goal;
    const first = scheduler.repo.getBySource('goal', goal.id)!;
    expect(first).toMatchObject({
      target: { adapter: 'hyperneo', id: 'neo:root' },
      cadence: { kind: 'every', everyMs: 3600000 },
      nudgeEvery: 4,
      status: 'active',
    });
    schedules.sync(goal);
    expect(scheduler.repo.getBySource('goal', goal.id)?.id).toBe(first.id);
    scheduler.pause(first);
    await call('goal.session.update', { goalId: goal.id, progress: 20 });
    expect(scheduler.repo.get(first.id)?.status).toBe('paused');
    await call('goal.session.update', { goalId: goal.id, status: 'active' });
    await call('goal.session.update', { goalId: goal.id, status: 'paused' });
    expect(scheduler.repo.get(first.id)).toMatchObject({ status: 'paused', pendingJobId: null });
    await call('goal.session.update', { goalId: goal.id, status: 'active' });
    expect(scheduler.repo.get(first.id)).toMatchObject({
      status: 'active',
      pendingJobId: expect.any(String),
    });
    await call('goal.session.update', { goalId: goal.id, status: 'completed' });
    expect(scheduler.repo.get(first.id)).toBeNull();
    expect(await schedules.facts(goal.id)).toBeNull();
    await call('goal.session.update', { goalId: goal.id, status: 'active' });
    expect(scheduler.repo.getBySource('goal', goal.id)?.status).toBe('active');
    await call('goal.session.update', { goalId: goal.id, status: 'archived' });
    expect(scheduler.repo.getBySource('goal', goal.id)).toBeNull();
    db.close();
  });

  test('invalid cadence creates neither a goal nor a job; facts are scoped and reads preserve the delta', async () => {
    const { db, call, goals, schedules } = setup();
    expect(
      await call('goal.session.create', {
        title: 'Ship',
        doneTest: 'Released',
        cadence: { kind: 'every', everyMs: 1000 },
      })
    ).toMatchObject({ accepted: false, reason: expect.stringContaining('invalid_cadence') });
    expect(goals.list('neo:root', false)).toEqual([]);
    const goal = (await call('goal.session.create', { title: 'Ship', metrics: { z: 0, a: 1 } }))
      .goal;
    const first = await call('goal.facts', { goalId: goal.id });
    expect(first.facts.lines).toEqual(['Metric a: 1', 'Metric z: 0', 'Progress: 0']);
    expect(await call('goal.facts', { goalId: goal.id })).toEqual(first);
    expect(
      await call(
        'goal.facts',
        { goalId: goal.id },
        { source: 'mcp', role: 'neo', sessionId: 'neo:other' }
      )
    ).toMatchObject({ accepted: true });
    (await schedules.facts(goal.id))!.commit();
    await call('goal.session.update', { goalId: goal.id, metrics: { a: 1, z: 0 } });
    expect((await call('goal.facts', { goalId: goal.id })).facts).toMatchObject({
      digest: first.facts.digest,
      summary: '',
    });
    await call('goal.session.update', { goalId: goal.id, progress: 20 });
    expect((await call('goal.facts', { goalId: goal.id })).facts.summary).toBe(
      '- Progress: 0\n+ Progress: 20'
    );
    db.close();
  });
});

describe('session-owned goals', () => {
  test('root Neo creates, reads and lists its own goal; a goal needs metrics or a done-test', async () => {
    const { db, call } = setup();
    expect(await call('goal.session.create', { title: 'Grow OAP' })).toEqual({
      accepted: false,
      reason: 'done_test_required: give the goal metrics or a written doneTest.',
    });
    const created = await call('goal.session.create', {
      title: 'Grow OAP',
      doneTest: 'Three outside projects run an OAP adapter',
      mandateRef: 'mandate.md#oap-adoption',
    });
    expect(created.goal).toMatchObject({
      ownerSessionId: 'neo:root',
      status: 'active',
      doneTest: 'Three outside projects run an OAP adapter',
      mandateRef: 'mandate.md#oap-adoption',
    });
    expect((await call('goal.session.get', { goalId: created.goal.id })).goal.title).toBe(
      'Grow OAP'
    );
    expect(
      (await call('goal.session.list', {})).goals.map((goal: { title: string }) => goal.title)
    ).toEqual(['Grow OAP']);
    expect(
      db
        .prepare('SELECT event_type, source, space_id FROM space_goal_events WHERE goal_id = ?')
        .all(created.goal.id)
    ).toEqual([]);
    db.close();
  });

  test('another session reaches the goal, and a human names the owner', async () => {
    const { db, call } = setup();
    const created = await call('goal.session.create', { title: 'Ship', metrics: { adopters: 0 } });
    const other: OperationCaller = { source: 'mcp', sessionId: 'neo:other', role: 'neo' };
    expect(await call('goal.session.get', { goalId: created.goal.id }, other)).toMatchObject({
      accepted: true,
      goal: { id: created.goal.id },
    });
    expect(await call('goal.session.list', { ownerSessionId: 'neo:root' }, other)).toMatchObject({
      accepted: true,
    });
    expect(await call('goal.session.list', {}, human)).toMatchObject({
      reason: expect.stringContaining('owner_unresolved'),
    });
    expect(
      (
        await call(
          'goal.session.get',
          { ownerSessionId: 'neo:root', goalId: created.goal.id },
          human
        )
      ).goal.id
    ).toBe(created.goal.id);
    expect(
      await call(
        'goal.session.create',
        { ownerSessionId: 'neo:typo', title: 'X', doneTest: 'Y' },
        human
      )
    ).toEqual({ accepted: false, reason: 'owner_unknown: no session neo:typo.' });
    db.close();
  });

  test('completing a goal records it, closes it from the default list, and keeps the done-test rule', async () => {
    const { db, call, audited } = setup();
    const created = await call('goal.session.create', { title: 'Ship', doneTest: 'Released' });
    expect(await call('goal.session.update', { goalId: created.goal.id })).toEqual({
      accepted: false,
      reason: 'nothing_to_update: name at least one field to change.',
    });
    expect(
      await call('goal.session.update', { goalId: created.goal.id, doneTest: null })
    ).toMatchObject({ reason: expect.stringContaining('done_test_required') });
    const updated = await call(
      'goal.session.update',
      { ownerSessionId: 'neo:root', goalId: created.goal.id, status: 'completed', progress: 100 },
      human
    );
    expect(updated.goal).toMatchObject({
      status: 'completed',
      progress: 100,
      completedAt: expect.any(Number),
    });
    expect((await call('goal.session.list', {})).goals).toEqual([]);
    expect(
      (await call('goal.session.update', { goalId: created.goal.id, status: 'active' })).goal
    ).toMatchObject({ status: 'active', completedAt: null });
    await call('goal.session.update', { goalId: created.goal.id, status: 'completed' });
    expect((await call('goal.session.list', { includeClosed: true })).goals).toHaveLength(1);
    expect(
      db
        .prepare(
          'SELECT event_type, source FROM space_goal_events WHERE goal_id = ? ORDER BY rowid'
        )
        .all(created.goal.id)
    ).toEqual([]);
    expect(audited).toEqual([
      'goal.session.create',
      'goal.session.update',
      'goal.session.update',
      'goal.session.update',
    ]);
    db.close();
  });

  test('Space goal reads never see a session goal', async () => {
    const { db, call } = setup();
    const created = await call('goal.session.create', { title: 'Ship', doneTest: 'Released' });
    const spaceGoals = new SpaceGoalRepository(db);
    expect(spaceGoals.getById(created.goal.id)).toBeNull();
    expect(spaceGoals.listAllActive()).toEqual([]);
    db.close();
  });

  test('any session owns goals and works on goals it does not own', async () => {
    const { db, call } = setup();
    const worker: OperationCaller = {
      source: 'mcp',
      sessionId: 'neo:other',
      role: 'workflow_worker',
    };
    const created = await call('goal.session.create', { title: 'Shared', doneTest: 'Done' });
    expect(
      (await call('goal.session.create', { title: 'Mine', doneTest: 'Done' }, worker)).goal
    ).toMatchObject({ ownerSessionId: 'neo:other' });
    expect(await call('goal.session.get', { goalId: created.goal.id }, worker)).toMatchObject({
      accepted: true,
      goal: { ownerSessionId: 'neo:root' },
    });
    expect(
      await call('goal.session.update', { goalId: created.goal.id, title: 'Shared 2' }, worker)
    ).toMatchObject({ accepted: true, goal: { title: 'Shared 2' } });
    expect(await call('goal.session.list', { ownerSessionId: 'neo:root' }, worker)).toMatchObject({
      accepted: true,
    });
    expect(
      await call(
        'goal.journal.append',
        { goalId: created.goal.id, done: 'helped', effect: 'goal progressed', worked: 'more' },
        worker
      )
    ).toMatchObject({ accepted: true });
    db.close();
  });
});

describe('deleting the owner session', () => {
  test('removes its goals and their events, and leaves other sessions’ goals', async () => {
    const { db, call } = setup();
    db.exec('PRAGMA foreign_keys = ON');
    const mine = (await call('goal.session.create', { title: 'Mine', doneTest: 'Done' })).goal;
    const other: OperationCaller = { source: 'mcp', sessionId: 'neo:other', role: 'neo' };
    const kept = (await call('goal.session.create', { title: 'Kept', doneTest: 'Done' }, other))
      .goal;
    new SessionRepository(db).deleteSession('neo:root');
    expect(new SessionGoalRepository(db).get(mine.id)).toBeNull();
    expect(new SessionGoalRepository(db).get(kept.id)?.title).toBe('Kept');
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM space_goal_events WHERE goal_id = ?').get(mine.id)
    ).toEqual({ n: 0 });
    db.close();
  });
});

describe('goal journal', () => {
  test('a retried run keeps its entry id, so a page cursor on it still works; an unknown cursor is refused', async () => {
    const { db, call } = setup();
    const goal = (await call('goal.session.create', { title: 'Grow', doneTest: 'Ten adopters' }))
      .goal;
    const append = (runId: string, effect: string) =>
      call('goal.journal.append', { goalId: goal.id, runId, done: runId, effect, worked: 'w' });
    await append('a', 'first');
    const b = (await append('b', 'first')).entry;
    const retried = (await append('b', 'second')).entry;
    expect(retried).toMatchObject({ id: b.id, effect: 'second' });
    expect(
      (await call('goal.journal.list', { goalId: goal.id, before: b.id })).entries.map(
        (entry: { runId: string }) => entry.runId
      )
    ).toEqual(['a']);
    expect(await call('goal.journal.list', { goalId: goal.id, before: 'missing' })).toEqual({
      accepted: false,
      reason: 'cursor_not_found: before names no entry of this goal; list again without it.',
    });
    db.close();
  });

  test('pages through entries written in the same millisecond without skipping any', async () => {
    const { db, call } = setup();
    const goal = (await call('goal.session.create', { title: 'Grow', doneTest: 'Ten adopters' }))
      .goal;
    for (const runId of ['a', 'b', 'c'])
      await call('goal.journal.append', {
        goalId: goal.id,
        runId,
        done: runId,
        effect: 'e',
        worked: 'w',
      });
    db.exec('UPDATE goal_journal SET created_at = 5');
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 4; page++) {
      const entries = (
        await call('goal.journal.list', {
          goalId: goal.id,
          limit: 1,
          ...(before ? { before } : {}),
        })
      ).entries as { id: string; runId: string }[];
      if (!entries.length) break;
      seen.push(entries[0].runId);
      before = entries[0].id;
    }
    expect(seen).toEqual(['c', 'b', 'a']);
    db.close();
  });

  test('a cycle appends one entry per run, newest first, and other sessions reach it', async () => {
    const { db, call, audited } = setup();
    const goal = (await call('goal.session.create', { title: 'Grow', doneTest: 'Ten adopters' }))
      .goal;
    const entry = {
      goalId: goal.id,
      done: 'Opened the adapter guide PR',
      effect: 'Two projects asked for the guide',
      evidence: [{ kind: 'pr', ref: 'https://github.com/lsm/oap/pull/9' }],
      worked: 'Answering adopters in their issues',
    };
    await call('goal.journal.append', { ...entry, runId: 'run-1' });
    await call('goal.journal.append', { ...entry, runId: 'run-1', effect: 'Three projects asked' });
    await call('goal.journal.append', { ...entry, runId: 'run-2', done: 'Published the guide' });
    const listed = await call('goal.journal.list', { goalId: goal.id });
    expect(
      listed.entries.map((item: { runId: string; done: string; effect: string }) => [
        item.runId,
        item.done,
        item.effect,
      ])
    ).toEqual([
      ['run-2', 'Published the guide', 'Two projects asked for the guide'],
      ['run-1', 'Opened the adapter guide PR', 'Three projects asked'],
    ]);
    expect(listed.entries[0]).toMatchObject({
      sessionId: 'neo:root',
      evidence: [{ kind: 'pr', ref: 'https://github.com/lsm/oap/pull/9' }],
      failed: null,
    });
    const other: OperationCaller = { source: 'mcp', sessionId: 'neo:other', role: 'neo' };
    expect(
      await call('goal.journal.append', { ...entry, runId: 'run-other' }, other)
    ).toMatchObject({ accepted: true });
    expect(
      (await call('goal.journal.list', { goalId: goal.id })).entries.map(
        (item: { runId: string }) => item.runId
      )
    ).toEqual(['run-other', 'run-2', 'run-1']);
    expect(audited.filter((name) => name === 'goal.journal.append')).toHaveLength(4);
    db.close();
  });
});
