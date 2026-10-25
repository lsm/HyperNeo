import { expect, test } from 'bun:test';
import {
  createNeoWorkerQuestionWriter,
  createNeoQuestionOperations,
} from '../../../../src/lib/neo/question-operations.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';

async function fixture() {
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
    { title: 'Build', doneWhen: 'Built', instruction: null, check: null, named: null },
    1
  );
  const source = {
    adapter: 'hyperneo' as const,
    id: 'worker',
    name: 'Worker',
    label: 'Worker',
    provider: 'Synthetic',
    link: null,
  };
  sessions.bind(todo.id, source, 2);
  store.updateTodo(todo, { state: 'doing', startedAt: 2 }, 2);
  const write = createNeoWorkerQuestionWriter(
    store,
    sessions,
    () => 'en',
    async () => source
  );
  const report = {
    todoId: todo.id,
    kind: 'blocked',
    title: 'Choose a destination',
    options: ['Staging', 'Production'],
    language: 'en',
    report: 'Need a destination',
  };
  const result = await write(source, report);
  if (!result.ok) throw new Error(result.reason);
  const get = createNeoQuestionOperations(
    store,
    async () => {},
    async () => ({ ok: true })
  ).find((op) => op.name === 'neo.question.get')!;
  const read = () => get.execute({ questionId: result.question.id }, { source: 'rpc' });
  return { db, store, source, write, report, question: result.question, read };
}

test('worker card exposes one immutable answer route before and after an answer', async () => {
  const f = await fixture();
  try {
    await f.write(f.source, f.report);
    const pending = await f.read();
    expect(pending).toMatchObject({
      ok: true,
      answerDelivery: [{ todoId: 'todo', state: 'waiting', sourceSession: f.source }],
    });
    f.store.answerQuestion(f.question, ['Staging'], 'button', 3);
    expect(await f.read()).toMatchObject({
      answeredByHuman: true,
      answerDelivery: [{ state: 'pending', answer: ['Staging'], answeredBy: 'button' }],
    });
    expect(f.store.answerQuestion(f.question, ['Production'], 'chat', 4)).toBeNull();
    expect(await f.read()).toMatchObject({
      answerDelivery: [{ answer: ['Staging'], answeredBy: 'button' }],
    });
    expect(f.store.getTodo('todo')).toMatchObject({ state: 'blocked', blockedBy: 'needs-human' });
  } finally {
    f.db.close();
  }
});

test('delivery acknowledgement is retained without releasing the hold in this build slice', async () => {
  const f = await fixture();
  try {
    f.store.answerQuestion(f.question, 'Use the preview environment', 'chat', 3);
    const [route] = f.store.questionAnswers.list(f.question.id);
    expect(route.answer).toBe('Use the preview environment');
    expect(f.store.questionAnswers.accept(route.id, 'synthetic-delivery', 4)).toBe(true);
    expect(f.store.questionAnswers.accept(route.id, 'different-receipt', 5)).toBe(false);
    expect(await f.read()).toMatchObject({
      answerDelivery: [
        { state: 'accepted', receipt: 'synthetic-delivery', acceptedAt: 4, answeredBy: 'chat' },
      ],
    });
    expect(f.store.questionAnswers.pending()).toHaveLength(0);
    expect(f.store.getTodo('todo')?.blockedBy).toBe('needs-human');
  } finally {
    f.db.close();
  }
});

test('unanswered routes cannot acknowledge delivery and route writes roll back with the hold', async () => {
  const f = await fixture();
  try {
    const [route] = f.store.questionAnswers.list(f.question.id);
    expect(f.store.questionAnswers.accept(route.id, 'premature', 3)).toBe(false);
    f.db.exec(
      "CREATE TRIGGER refuse_answer BEFORE UPDATE ON neo_question_answers WHEN NEW.answer IS NOT NULL BEGIN SELECT RAISE(ABORT, 'synthetic answer failure'); END"
    );
    expect(() => f.store.answerQuestion(f.question, ['Staging'], 'button', 4)).toThrow(
      'synthetic answer failure'
    );
    expect(await f.read()).toMatchObject({
      question: { state: 'open' },
      answerDelivery: [{ state: 'waiting', answer: null }],
    });
  } finally {
    f.db.close();
  }
});
