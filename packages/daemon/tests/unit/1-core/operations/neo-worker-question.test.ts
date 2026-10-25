import { expect, test } from 'bun:test';
import { createNeoWorkerQuestionWriter } from '../../../../src/lib/neo/question-operations.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  store.openAsk({
    id: 'ask',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    title: 'Build',
    request: 'Build',
    createdAt: 1,
  });
  const todo = store.addTodo(
    'todo',
    'ask',
    { title: 'Build', doneWhen: 'Done', check: null, instruction: null, named: null },
    1
  );
  const ref = { adapter: 'hyperneo', id: 'worker' };
  sessions.bind(todo.id, ref, 2);
  store.updateTodo(todo, { state: 'doing', startedAt: 2 }, 2);
  const write = createNeoWorkerQuestionWriter(
    store,
    sessions,
    () => 'en',
    async (source) => ({
      ...source,
      name: 'Worker',
      label: 'HyperNeo · Worker',
      provider: 'Test',
      link: null,
    })
  );
  return { db, store, sessions, ref, write };
}
const report = {
  todoId: 'todo',
  kind: 'blocked',
  title: 'Choose a destination',
  options: ['Use staging', 'Use production'],
  language: 'en',
  report: '  Original worker evidence\n',
};

test('assignment is revalidated after source lookup and the card/hold commit together', async () => {
  const { db, store, sessions, ref } = setup();
  try {
    const write = createNeoWorkerQuestionWriter(
      store,
      sessions,
      () => 'en',
      async () => {
        sessions.bind('todo', { ...ref, id: 'replacement' }, 3);
        return { ...ref, name: 'Worker', label: 'Worker', provider: 'Test', link: null };
      }
    );
    expect(await write(ref, report)).toMatchObject({ ok: false });
    expect(store.listQuestions('ask')).toHaveLength(0);
    sessions.bind('todo', ref, 4);
    const atomic = createNeoWorkerQuestionWriter(
      store,
      sessions,
      () => 'en',
      async () => ({ ...ref, name: 'Worker', label: 'Worker', provider: 'Test', link: null })
    );
    db.exec(
      "CREATE TRIGGER refuse_hold BEFORE UPDATE ON neo_todos WHEN NEW.blocked_by = 'needs-human' BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END"
    );
    await expect(atomic(ref, report)).rejects.toThrow('synthetic write failure');
    expect(store.listQuestions('ask')).toHaveLength(0);
    expect(store.getTodo('todo')?.state).toBe('doing');
  } finally {
    db.close();
  }
});

test('worker reports reuse the existing card and preserve a durable hold through routine updates', async () => {
  const { db, store, ref, write } = setup();
  try {
    const first = await write(ref, report);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.reason);
    expect(first.question).toMatchObject({
      todoId: 'todo',
      text: report.title,
      options: report.options,
      document: report.report,
      sourceSession: { id: ref.id },
    });
    expect(await write(ref, { ...report, report: 'Repeat' })).toMatchObject({
      ok: true,
      question: { id: first.question.id },
    });
    expect(store.listQuestions('ask').filter((q) => q.state === 'open')).toHaveLength(1);
    store.updateTodo(store.getTodo('todo')!, { state: 'doing', report: 'Routine activity' }, 4);
    await store.recompute(
      store.getTodo('todo')!,
      {},
      5,
      { state: 'done', evidence: 'Routine check' },
      async () => {}
    );
    expect(store.getTodo('todo')).toMatchObject({ state: 'blocked', blockedBy: 'needs-human' });
    store.answerQuestion(first.question, ['Use staging'], 'button', 6);
    store.updateTodo(store.getTodo('todo')!, { state: 'doing' }, 7);
    expect(store.getTodo('todo')).toMatchObject({ state: 'blocked', blockedBy: 'needs-human' });
  } finally {
    db.close();
  }
});

test.each([
  ['wrong worker', { adapter: 'hyperneo', id: 'stranger' }, report],
  ['wrong daemon', { adapter: 'hyperneo', id: 'worker', daemon: 'other' }, report],
  ['missing todo', { adapter: 'hyperneo', id: 'worker' }, { ...report, todoId: 'missing' }],
  ['long title', { adapter: 'hyperneo', id: 'worker' }, { ...report, title: 'x'.repeat(81) }],
  ['multiline title', { adapter: 'hyperneo', id: 'worker' }, { ...report, title: 'One\nTwo' }],
  ['one option', { adapter: 'hyperneo', id: 'worker' }, { ...report, options: ['Only'] }],
  ['wrong language', { adapter: 'hyperneo', id: 'worker' }, { ...report, language: 'zh-Hans' }],
  [
    'claimed identity',
    { adapter: 'hyperneo', id: 'worker' },
    { ...report, sourceSession: { id: 'fake' } },
  ],
])('refuses %s without creating a card or hold', async (_label, ref, input) => {
  const { db, store, write } = setup();
  try {
    expect(await write(ref, input)).toMatchObject({ ok: false });
    expect(store.listQuestions('ask')).toHaveLength(0);
    expect(store.getTodo('todo')?.state).toBe('doing');
  } finally {
    db.close();
  }
});
