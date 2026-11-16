import { afterEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoTodoTarget } from '../../../../src/lib/neo/driver-work.ts';
import type { NeoPack, NeoWorkerTargetDecision } from '../../../../src/lib/neo/pack-contract.ts';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import { codingSessionAssignmentWrites } from '../../../../src/lib/neo/packs/coding/session-assignments-worker.ts';
import { decideCodingSessionTarget } from '../../../../src/lib/neo/packs/coding/session-target.ts';
import {
  CodingTodoPrRepository,
  createCodingTodoPack,
} from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import { prepareCodingTodoStorage } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import type { OperationOutcome } from '../../../../src/lib/operations/invoke.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const completed = (value: unknown): OperationOutcome =>
  ({ kind: 'completed', value }) as OperationOutcome;
const start: NeoTodoTarget = {
  verb: 'start',
  adapter: 'hyperneo',
  place: { machine: 'laptop', name: 'repo', folder: '/repo' },
};
const backend = { adapter: 'hyperneo', id: 'backend' };

function world(coding = false) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  prepareCodingTodoStorage(db);
  createCodingTodoPack(new CodingTodoPrRepository(db), async () => []).schema(db);
  db.prepare(
    "INSERT INTO neo_conversation (singleton,id,created_at) VALUES (1,'conversation',0)"
  ).run();
  db.exec(
    "INSERT INTO neo_concerns (id,title,summary,context,revision,created_at,updated_at) VALUES ('p','P','','',1,1,1)"
  );
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const told: { id: string; note: string; key?: string }[] = [];
  const asked: { todo: string; target: NeoTodoTarget; status: unknown }[] = [];
  let decide: (target: NeoTodoTarget) => NeoWorkerTargetDecision = (target) => ({
    value: target,
  });
  const failing = {
    refuse: null as string | null,
    start: false,
    status: null as (() => unknown) | null,
  };
  const pack = {
    id: 'synthetic',
    describe: 'synthetic',
    instructions: () => null,
    workerTarget: async (todo, target, status) => {
      asked.push({ todo: todo.id, target, status: await status(backend) });
      return decide(target);
    },
  } satisfies NeoPack;
  const real = {
    id: 'coding',
    describe: 'coding',
    instructions: () => null,
    workerTarget: (todo, target, status) => decideCodingSessionTarget(db, todo, target, status),
    workerStartExclusions: () => (failing.refuse ? { reason: failing.refuse } : { value: [] }),
    workerTargetRefused: (todo) =>
      gatewayFor(db).call(codingSessionAssignmentWrites, 'releaseFeature', { todoId: todo.id }),
  } satisfies NeoPack;
  const runner = createNeoTodoRunner({
    write: gatewayFor(db).run.bind(gatewayFor(db)),
    store,
    sessions,
    invoke: async (_caller, name, input) => {
      calls.push({ name, input });
      if (name === 'work.status' && failing.status)
        return completed({ ok: true, value: failing.status() });
      if (name === 'work.start' && failing.start)
        return completed({ ok: false, reason: 'start_failed', detail: 'driver down' });
      if (name === 'work.start')
        return completed({ ok: true, value: { ref: { adapter: 'hyperneo', id: 'fresh' } } });
      if (name === 'work.send') return completed({ ok: true, value: { delivered: true } });
      return completed({ ok: true, value: { status: 'done', lastActivityAt: Date.now() } });
    },
    packs: () => [coding ? real : pack],
    tell: async () => {},
    attend: async (event) => {
      told.push({ id: event.subject.id, note: String(event.facts.text), key: event.kind });
    },
    changed: () => {},
    limits: () => ({ running: 6, perGroup: 3 }),
  });
  store.openAsk({
    id: 'ask',
    projectId: 'p',
    sessionId: 'neo',
    originMessageId: 'ask',
    title: 'ask',
    request: 'ask',
    createdAt: 1,
  });
  const add = (
    check: NeoTodo['check'] = { pack: 'synthetic', kind: 'k', params: {} },
    id = 'todo',
    dependsOn: string[] | null = null
  ) => {
    const todo = store.addTodo(
      id,
      'ask',
      {
        approvedAt: 1,
        title: 'Build the API',
        doneWhen: 'done',
        check,
        instruction: 'Do it.',
        named: null,
        dependsOn,
      },
      1
    );
    sessions.create(todo.id, start);
    return todo.id;
  };
  return {
    db,
    store,
    sessions,
    clock,
    calls,
    told,
    asked,
    runner,
    add,
    failing,
    decideWith: (fn: typeof decide) => {
      decide = fn;
    },
    dispatched: () =>
      calls.filter((call) => call.name === 'work.start' || call.name === 'work.send'),
  };
}

let current: ReturnType<typeof world> | null = null;
afterEach(() => {
  current?.clock.mockRestore();
  current?.db.close();
  current = null;
});

describe('createNeoTodoRunner asks the todo pack for its worker target', () => {
  test('the pack sees the stored target and can read a session status', async () => {
    const w = (current = world());
    const id = w.add();
    await w.runner.start(id);
    expect(w.asked).toEqual([
      {
        todo: id,
        target: start,
        status: completed({ ok: true, value: { status: 'done', lastActivityAt: 1_000_000 } }),
      },
    ]);
    expect(w.dispatched().map((call) => call.name)).toEqual(['work.start']);
  });

  test('a reuse decision sends to the chosen session and records that send target', async () => {
    const w = (current = world());
    w.decideWith(() => ({ value: { verb: 'send', ref: backend } }));
    const id = w.add();
    await w.runner.start(id);
    expect(w.dispatched()).toEqual([
      { name: 'work.send', input: expect.objectContaining({ ref: backend, todoId: id }) },
    ]);
    expect(w.sessions.get(id)).toEqual({ verb: 'send', ref: backend });
    expect(w.sessions.readRef(id)).toEqual(backend);
    expect(w.store.getTodo(id)?.state).toBe('doing');
  });

  test('a named start decision starts a session with that name', async () => {
    const w = (current = world());
    w.decideWith((target) => ({ value: { ...target, name: 'backend-2' } as NeoTodoTarget }));
    const id = w.add();
    await w.runner.start(id);
    expect(w.dispatched()).toEqual([
      { name: 'work.start', input: expect.objectContaining({ title: 'backend-2' }) },
    ]);
    expect(w.sessions.get(id)).toEqual({ ...start, name: 'backend-2' });
  });

  test('a wait decision dispatches nothing, keeps the todo and its target, and tells Neo once', async () => {
    const w = (current = world());
    const wait = 'session_unknown: the session for this work is starting or unreachable; wait.';
    w.decideWith(() => ({ reason: wait }));
    const id = w.add();
    await w.runner.start(id);
    await w.runner.start(id);
    expect(w.dispatched()).toEqual([]);
    const todo = w.store.getTodo(id);
    expect(todo).toMatchObject({ state: 'todo', startedAt: null });
    expect(todo?.reason).toContain(wait);
    expect(w.sessions.get(id)).toEqual(start);
    expect(w.told).toHaveLength(1);
    expect(w.told[0].note).toContain(wait);

    w.decideWith((target) => ({ value: target }));
    await w.runner.start(id);
    expect(w.dispatched().map((call) => call.name)).toEqual(['work.start']);
    expect(w.store.getTodo(id)?.reason ?? '').not.toContain(wait);
  });

  test('a start-needed decision leaves a send target in place for Neo to replace', async () => {
    const w = (current = world());
    const needed =
      'session_start_needed: this work needs a new session; add it with a start target.';
    w.decideWith(() => ({ reason: needed }));
    const id = w.add();
    w.sessions.queueOn(id, backend, '');
    await w.runner.start(id);
    expect(w.dispatched()).toEqual([]);
    expect(w.store.getTodo(id)).toMatchObject({ state: 'todo' });
    expect(w.store.getTodo(id)?.reason).toContain(needed);
    expect(w.sessions.get(id)).toEqual({ verb: 'send', ref: backend });
  });

  test('a todo of another pack is not asked', async () => {
    const w = (current = world());
    const id = w.add(null);
    await w.runner.start(id);
    expect(w.asked).toEqual([]);
    expect(w.dispatched().map((call) => call.name)).toEqual(['work.start']);
  });

  test('a refused start does not reserve the feature for the coding hook', async () => {
    const w = (current = world(true));
    const check = { pack: 'coding', kind: 'pr_merged', params: {} };
    const first = w.add(check, 'first');
    const second = w.add(check, 'second', [first]);
    for (const id of [first, second])
      w.db
        .prepare('UPDATE pack_coding_todos SET repo = ?2 WHERE todo_id = ?1')
        .run(id, 'synthetic/repo');
    await w.runner.start(second);
    expect(w.store.getTodo(second)?.state).toBe('todo');
    await w.runner.start(first);
    expect(w.store.getTodo(first)?.reason ?? '').not.toContain('session_unknown');
    expect(w.dispatched().map((call) => call.name)).toEqual(['work.start']);
    expect(w.store.getTodo(first)?.state).toBe('doing');
  });

  test.each([
    ['a start refusal', (w: ReturnType<typeof world>) => (w.failing.refuse = 'no free worker')],
    ['a driver start failure', (w: ReturnType<typeof world>) => (w.failing.start = true)],
  ])('%s without a session releases the coding feature for the next todo', async (_, fail) => {
    const w = (current = world(true));
    const check = { pack: 'coding', kind: 'pr_merged', params: {} };
    const first = w.add(check, 'first');
    const second = w.add(check, 'second');
    for (const id of [first, second])
      w.db
        .prepare('UPDATE pack_coding_todos SET repo = ?2 WHERE todo_id = ?1')
        .run(id, 'synthetic/repo');
    fail(w);
    await w.runner.start(first);
    expect(w.sessions.readRef(first)).toBeFalsy();
    expect(w.store.getTodo(first)?.state).not.toBe('doing');
    w.failing.refuse = null;
    w.failing.start = false;
    const before = w.dispatched().length;
    await w.runner.start(second);
    expect(w.store.getTodo(second)?.reason ?? '').not.toContain('session_unknown');
    expect(
      w
        .dispatched()
        .slice(before)
        .map((call) => call.name)
    ).toEqual(['work.start']);
    expect(w.store.getTodo(second)?.state).toBe('doing');
  });

  test('a claim refused after the coding hook reserved a new start releases the feature', async () => {
    const w = (current = world(true));
    const check = { pack: 'coding', kind: 'pr_merged', params: {} };
    const running = w.add(check, 'running');
    const first = w.add(check, 'first');
    const second = w.add(check, 'second', [first]);
    for (const id of [running, first, second])
      w.db
        .prepare('UPDATE pack_coding_todos SET repo = ?2 WHERE todo_id = ?1')
        .run(id, 'synthetic/repo');
    w.store.updateTodo(w.store.getTodo(running)!, { state: 'doing', startedAt: 1 }, 1);
    w.db
      .prepare('UPDATE neo_todo_sessions SET ref = ?2 WHERE todo_id = ?1')
      .run(running, JSON.stringify(backend));
    w.store.updateTodo(w.store.getTodo(first)!, { state: 'done', finishedAt: 1 }, 1);
    w.failing.status = () => {
      const prerequisite = w.store.getTodo(first)!;
      if (prerequisite.state === 'done')
        w.store.updateTodo(prerequisite, { state: 'todo', finishedAt: null }, 1);
      return {
        ref: backend,
        title: 'busy',
        place: start.place,
        status: 'running',
        lastActivityAt: 1,
      };
    };
    await w.runner.start(second);
    expect(w.store.getTodo(second)).toMatchObject({ state: 'todo', startedAt: null });
    expect(w.dispatched()).toEqual([]);
    expect(w.db.prepare('SELECT todo_id FROM pack_coding_feature_sessions').all()).toEqual([]);
    await w.runner.start(first);
    expect(w.store.getTodo(first)?.reason ?? '').not.toContain('session_unknown');
    expect(w.dispatched().map((call) => call.name)).toEqual(['work.start']);
    expect(w.store.getTodo(first)?.state).toBe('doing');
  });

  test('an interrupted start keeps the coding feature after recovery, so the next todo waits', async () => {
    const w = (current = world(true));
    const check = { pack: 'coding', kind: 'pr_merged', params: {} };
    const first = w.add(check, 'first');
    const second = w.add(check, 'second');
    for (const id of [first, second])
      w.db
        .prepare('UPDATE pack_coding_todos SET repo = ?2 WHERE todo_id = ?1')
        .run(id, 'synthetic/repo');
    w.db
      .prepare(
        "INSERT INTO pack_coding_feature_sessions (repo, feature_key, todo_id, reserved_at) VALUES ('synthetic/repo', 'ask', ?, 1)"
      )
      .run(first);
    w.store.updateTodo(w.store.getTodo(first)!, { state: 'doing', startedAt: 1 }, 1);
    await w.runner.refresh(() => {});
    expect(w.store.getTodo(first)?.state).toBe('blocked');
    expect(w.sessions.readStartInterrupted(first)).toBeTruthy();
    await w.runner.start(second);
    expect(w.store.getTodo(second)?.reason ?? '').toContain('session_unknown');
    expect(w.dispatched()).toEqual([]);
  });
});
