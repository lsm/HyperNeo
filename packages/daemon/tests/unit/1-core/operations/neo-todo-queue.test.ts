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

function world(limits = { running: 6, perProject: 3 }) {
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
  let workers = 0;
  const runner = createNeoTodoRunner({
    write: gatewayFor(db).run.bind(gatewayFor(db)),
    store,
    sessions,
    invoke: async (_caller, name, input) => {
      if (name === 'work.start') {
        const ref = { adapter: 'hyperneo', id: `worker-${++workers}` };
        started.push(String(input.todoId));
        return completed({ ok: true, value: { ref } });
      }
      if (name === 'work.send') {
        started.push(String((input.ref as { id: string }).id));
        return completed({ ok: true, value: { delivered: true } });
      }
      return completed({ ok: true, value: { status: 'running', lastActivityAt: Date.now() } });
    },
    packs: () => [],
    tell: async () => {},
    changed: () => {},
    limits: () => limits,
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
      { title: 'First step', doneWhen: 'done', check: null, instruction: 'Do it.', named: null },
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
    target: { verb: 'send'; ref: { adapter: string; id: string } } | null = null
  ) => {
    const todo = store.addTodo(
      `t${++created}`,
      askId,
      { title: `t${created}`, doneWhen: 'done', check: null, instruction: 'Do it.', named: null },
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
  return { db, clock, started, ask, approved, add, state, finish, tick };
}

let current: ReturnType<typeof world> | null = null;
afterEach(() => {
  current?.clock.mockRestore();
  current?.db.close();
  current = null;
});

describe('queued todos start themselves', () => {
  test('free slots start waiting todos first come, first served, and a finished one makes room', async () => {
    const w = (current = world({ running: 2, perProject: 2 }));
    const [a, b, c] = [w.add(w.approved()), w.add(w.approved()), w.add(w.approved())];
    await w.tick();
    expect(w.started).toEqual([a, b]);
    expect(w.state(c)).toBe('todo');
    await w.finish(a);
    await w.tick();
    expect(w.started).toEqual([a, b, c]);
  });

  test('never more running than the overall cap or a project cap', async () => {
    const w = (current = world({ running: 3, perProject: 2 }));
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
    await w.tick();
    expect([w.state(first), w.state(second)]).toEqual(['doing', 'todo']);
    await w.finish(first);
    await w.tick();
    expect(w.state(second)).toBe('doing');
  });

  test("an ask's later todo waits for the earlier one", async () => {
    const w = (current = world());
    const ask = w.approved();
    const first = w.add(ask);
    const second = w.add(ask);
    await w.tick();
    expect([w.state(first), w.state(second)]).toEqual(['doing', 'todo']);
  });

  test('an ask nobody approved waits for its start question', async () => {
    const w = (current = world());
    const todo = w.add(w.ask());
    await w.tick();
    expect(w.state(todo)).toBe('todo');
    expect(w.started).toEqual([]);
  });
});
