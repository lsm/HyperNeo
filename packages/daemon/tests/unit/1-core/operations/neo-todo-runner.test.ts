import { describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoPack } from '../../../../src/lib/neo/packs/types.ts';
import {
  createNeoTodoRunner,
  neoTodoNote,
  planNeoTodoCheck,
  planNeoTodoSettled,
  requireNeoTodoStartable,
} from '../../../../src/lib/neo/todo-runner.ts';
import type { OperationOutcome } from '../../../../src/lib/operations/invoke.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const ref = { adapter: 'hyperneo', id: 'worker-1' };
const completed = (value: unknown): OperationOutcome =>
  ({ kind: 'completed', value }) as OperationOutcome;

function setup(packDone: boolean | null = null) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  store.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: 'm1',
    title: 'iOS card',
    request: 'Redo the iOS card',
    createdAt: 1,
  });
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const told: string[] = [];
  let status: unknown = null;
  const pack = {
    id: 'coding',
    describe: 'coding',
    instructions: () => null,
    todos: {
      schema: () => {},
      check: async () => (packDone === null ? null : { done: packDone, evidence: '#1 已合并' }),
      statusLine: () => null,
      topics: () => [],
      event: () => [],
    },
  } satisfies NeoPack;
  const runner = createNeoTodoRunner({
    store,
    sessions,
    invoke: async (_caller, name, input) => {
      calls.push({ name, input });
      if (name === 'work.start')
        return completed({ ok: true, value: { ref, lastActivityAt: 1_000, link: '/session/w' } });
      return completed(status);
    },
    packs: () => [pack],
    tell: async (_ask, _todo, note) => {
      told.push(note);
    },
    changed: () => {},
  });
  const add = (check: NeoTodo['check'] = null) => {
    const todo = store.addTodo(
      crypto.randomUUID(),
      'ask',
      { title: 'Rows', doneWhen: 'PR merged', check, instruction: 'Build the rows.', named: null },
      1
    );
    sessions.create(todo.id, {
      verb: 'start',
      adapter: 'hyperneo',
      place: { machine: 'laptop', name: 'repo', folder: '/repo' },
    });
    return todo;
  };
  return {
    db,
    store,
    sessions,
    runner,
    calls,
    told,
    add,
    setStatus: (value: unknown) => {
      status = value;
    },
  };
}

describe('neo todo runner', () => {
  test('starts a todo in its session, settles its report and lets the pack tick it done', async () => {
    const { store, sessions, runner, calls, told, add, setStatus } = setup(true);
    const todo = add({ pack: 'coding', kind: 'pr_merged', params: {} });
    const started = await runner.start(todo.id);
    expect(started.ok && started.todo).toMatchObject({
      state: 'doing',
      startedAt: expect.any(Number),
    });
    expect(calls[0]).toMatchObject({
      name: 'work.start',
      input: { adapter: 'hyperneo', title: 'Rows' },
    });
    expect(String(calls[0].input.message)).toContain('Build the rows.');
    expect(sessions.readRef(todo.id)).toEqual(ref);
    expect(await runner.start(todo.id)).toEqual({
      ok: false,
      reason: 'already_started: this todo is doing.',
    });

    setStatus({
      ok: true,
      value: {
        status: 'done',
        lastActivityAt: 2_000,
        lastReply: 'Opened the PR',
        exchange: [
          { at: 1_500, role: 'user', text: String(calls[0].input.message) },
          { at: 2_000, role: 'agent', text: 'Opened https://github.com/a/b/pull/1' },
        ],
      },
    });
    await runner.refresh(() => {});
    expect(store.getTodo(todo.id)).toMatchObject({
      state: 'done',
      report: expect.stringContaining('pull/1'),
      evidence: '#1 已合并',
    });
    expect(told).toEqual([
      expect.stringContaining('Todo "Rows" reported:'),
      'Todo "Rows" is done: #1 已合并',
    ]);
  });

  test('a start a restart interrupted fails the todo on the next refresh', async () => {
    const { store, runner, told, add } = setup();
    const todo = add();
    store.claimStart(todo, 2);
    await runner.refresh(() => {});
    expect(store.getTodo(todo.id)).toMatchObject({
      state: 'failed',
      reason: 'Start was interrupted; a session may have started without being recorded.',
    });
    expect(told).toEqual([expect.stringContaining('Start was interrupted')]);
  });

  test('a start the driver refuses fails the todo with its reason', async () => {
    const { db, store, add, told } = setup();
    const todo = add();
    const failing = createNeoTodoRunner({
      store,
      sessions: new NeoTodoSessionRepository(db),
      invoke: async () => completed({ ok: false, reason: 'unavailable', detail: 'login expired' }),
      packs: () => [],
      tell: async (_ask, _todo, note) => {
        told.push(note);
      },
      changed: () => {},
    });
    const result = await failing.start(todo.id);
    expect(result.ok && result.todo).toMatchObject({
      state: 'failed',
      reason: 'Could not start: unavailable: login expired',
    });
    expect(told).toEqual(['Todo "Rows" failed: Could not start: unavailable: login expired']);
  });
});

describe('neo todo runner follow-ups', () => {
  test('continue sends the next step and reopens the todo; retry goes again only before a session', async () => {
    const { store, runner, calls, add, setStatus } = setup();
    const todo = add();
    expect(await runner.proceed(todo.id, 'next')).toEqual({
      ok: false,
      reason: 'not_started: this todo is todo and has no session to continue.',
    });
    await runner.start(todo.id);
    store.updateTodo(store.getTodo(todo.id)!, { state: 'done', report: 'Done' }, 3);
    setStatus({ ok: true, value: { delivered: true } });
    const continued = await runner.proceed(todo.id, 'Now add tests.');
    expect(continued.ok && continued.todo).toMatchObject({ state: 'doing', report: null });
    expect(calls.at(-1)).toMatchObject({ name: 'work.send', input: { ref } });
    expect(String(calls.at(-1)?.input.message)).toContain('Now add tests.');
    expect(await runner.retry(todo.id)).toEqual({
      ok: false,
      reason: 'not_retryable: only a todo that failed before its session started goes again.',
    });
  });
});

describe('neo todo runner uncertainty', () => {
  test('a start that may have opened a session is not retried, and a running session is stopped', async () => {
    const { db, store, add, calls } = setup();
    const todo = add();
    const sessions = new NeoTodoSessionRepository(db);
    const flaky = createNeoTodoRunner({
      store,
      sessions,
      invoke: async (_caller, name, input) => {
        calls.push({ name, input });
        return { kind: 'failed', code: 'execution_failed', message: 'socket hang up' } as never;
      },
      packs: () => [],
      tell: async () => {},
      changed: () => {},
    });
    const result = await flaky.start(todo.id);
    expect(result.ok && result.todo.state).toBe('failed');
    expect(await flaky.retry(todo.id)).toEqual({
      ok: false,
      reason:
        'start_uncertain: the start failed after the driver may have opened a session; find it with work.find before starting again.',
    });
    const running = add();
    sessions.recordRef(running.id, ref);
    sessions.recordLive(running.id, 'running', undefined);
    await flaky.stop(store.updateTodo(running, { state: 'done', report: 'Claimed done' }, 5));
    expect(calls.at(-1)).toMatchObject({ name: 'work.stop', input: { ref } });
  });
});

describe('requireNeoTodoStartable', () => {
  test('refuses daemon-checked todos and read targets', () => {
    const todo = { state: 'todo', instruction: null } as NeoTodo;
    const ask = { status: 'open' } as never;
    expect(requireNeoTodoStartable({ todo, ask, target: null })).toEqual({
      reason: {
        ok: false,
        reason: 'no_session: this todo has no instruction and target; the daemon checks it.',
      },
    });
    expect(
      requireNeoTodoStartable({
        todo: { ...todo, instruction: 'x' },
        ask,
        target: { verb: 'read', operation: 'x', input: {} } as never,
      })
    ).toEqual({
      reason: { ok: false, reason: 'unsupported_target: a todo cannot read a session.' },
    });
    expect(
      requireNeoTodoStartable({
        todo: { ...todo, instruction: 'x' },
        ask,
        target: { verb: 'adopt', ref: { adapter: 'hyperneo', id: 'w' } },
      })
    ).toEqual({
      reason: { ok: false, reason: 'unsupported_target: a todo cannot adopt a session.' },
    });
  });
});

describe('planNeoTodoSettled', () => {
  test('a report finishes a todo without a check and waits for the check otherwise', () => {
    const todo = { check: null } as NeoTodo;
    expect(planNeoTodoSettled(todo, { status: 'reported', report: 'Done' }, 5)).toEqual({
      report: 'Done',
      state: 'done',
      finishedAt: 5,
    });
    expect(
      planNeoTodoSettled(
        { check: { pack: 'coding', kind: 'pr_merged', params: {} } } as NeoTodo,
        { status: 'reported', report: 'Done' },
        5
      )
    ).toEqual({ report: 'Done' });
    expect(planNeoTodoSettled(todo, { status: 'failed', report: 'It stopped.' }, 5)).toEqual({
      state: 'failed',
      reason: 'It stopped.',
      finishedAt: 5,
    });
  });
});

describe('planNeoTodoCheck', () => {
  test('only a passing check on an unfinished todo changes it', () => {
    const doing = { state: 'doing' } as NeoTodo;
    expect(planNeoTodoCheck(doing, { done: true, evidence: 'ok' }, 1)).toEqual({
      state: 'done',
      evidence: 'ok',
      finishedAt: 1,
    });
    expect(planNeoTodoCheck(doing, { done: false, evidence: null }, 1)).toBeNull();
    expect(
      planNeoTodoCheck({ state: 'done' } as NeoTodo, { done: true, evidence: 'ok' }, 1)
    ).toBeNull();
  });
});

describe('neoTodoNote', () => {
  test('says a failure with its reason', () => {
    expect(neoTodoNote({ title: 'T', state: 'failed', reason: 'gone' } as NeoTodo)).toBe(
      'Todo "T" failed: gone'
    );
  });
});
