import { expect, test } from 'bun:test';
import {
  createNeoWorkerQuestionWriter,
  createNeoQuestionOperations,
} from '../../../../src/lib/neo/question-operations.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { createNeoQuestionAnswerDelivery } from '../../../../src/lib/neo/question-answer-delivery.ts';
import type { OperationOutcome } from '../../../../src/lib/operations/invoke.ts';
import type { NeoTodoRunnerDeps } from '../../../../src/lib/neo/todo-runner.ts';

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

async function deliveryFixture(adapter = 'hyperneo') {
  const f = await fixture();
  const ref = { ...f.source, adapter };
  if (adapter !== 'hyperneo') {
    new NeoTodoSessionRepository(f.db).bind('todo', ref, 3);
    await f.write(ref, f.report);
  }
  f.store.answerQuestion(f.question, ['Staging'], 'button', 4);
  const inputs: string[] = [];
  const notes = new Map<string, string>();
  let failed = false;
  let uncertain = false;
  let crash = false;
  const invoke: NeoTodoRunnerDeps['invoke'] = async (
    _caller,
    name,
    input
  ): Promise<OperationOutcome> => {
    if (name === 'work.status')
      return {
        kind: 'completed',
        value: { ok: true, value: { recentInputs: inputs.map((text) => ({ text, at: 5 })) } },
      };
    if (failed)
      return {
        kind: 'completed',
        value:
          name === 'message.send'
            ? { kind: 'rejected', reason: 'synthetic unavailable' }
            : { ok: false, reason: 'not_open', detail: 'synthetic unavailable' },
      };
    inputs.push(String(input.text ?? input.message));
    if (crash) throw new Error('synthetic lost response');
    return {
      kind: 'completed',
      value:
        name === 'message.send'
          ? { kind: 'accepted', messageId: 'accepted-input', mailboxId: 'mailbox' }
          : {
              ok: true,
              value: uncertain
                ? { delivered: false, unconfirmed: true }
                : { delivered: true, startedTurnId: 'accepted-turn' },
            },
    };
  };
  const flush = () =>
    createNeoQuestionAnswerDelivery(
      f.store,
      new NeoTodoSessionRepository(f.db),
      invoke,
      async (_session, key, content) => {
        notes.set(key, String(content));
      },
      async (todo) => f.store.recompute(todo, {}, 8, { state: 'no_opinion' }, async () => {}),
      () => {}
    );
  return {
    ...f,
    inputs,
    notes,
    flush,
    fail(value: boolean) {
      failed = value;
    },
    uncertain(value: boolean) {
      uncertain = value;
    },
    crash(value: boolean) {
      crash = value;
    },
  };
}

test.each(['hyperneo', 'codex-desktop'])(
  'a human answer goes directly to %s and releases its hold once',
  async (adapter) => {
    const f = await deliveryFixture(adapter);
    try {
      await f.flush()();
      expect(f.inputs).toHaveLength(1);
      expect(f.inputs[0]).toContain('Staging');
      expect([...f.notes.values()].join()).toContain('Staging');
      expect(await f.read()).toMatchObject({
        answerDelivery: [{ state: 'accepted' }],
        answeredByHuman: true,
      });
      expect(f.store.getTodo('todo')).toMatchObject({ state: 'doing', blockedBy: null });
      await f.flush()();
      expect(f.inputs).toHaveLength(1);
      expect(f.notes.size).toBe(1);
    } finally {
      f.db.close();
    }
  }
);

test.each(['hyperneo', 'codex-desktop'])(
  'a failed %s delivery holds the todo until a successful retry',
  async (adapter) => {
    const f = await deliveryFixture(adapter);
    try {
      f.fail(true);
      await f.flush()();
      expect(f.store.getTodo('todo')?.blockedBy).toBe('needs-human');
      expect(await f.read()).toMatchObject({ answerDelivery: [{ state: 'pending' }] });
      f.fail(false);
      await f.flush()();
      expect(f.inputs).toHaveLength(1);
      expect(f.store.getTodo('todo')?.state).toBe('doing');
    } finally {
      f.db.close();
    }
  }
);

test('an uncertain external response is reconciled after restart without resending', async () => {
  const f = await deliveryFixture('codex-desktop');
  try {
    f.crash(true);
    await f.flush()();
    expect(f.store.getTodo('todo')?.blockedBy).toBe('needs-human');
    expect(f.inputs).toHaveLength(1);
    f.crash(false);
    await f.flush()();
    expect(f.inputs).toHaveLength(1);
    expect(f.store.getTodo('todo')?.state).toBe('doing');
  } finally {
    f.db.close();
  }
});

test('an unconfirmed external write without peer evidence stays held and is never blindly repeated', async () => {
  const f = await deliveryFixture('codex-desktop');
  try {
    f.uncertain(true);
    await f.flush()();
    const text = f.inputs[0];
    f.inputs.length = 0;
    await f.flush()();
    expect(f.inputs).toHaveLength(0);
    expect(f.store.getTodo('todo')?.blockedBy).toBe('needs-human');
    f.inputs.push(text);
    await f.flush()();
    expect(f.inputs).toHaveLength(1);
    expect(f.store.getTodo('todo')?.state).toBe('doing');
  } finally {
    f.db.close();
  }
});

test('an accepted old answer cannot release a later worker question or a rebound todo', async () => {
  const f = await deliveryFixture();
  try {
    await f.flush()();
    await f.write(f.source, { ...f.report, title: 'Choose the next destination' });
    f.store.updateTodo(f.store.getTodo('todo')!, { state: 'doing' }, 9);
    expect(f.store.getTodo('todo')?.blockedBy).toBe('needs-human');
    const latest = f.store.listQuestions('ask').find((q) => q.state === 'open')!;
    f.store.answerQuestion(latest, ['Staging'], 'button', 10);
    await f.flush()();
    new NeoTodoSessionRepository(f.db).bind('todo', { ...f.source, id: 'other-worker' }, 11);
    await f.write({ ...f.source, id: 'other-worker' }, f.report);
    f.store.updateTodo(f.store.getTodo('todo')!, { state: 'doing' }, 12);
    expect(f.store.getTodo('todo')?.blockedBy).toBe('needs-human');
  } finally {
    f.db.close();
  }
});
