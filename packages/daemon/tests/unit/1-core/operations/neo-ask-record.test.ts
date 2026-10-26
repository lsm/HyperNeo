import { describe, expect, test } from 'bun:test';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import {
  createNeoAskRecordOperations,
  requireNeoAskProject,
  requireNeoAskSession,
} from '../../../../src/lib/neo/ask-record-operations.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { SessionGoalRepository } from '../../../../src/storage/repositories/session-goal-repository.ts';
import { neoTodoHome } from '../../../../src/lib/neo/todo-repo.ts';

const turn = (_messageId: string, _human = true): OperationCaller => ({
  source: 'mcp',
  sessionId: 'neo-a',
  role: 'neo',
});

type Receipt = { ok: true; ask: NeoAsk; todos: NeoTodo[] } | { ok: false; reason: string };

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  db.exec(
    "INSERT INTO neo_concerns (id, title, summary, context, revision, created_at, updated_at) VALUES ('project-1', 'P', '', '', 1, 1, 1)"
  );
  const store = new NeoAskTodoRepository(db);
  const goals = new SessionGoalRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  const started: string[] = [];
  const stopped: string[] = [];
  const refuse = { value: false };
  const stopFails = { value: false };
  const onStop: { value: ((todo: NeoTodo) => void) | null } = { value: null };
  const ops = Object.fromEntries(
    createNeoAskRecordOperations(
      store,
      sessions,
      {
        start: async (todoId) => {
          if (refuse.value) return { ok: false, reason: 'busy' };
          started.push(todoId);
          return {
            ok: true,
            todo: store.updateTodo(store.getTodo(todoId)!, { state: 'doing' }, 2),
          };
        },
        proceed: async () => ({ ok: false, reason: 'unused' }),
        retry: async () => ({ ok: false, reason: 'unused' }),
        stop: async (todo) => {
          stopped.push(todo.id);
          onStop.value?.(todo);
          return stopFails.value ? 'stop_failed: offline' : null;
        },
      },
      (projectId) => (projectId === 'project-1' ? projectId : null),
      (sessionId) => ['neo-a', 'neo-other'].includes(sessionId),
      () => [{ id: 'project-1', title: 'P' }],
      () => [],
      (id) => goals.get(id)
    ).map((op) => [op.name, op])
  );
  const call = async (name: string, input: unknown, caller: OperationCaller) =>
    (await ops[name].execute(ops[name].inputSchema.parse(input), caller)) as Receipt;
  return { store, goals, sessions, call, started, stopped, refuse, stopFails, onStop };
}

const opening = {
  title: 'Fix login',
  request: 'Fix the login bug and merge it',
  todos: [
    {
      title: 'Fix it',
      doneWhen: 'PR merged',
      check: { pack: 'coding', kind: 'pr_merged' },
      instruction: 'Fix the login bug.',
      target: { verb: 'send', ref: { adapter: 'hyperneo', id: 'dev-1' } },
      start: true,
    },
    { title: 'Deploy', doneWhen: 'Both daemons run it' },
  ],
};

describe('neo.ask.open and neo.ask.settle', () => {
  test('settling an ask preserves an unverified close instead of treating it as unfinished', async () => {
    const h = setup();
    const opened = await h.call(
      'neo.ask.open',
      {
        title: 'Unverified delivery',
        request: 'Close without a verified outcome',
        todos: [{ title: 'Delivery', doneWhen: 'Result checked' }],
      },
      turn('m1')
    );
    if (!opened.ok) throw new Error(opened.reason);
    h.store.updateTodo(
      opened.todos[0],
      { state: 'closed_unverified', reason: 'Outcome not checked' },
      2
    );
    const settled = await h.call(
      'neo.ask.settle',
      {
        askId: opened.ask.id,
        status: 'done',
        outcome: 'Closed with verification still outstanding',
      },
      turn('m2')
    );
    expect(settled).toMatchObject({
      ok: true,
      todos: [{ state: 'closed_unverified', reason: 'Outcome not checked' }],
    });
  });

  test('records a settled discussion decision and links while execution stays open', async () => {
    const h = setup();
    const opened = await h.call(
      'neo.ask.open',
      {
        title: 'Choose positioning',
        request: 'Discuss then implement',
        todos: [{ title: 'Implement the chosen option', doneWhen: 'PR merged' }],
      },
      turn('m1')
    );
    if (!opened.ok) throw new Error(opened.reason);
    h.store.focusAsk(
      opened.ask.id,
      {
        adapter: 'hyperneo',
        id: 'discussion',
        name: 'Discussion',
        label: 'Discussion',
        provider: 'Anthropic',
        link: '/session/discussion',
      },
      2
    );
    const todos = h.store.listTodos(opened.ask.id);
    const outcome =
      'Decision: prioritize beginner gardeners.\nDocument: [Positioning](https://example.test/positioning.md)\nPR: https://github.com/example/project/pull/8';
    expect(
      await h.call('neo.ask.outcome', { askId: opened.ask.id, outcome }, turn('m2'))
    ).toMatchObject({
      ok: true,
      ask: { outcome, status: 'open', settledAt: null, focusedSession: { id: 'discussion' } },
    });
    expect(h.store.listTodos(opened.ask.id)).toEqual(todos);
    expect(h.stopped).toEqual([]);
    expect(h.started).toEqual([]);
    expect(
      await h.call(
        'neo.ask.settle',
        { askId: opened.ask.id, status: 'done', outcome: 'Done' },
        turn('m3')
      )
    ).toMatchObject({ ok: false, reason: expect.stringContaining('todos_unfinished') });
    expect(h.store.getAsk(opened.ask.id)).toMatchObject({ status: 'open', outcome });
    expect(
      await h.call(
        'neo.ask.open',
        {
          title: 'Choose positioning',
          request: 'Discuss then implement',
          todos: [{ title: 'Deploy after implementation', doneWhen: 'Build readback matches' }],
        },
        turn('m4')
      )
    ).toMatchObject({ ok: true, ask: { id: opened.ask.id, outcome } });
    expect(h.store.listTodos(opened.ask.id)).toHaveLength(2);
  });

  test('refuses recording by a worker, another Neo, or on an unfocused or settled ask', async () => {
    const h = setup();
    const opened = await h.call(
      'neo.ask.open',
      { title: 'Discussion', request: 'Choose a direction' },
      turn('m1')
    );
    if (!opened.ok) throw new Error(opened.reason);
    const input = { askId: opened.ask.id, outcome: 'Claimed approval' };
    expect(await h.call('neo.ask.outcome', input, turn('m2'))).toMatchObject({ ok: false });
    h.store.focusAsk(
      opened.ask.id,
      {
        adapter: 'hyperneo',
        id: 'discussion',
        name: null,
        label: 'Discussion',
        provider: 'Anthropic',
        link: '/session/discussion',
      },
      2
    );
    for (const caller of [
      { source: 'mcp', role: 'worker', sessionId: 'discussion' },
      { source: 'mcp', role: 'neo', sessionId: 'neo-other' },
      { source: 'rpc', principal: 'local' },
    ] as OperationCaller[])
      expect(await h.call('neo.ask.outcome', input, caller)).toMatchObject({ ok: false });
    expect(h.store.getAsk(opened.ask.id)?.outcome).toBeNull();
    h.store.settleAsk(h.store.getAsk(opened.ask.id)!, 'done', 'Finished', 3);
    expect(await h.call('neo.ask.outcome', input, turn('m3'))).toMatchObject({ ok: false });
    expect(h.store.getAsk(opened.ask.id)?.outcome).toBe('Finished');
  });

  test('only the goal owner links an ask; retries and repo splits retain that goal', async () => {
    const { store, goals, call, started } = setup();
    const mine = goals.create('neo-a', { title: 'Ship', doneTest: 'Released' }, 'neo', 1);
    const other = goals.create('neo-other', { title: 'Other', doneTest: 'Released' }, 'neo', 1);
    for (const goalId of ['missing', other.id]) {
      expect(await call('neo.ask.open', { ...opening, goalId }, turn('m1'))).toMatchObject({
        ok: false,
        reason: expect.stringContaining('goal_not_found'),
      });
    }
    expect(store.listAsks(undefined, 100)).toEqual([]);
    expect(started).toEqual([]);
    const result = await call('neo.ask.open', { ...opening, goalId: mine.id }, turn('m1'));
    if (!result.ok) throw new Error(result.reason);
    expect(result.ask.goalId).toBe(mine.id);
    expect(await call('neo.ask.open', { ...opening, goalId: mine.id }, turn('m1'))).toMatchObject({
      ok: true,
      ask: { id: result.ask.id },
    });
    const independent = await call('neo.ask.open', { ...opening, todos: [] }, turn('m1'));
    expect(independent.ok && independent.ask.id).not.toBe(result.ask.id);
    const child = neoTodoHome(store, result.ask, 'github.com/verify/second', true);
    expect(child.goalId).toBe(mine.id);
    expect(store.listGoalAsks(mine.id).map((ask) => ask.id)).toEqual(
      expect.arrayContaining([result.ask.id, child.id])
    );
  });
  test('opens an ask with its todos once per turn and starts the ones asked to start', async () => {
    const { call, started } = setup();
    const first = await call('neo.ask.open', opening, turn('m1'));
    if (!first.ok) throw new Error(first.reason);
    expect(first.ask).toMatchObject({
      projectId: null,
      sessionId: 'neo-a',
      originMessageId: null,
      status: 'open',
    });
    expect(first.todos.map((todo) => [todo.title, todo.instruction !== null])).toEqual([
      ['Fix it', true],
      ['Deploy', false],
    ]);
    expect(started).toEqual([first.todos[0].id]);
    const retry = await call('neo.ask.open', opening, turn('m1'));
    expect(retry.ok && retry.ask.id).toBe(first.ask.id);
    expect(retry.ok && retry.todos).toHaveLength(2);
    expect(started).toHaveLength(1);
  });

  test('a retry after a refused start adds the todos that are still missing', async () => {
    const { call, refuse, started } = setup();
    refuse.value = true;
    expect(await call('neo.ask.open', opening, turn('m3'))).toEqual({
      ok: false,
      reason: 'busy',
    });
    refuse.value = false;
    const retry = await call(
      'neo.ask.open',
      { ...opening, todos: [opening.todos[1], opening.todos[0]] },
      turn('m3')
    );
    expect(retry.ok && retry.todos.map((todo) => todo.title)).toEqual(['Fix it', 'Deploy']);
    expect(started).toEqual([retry.ok && retry.todos[0].id]);
  });

  test('start in a turn the human did not start still starts', async () => {
    const { call, started } = setup();
    const opened = await call('neo.ask.open', opening, turn('m2', false));
    if (!opened.ok) throw new Error(opened.reason);
    expect(started).toEqual([opened.todos[0].id]);
  });

  test('a start that lands while settle stops other sessions is stopped after the ask settles', async () => {
    const { call, sessions, stopped, onStop } = setup();
    const opened = await call('neo.ask.open', opening, turn('m6'));
    if (!opened.ok) throw new Error(opened.reason);
    const [first, second] = opened.todos;
    onStop.value = (todo) => {
      if (todo.id === second.id) sessions.recordRef(first.id, { adapter: 'hyperneo', id: 'late' });
    };
    const settled = await call(
      'neo.ask.settle',
      { askId: opened.ask.id, status: 'dropped', outcome: 'x' },
      turn('m6')
    );
    expect(settled.ok).toBe(true);
    expect(stopped).toEqual([first.id, second.id, first.id]);
  });

  test('a settle whose stop fails leaves the ask open and says so', async () => {
    const { call, store, stopFails } = setup();
    const opened = await call('neo.ask.open', opening, turn('m5'));
    if (!opened.ok) throw new Error(opened.reason);
    stopFails.value = true;
    const settled = await call(
      'neo.ask.settle',
      { askId: opened.ask.id, status: 'dropped', outcome: 'x' },
      turn('m5')
    );
    expect(settled.ok).toBe(false);
    expect(!settled.ok && settled.reason).toContain('the ask is still open');
    expect(store.getAsk(opened.ask.id)?.status).toBe('open');
  });

  test('the human can mark an ask done with unfinished coding todos', async () => {
    const { call, store, stopped } = setup();
    const opened = await call('neo.ask.open', opening, turn('human-mark-done'));
    if (!opened.ok) throw new Error(opened.reason);
    const settled = await call(
      'neo.ask.settle',
      { askId: opened.ask.id, status: 'done', outcome: 'Closed by the user.' },
      { source: 'rpc', principal: 'local' }
    );
    expect(settled.ok && settled.ask.status).toBe('done');
    expect(store.getAsk(opened.ask.id)?.status).toBe('done');
    expect(stopped).toEqual(opened.todos.map((todo) => todo.id));
    expect(store.listTodos(opened.ask.id).every((todo) => todo.state === 'removed')).toBe(true);
  });

  test('done is refused while a todo is neither done nor removed with a reason', async () => {
    const { call, store, stopped } = setup();
    const opened = await call('neo.ask.open', opening, turn('m7'));
    if (!opened.ok) throw new Error(opened.reason);
    const [fix, deploy] = opened.todos;
    const settle = () =>
      call(
        'neo.ask.settle',
        { askId: opened.ask.id, status: 'done', outcome: 'Shipped.' },
        turn('m7')
      );
    expect(await settle()).toEqual({
      ok: false,
      reason: `todos_unfinished: finish or remove these todos first: "Fix it" (${fix.id}, doing), "Deploy" (${deploy.id}, todo).`,
    });
    expect(store.getAsk(opened.ask.id)?.status).toBe('open');
    expect(stopped).toEqual([]);
    store.updateTodo(fix, { state: 'done', evidence: '#8 merged', finishedAt: 3 }, 3);
    store.updateTodo(deploy, { state: 'removed', reason: 'The human deploys it.' }, 3);
    const settled = await call(
      'neo.ask.settle',
      { askId: opened.ask.id, status: 'done', outcome: 'Shipped.' },
      turn('m7')
    );
    expect(settled.ok && settled.ask.status).toBe('done');
  });

  test('settling stops running sessions, retires open questions and ends the ask', async () => {
    const { call, store, stopped } = setup();
    const opened = await call('neo.ask.open', opening, turn('m3'));
    if (!opened.ok) throw new Error(opened.reason);
    store.askQuestion(
      'q',
      opened.ask.id,
      {
        text: 'Deploy now?',
        kind: 'reply',
        options: null,
        multiple: false,
        noLabel: null,
        yesLabel: null,
        startTodos: null,
      },
      1
    );
    const settled = await call(
      'neo.ask.settle',
      { askId: opened.ask.id, status: 'dropped', outcome: 'The human dropped it.' },
      { source: 'rpc', principal: 'local' }
    );
    expect(settled.ok && settled.ask).toMatchObject({
      status: 'dropped',
      outcome: 'The human dropped it.',
      settledAt: expect.any(Number),
    });
    expect(stopped).toHaveLength(2);
    expect(store.getQuestion('q')?.state).toBe('retired');
    expect(store.listTodos(opened.ask.id).map((todo) => [todo.state, todo.reason])).toEqual([
      ['removed', 'The ask was settled dropped.'],
      ['removed', 'The ask was settled dropped.'],
    ]);
    expect(
      await call(
        'neo.ask.settle',
        { askId: opened.ask.id, status: 'done', outcome: 'x' },
        turn('m4')
      )
    ).toEqual({ ok: false, reason: 'ask_settled: this ask is dropped.' });
  });
});

describe('requireNeoAskProject', () => {
  test('keeps no project by default and refuses an unknown id', () => {
    const resolve = (id: string) => (id === 'old' ? 'kept' : null);
    expect(requireNeoAskProject({}, resolve)).toEqual({ value: null });
    expect(requireNeoAskProject({ projectId: null }, resolve)).toEqual({ value: null });
    expect(requireNeoAskProject({ projectId: 'old' }, resolve)).toEqual({ value: 'kept' });
    expect(requireNeoAskProject({ projectId: 'nope' }, resolve)).toEqual({
      reason: { ok: false, reason: 'unknown_project: no project nope.' },
    });
  });

  test('caps the listed projects at 50', () => {
    const known = () => Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, title: `T${i}` }));
    const refused = requireNeoAskProject({ projectId: 'x' }, () => null, known);
    const reason = 'reason' in refused ? refused.reason.reason : '';
    expect(reason).toContain('p49 (T49)');
    expect(reason).not.toContain('p50 (T50)');
  });

  test('lists the known projects when an id matches none', () => {
    const known = () => [
      { id: 'project:a', title: 'Alpha' },
      { id: 'b', title: 'Beta' },
    ];
    expect(requireNeoAskProject({ projectId: 'nope' }, () => null, known)).toEqual({
      reason: {
        ok: false,
        reason: 'unknown_project: no project nope. Projects: project:a (Alpha); b (Beta).',
      },
    });
  });
});

describe('requireNeoAskSession', () => {
  test('needs a Neo session', () => {
    const refused = {
      reason: { ok: false, reason: 'no_session: only a Neo session opens an ask.' },
    };
    expect(requireNeoAskSession({ source: 'rpc' }, () => true)).toEqual(refused);
    expect(requireNeoAskSession({ source: 'mcp', sessionId: 'worker-1' }, () => false)).toEqual(
      refused
    );
  });
});
