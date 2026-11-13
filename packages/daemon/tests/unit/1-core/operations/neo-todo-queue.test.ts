import { afterEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import type { OperationOutcome } from '../../../../src/lib/operations/invoke.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const completed = (value: unknown): OperationOutcome =>
  ({ kind: 'completed', value }) as OperationOutcome;

function world(limits = { running: 6, perGroup: 3 }, broken = false, refuseStart = false) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  db.prepare(
    "INSERT INTO neo_conversation (singleton,id,created_at) VALUES (1,'conversation',0)"
  ).run();
  db.exec(
    "INSERT INTO neo_concerns (id,title,summary,context,revision,created_at,updated_at) VALUES ('p','P','','',1,1,1), ('q','Q','','',1,1,1)"
  );
  new JobQueueRepository(db).commitSubmissionReceipt('neo-turn-report:v2:cutoff', 'v2', () => 0);
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  const started: string[] = [];
  const told: { id: string; note: string; key?: string }[] = [];
  const idle = new Set<string>();
  const unreadable = new Set<string>();
  let workers = 0;
  const runner = createNeoTodoRunner({
    write: gatewayFor(db).run.bind(gatewayFor(db)),
    store,
    sessions,
    invoke: async (_caller, name, input) => {
      if (name === 'work.start') {
        if (refuseStart)
          return completed({
            ok: false,
            reason: 'place_refused',
            detail: 'Synthetic place refusal',
          });
        const ref = { adapter: 'hyperneo', id: `worker-${++workers}` };
        started.push(String(input.todoId));
        return completed({ ok: true, value: { ref } });
      }
      if (name === 'work.send') {
        started.push(String((input.ref as { id: string }).id));
        return completed({ ok: true, value: { delivered: true } });
      }
      if (unreadable.has(String((input.ref as { id?: string } | undefined)?.id)))
        return completed({ ok: false, reason: 'unreachable', detail: 'synthetic status failure' });
      return completed({
        ok: true,
        value: {
          status: idle.has(String((input.ref as { id?: string } | undefined)?.id))
            ? 'done'
            : 'running',
          lastActivityAt: Date.now(),
        },
      });
    },
    packs: () => [],
    tell: async (_ask, todo, note, key) => {
      told.push({ id: todo.id, note, key });
    },
    changed: () => {},
    limits: () => {
      if (broken) throw new Error('synthetic queue failure');
      return limits;
    },
  });
  let asks = 0;
  const ask = (projectId: string | null = 'p') => {
    const id = `ask-${++asks}`;
    store.openAsk({
      id,
      projectId,
      sessionId: 'neo',
      originMessageId: id,
      title: id,
      request: id,
      createdAt: asks,
    });
    return id;
  };
  const approved = (projectId: string | null = 'p') => {
    const id = ask(projectId);
    const step = store.addTodo(
      `${id}-step`,
      id,
      {
        approvedAt: 1,
        title: 'First step',
        doneWhen: 'done',
        check: null,
        instruction: 'Do it.',
        named: null,
      },
      0
    );
    db.prepare(
      "UPDATE neo_todos SET state = 'done', started_at = 1, finished_at = 2 WHERE id = ?"
    ).run(step.id);
    return id;
  };
  let created = 0;
  const add = (
    askId: string,
    target: { verb: 'send'; ref: { adapter: string; id: string } } | null = null,
    dependsOn: string[] | null = null
  ) => {
    const todo = store.addTodo(
      `t${++created}`,
      askId,
      {
        approvedAt: 1,
        title: `t${created}`,
        doneWhen: 'done',
        check: null,
        instruction: 'Do it.',
        named: null,
        dependsOn,
      },
      created
    );
    sessions.create(
      todo.id,
      target ?? {
        verb: 'start',
        adapter: 'hyperneo',
        place: { machine: 'laptop', name: 'repo', folder: '/repo' },
      }
    );
    return todo.id;
  };
  const state = (id: string) => (store.getTodo(id) as NeoTodo).state;
  const finish = async (id: string) => {
    await runner.recompute(store.getTodo(id)!, { state: 'done', finishedAt: Date.now() });
  };
  const tick = () => runner.refresh(() => {});
  return {
    db,
    store,
    sessions,
    idle,
    unreadable,
    runner,
    clock,
    started,
    told,
    ask,
    approved,
    add,
    state,
    finish,
    tick,
  };
}

let current: ReturnType<typeof world> | null = null;
afterEach(() => {
  current?.clock.mockRestore();
  current?.db.close();
  current = null;
});

describe('queued todos start themselves', () => {
  test('free slots start waiting todos first come, first served, and a finished one makes room', async () => {
    const w = (current = world({ running: 2, perGroup: 2 }));
    const [a, b, c] = [w.add(w.approved()), w.add(w.approved()), w.add(w.approved())];
    await w.tick();
    expect(w.started).toEqual([a, b]);
    expect(w.state(c)).toBe('todo');
    await w.finish(a);
    await w.tick();
    expect(w.started).toEqual([a, b, c]);
  });

  test('never more running than the overall cap or a project cap', async () => {
    const w = (current = world({ running: 3, perGroup: 2 }));
    const p = [w.add(w.approved('p')), w.add(w.approved('p')), w.add(w.approved('p'))];
    const q = [w.add(w.approved('q')), w.add(w.approved('q'))];
    await w.tick();
    await w.tick();
    expect(w.started).toEqual([p[0], p[1], q[0]]);
    expect([...p, ...q].filter((id) => w.state(id) === 'doing')).toHaveLength(3);
  });

  test('one todo at a time per worker', async () => {
    const w = (current = world());
    const ref = { adapter: 'codex-desktop', id: 'thread-1' };
    const first = w.add(w.approved(), { verb: 'send', ref });
    const second = w.add(w.approved(), { verb: 'send', ref });
    w.idle.add(ref.id);
    await w.tick();
    expect([w.state(first), w.state(second)]).toEqual(['doing', 'todo']);
    await w.finish(first);
    await w.tick();
    expect(w.state(second)).toBe('doing');
  });

  test("an ask's later todo waits for the earlier one it names", async () => {
    const w = (current = world());
    const ask = w.approved();
    const first = w.add(ask);
    const second = w.add(ask, null, [first]);
    await w.tick();
    expect([w.state(first), w.state(second)]).toEqual(['doing', 'todo']);
  });

  test('an unapproved ready step tells Neo once without a start card', async () => {
    const w = (current = world());
    const todo = w.add(w.ask());
    w.store.updateTodo(w.store.getTodo(todo)!, { approvedAt: null }, 1);
    await w.tick();
    expect(w.state(todo)).toBe('todo');
    expect(w.started).toEqual([]);
    expect(w.store.listQuestions(w.store.getTodo(todo)!.askId)).toEqual([]);
    expect(w.told).toHaveLength(1);
    expect(w.told[0]).toMatchObject({ id: todo, key: `neo-todo-unworked:${todo}` });
    expect(w.told[0].note).toContain('not approved');
    await w.tick();
    expect(w.told).toHaveLength(1);
  });

  test('a step waits while its ask has an open question for the human', async () => {
    const w = (current = world());
    const ask = w.approved();
    const todo = w.add(ask);
    w.store.askQuestion(
      'q',
      ask,
      {
        text: 'Which way?',
        kind: 'reply',
        options: null,
        multiple: false,
        noLabel: null,
        yesLabel: null,
        startTodos: null,
        todoId: null,
      },
      3
    );
    await w.tick();
    expect(w.state(todo)).toBe('todo');
  });

  test('todos outside any project share only the overall cap', async () => {
    const w = (current = world({ running: 6, perGroup: 1 }));
    const todos = [w.add(w.approved(null)), w.add(w.approved(null)), w.add(w.approved(null))];
    await w.tick();
    expect(todos.map(w.state)).toEqual(['doing', 'doing', 'doing']);
  });

  test('overlapping fills never start more than the cap', async () => {
    const w = (current = world({ running: 1, perGroup: 1 }));
    w.add(w.approved());
    w.add(w.approved());
    await Promise.all([w.runner.fill(), w.runner.fill()]);
    expect(w.started).toHaveLength(1);
  });

  test('a todo the human left unticked in the start answer is held, not queued', async () => {
    const w = (current = world());
    const ask = w.approved();
    const [ticked, unticked] = [w.add(ask), w.add(ask)];
    for (const id of [ticked, unticked]) {
      w.store.updateTodo(w.store.getTodo(id)!, { approvedAt: null }, 2);
      w.store.joinStartQuestion(w.store.getTodo(id)!, 2);
      w.store.updateTodo(
        w.store.getTodo(id)!,
        { state: 'blocked', blockedBy: 'question', blockedReason: 'Waiting for the human.' },
        2
      );
    }
    const question = w.store.listQuestions(ask).find((item) => item.kind === 'start')!;
    w.store.answerQuestion(question, [ticked], 'button', 3);
    expect(w.store.getTodo(unticked)).toMatchObject({
      state: 'blocked',
      blockedBy: 'held',
      blockedReason: 'Not ticked in the start answer.',
    });
    await w.finish(ticked);
    await w.tick();
    expect(w.state(unticked)).toBe('blocked');
  });

  test('a withdrawn start question leaves its todos held, not queued', async () => {
    const w = (current = world());
    const ask = w.approved();
    const todo = w.add(ask);
    w.store.updateTodo(w.store.getTodo(todo)!, { approvedAt: null }, 2);
    w.store.joinStartQuestion(w.store.getTodo(todo)!, 2);
    w.store.updateTodo(
      w.store.getTodo(todo)!,
      { state: 'blocked', blockedBy: 'question', blockedReason: 'Waiting for the human.' },
      2
    );
    const question = w.store.listQuestions(ask).find((item) => item.kind === 'start')!;
    w.store.retireQuestion(question, 'Neo withdrew it', null, 3);
    expect(w.store.getTodo(todo)).toMatchObject({
      state: 'blocked',
      blockedBy: 'held',
      blockedReason: 'Start question withdrawn.',
    });
    await w.tick();
    expect(w.started).toEqual([]);
  });

  test('an urgent todo starts before older normal work when one slot is free', async () => {
    const w = (current = world({ running: 1, perGroup: 1 }));
    const older = w.add(w.approved());
    const urgent = w.add(w.approved());
    w.store.updateTodo(w.store.getTodo(urgent)!, { priority: 'urgent' }, 5);
    await w.tick();
    expect(w.started).toEqual([urgent]);
    expect(w.state(older)).toBe('todo');
  });

  test('a failing queue fill does not undo the completion that triggered it', async () => {
    const w = (current = world(undefined, true));
    const ask = w.approved();
    const first = w.add(ask);
    w.add(ask);
    w.store.updateTodo(w.store.getTodo(first)!, { state: 'doing', startedAt: 3 }, 3);
    await w.finish(first);
    expect(w.state(first)).toBe('done');
  });

  test('todos whose workers sit idle do not fill the running cap', async () => {
    const w = (current = world({ running: 2, perGroup: 2 }));
    const idle = [w.add(w.approved()), w.add(w.approved())];
    await w.tick();
    expect(idle.map(w.state)).toEqual(['doing', 'doing']);
    w.idle.add('worker-1');
    w.idle.add('worker-2');
    await w.tick();
    expect(idle.map((id) => w.sessions.workerIdle(id))).toEqual([true, true]);
    const waiting = w.add(w.approved());
    await w.tick();
    expect(w.state(waiting)).toBe('doing');
  });

  test('a worker whose status cannot be read counts as busy again', async () => {
    const w = (current = world({ running: 1, perGroup: 1 }));
    const first = w.add(w.approved());
    await w.tick();
    w.idle.add('worker-1');
    await w.tick();
    expect(w.sessions.workerIdle(first)).toBe(true);
    w.idle.delete('worker-1');
    w.unreadable.add('worker-1');
    const waiting = w.add(w.approved());
    await w.tick();
    expect(w.sessions.workerIdle(first)).toBe(false);
    expect(w.state(waiting)).toBe('todo');
  });

  test('independent steps start together and a join waits for all of its prerequisites', async () => {
    const w = (current = world());
    const ask = w.approved();
    const left = w.add(ask, null, []);
    const right = w.add(ask, null, []);
    const join = w.add(ask, null, [left, right]);
    await w.tick();
    expect([w.state(left), w.state(right), w.state(join)]).toEqual(['doing', 'doing', 'todo']);
    await w.finish(left);
    await w.tick();
    expect(w.state(join)).toBe('todo');
    await w.finish(right);
    await w.tick();
    expect(w.state(join)).toBe('doing');
  });

  test('a dependency completion starts an approved step left on a start card without waking Neo', async () => {
    const w = (current = world());
    const ask = w.approved();
    const prerequisite = w.add(ask, null, []);
    const next = w.add(ask, null, [prerequisite]);
    w.store.updateTodo(w.store.getTodo(next)!, { state: 'blocked', blockedBy: 'question' }, 2);
    await w.tick();
    expect(w.started).toEqual([prerequisite]);
    await w.finish(prerequisite);
    await w.tick();
    expect(w.started).toEqual([prerequisite, next]);
    expect(w.told.filter((note) => note.id === next)).toEqual([]);
    await w.tick();
    expect(w.started).toEqual([prerequisite, next]);
  });

  test('a ready step held by capacity tells Neo once and starts when a slot opens', async () => {
    const w = (current = world({ running: 1, perGroup: 1 }));
    const first = w.add(w.approved());
    const next = w.add(w.approved());
    await w.tick();
    expect(w.started).toEqual([first]);
    expect(w.told.filter((note) => note.id === next)).toHaveLength(1);
    expect(w.told.find((note) => note.id === next)?.note).toContain('capacity');
    await w.tick();
    expect(w.told.filter((note) => note.id === next)).toHaveLength(1);
    await w.finish(first);
    await w.tick();
    expect(w.started).toEqual([first, next]);
  });

  test('a refused place tells Neo once and waits on one retries card', async () => {
    const w = (current = world({ running: 6, perGroup: 3 }, false, true));
    const todo = w.add(w.approved());
    await w.tick();
    expect(w.started).toEqual([]);
    expect(w.told.filter((note) => note.id === todo)).toHaveLength(1);
    expect(w.told.find((note) => note.id === todo)?.note).toContain('place_refused');
    expect(
      w.store
        .listQuestions(w.store.getTodo(todo)!.askId)
        .map(({ cause, todos }) => ({ cause, todos }))
    ).toEqual([{ cause: 'retries_exhausted', todos: [todo] }]);
    await w.tick();
    expect(w.told.filter((note) => note.id === todo)).toHaveLength(1);
  });

  test('a ready step with an instruction but no target tells Neo once', async () => {
    const w = (current = world());
    const todo = w.add(w.approved());
    w.db.prepare('DELETE FROM neo_todo_sessions WHERE todo_id = ?').run(todo);
    await w.tick();
    expect(w.started).toEqual([]);
    expect(w.told).toHaveLength(1);
    expect(w.told[0].note).toContain('target');
    await w.tick();
    expect(w.told).toHaveLength(1);
  });

  test('an ask whose start question the human answered may start released steps', async () => {
    const w = (current = world());
    const ask = w.ask();
    const todo = w.add(ask);
    w.store.updateTodo(w.store.getTodo(todo)!, { approvedAt: null }, 2);
    w.store.joinStartQuestion(w.store.getTodo(todo)!, 2);
    const question = w.store.listQuestions(ask).find((item) => item.kind === 'start')!;
    w.store.answerQuestion(question, [todo], 'button', 3);
    await w.tick();
    expect(w.state(todo)).toBe('doing');
  });
});
