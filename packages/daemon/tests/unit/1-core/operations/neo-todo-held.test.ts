import { afterEach, describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { planNeoTodoEdit } from '../../../../src/lib/neo/todo-operations.ts';
import { createNeoTodoRunner, planNeoTodoCheck } from '../../../../src/lib/neo/todo-runner.ts';
import type { OperationOutcome } from '../../../../src/lib/operations/invoke.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const completed = (value: unknown): OperationOutcome =>
  ({ kind: 'completed', value }) as OperationOutcome;

function world() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  db.prepare(
    "INSERT INTO neo_conversation (singleton,id,created_at) VALUES (1,'conversation',0)"
  ).run();
  new JobQueueRepository(db).commitSubmissionReceipt('neo-turn-report:v2:cutoff', 'v2', () => 0);
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  const started: string[] = [];
  const runner = createNeoTodoRunner({
    limits: () => ({ running: 99, perGroup: 99 }),
    write: gatewayFor(db).run.bind(gatewayFor(db)),
    store,
    sessions,
    invoke: async (_caller, name, input) => {
      if (name === 'work.start') {
        started.push(String(input.todoId));
        return completed({
          ok: true,
          value: { ref: { adapter: 'hyperneo', id: `w-${started.length}` } },
        });
      }
      return completed({ ok: true, value: { status: 'running', lastActivityAt: Date.now() } });
    },
    packs: () => [],
    tell: async () => {},
    changed: () => {},
  });
  store.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: 'm1',
    title: 'Settings review',
    request: 'Settings review',
    createdAt: 1,
  });
  const add = (id: string) => {
    const todo = store.addTodo(
      id,
      'ask',
      { title: id, doneWhen: 'done', check: null, instruction: 'Do it.', named: null },
      1
    );
    sessions.create(todo.id, {
      verb: 'start',
      adapter: 'hyperneo',
      place: { machine: 'laptop', name: 'repo', folder: '/repo' },
    });
    return todo.id;
  };
  const todo = (id: string) => store.getTodo(id) as NeoTodo;
  const edit = async (id: string, hold: string | null) => {
    const plan = planNeoTodoEdit(todo(id), { todoId: id, hold });
    if ('reason' in plan) return plan.reason;
    return runner.recompute(todo(id), plan.value.patch);
  };
  return { db, store, runner, started, add, todo, edit };
}

let current: ReturnType<typeof world> | null = null;
afterEach(() => {
  current?.db.close();
  current = null;
});

describe('a held todo', () => {
  test('is never started, by plan advancement or by an explicit start, until it is released', async () => {
    const w = (current = world());
    const first = w.add('first');
    const second = w.add('second');
    await w.runner.start(first);
    await w.edit(second, 'The human said not to start it yet.');
    expect(w.todo(second)).toMatchObject({
      state: 'blocked',
      blockedBy: 'held',
      blockedReason: 'The human said not to start it yet.',
    });
    await w.runner.recompute(w.todo(first), { state: 'done', finishedAt: Date.now() });
    await w.runner.refresh(() => {});
    expect(await w.runner.start(second)).toMatchObject({ ok: false });
    expect(w.started).toEqual([first]);
    expect(w.todo(second).blockedBy).toBe('held');

    await w.edit(second, null);
    expect(w.todo(second)).toMatchObject({ state: 'todo', blockedBy: null });
    await w.runner.start(second);
    expect(w.started).toEqual([first, second]);
  });

  test('cannot be a todo that already started', async () => {
    const w = (current = world());
    const id = w.add('first');
    await w.runner.start(id);
    expect(await w.edit(id, 'Wait.')).toMatchObject({ ok: false });
    expect(w.todo(id).state).toBe('doing');
  });

  test('keeps its hold through a failing or blocking check, and still finishes when the work is done', async () => {
    const w = (current = world());
    const id = w.add('first');
    await w.edit(id, 'Wait for the human.');
    for (const judgement of [
      { state: 'failed' as const, reason: 'CI failed' },
      { state: 'blocked' as const, reason: 'Needs review' },
    ]) {
      await w.runner.recompute(w.todo(id), {}, Date.now(), judgement);
      expect(w.todo(id)).toMatchObject({ state: 'blocked', blockedBy: 'held' });
    }
    await w.runner.recompute(w.todo(id), {}, Date.now(), { state: 'done', evidence: 'Merged' });
    expect(w.todo(id).state).toBe('done');
  });

  test('cannot be held or released together with ticking it done', () => {
    const w = (current = world());
    const id = w.add('first');
    expect(
      planNeoTodoEdit(w.todo(id), { todoId: id, hold: 'Wait.', done: 'met', evidence: 'x' })
    ).toMatchObject({ reason: { ok: false } });
  });

  test("keeps its hold when a pack's own check reports a failure", async () => {
    const w = (current = world());
    const id = w.add('first');
    await w.edit(id, 'Wait for the human.');
    expect(
      planNeoTodoCheck(w.todo(id), { done: false, failed: 'CI failed', evidence: null }, 5, false)
    ).toBe(null);
  });

  test('can hold a todo still waiting on its start card', async () => {
    const w = (current = world());
    const id = w.add('first');
    w.store.updateTodo(
      w.todo(id),
      {
        state: 'blocked',
        blockedBy: 'question',
        blockedReason: 'Waiting for the human to start it.',
        nextAction: 'Answer the start question.',
      },
      2
    );
    await w.edit(id, 'Not this one yet.');
    expect(w.todo(id)).toMatchObject({ state: 'blocked', blockedBy: 'held' });
  });
});
