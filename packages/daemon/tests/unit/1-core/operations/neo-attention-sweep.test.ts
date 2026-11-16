import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { NEO_ATTENTION_KINDS } from '../../../../src/lib/neo/attention/decide.ts';
import { createNeoAttentionSweep } from '../../../../src/lib/neo/attention/sweep.ts';
import {
  createNeoAttention,
  neoAttentionDelivery,
} from '../../../../src/lib/neo/attention/tell.ts';
import type { NeoPack } from '../../../../src/lib/neo/pack-contract.ts';
import {
  NeoAskTodoRepository,
  type NeoTodoDraft,
} from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const HOUR = 3_600_000;
const T0 = 1_000_000;
const ROOT = 'neo:root';
const draft: NeoTodoDraft = {
  title: 'Ship it',
  doneWhen: 'Shipped',
  check: null,
  named: null,
  instruction: 'Ship the change.',
  approvedAt: T0,
  dependsOn: [],
};
const ref = { adapter: 'hyperneo', id: 'worker-1' };

describe('the Neo attention sweep', () => {
  let db: Database;
  let store: NeoAskTodoRepository;
  let sessions: NeoTodoSessionRepository;
  let packs: NeoPack[];
  let limits: { running: number; perGroup: number };
  let sweep: (now: number) => Promise<void>;

  const wakes = () =>
    (
      db.prepare("SELECT payload FROM job_queue WHERE queue = 'mailbox'").all() as {
        payload: string;
      }[]
    ).map((row) => String(JSON.parse(row.payload).message.message.content));
  const digests = () =>
    (
      db.prepare("SELECT payload FROM job_queue WHERE queue = 'neo_notes'").all() as {
        payload: string;
      }[]
    ).map((row) => String(JSON.parse(row.payload).message.message.content));
  const add = (id: string, change: Partial<NeoTodoDraft> = {}) =>
    store.addTodo(id, 'ask-1', { ...draft, ...change }, T0);
  const started = (todo: NeoTodo, live: string) => {
    sessions.create(todo.id, { verb: 'send', ref });
    sessions.recordRef(todo.id, ref, T0);
    store.updateTodo(todo, { state: 'doing', startedAt: T0 }, T0);
    sessions.recordNudge(todo.id, { since: T0, nudges: 0, live });
    return store.getTodo(todo.id)!;
  };
  const failed = (todo: NeoTodo, at = T0) =>
    store.updateTodo(
      todo,
      { state: 'blocked', blockedBy: 'failure', blockedReason: 'CI keeps failing.' },
      at
    );

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    store = new NeoAskTodoRepository(db);
    sessions = new NeoTodoSessionRepository(db);
    store.openAsk({
      id: 'ask-1',
      title: 'Cache layer',
      request: 'Build the cache layer',
      sessionId: ROOT,
      projectId: null,
      originMessageId: null,
      createdAt: T0,
    });
    packs = [];
    limits = { running: 6, perGroup: 3 };
    sweep = createNeoAttentionSweep({
      sessions,
      packs: () => packs,
      limits: () => limits,
      tell: createNeoAttention({
        kinds: () => NEO_ATTENTION_KINDS,
        read: () => ({ covered: false, latestReportAt: null }),
        ...neoAttentionDelivery(
          db,
          () => ROOT,
          () => false
        ),
        dropped: () => {},
      }),
      failed: (_event, error) => {
        throw error;
      },
    });
  });
  afterEach(() => db.close());

  test('a failed todo with an idle worker is one message to Neo', async () => {
    failed(started(add('todo-1'), 'done'));
    await sweep(T0);
    await sweep(T0 + 5 * 60_000);
    expect(wakes()).toEqual([
      'Todo "Ship it" (todo-1) needs your next step: it failed: CI keeps failing. Continue it with new direction, start a fresh worker, or remove it.',
    ]);
  });

  test('a todo with no start target after its prerequisite finished wakes Neo', async () => {
    store.updateTodo(add('first'), { state: 'done', finishedAt: T0 }, T0);
    add('todo-1', { instruction: null, dependsOn: ['first'] });
    await sweep(T0);
    expect(wakes()).toEqual([
      'Todo "Ship it" (todo-1) needs your next step: its prerequisites are done and it has no instruction or worker. Write the instruction and start it, or remove it.',
    ]);
  });

  test('a todo waiting on an unfinished prerequisite is no message', async () => {
    add('first');
    add('todo-1', { instruction: null, dependsOn: ['first'] });
    sessions.create('first', { verb: 'start', adapter: 'hyperneo' } as never);
    await sweep(T0);
    expect(wakes()).toEqual([]);
  });

  test.each([
    ['the queue would start now', { running: 6, perGroup: 3 }],
    ['the queue holds at its limit', { running: 0, perGroup: 0 }],
  ])('a todo with a start target that %s is the daemon’s', async (_name, set) => {
    limits = set;
    const todo = add('todo-1');
    sessions.create(todo.id, { verb: 'start', adapter: 'hyperneo' } as never);
    await sweep(T0);
    expect(wakes()).toEqual([]);
  });

  test('an idle worker with an open pull request is the pack’s', async () => {
    started(add('todo-1'), 'done');
    packs = [{ id: 'coding', todos: { waiting: () => true } } as never];
    await sweep(T0);
    expect(wakes()).toEqual([]);
  });

  test('an idle worker with nothing to wait on wakes Neo', async () => {
    started(add('todo-1'), 'stopped');
    await sweep(T0);
    expect(wakes()).toEqual([
      'Todo "Ship it" (todo-1) needs your next step: its worker is idle and nothing is pending. Continue it, mark it done, or remove it.',
    ]);
  });

  test.each(['running', 'queued', undefined])(
    'a worker whose last status is %s is no message',
    async (live) => {
      const todo = started(add('todo-1'), 'done');
      sessions.recordNudge(todo.id, { since: T0, nudges: 0, ...(live ? { live } : {}) });
      await sweep(T0);
      expect(wakes()).toEqual([]);
    }
  );

  test('a todo Neo holds, one under an open card and an unapproved one are no message', async () => {
    store.updateTodo(
      started(add('held'), 'done'),
      { state: 'blocked', blockedBy: 'held', blockedReason: 'Human said wait.' },
      T0
    );
    const covered = failed(started(add('covered'), 'done'));
    store.askQuestion(
      'card',
      'ask-1',
      {
        text: 'Retry?',
        kind: 'choice',
        options: ['Retry', 'Remove'],
        multiple: false,
        noLabel: null,
        yesLabel: null,
        todos: [covered.id],
      },
      T0
    );
    add('unapproved', { approvedAt: null, instruction: null });
    await sweep(T0);
    expect(wakes()).toEqual([]);
  });

  test('an unapproved todo nobody was asked about is one digest line, and one more a day later', async () => {
    add('unapproved', { approvedAt: null });
    const line =
      'Todo "Ship it" (unapproved) cannot start: it was not approved. Review it with neo.todo.read.';
    await sweep(T0);
    await sweep(T0 + 5 * 60_000);
    expect(digests()).toEqual([line]);
    for (const hours of [24, 25, 48, 72]) await sweep(T0 + hours * HOUR);
    expect(digests()).toEqual([line, line]);
    expect(wakes()).toEqual([]);
  });

  test('an unapproved todo under an open card, and one the queue will start, are not told', async () => {
    const asked = add('asked', { approvedAt: null });
    store.askQuestion(
      'card',
      'ask-1',
      {
        text: 'Start it?',
        kind: 'choice',
        options: ['Start', 'Remove'],
        multiple: false,
        noLabel: null,
        yesLabel: null,
        todos: [asked.id],
      },
      T0
    );
    sessions.create(add('queued').id, {
      verb: 'start',
      adapter: 'hyperneo',
      place: { machine: 'laptop', name: 'repo', folder: '/repo' },
    });
    await sweep(T0);
    expect([wakes(), digests()]).toEqual([[], []]);
  });

  test('an unchanged Neo-owned todo still wakes after the last ladder step', async () => {
    failed(started(add('todo-1'), 'done'));
    const sent: number[] = [];
    for (let minutes = 0; minutes <= 73 * 60; minutes += 30) {
      const before = wakes().length;
      await sweep(T0 + minutes * 60_000);
      if (wakes().length > before) sent.push(minutes / 60);
    }
    expect(sent).toEqual([0, 1, 4, 24, 48, 72]);
  });

  test('a second failure starts its own ladder', async () => {
    const todo = failed(started(add('todo-1'), 'done'));
    await sweep(T0 + 5 * HOUR);
    failed(store.updateTodo(todo, { state: 'doing' }, T0 + 5 * HOUR), T0 + 6 * HOUR);
    await sweep(T0 + 6 * HOUR);
    await sweep(T0 + 6 * HOUR + 30 * 60_000);
    await sweep(T0 + 7 * HOUR);
    expect(wakes()).toHaveLength(3);
  });

  test('a finished todo that produces follow-up work with nothing after it wakes Neo on the ladder', async () => {
    const plan = add('todo-plan', { title: 'Write the plan', producesFollowUp: true });
    sessions.create(plan.id, { verb: 'start', adapter: 'hyperneo' } as never);
    await sweep(T0);
    expect(wakes()).toEqual([]);
    store.updateTodo(plan, { state: 'done', finishedAt: T0 }, T0);
    await sweep(T0);
    await sweep(T0 + 30 * 60_000);
    expect(wakes()).toEqual([
      'Todo "Write the plan" (todo-plan) in ask "Cache layer" (ask-1) finished and produces follow-up work, but no todo follows it. Add the follow-up todos it calls for with neo.todo.add after:["todo-plan"]; the ask cannot settle done until one exists.',
    ]);
    await sweep(T0 + HOUR);
    expect(wakes()).toHaveLength(2);
    add('todo-build', { title: 'Build it', approvedAt: null, dependsOn: ['todo-plan'] });
    await sweep(T0 + 4 * HOUR);
    expect(wakes()).toHaveLength(2);
  });

  test('a finished last todo without the marker raises nothing', async () => {
    store.updateTodo(add('todo-1'), { state: 'done', finishedAt: T0 }, T0);
    await sweep(T0);
    expect(wakes()).toEqual([]);
  });

  test('a settled ask raises nothing', async () => {
    const plan = add('todo-plan', { producesFollowUp: true });
    store.updateTodo(plan, { state: 'done', finishedAt: T0 }, T0);
    failed(started(add('todo-1'), 'done'));
    store.settleAsk(store.getAsk('ask-1')!, 'dropped', 'Not needed', T0);
    await sweep(T0);
    expect(wakes()).toEqual([]);
  });
});
