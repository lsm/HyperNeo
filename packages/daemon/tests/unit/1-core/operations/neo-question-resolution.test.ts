import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema/index';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository';
import {
  createNeoQuestionOperations,
  createNeoWorkerQuestionWriter,
  readNeoQuestion,
} from '../../../../src/lib/neo/question-operations';
import { createNeoQuestionAnswerDelivery } from '../../../../src/lib/neo/question-answer-delivery';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createWorkVerbOperations } from '../../../../src/lib/drivers/work-operations';

const owner = { source: 'mcp', sessionId: 'neo', role: 'neo' } as const;
const rule = 'Use staging for previews.';
async function fixture(path = ':memory:', adapter = 'hyperneo') {
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
    title: 'Plan',
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
    adapter,
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
  const reported = await write(source, {
    todoId: todo.id,
    kind: 'blocked',
    title: 'Choose a destination',
    options: ['Staging', 'Production'],
    language: 'en',
    report: 'Need a destination',
  });
  if (!reported.ok) throw new Error(reported.reason);
  const rules = [rule];
  const messages = new Map<string, string>();
  const notes = new Map<string, string>();
  const native = createOperationRegistry(
    createWorkVerbOperations({
      daemonName: 'synthetic',
      remote: {
        list: () => [],
        invoke: async () => {
          throw new Error('No remote in this fixture');
        },
      },
      adapters: () => [
        {
          id: 'codex-desktop',
          capabilities: ['send'],
          find: () => [],
          send: async (_ref, message) => {
            messages.set(message.split('\n')[0], message);
            return { ok: true, value: { delivered: true } };
          },
        },
      ],
    })
  );
  let unavailable = false;
  const flush = createNeoQuestionAnswerDelivery(
    store,
    sessions,
    async (_caller, name, input) => {
      if (unavailable)
        return { kind: 'completed', value: { kind: 'rejected', reason: 'Unavailable' } };
      if (adapter !== 'hyperneo') return invokeOperation(native, name, input, _caller);
      messages.set(String(input.idempotencyKey), String(input.text));
      return {
        kind: 'completed',
        value: { kind: 'accepted', messageId: 'accepted-input', mailboxId: 'mailbox' },
      };
    },
    async (_session, key, text) => {
      notes.set(key, String(text));
    },
    async (current) => store.recompute(current, {}, 10, { state: 'no_opinion' }, async () => {}),
    (error) => {
      throw error;
    }
  );
  const registry = createOperationRegistry(
    createNeoQuestionOperations(
      store,
      async (_ask, question, note) => {
        notes.set(`neo-question:${question.id}`, note);
      },
      async () => ({ ok: true }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (id) => flush(id),
      () => rules
    )
  );
  const call = async (name: string, input: unknown, caller: OperationCaller = owner) => {
    const result = await invokeOperation(registry, name, input, caller);
    return result.kind === 'completed' ? result.value : result;
  };
  const resolve = (
    source: unknown,
    extra: Record<string, unknown> = {},
    caller: OperationCaller = owner
  ) =>
    call(
      'neo.question.resolve',
      { questionId: reported.question.id, answer: ['Staging'], source, ...extra },
      caller
    );
  const prior = (askId = 'ask', text = 'Previous destination') => {
    const question = store.askQuestion(
      'prior',
      askId,
      {
        text,
        kind: 'choice',
        options: ['Staging', 'Production'],
        multiple: false,
        noLabel: null,
        yesLabel: null,
        startTodos: null,
      },
      1
    );
    store.answerQuestion(question, ['Staging'], 'chat', 2);
    return question;
  };
  return {
    db,
    store,
    rules,
    messages,
    notes,
    flush,
    call,
    resolve,
    prior,
    async next() {
      const result = await write(source, {
        todoId: todo.id,
        kind: 'blocked',
        title: 'Choose the next destination',
        options: ['Staging', 'Production'],
        language: 'en',
        report: 'Need another decision',
      });
      if (!result.ok) throw new Error(result.reason);
      return result.question;
    },
    question: reported.question,
    unavailable(value: boolean) {
      unavailable = value;
    },
  };
}

test('a cited saved rule retires the worker card and delivers once without human approval', async () => {
  const f = await fixture();
  try {
    expect(await f.resolve({ kind: 'rule', text: rule })).toMatchObject({
      ok: true,
      question: { state: 'retired', answer: ['Staging'], answeredBy: null },
    });
    expect(await f.call('neo.question.get', { questionId: f.question.id })).toMatchObject({
      answeredByHuman: false,
      resolvedByAgent: true,
      question: { retiredReason: expect.stringContaining(rule) },
      answerDelivery: [{ answeredBy: 'rule', state: 'accepted' }],
    });
    expect(f.store.getTodo('todo')).toMatchObject({ state: 'doing', blockedBy: null });
    expect([...f.messages.values()][0]).toContain('Neo resolved');
    expect([...f.messages.values()][0]).toContain(rule);
    expect([...f.notes.values()].join()).toContain('Neo resolved');
    expect([...f.notes.values()].join()).not.toContain('The human answered');
    await f.resolve({ kind: 'rule', text: rule });
    await f.flush();
    expect(f.messages.size).toBe(1);
  } finally {
    f.db.close();
  }
});

test('an earlier human answer can be cited, while a retired agent resolution cannot', async () => {
  const f = await fixture();
  try {
    const prior = f.prior();
    expect(await f.resolve({ kind: 'answer', questionId: prior.id })).toMatchObject({ ok: true });
    expect(f.store.getQuestion(f.question.id)?.retiredReason).toContain(prior.id);
    expect(readNeoQuestion(f.store.getQuestion(prior.id))).toMatchObject({
      answeredByHuman: true,
      resolvedByAgent: false,
    });
    expect(readNeoQuestion(f.store.getQuestion(f.question.id))).toMatchObject({
      answeredByHuman: false,
      resolvedByAgent: true,
    });
    const next = await f.next();
    expect(
      await f.resolve({ kind: 'answer', questionId: f.question.id }, { questionId: next.id })
    ).toMatchObject({ ok: false });
    expect(f.store.getQuestion(next.id)?.state).toBe('open');
    expect(f.store.getTodo('todo')?.blockedBy).toBe('needs-human');
    expect(f.messages.size).toBe(1);
  } finally {
    f.db.close();
  }
});

test('a long prior card remains a citation without overflowing external worker input', async () => {
  const f = await fixture(undefined, 'codex-desktop');
  try {
    const prior = f.prior('ask', `Earlier decision ${'x'.repeat(22000)}`);
    expect(await f.resolve({ kind: 'answer', questionId: prior.id })).toMatchObject({ ok: true });
    expect(await f.call('neo.question.get', { questionId: f.question.id })).toMatchObject({
      answerDelivery: [{ state: 'accepted' }],
    });
    expect(f.store.getTodo('todo')).toMatchObject({ state: 'doing', blockedBy: null });
    expect(f.messages.size).toBe(1);
    expect([...f.messages.values()][0]).toContain(prior.id);
  } finally {
    f.db.close();
  }
});

test.each([
  'missing-rule',
  'missing-answer',
  'foreign-answer',
  'worker',
  'foreign-neo',
  'approval-card',
  'start-card',
  'ordinary-card',
  'invalid-answer',
])('invalid triage leaves the card open and worker held: %s', async (bad) => {
  const f = await fixture();
  try {
    let source: unknown = { kind: 'rule', text: rule };
    let caller: OperationCaller = owner;
    let questionId = f.question.id;
    let answer: string | string[] = ['Staging'];
    if (bad === 'missing-rule') f.rules.length = 0;
    if (bad === 'missing-answer') source = { kind: 'answer', questionId: 'missing' };
    if (bad === 'foreign-answer') {
      f.store.openAsk({
        id: 'foreign',
        sessionId: 'another-neo',
        projectId: null,
        originMessageId: null,
        title: 'Other',
        request: 'Other',
        createdAt: 1,
      });
      source = { kind: 'answer', questionId: f.prior('foreign').id };
    }
    if (bad === 'worker') caller = { source: 'mcp', sessionId: 'worker', role: 'worker' };
    if (bad === 'foreign-neo') caller = { ...owner, sessionId: 'another-neo' };
    if (bad === 'approval-card' || bad === 'ordinary-card' || bad === 'start-card') {
      questionId = f.store.askQuestion(
        'ordinary',
        'ask',
        {
          text: 'May I proceed?',
          kind: bad === 'approval-card' ? 'yesno' : bad === 'start-card' ? 'start' : 'reply',
          options: null,
          multiple: false,
          noLabel: 'No',
          yesLabel: 'Yes',
          startTodos: bad === 'start-card' ? ['todo'] : null,
          confirm:
            bad === 'approval-card' ? { path: 'direction.md', sha256: 'a'.repeat(64) } : null,
        },
        1
      ).id;
      answer = bad === 'approval-card' ? 'yes' : bad === 'start-card' ? ['todo'] : 'Use staging.';
      if (bad !== 'ordinary-card')
        f.store.questionAnswers.bind(questionId, 'todo', f.question.sourceSession!);
    }
    if (bad === 'invalid-answer') answer = ['Not an option'];
    expect(await f.resolve(source, { questionId, answer }, caller)).toMatchObject({ ok: false });
    expect(f.store.getQuestion(questionId)?.state).toBe('open');
    expect(f.store.getTodo('todo')?.blockedBy).toBe('needs-human');
    expect(f.messages.size).toBe(0);
  } finally {
    f.db.close();
  }
});

test('failed delivery retains its hold and durable citation through restart', async () => {
  const run = mkdtempSync(join(tmpdir(), 'question-resolution-'));
  const path = join(run, 'daemon.db');
  const f = await fixture(path);
  let closed = false;
  try {
    f.unavailable(true);
    expect(await f.resolve({ kind: 'rule', text: rule })).toMatchObject({ ok: true });
    expect(f.store.getTodo('todo')?.blockedBy).toBe('needs-human');
    f.rules.length = 0;
    f.unavailable(false);
    await f.flush();
    expect(f.store.getTodo('todo')?.state).toBe('doing');
    f.db.close();
    closed = true;
    const reopened = new Database(path);
    try {
      const store = new NeoAskTodoRepository(reopened);
      expect(readNeoQuestion(store.getQuestion(f.question.id))).toMatchObject({
        answeredByHuman: false,
        resolvedByAgent: true,
        question: { retiredReason: expect.stringContaining(rule) },
      });
      expect(store.questionAnswers.list(f.question.id)).toMatchObject([
        { answeredBy: 'rule', state: 'accepted' },
      ]);
    } finally {
      reopened.close();
    }
  } finally {
    if (!closed) f.db.close();
    rmSync(run, { recursive: true, force: true });
  }
});
