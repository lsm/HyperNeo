import { afterEach, describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { WorkRef } from '../../../../src/lib/drivers/types.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import {
  CodingTodoPrRepository,
  createCodingTodoPack,
} from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import type { NeoWorkPrReader } from '../../../../src/lib/neo/packs/coding/work-prs.ts';
import { wireNeoTodoMutations } from '../../../../src/lib/neo/todo-mutation-operation.ts';
import {
  createNeoTodoOperations,
  planNeoTodoEdit,
} from '../../../../src/lib/neo/todo-operations.ts';
import { createNeoTodoRunner, planNeoTodoCheck } from '../../../../src/lib/neo/todo-runner.ts';
import { invokeOperation, type OperationOutcome } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const completed = (value: unknown): OperationOutcome =>
  ({ kind: 'completed', value }) as OperationOutcome;

function world(readPrs?: NeoWorkPrReader) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  db.prepare(
    "INSERT INTO neo_conversation (singleton,id,created_at) VALUES (1,'conversation',0)"
  ).run();
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  const started: string[] = [];
  const events: string[] = [];
  const packs = readPrs
    ? [
        {
          id: 'coding',
          describe: 'Coding',
          instructions: () => null,
          todos: createCodingTodoPack(new CodingTodoPrRepository(db), readPrs),
        },
      ]
    : [];
  const gateway = gatewayFor(db);
  const write = gateway.run.bind(gateway);
  const runner = createNeoTodoRunner({
    limits: () => ({ running: 99, perGroup: 99 }),
    write,
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
    packs: () => packs,
    tell: async () => {},
    attend: async ({ kind }) => {
      events.push(kind);
    },
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
      {
        approvedAt: 1,
        title: id,
        doneWhen: 'done',
        check: null,
        instruction: 'Do it.',
        named: null,
      },
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
  const controls = { ...runner, resolveTarget: async (ref: WorkRef) => ({ value: ref }) };
  const registry = createOperationRegistry(
    wireNeoTodoMutations(
      (writeHold) =>
        createNeoTodoOperations(
          store,
          sessions,
          controls,
          () => packs,
          () => null,
          undefined,
          undefined,
          writeHold
        ),
      {
        gateway,
        write,
        packs: () => packs,
        artifact: () => null,
        stop: runner.stop,
        userFolder: '/synthetic',
        resolveTarget: controls.resolveTarget,
        advance: runner.advance,
        changed: () => {},
        project: async (todos) => [...todos],
      }
    )
  );
  const hold = (id: string, urls: string[]) =>
    invokeOperation(
      registry,
      'neo.todo.hold',
      {
        todoId: id,
        reason: 'Wait for the named pull requests.',
        until: { pack: 'coding', kind: 'pr_merged', params: { urls } },
      },
      { source: 'mcp', role: 'neo', sessionId: 'neo' }
    );
  return { db, store, runner, started, add, todo, edit, hold, events };
}

let current: ReturnType<typeof world> | null = null;
afterEach(() => {
  current?.db.close();
  current = null;
});

describe('a held todo', () => {
  test('refresh uses the first matching result and waits for every named PR', async () => {
    const merged = 'https://github.com/example/demo/pull/1';
    const second = 'https://github.com/example/demo/pull/2';
    let missing = true;
    const w = (current = world(async (urls) =>
      urls
        .filter((url) => url === merged || (!missing && url === second))
        .flatMap((url) => [
          {
            url: url.replace('example/demo', 'Example/Demo'),
            state: 'MERGED',
            checks: 'none',
            review: 'none',
          },
          { url, state: 'CLOSED', checks: 'none', review: 'none' },
        ])
    ));
    const id = w.add('conditional');
    expect(await w.hold(id, [merged, second])).toMatchObject({
      kind: 'completed',
      value: { ok: true, todo: { blockedBy: 'held' } },
    });
    const refresh = () =>
      w.runner.refresh((_message, error) => {
        throw error;
      });
    await refresh();
    expect(w.todo(id).blockedBy).toBe('held');
    expect(w.events).toEqual([]);
    missing = false;
    await refresh();
    await refresh();
    expect(w.started).toEqual([id]);
    expect(w.events.filter((kind) => kind === 'todo.hold_released')).toHaveLength(1);
  });

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

  test('can hold a todo that already started', async () => {
    const w = (current = world());
    const id = w.add('first');
    await w.runner.start(id);
    await w.edit(id, 'Wait.');
    expect(w.todo(id)).toMatchObject({ state: 'blocked', blockedBy: 'held' });
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
      planNeoTodoCheck(w.todo(id), { done: false, failed: 'CI failed', evidence: null }, 5)
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
