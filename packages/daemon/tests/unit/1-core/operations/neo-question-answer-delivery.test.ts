import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@hyperneo/shared';
import type { Database as DaemonDatabase } from '../../../../src/storage/database.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { createNeoIntakeOperation } from '../../../../src/lib/neo/intake.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
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
import { createSendMessageOperation } from '../../../../src/lib/messaging/message-send.ts';
import { workInput } from '../../../../src/lib/drivers/work-messages.ts';

async function fixture(path = ':memory:', title = 'Choose a destination') {
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
    title,
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
    expect([...f.inputs.values()][0]).toMatch(
      /^The human answered[\s\S]*\n\[worker-answer:[a-f0-9-]+\]$/
    );
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

test('a competing duplicate rejection cannot strand an admitted answer or its hold', async () => {
  const f = await fixture();
  f.store.answerQuestion(f.question, ['Staging'], 'button', 4);
  let entered!: () => void;
  let release!: () => void;
  const admitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const registry = createOperationRegistry([
    createSendMessageOperation(
      new JobQueueRepository(f.db),
      () => 'active',
      undefined,
      undefined,
      async () => {
        entered();
        await barrier;
        return 'Neo';
      }
    ),
  ]);
  const outcomes: OperationOutcome[] = [];
  const flush = createNeoQuestionAnswerDelivery(
    f.store,
    new NeoTodoSessionRepository(f.db),
    async (caller, name, input) => {
      const outcome = await invokeOperation(registry, name, input, caller);
      outcomes.push(outcome);
      return outcome;
    },
    async () => {},
    async (todo) => f.store.recompute(todo, {}, 8, { state: 'no_opinion' }, async () => {}),
    (error) => {
      throw error;
    }
  );
  const winner = flush(f.question.id);
  try {
    await admitted;
    await flush();
    expect(outcomes).toMatchObject([
      {
        kind: 'completed',
        value: { kind: 'rejected', reason: expect.stringContaining('duplicate') },
      },
    ]);
    release();
    await winner;
    expect(await f.read()).toMatchObject({ answerDelivery: [{ state: 'accepted' }] });
    expect(f.store.getTodo('todo')).toMatchObject({ state: 'doing', blockedBy: null });
  } finally {
    release();
    await winner;
    f.db.close();
  }
});

test('a lost acknowledgement replays its durable HyperNeo receipt without another admission', async () => {
  const f = await fixture();
  f.store.answerQuestion(f.question, ['Staging'], 'button', 4);
  let admissions = 0;
  const registry = createOperationRegistry([
    createSendMessageOperation(
      new JobQueueRepository(f.db),
      () => 'active',
      undefined,
      undefined,
      () => {
        admissions++;
        return 'Neo';
      }
    ),
  ]);
  let loseReply = true;
  const warnings: unknown[] = [];
  const createDelivery = () =>
    createNeoQuestionAnswerDelivery(
      f.store,
      new NeoTodoSessionRepository(f.db),
      async (caller, name, input) => {
        const outcome = await invokeOperation(registry, name, input, caller);
        if (loseReply) throw new Error('Synthetic lost acknowledgement');
        return outcome;
      },
      async () => {},
      async (todo) => f.store.recompute(todo, {}, 8, { state: 'no_opinion' }, async () => {}),
      (error) => {
        warnings.push(error);
      }
    );
  try {
    await createDelivery()();
    expect(warnings).toHaveLength(1);
    expect(await f.read()).toMatchObject({ answerDelivery: [{ state: 'pending' }] });
    expect(f.store.getTodo('todo')?.blockedBy).toBe('needs-human');
    loseReply = false;
    await createDelivery()();
    expect(await f.read()).toMatchObject({ answerDelivery: [{ state: 'accepted' }] });
    expect(f.store.getTodo('todo')).toMatchObject({ state: 'doing', blockedBy: null });
    expect(admissions).toBe(1);
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

async function externalFixture(path = ':memory:', title = 'Choose a destination') {
  const f = await fixture(path, title);
  const peer = { ...f.source, adapter: 'codex-desktop' };
  new NeoTodoSessionRepository(f.db).bind('todo', peer, 3);
  await f.write(peer, f.report);
  f.store.answerQuestion(f.question, ['Staging'], 'button', 4);
  return { ...f, peer };
}

function externalDelivery(
  f: Awaited<ReturnType<typeof fixture>>,
  invoke: NeoTodoRunnerDeps['invoke'],
  warn: (error: unknown) => void = (error) => {
    throw error;
  }
) {
  return createNeoQuestionAnswerDelivery(
    f.store,
    new NeoTodoSessionRepository(f.db),
    invoke,
    async () => {},
    async (todo) => f.store.recompute(todo, {}, 8, { state: 'no_opinion' }, async () => {}),
    warn
  );
}

test.each([
  { delivered: true },
  { delivered: false },
  { delivered: false, queuedSubmissionId: 'accepted-queue' },
])('an accepted external answer releases its hold once: %j', async (delivery) => {
  const f = await externalFixture();
  const sent: unknown[] = [];
  const flush = externalDelivery(f, async (_caller, name, input) => {
    expect(name).toBe('work.send');
    expect(input.ref).toMatchObject({ adapter: 'codex-desktop', id: 'worker' });
    expect(input.message).toContain('Staging');
    sent.push(input);
    return { kind: 'completed', value: { ok: true, value: delivery } };
  });
  try {
    await flush();
    expect(await f.read()).toMatchObject({ answerDelivery: [{ state: 'accepted' }] });
    await flush();
    expect(f.store.getTodo('todo')).toMatchObject({ state: 'doing', blockedBy: null });
    expect(sent).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test.each([
  { reason: 'not_delivered', notSent: true },
  { reason: 'not_open' },
  { reason: 'not_found' },
  { reason: 'busy' },
])('a definite external refusal retries without releasing the hold: %j', async (failure) => {
  const f = await externalFixture();
  let attempts = 0;
  const flush = externalDelivery(f, async (_caller, name) => {
    expect(name).toBe('work.send');
    return {
      kind: 'completed',
      value:
        ++attempts === 1
          ? { ok: false, detail: 'Synthetic refusal', ...failure }
          : { ok: true, value: { delivered: true } },
    };
  });
  try {
    await flush();
    expect(await f.read()).toMatchObject({ answerDelivery: [{ state: 'pending' }] });
    expect(f.store.getTodo('todo')?.blockedBy).toBe('needs-human');
    await flush();
    expect(attempts).toBe(2);
    expect(await f.read()).toMatchObject({ answerDelivery: [{ state: 'accepted' }] });
    expect(f.store.getTodo('todo')?.state).toBe('doing');
  } finally {
    f.db.close();
  }
});

test.each(['lost-reply', 'not_delivered', 'unconfirmed'] as const)(
  'an uncertain external %s reconciles after restart without resending',
  async (mode) => {
    const run = mkdtempSync(join(tmpdir(), 'external-answer-restart-'));
    const path = join(run, 'daemon.db');
    const f = await externalFixture(
      path,
      'Choose the destination for this worker after the pending dependency is resolved'.padEnd(
        80,
        '?'
      )
    );
    let sends = 0;
    let message = '';
    let visible = false;
    const warnings: unknown[] = [];
    const invoke: NeoTodoRunnerDeps['invoke'] = async (_caller, name, input) => {
      if (name === 'work.send') {
        sends++;
        message = String(input.message);
        if (mode === 'lost-reply') throw new Error('Synthetic reply lost after peer acceptance');
        return {
          kind: 'completed',
          value:
            mode === 'unconfirmed'
              ? {
                  ok: true,
                  value: {
                    delivered: false,
                    unconfirmed: true,
                    receipt: { executionId: 'worker', inputId: 'queued' },
                  },
                }
              : { ok: false, reason: 'not_delivered', detail: 'Reply lost' },
        };
      }
      expect(name).toBe('work.status');
      return {
        kind: 'completed',
        value: {
          ok: true,
          value: {
            status: 'running',
            lastActivityAt: 9,
            recentInputs: [
              workInput(9, visible ? message : 'unrelated answer [worker-answer:other]')!,
            ],
          },
        },
      };
    };
    let reopened: Database | undefined;
    try {
      await externalDelivery(f, invoke, (error) => warnings.push(error))();
      expect(await f.read()).toMatchObject({ answerDelivery: [{ state: 'pending' }] });
      expect(f.store.getTodo('todo')?.blockedBy).toBe('needs-human');
      f.db.close();
      reopened = new Database(path);
      const store = new NeoAskTodoRepository(reopened);
      const get = createNeoQuestionOperations(
        store,
        async () => {},
        async () => ({ ok: true })
      ).find((op) => op.name === 'neo.question.get')!;
      const flush = createNeoQuestionAnswerDelivery(
        store,
        new NeoTodoSessionRepository(reopened),
        invoke,
        async () => {},
        async (todo) => store.recompute(todo, {}, 10, { state: 'no_opinion' }, async () => {}),
        (error) => {
          throw error;
        }
      );
      await flush();
      expect(sends).toBe(1);
      expect(store.getTodo('todo')?.blockedBy).toBe('needs-human');
      visible = true;
      await flush();
      await flush();
      expect(await get.execute({ questionId: f.question.id }, { source: 'rpc' })).toMatchObject({
        answerDelivery: [{ state: 'accepted' }],
      });
      expect(store.getTodo('todo')).toMatchObject({ state: 'doing', blockedBy: null });
      expect(sends).toBe(1);
    } finally {
      if (reopened) reopened.close();
      else f.db.close();
      rmSync(run, { recursive: true, force: true });
    }
  }
);

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

test('a quoted chat answer selects only its question for inline delivery', async () => {
  const f = await fixture();
  try {
    const rootId = `neo:${crypto.randomUUID()}`;
    f.db.prepare('UPDATE neo_asks SET session_id = ? WHERE id = ?').run(rootId, 'ask');
    const sessions = new SessionRepository(f.db);
    sessions.createSession({
      id: rootId,
      title: 'Synthetic Neo',
      workspacePath: '/synthetic',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: {},
      metadata: {},
    } as Session);
    const repo = new NeoRepository(f.db);
    repo.reserveBinding({ sessionId: rootId, projectId: null, kind: 'neo' });
    const sdk = new SDKMessageRepository(f.db);
    const jobs = new JobQueueRepository(f.db);
    const facade = {
      getDatabase: () => f.db,
      getSDKMessageRepo: () => sdk,
      getJobQueueRepo: () => jobs,
      getSession: (id: string) => sessions.getSession(id),
      getGlobalSettings: () => ({}),
    } as unknown as DaemonDatabase;
    const notified: string[] = [];
    const operation = createNeoIntakeOperation(
      facade,
      repo,
      (_session, questionId) => {
        if (questionId) notified.push(questionId);
      },
      f.store
    );
    const result = await invokeOperation(
      createOperationRegistry([operation]),
      'neo.message.send',
      {
        sessionId: rootId,
        requestId: crypto.randomUUID(),
        content: 'Use staging',
        replyTo: { kind: 'question', id: f.question.id },
      },
      { source: 'rpc', principal: 'local' }
    );
    expect(result).toMatchObject({ kind: 'completed', value: { ok: true } });
    expect(notified).toEqual([f.question.id]);
    expect(f.store.getQuestion(f.question.id)).toMatchObject({
      answer: 'Use staging',
      answeredBy: 'chat',
    });
  } finally {
    f.db.close();
  }
});
