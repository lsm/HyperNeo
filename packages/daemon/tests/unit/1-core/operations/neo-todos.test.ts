import { describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const owner: OperationCaller = { source: 'mcp', sessionId: 'neo-a', role: 'neo' };
const other: OperationCaller = { source: 'mcp', sessionId: 'neo-b', role: 'neo' };

function setup() {
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
  const ops = Object.fromEntries(
    createNeoTodoOperations(repo, new NeoTodoSessionRepository(db), {
      start: async () => ({ ok: false as const, reason: 'not started' }),
      proceed: async () => ({ ok: false as const, reason: 'no session' }),
      retry: async () => ({ ok: false as const, reason: 'not failed' }),
      stop: async (todo) => {
        stopped.push(todo.id);
      },
    }).map((op) => [op.name, op])
  );
  const call = async (name: string, input: unknown, caller = owner) =>
    (await ops[name].execute(ops[name].inputSchema.parse(input), caller)) as
      | { ok: true; todo: NeoTodo; todos: NeoTodo[] }
      | { ok: false; reason: string };
  return { db, repo, call, stopped, changes: () => changes };
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

  test('only the owning Neo session changes an open ask', async () => {
    const { db, call } = setup();
    expect(await call('neo.todo.add', { askId: 'ask', title: 'x', doneWhen: 'y' }, other)).toEqual({
      ok: false,
      reason: 'not_owner: another Neo session owns this ask.',
    });
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

  test('start:true needs a turn the human started', async () => {
    const { call } = setup();
    const target = { verb: 'send', ref: { adapter: 'hyperneo', id: 'w' } };
    expect(
      await call('neo.todo.add', {
        askId: 'ask',
        title: 'Fix',
        doneWhen: 'Merged',
        instruction: 'Fix it',
        target,
        start: true,
      })
    ).toEqual({
      ok: false,
      reason:
        'start_needs_human: start:true only in a turn the human started; ask a start question instead.',
    });
    await expect(
      call('neo.todo.add', {
        askId: 'ask',
        title: 'Fix',
        doneWhen: 'Merged',
        instruction: 'Fix it',
      })
    ).rejects.toThrow();
  });
});
