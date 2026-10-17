import { describe, expect, test } from 'bun:test';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import {
  createNeoAskRecordOperations,
  requireNeoAskSession,
} from '../../../../src/lib/neo/ask-record-operations.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const turn = (messageId: string, human = true): OperationCaller => ({
  source: 'mcp',
  sessionId: 'neo-a',
  role: 'neo',
  neoTurn: { messageId, human, isLive: () => true },
});

type Receipt = { ok: true; ask: NeoAsk; todos: NeoTodo[] } | { ok: false; reason: string };

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  const started: string[] = [];
  const stopped: string[] = [];
  const ops = Object.fromEntries(
    createNeoAskRecordOperations(
      store,
      sessions,
      {
        start: async (todoId) => {
          started.push(todoId);
          return { ok: true, todo: store.getTodo(todoId)! };
        },
        proceed: async () => ({ ok: false, reason: 'unused' }),
        retry: async () => ({ ok: false, reason: 'unused' }),
        stop: async (todo) => {
          stopped.push(todo.id);
        },
      },
      () => 'project-1'
    ).map((op) => [op.name, op])
  );
  const call = async (name: string, input: unknown, caller: OperationCaller) =>
    (await ops[name].execute(ops[name].inputSchema.parse(input), caller)) as Receipt;
  return { store, call, started, stopped };
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
  test('opens an ask with its todos once per turn and starts the ones asked to start', async () => {
    const { call, started } = setup();
    const first = await call('neo.ask.open', opening, turn('m1'));
    if (!first.ok) throw new Error(first.reason);
    expect(first.ask).toMatchObject({
      projectId: 'project-1',
      sessionId: 'neo-a',
      originMessageId: 'm1',
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

  test('start in a turn the human did not start is refused before anything is written', async () => {
    const { call, store } = setup();
    expect(await call('neo.ask.open', opening, turn('m2', false))).toEqual({
      ok: false,
      reason:
        'start_needs_human: start:true only in a turn the human started; ask a start question instead.',
    });
    expect(store.listAsks(undefined, 10)).toEqual([]);
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
    expect(
      await call(
        'neo.ask.settle',
        { askId: opened.ask.id, status: 'done', outcome: 'x' },
        turn('m4')
      )
    ).toEqual({ ok: false, reason: 'ask_settled: this ask is dropped.' });
  });
});

describe('requireNeoAskSession', () => {
  test('needs a Neo session', () => {
    expect(requireNeoAskSession({ source: 'rpc' })).toEqual({
      reason: { ok: false, reason: 'no_session: only a Neo session opens an ask.' },
    });
  });
});
