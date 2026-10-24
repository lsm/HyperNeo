import { describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import {
  createNeoTodoOperations,
  type NeoTodoControls,
} from '../../../../src/lib/neo/todo-operations.ts';
import type { NeoPack } from '../../../../src/lib/neo/pack-contract.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const owner: OperationCaller = { source: 'mcp', sessionId: 'neo-a', role: 'neo' };
const other: OperationCaller = { source: 'mcp', sessionId: 'neo-b', role: 'neo' };

function setup(packs: NeoPack[] = []) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  let changes = 0;
  const stopped: string[] = [];
  const repo = new NeoAskTodoRepository(db, () => changes++);
  repo.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo-a',
    originMessageId: 'm1',
    title: 'Ship login fix',
    request: 'Fix login and ship it',
    createdAt: 1,
  });
  const stopFails = { value: false };
  const ops = Object.fromEntries(
    createNeoTodoOperations(
      repo,
      new NeoTodoSessionRepository(db),
      {
        recompute: async (todo, patch) => repo.updateTodo(todo, patch, Date.now()),
        start: async () => ({ ok: false as const, reason: 'not started' }),
        proceed: async () => ({ ok: false as const, reason: 'no session' }),
        retry: async () => ({ ok: false as const, reason: 'not failed' }),
        stop: async (todo) => {
          stopped.push(todo.id);
          return stopFails.value ? 'stop_failed: driver offline' : null;
        },
      },
      () => packs,
      () => null
    ).map((op) => [op.name, op])
  );
  const call = async (name: string, input: unknown, caller = owner) =>
    (await ops[name].execute(ops[name].inputSchema.parse(input), caller)) as
      | { ok: true; todo: NeoTodo; todos: NeoTodo[] }
      | { ok: false; reason: string };
  return { db, repo, call, stopped, stopFails, changes: () => changes };
}

describe('neo.todo operations', () => {
  test('adds todos in order and marks the ones added after work started', async () => {
    const { repo, call, changes } = setup();
    const first = await call('neo.todo.add', {
      askId: 'ask',
      title: 'Fix login',
      doneWhen: 'PR merged',
      check: { pack: 'coding', kind: 'pr_merged' },
      instruction: 'Fix the login bug and open a PR.',
      target: { verb: 'send', ref: { adapter: 'hyperneo', id: 'dev-1' } },
    });
    if (!first.ok) throw new Error(first.reason);
    expect(first.todo).toMatchObject({
      position: 0,
      state: 'todo',
      check: { pack: 'coding', kind: 'pr_merged', params: {} },
      addedAfterStart: false,
    });
    repo.updateTodo(first.todo, { state: 'doing', startedAt: 5 }, 5);
    const second = await call('neo.todo.add', {
      askId: 'ask',
      title: 'Deploy',
      doneWhen: 'Both daemons run it',
    });
    if (!second.ok) throw new Error(second.reason);
    expect(second.todo).toMatchObject({ position: 1, instruction: null, addedAfterStart: true });
    expect(second.todos.map((todo) => todo.title)).toEqual(['Fix login', 'Deploy']);
    expect(changes()).toBeGreaterThan(0);
  });

  test('accepts only start and send targets', () => {
    const add = createNeoTodoOperations(
      {} as NeoAskTodoRepository,
      {} as NeoTodoSessionRepository,
      {} as NeoTodoControls,
      () => [],
      () => null
    ).find((op) => op.name === 'neo.todo.add')!;
    const input = { askId: 'ask', title: 'T', doneWhen: 'D', instruction: 'Do' };
    const ref = { adapter: 'hyperneo', id: 'dev-1' };
    expect(add.inputSchema.safeParse({ ...input, target: { verb: 'send', ref } }).success).toBe(
      true
    );
    for (const verb of ['adopt', 'read'])
      expect(add.inputSchema.safeParse({ ...input, target: { verb, ref } }).success).toBe(false);
  });

  test('changes only an open ask', async () => {
    const { db, call } = setup();
    db.exec("UPDATE neo_asks SET status = 'done'");
    expect(await call('neo.todo.add', { askId: 'ask', title: 'x', doneWhen: 'y' })).toEqual({
      ok: false,
      reason: 'ask_settled: this ask is done.',
    });
    expect(await call('neo.todo.add', { askId: 'none', title: 'x', doneWhen: 'y' })).toEqual({
      ok: false,
      reason: 'not_found: no such ask.',
    });
  });

  test('ticks a todo met or reported with evidence', async () => {
    const { call } = setup();
    const added = await call('neo.todo.add', { askId: 'ask', title: 'Fix', doneWhen: 'Merged' });
    if (!added.ok) throw new Error(added.reason);
    expect(await call('neo.todo.edit', { todoId: added.todo.id, done: 'met' })).toEqual({
      ok: false,
      reason: 'evidence_missing: ticking a todo needs evidence.',
    });
    const met = await call('neo.todo.edit', {
      todoId: added.todo.id,
      title: 'Fix login',
      done: 'met',
      evidence: '#12 merged',
    });
    expect(met.ok && met.todo).toMatchObject({
      title: 'Fix login',
      state: 'done',
      finishedAt: expect.any(Number),
      evidence: '#12 merged',
      report: null,
    });
    const reported = await call('neo.todo.edit', {
      todoId: added.todo.id,
      done: 'reported',
      evidence: 'The session says it is fixed',
    });
    expect(reported.ok && reported.todo).toMatchObject({
      state: 'done',
      report: 'The session says it is fixed',
    });
  });

  test('removes a todo with its reason and replacement', async () => {
    const { call, stopped } = setup();
    const old = await call('neo.todo.add', { askId: 'ask', title: 'Old', doneWhen: 'x' });
    const next = await call('neo.todo.add', { askId: 'ask', title: 'New', doneWhen: 'x' });
    if (!old.ok || !next.ok) throw new Error('add failed');
    expect(
      await call('neo.todo.remove', { todoId: old.todo.id, reason: 'r', replacedBy: old.todo.id })
    ).toEqual({
      ok: false,
      reason: 'replacement_missing: replacedBy is not another todo on this ask.',
    });
    const removed = await call('neo.todo.remove', {
      todoId: old.todo.id,
      reason: 'The human chose a new session',
      replacedBy: next.todo.id,
    });
    expect(removed.ok && removed.todo).toMatchObject({
      state: 'removed',
      reason: 'The human chose a new session',
      replacedBy: next.todo.id,
    });
    expect(await call('neo.todo.edit', { todoId: old.todo.id, title: 'x' })).toEqual({
      ok: false,
      reason: 'todo_removed: this todo was removed.',
    });
    expect(stopped).toEqual([old.todo.id]);
  });

  test('closes a todo done with the reason and stops its session', async () => {
    const { call, stopped } = setup();
    const added = await call('neo.todo.add', { askId: 'ask', title: 'Fix', doneWhen: 'Merged' });
    if (!added.ok) throw new Error(added.reason);
    const closed = await call('neo.todo.close', {
      todoId: added.todo.id,
      reason: 'Verified on device',
    });
    expect(closed.ok && closed.todo).toMatchObject({
      state: 'done',
      evidence: 'Verified on device',
      finishedAt: expect.any(Number),
    });
    expect(stopped).toEqual([added.todo.id]);
    expect(await call('neo.todo.continue', { todoId: added.todo.id, message: 'next' })).toEqual({
      ok: false,
      reason: 'no session',
    });
  });

  test('refuses to finish a todo while its card waits for the human, and keeps the card', async () => {
    const { call, repo, stopped } = setup();
    const added = await call('neo.todo.add', { askId: 'ask', title: 'Fix', doneWhen: 'Merged' });
    if (!added.ok) throw new Error(added.reason);
    const card = repo.askQuestion(
      'card-1',
      'ask',
      {
        text: 'Approve step 1?',
        kind: 'yesno',
        options: null,
        multiple: false,
        noLabel: null,
        yesLabel: null,
        startTodos: null,
        todoId: added.todo.id,
      },
      Date.now()
    );
    const refused = {
      ok: false,
      reason: 'card_unanswered: card card-1 is still waiting for the human.',
    };
    expect(await call('neo.todo.close', { todoId: added.todo.id, reason: 'Done' })).toEqual(
      refused
    );
    expect(
      await call('neo.todo.edit', { todoId: added.todo.id, done: 'met', evidence: '#12 merged' })
    ).toEqual(refused);
    expect(repo.getQuestion(card.id)?.state).toBe('open');
    expect(repo.getTodo(added.todo.id)?.state).not.toBe('done');
    expect(stopped).toEqual([]);
  });

  test('finishes a todo once its card is answered', async () => {
    const { call, repo } = setup();
    const added = await call('neo.todo.add', { askId: 'ask', title: 'Fix', doneWhen: 'Merged' });
    if (!added.ok) throw new Error(added.reason);
    const card = repo.askQuestion(
      'card-1',
      'ask',
      {
        text: 'Approve step 1?',
        kind: 'yesno',
        options: null,
        multiple: false,
        noLabel: null,
        yesLabel: null,
        startTodos: null,
        todoId: added.todo.id,
      },
      Date.now()
    );
    repo.answerQuestion(card, 'yes', 'button', Date.now());
    const closed = await call('neo.todo.close', { todoId: added.todo.id, reason: 'Approved' });
    expect(closed.ok && closed.todo).toMatchObject({ state: 'done', evidence: 'Approved' });
    expect(repo.getQuestion(card.id)).toMatchObject({ state: 'answered', answer: 'yes' });
  });

  test('a close whose stop fails leaves the todo unchanged and says so', async () => {
    const { call, stopFails, repo } = setup();
    const added = await call('neo.todo.add', { askId: 'ask', title: 'Fix', doneWhen: 'Merged' });
    if (!added.ok) throw new Error(added.reason);
    stopFails.value = true;
    expect(await call('neo.todo.close', { todoId: added.todo.id, reason: 'x' })).toEqual({
      ok: false,
      reason: 'stop_failed: driver offline; the todo is unchanged, its session may still run.',
    });
    expect(repo.getTodo(added.todo.id)?.state).toBe('todo');
  });

  test('start:true starts in any Neo turn, not only one the human started', async () => {
    const { call } = setup();
    expect(
      await call('neo.todo.add', {
        askId: 'ask',
        title: 'Fix',
        doneWhen: 'Merged',
        instruction: 'Fix it',
        target: { verb: 'send', ref: { adapter: 'hyperneo', id: 'w' } },
        start: true,
      })
    ).toEqual({ ok: false, reason: 'not started' });
  });

  test('an unstarted todo with an instruction joins the ask start question, ticked', async () => {
    const { repo, call } = setup();
    const target = { verb: 'send', ref: { adapter: 'hyperneo', id: 'w' } };
    const fix = await call('neo.todo.add', {
      askId: 'ask',
      title: 'Fix',
      doneWhen: 'Merged',
      instruction: 'Fix it',
      target,
    });
    if (!fix.ok) throw new Error(fix.reason);
    expect(repo.listQuestions('ask')).toMatchObject([
      { kind: 'start', state: 'open', text: 'Start "Fix"?', startTodos: [fix.todo.id] },
    ]);
    await call('neo.todo.add', { askId: 'ask', title: 'Note', doneWhen: 'Written' });
    const deploy = await call('neo.todo.add', {
      askId: 'ask',
      title: 'Deploy',
      doneWhen: 'Live',
      instruction: 'Deploy it',
      target,
    });
    if (!deploy.ok) throw new Error(deploy.reason);
    expect(repo.listQuestions('ask')).toMatchObject([
      { kind: 'start', text: 'Start these 2?', startTodos: [fix.todo.id, deploy.todo.id] },
    ]);
    expect(repo.listTodos('ask').map((todo) => [todo.title, todo.state, todo.blockedBy])).toEqual([
      ['Fix', 'blocked', 'question'],
      ['Note', 'todo', null],
      ['Deploy', 'blocked', 'question'],
    ]);
  });

  test('extending the start question drops a todo that can no longer start', async () => {
    const { repo, call } = setup();
    const target = { verb: 'send', ref: { adapter: 'hyperneo', id: 'w' } };
    const fix = await call('neo.todo.add', {
      askId: 'ask',
      title: 'Fix',
      doneWhen: 'Merged',
      instruction: 'Fix it',
      target,
    });
    if (!fix.ok) throw new Error(fix.reason);
    await call('neo.todo.remove', { todoId: fix.todo.id, reason: 'not needed' });
    const deploy = await call('neo.todo.add', {
      askId: 'ask',
      title: 'Deploy',
      doneWhen: 'Live',
      instruction: 'Deploy it',
      target,
    });
    if (!deploy.ok) throw new Error(deploy.reason);
    expect(repo.listQuestions('ask')).toMatchObject([
      { state: 'retired', retiredReason: 'nothing left to start', startTodos: [] },
      { state: 'open', text: 'Start "Deploy"?', startTodos: [deploy.todo.id] },
    ]);
  });
});

describe('a pack owns its check', () => {
  const gauge = {
    id: 'gauge',
    describe: 'gauges',
    instructions: () => null,
    todos: {
      doneWhen: (check) => `gauge ${check.kind} reads ${String(check.params.target)}`,
      refuse: (draft) => (draft.instruction ? null : 'gauge needs an instruction'),
    },
  } as NeoPack;
  const target = { verb: 'send', ref: { adapter: 'hyperneo', id: 'w' } };
  const check = { pack: 'gauge', kind: 'level', params: { target: 5 } };

  test("writes the todo's done-when, and Neo cannot edit it", async () => {
    const { call } = setup([gauge]);
    const added = await call('neo.todo.add', {
      askId: 'ask',
      title: 'Fill it',
      doneWhen: 'Full enough',
      check,
      instruction: 'Fill the tank.',
      target,
    });
    if (!added.ok) throw new Error(added.reason);
    expect(added.todo.doneWhen).toBe('gauge level reads 5');
    expect(await call('neo.todo.edit', { todoId: added.todo.id, doneWhen: 'Half' })).toEqual({
      ok: false,
      reason:
        "done_when_from_check: this todo's done-when comes from its check; change the check instead.",
    });
  });

  test('a todo whose done-when predates its pack wording stays editable', async () => {
    const { repo, call } = setup([gauge]);
    const old = repo.addTodo(
      'old',
      'ask',
      { title: 'Fill it', doneWhen: 'Full enough', check, instruction: 'Fill.', named: null },
      1
    );
    const edited = await call('neo.todo.edit', { todoId: old.id, doneWhen: 'Half full' });
    expect(edited.ok && edited.todo.doneWhen).toBe('Half full');
  });

  test('refuses a check its pack refuses, and adds nothing', async () => {
    const { repo, call } = setup([gauge]);
    expect(
      await call('neo.todo.add', { askId: 'ask', title: 'Fill it', doneWhen: 'Full', check })
    ).toEqual({ ok: false, reason: 'check_refused: gauge needs an instruction' });
    expect(repo.listTodos('ask')).toEqual([]);
  });
});
