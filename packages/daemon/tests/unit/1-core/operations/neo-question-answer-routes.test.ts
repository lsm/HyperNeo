import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import {
  createNeoWorkerQuestionWriter,
  createNeoQuestionOperations,
} from '../../../../src/lib/neo/question-operations.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { runMigration457 } from '../../../../src/storage/schema/m457-neo-question-answers.ts';

async function fixture(path = ':memory:') {
  const db = new Database(path);
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
    async (ref) => ({ ...source, ...ref })
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
  const read = (questionId = result.question.id) => get.execute({ questionId }, { source: 'rpc' });
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
      "CREATE TRIGGER refuse_answer BEFORE UPDATE ON neo_questions WHEN NEW.answer IS NOT NULL BEGIN SELECT RAISE(ABORT, 'synthetic answer failure'); END"
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

test('upgrade recovers held historical answers once without changing their provenance', async () => {
  const f = await fixture();
  try {
    f.store.answerQuestion(f.question, 'Use preview', 'chat', 3);
    f.db.exec('UPDATE neo_questions SET worker_answers_json = NULL');
    runMigration457(f.db);
    runMigration457(f.db);
    const [route] = f.store.questionAnswers.pending();
    expect(await f.read()).toMatchObject({
      answerDelivery: [
        {
          state: 'pending',
          sourceSession: f.source,
          answer: 'Use preview',
          answeredBy: 'chat',
          answeredAt: 3,
        },
      ],
    });
    f.store.questionAnswers.accept(route.id, 'stored-receipt', 4);
    runMigration457(f.db);
    expect(await f.read()).toMatchObject({
      answerDelivery: [{ state: 'accepted', receipt: 'stored-receipt' }],
    });
    expect(f.store.questionAnswers.pending()).toHaveLength(0);
    expect(f.store.getTodo('todo')?.blockedBy).toBe('needs-human');
  } finally {
    f.db.close();
  }
});

test('a failed route write rolls back the new card and its needs-human hold', async () => {
  const f = await fixture();
  try {
    const todo = f.store.addTodo(
      'second',
      'ask',
      { title: 'Second', doneWhen: 'Built', instruction: null, check: null, named: null },
      2
    );
    new NeoTodoSessionRepository(f.db).bind(todo.id, f.source, 2);
    f.store.updateTodo(todo, { state: 'doing', startedAt: 2 }, 2);
    f.db.exec(
      "CREATE TRIGGER refuse_route BEFORE UPDATE ON neo_questions WHEN NEW.worker_answers_json IS NOT NULL BEGIN SELECT RAISE(ABORT, 'synthetic route failure'); END"
    );
    await expect(f.write(f.source, { ...f.report, todoId: todo.id })).rejects.toThrow(
      'synthetic route failure'
    );
    expect(f.store.listQuestions('ask')).toHaveLength(1);
    expect(f.store.getTodo(todo.id)).toMatchObject({ state: 'doing', blockedBy: null });
  } finally {
    f.db.close();
  }
});

test('startup does not turn a later manual replacement into a worker report', async () => {
  const f = await fixture();
  try {
    const ask = createNeoQuestionOperations(
      f.store,
      async () => {},
      async () => ({ ok: true }),
      undefined,
      undefined,
      async () => f.source
    ).find((op) => op.name === 'neo.question.ask')!;
    expect(
      await ask.execute(
        {
          askId: 'ask',
          todoId: 'todo',
          sourceSession: f.source,
          kind: 'reply',
          text: 'A manual clarification',
          replaces: f.question.id,
        },
        { source: 'rpc' }
      )
    ).toMatchObject({ ok: true });
    const replacement = f.store.listQuestions('ask').find((q) => q.state === 'open')!;
    expect(await f.read(replacement.id)).toMatchObject({ answerDelivery: [] });
    expect(f.store.getTodo('todo')?.blockedBy).toBe('needs-human');
    runMigrations(f.db, () => {});
    createTables(f.db);
    expect(await f.read(replacement.id)).toMatchObject({ answerDelivery: [] });
    expect(await f.read()).toMatchObject({ answerDelivery: [{ state: 'waiting' }] });
  } finally {
    f.db.close();
  }
});

test('a validated replacement worker receives the existing card answer route', async () => {
  const f = await fixture();
  try {
    const replacement = { ...f.source, id: 'replacement' };
    new NeoTodoSessionRepository(f.db).bind('todo', replacement, 3);
    const reported = await f.write(replacement, f.report);
    expect(reported).toMatchObject({ ok: true, question: { id: f.question.id } });
    expect(await f.read()).toMatchObject({
      answerDelivery: [{ sourceSession: replacement, state: 'waiting' }],
    });
    f.store.answerQuestion(f.question, ['Staging'], 'button', 4);
    const [route] = f.store.questionAnswers.pending();
    f.store.questionAnswers.accept(route.id, 'accepted-by-replacement', 5);
    f.store.questionAnswers.bind(f.question.id, 'todo', f.source);
    expect(await f.read()).toMatchObject({
      answerDelivery: [
        { sourceSession: replacement, receipt: 'accepted-by-replacement', acceptedAt: 5 },
      ],
    });
  } finally {
    f.db.close();
  }
});

test('question reads stay coherent when a peer connection tries to answer between projections', async () => {
  const run = mkdtempSync(join(tmpdir(), 'answer-read-race-'));
  const f = await fixture(join(run, 'daemon.db'));
  const peer = new Database(join(run, 'daemon.db'));
  peer.exec('PRAGMA busy_timeout = 0');
  const other = new NeoAskTodoRepository(peer);
  const read = f.store.getQuestion.bind(f.store);
  let attempted = false;
  let deferred = false;
  f.store.getQuestion = (id) => {
    const question = read(id);
    if (!attempted && id === f.question.id) {
      attempted = true;
      try {
        other.answerQuestion(f.question, ['Staging'], 'button', 4);
      } catch (error) {
        if (!/busy|locked/i.test(String(error))) throw error;
        deferred = true;
      }
    }
    return question;
  };
  try {
    expect(await f.read()).toMatchObject({
      question: { state: 'open', answer: null },
      answeredByHuman: false,
      answerDelivery: [{ state: 'waiting', answer: null }],
    });
    f.store.getQuestion = read;
    if (deferred) other.answerQuestion(f.question, ['Staging'], 'button', 4);
    expect(await f.read()).toMatchObject({
      question: { state: 'answered', answer: ['Staging'] },
      answeredByHuman: true,
      answerDelivery: [{ state: 'pending', answer: ['Staging'] }],
    });
  } finally {
    peer.close();
    f.db.close();
    rmSync(run, { recursive: true, force: true });
  }
});

test('competing delivery acknowledgements cannot replace an already accepted receipt', async () => {
  const run = mkdtempSync(join(tmpdir(), 'answer-accept-race-'));
  const f = await fixture(join(run, 'daemon.db'));
  const peer = new Database(join(run, 'daemon.db'));
  peer.exec('PRAGMA busy_timeout = 0');
  const other = new NeoAskTodoRepository(peer);
  try {
    f.store.answerQuestion(f.question, ['Staging'], 'button', 3);
    const answers = f.store.questionAnswers;
    const [route] = answers.pending();
    const pending = answers.pending.bind(answers);
    let peerAccepted = false;
    let deferred = false;
    answers.pending = () => {
      const routes = pending();
      try {
        peerAccepted = other.questionAnswers.accept(route.id, 'peer-receipt', 4);
      } catch (error) {
        if (!/busy|locked/i.test(String(error))) throw error;
        deferred = true;
      }
      return routes;
    };
    const accepted = answers.accept(route.id, 'first-receipt', 5);
    if (deferred) peerAccepted = other.questionAnswers.accept(route.id, 'peer-receipt', 6);
    expect(Number(accepted) + Number(peerAccepted)).toBe(1);
    expect(await f.read()).toMatchObject({
      answerDelivery: [
        { state: 'accepted', receipt: peerAccepted ? 'peer-receipt' : 'first-receipt' },
      ],
    });
  } finally {
    peer.close();
    f.db.close();
    rmSync(run, { recursive: true, force: true });
  }
});

test('recompute releases a held todo only after the latest answer was accepted by its assigned worker', async () => {
  const f = await fixture();
  try {
    f.store.answerQuestion(f.question, ['Staging'], 'button', 3);
    f.store.updateTodo(f.store.getTodo('todo')!, { state: 'doing' }, 4);
    expect(f.store.getTodo('todo')?.blockedBy).toBe('needs-human');
    const [route] = f.store.questionAnswers.pending();
    f.store.questionAnswers.accept(route.id, 'accepted-receipt', 5);
    await f.store.recompute(
      f.store.getTodo('todo')!,
      {},
      6,
      { state: 'no_opinion' },
      async () => {}
    );
    expect(f.store.getTodo('todo')).toMatchObject({ state: 'doing', blockedBy: null });
  } finally {
    f.db.close();
  }
});
