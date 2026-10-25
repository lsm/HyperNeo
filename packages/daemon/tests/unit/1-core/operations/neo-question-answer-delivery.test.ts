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

async function deliveryFixture() {
  const f = await fixture();
  f.store.answerQuestion(f.question, ['Staging'], 'button', 4);
  const inputs = new Map<string, string>();
  const notes = new Map<string, string>();
  let failed = false;
  const invoke: NeoTodoRunnerDeps['invoke'] = async (
    _caller,
    _name,
    input
  ): Promise<OperationOutcome> => {
    if (failed) return { kind: 'completed', value: { kind: 'rejected', reason: 'Unavailable' } };
    inputs.set(String(input.idempotencyKey), String(input.text));
    return {
      kind: 'completed',
      value: { kind: 'accepted', messageId: 'accepted-input', mailboxId: 'mailbox' },
    };
  };
  const flush = createNeoQuestionAnswerDelivery(
    f.store,
    new NeoTodoSessionRepository(f.db),
    invoke,
    async (_session, key, content) => {
      notes.set(key, String(content));
    },
    async (todo) => f.store.recompute(todo, {}, 8, { state: 'no_opinion' }, async () => {}),
    (error) => {
      throw error;
    }
  );
  return {
    ...f,
    inputs,
    notes,
    flush,
    fail(value: boolean) {
      failed = value;
    },
  };
}

test('a HyperNeo answer reaches the bound session and releases its hold once', async () => {
  const f = await deliveryFixture();
  try {
    await f.flush();
    expect(f.inputs.size).toBe(1);
    expect([...f.inputs.values()].join()).toContain('Staging');
    expect([...f.notes.values()].join()).toContain('Staging');
    expect(await f.read()).toMatchObject({
      answerDelivery: [{ state: 'accepted' }],
      answeredByHuman: true,
    });
    expect(f.store.getTodo('todo')).toMatchObject({ state: 'doing', blockedBy: null });
    await f.flush();
    expect(f.inputs.size).toBe(1);
    expect(f.notes.size).toBe(1);
  } finally {
    f.db.close();
  }
});

test('a refused HyperNeo admission stays held until a successful retry', async () => {
  const f = await deliveryFixture();
  try {
    f.fail(true);
    await f.flush();
    expect(f.store.getTodo('todo')?.blockedBy).toBe('needs-human');
    expect(await f.read()).toMatchObject({ answerDelivery: [{ state: 'pending' }] });
    f.fail(false);
    await f.flush();
    expect(f.inputs.size).toBe(1);
    expect(f.store.getTodo('todo')?.state).toBe('doing');
  } finally {
    f.db.close();
  }
});

test('an old accepted answer cannot release a newer unanswered worker card', async () => {
  const f = await deliveryFixture();
  try {
    await f.flush();
    await f.write(f.source, { ...f.report, title: 'Choose the next destination' });
    f.store.updateTodo(f.store.getTodo('todo')!, { state: 'doing' }, 9);
    expect(f.store.getTodo('todo')?.blockedBy).toBe('needs-human');
  } finally {
    f.db.close();
  }
});

test('external answer routes stay pending for the separately tracked delivery path', async () => {
  const f = await fixture();
  try {
    const peer = { ...f.source, adapter: 'codex-desktop' };
    new NeoTodoSessionRepository(f.db).bind('todo', peer, 3);
    await f.write(peer, f.report);
    f.store.answerQuestion(f.question, ['Staging'], 'button', 4);
    const calls: string[] = [];
    await createNeoQuestionAnswerDelivery(
      f.store,
      new NeoTodoSessionRepository(f.db),
      async (_caller, name) => {
        calls.push(name);
        throw new Error('No external dispatch in this slice');
      },
      async () => {
        calls.push('context');
      },
      async (todo) => f.store.recompute(todo, {}, 8, { state: 'no_opinion' }, async () => {}),
      (error) => {
        throw error;
      }
    )();
    expect(calls).toEqual([]);
    expect(await f.read()).toMatchObject({ answerDelivery: [{ state: 'pending', receipt: null }] });
    expect(f.store.getTodo('todo')?.blockedBy).toBe('needs-human');
  } finally {
    f.db.close();
  }
});

test('a button answer never waits for an unrelated unavailable HyperNeo session', async () => {
  const f = await fixture();
  const peer = { ...f.source, id: 'unavailable-peer', daemon: 'synthetic-remote' };
  const sessions = new NeoTodoSessionRepository(f.db);
  const other = f.store.addTodo(
    'other',
    'ask',
    { title: 'Other', doneWhen: 'Done', instruction: null, check: null, named: null },
    2
  );
  sessions.bind(other.id, peer, 3);
  f.store.updateTodo(other, { state: 'doing', startedAt: 3 }, 3);
  const reported = await f.write(peer, { ...f.report, todoId: other.id });
  if (!reported.ok) throw new Error(reported.reason);
  f.store.answerQuestion(reported.question, ['Staging'], 'button', 4);
  let announceTarget!: () => void;
  let announceStale!: () => void;
  let release!: () => void;
  const target = new Promise<void>((resolve) => {
    announceTarget = resolve;
  });
  const stale = new Promise<void>((resolve) => {
    announceStale = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const resumed: string[] = [];
  const flush = createNeoQuestionAnswerDelivery(
    f.store,
    sessions,
    async (_caller, _name, input) => {
      if (input.to !== f.source.id) {
        announceStale();
        await blocked;
        return { kind: 'completed', value: { kind: 'rejected', reason: 'Unavailable' } };
      }
      announceTarget();
      return {
        kind: 'completed',
        value: { kind: 'accepted', messageId: 'target-input', mailboxId: 'target-mailbox' },
      };
    },
    async () => {},
    async (todo) => {
      resumed.push(todo.id);
      return f.store.recompute(todo, {}, 5, { state: 'no_opinion' }, async () => {});
    },
    (error) => {
      throw error;
    }
  );
  const answer = createNeoQuestionOperations(
    f.store,
    async () => {},
    async () => ({ ok: true }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (id) => flush(id)
  ).find((op) => op.name === 'neo.question.answer')!;
  const running = answer.execute(
    { questionId: f.question.id, answer: ['Staging'] },
    { source: 'rpc', principal: 'local' }
  );
  try {
    expect(await Promise.race([target.then(() => 'target'), stale.then(() => 'stale')])).toBe(
      'target'
    );
    await running;
    expect(resumed).toEqual(['todo']);
    expect(f.store.getTodo('other')?.blockedBy).toBe('needs-human');
  } finally {
    release();
    await running;
    f.db.close();
  }
});
