import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { createTodoCheckPacks } from '../../helpers/todo-check-packs.ts';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageHub } from '@hyperneo/shared';
import { createNeoQuestionOperations } from '../../../../src/lib/neo/question-operations.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb } from '../../../helpers/database.ts';

test('20707c94: an unlinked stale facts card retires and releases the todo it blocked', async () => {
  const run = mkdtempSync(join(tmpdir(), 'question-retire-'));
  const db = await createTestDb();
  const service = createNeoService(
    db,
    {} as SessionManager,
    { event: () => {} } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
  const notes = () => retiredNotices(db.getDatabase());
  service.packs = () => [];
  try {
    const store = service.todos;
    store.openAsk({
      id: 'ask',
      sessionId: 'neo',
      projectId: null,
      originMessageId: null,
      title: 'Qlark #78',
      request: 'Bot-approve and merge',
      createdAt: 1,
    });
    const check = { pack: 'core', kind: 'evidence', params: { path: join(run, 'approved.txt') } };
    const worker = store.addTodo(
      'worker',
      'ask',
      { title: 'Worker report', doneWhen: 'Reported', instruction: null, named: null, check },
      1
    );
    store.updateTodo(worker, { state: 'done' }, 2);
    writeFileSync(check.params.path, 'Bot APPROVED 16:08Z, five seconds before the card.');
    const operation = createNeoQuestionOperations(
      store,
      async () => {},
      async () => ({ ok: true })
    ).find((op) => op.name === 'neo.question.ask')!;
    const receipt = (await operation.execute(
      operation.inputSchema.parse({
        askId: 'ask',
        todoId: worker.id,
        kind: 'reply',
        text: 'qlark has no review bot and no CI',
        retireWhen: check,
      }),
      { source: 'mcp', sessionId: 'neo', role: 'neo' }
    )) as { ok: boolean; question: { id: string; todoId?: string } };
    expect(receipt.ok).toBe(true);
    expect(receipt.question.todoId).toBeUndefined();
    const waiting = store.addTodo(
      'waiting',
      'ask',
      {
        title: 'Qlark #78: bot-approve and merge',
        doneWhen: 'Merged',
        check: null,
        instruction: null,
        named: null,
      },
      3
    );
    store.updateTodo(
      waiting,
      { state: 'blocked', blockedBy: 'needs-human', blockedReason: 'Waiting on stale card' },
      3
    );
    await service.sweepPacks();
    expect(store.getQuestion(receipt.question.id)).toMatchObject({
      state: 'retired',
      retiredReason: `File ${check.params.path} exists.`,
      answer: null,
      answeredBy: null,
    });
    expect(store.getTodo(waiting.id)).toMatchObject({ state: 'todo', blockedBy: null });
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toContain(`File ${check.params.path} exists.`);
    expect(notes()[0]).not.toContain('\n');
    await service.sweepPacks();
    expect(notes()).toHaveLength(1);
  } finally {
    service.dispose();
    db.close();
    rmSync(run, { recursive: true, force: true });
  }
});

import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import {
  createQuestionRetirement,
  passedQuestionCheck,
} from '../../../../src/lib/neo/question-retirement.ts';
import type { NeoTodoCheckResult } from '../../../../src/lib/neo/pack-contract.ts';
import {
  createCodingTodoPack,
  CodingTodoPrRepository,
} from '../../../../src/lib/neo/packs/coding/todo-prs.ts';

function retiredNotices(db: Database): string[] {
  return new JobQueueRepository(db)
    .listActiveByPayload('mailbox', { 'to.sessionId': 'neo' })
    .map((job) => (job.payload.message as { message: { content: string } }).message.content);
}

function fixture(path = ':memory:') {
  const db = new Database(path);
  runMigrations(db, () => {});
  createTables(db);
  const store = new NeoAskTodoRepository(db);
  store.openAsk({
    id: 'ask',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    title: 'Facts',
    request: 'Follow facts',
    createdAt: 1,
  });
  const check = { pack: 'test', kind: 'fact', params: { id: 'observed' } };
  const todo = store.addTodo(
    'todo',
    'ask',
    { title: 'Work', doneWhen: 'Observed', check, instruction: null, named: null },
    1
  );
  const packs = createTodoCheckPacks(db);
  const operation = createNeoQuestionOperations(
    store,
    async () => {},
    async () => ({ ok: true }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => [...packs, { id: 'test', todos: { doneWhen: () => 'Fact observed' } }]
  ).find((op) => op.name === 'neo.question.ask')!;
  const ask = async (input: Record<string, unknown>) =>
    operation.execute(
      operation.inputSchema.parse({ askId: 'ask', kind: 'reply', text: 'Still needed?', ...input }),
      { source: 'mcp', sessionId: 'neo', role: 'neo' }
    ) as Promise<{
      ok: boolean;
      reason?: string;
      question: import('@hyperneo/shared/types/neo-ask').NeoQuestion;
    }>;
  let result: NeoTodoCheckResult | null = { done: true, evidence: 'Fact observed\nwith detail' };
  let observe = async () => {};
  const retire = createQuestionRetirement(store, () => [
    {
      id: 'test',
      describe: 'Synthetic facts',
      instructions: () => null,
      todos: {
        schema: () => {},
        statusLine: () => null,
        check: async () => {
          await observe();
          return result;
        },
      },
    },
  ]);
  return {
    db,
    store,
    todo,
    operation,
    check,
    ask,
    retire,
    get notes() {
      return retiredNotices(db);
    },
    result(value: NeoTodoCheckResult | null) {
      result = value;
    },
    during(read: () => Promise<void>) {
      observe = read;
    },
  };
}

test('the schema explains that unlinked cards need retireWhen, including start rewording', async () => {
  const f = fixture();
  try {
    for (const kind of ['reply', 'start']) {
      const parsed = f.operation.inputSchema.safeParse({ askId: 'ask', kind, text: 'Need input' });
      expect(parsed.success).toBe(false);
      if (!parsed.success)
        expect(parsed.error.message).toContain('retireWhen is required without a linked todo');
    }
    const stale = await f.ask({ todoId: 'gone' });
    expect(stale).toMatchObject({
      ok: false,
      reason: expect.stringContaining('retire_when_required'),
    });
    expect(f.store.listQuestions('ask')).toEqual([]);
  } finally {
    f.db.close();
  }
});

test('a linked question defaults to its todo check and explicit retireWhen overrides it', async () => {
  const f = fixture();
  try {
    const first = await f.ask({ todoId: f.todo.id });
    expect(first.question.retireWhen).toBeUndefined();
    expect(await f.retire(first.question, f.todo, 4)).toMatchObject({
      state: 'retired',
      retiredReason: 'Fact observed\nwith detail',
    });
    const other = { ...f.check, params: { id: 'other' } };
    const next = await f.ask({ todoId: f.todo.id, retireWhen: other });
    expect(next.question.retireWhen).toEqual(other);
    expect(f.store.getTodo(f.todo.id)?.check).toEqual(f.check);
  } finally {
    f.db.close();
  }
});

test.each([
  null,
  { done: false, evidence: null },
  { done: true, evidence: null },
  { done: true, evidence: ' ', failed: 'Unreadable' },
  { done: false, evidence: 'Not yet', blocked: { reason: 'Pending', nextAction: 'Wait' } },
] satisfies (NeoTodoCheckResult | null)[])(
  'unmet or unevidenced checks keep the card open: %j',
  async (result) => {
    const f = fixture();
    try {
      f.result(result);
      expect(passedQuestionCheck(result)).toEqual({ reason: null });
      const card = await f.ask({ retireWhen: f.check });
      await f.retire(card.question, null, 4);
      expect(f.store.getQuestion(card.question.id)?.state).toBe('open');
      expect(f.notes).toEqual([]);
    } finally {
      f.db.close();
    }
  }
);

test('failed reads preserve the card and its hold, and the next successful sweep can retire it', async () => {
  const f = fixture();
  try {
    const card = await f.ask({ retireWhen: f.check });
    f.store.updateTodo(f.todo, { state: 'blocked', blockedBy: 'needs-human' }, 2);
    f.during(async () => {
      throw new Error('Read failed');
    });
    await expect(f.retire(card.question, null, 4)).rejects.toThrow('Read failed');
    expect(f.store.getQuestion(card.question.id)?.state).toBe('open');
    expect(f.store.getTodo(f.todo.id)?.blockedBy).toBe('needs-human');
    expect(f.notes).toEqual([]);
    f.during(async () => {});
    await f.retire(card.question, null, 5);
    expect(f.store.getTodo(f.todo.id)).toMatchObject({ state: 'todo', blockedBy: null });
  } finally {
    f.db.close();
  }
});

test.each(['answered', 'replaced-check', 'settled-ask'] as const)(
  'a late check result cannot retire changed facts: %s',
  async (changed) => {
    const f = fixture();
    try {
      const card = await f.ask({ retireWhen: f.check });
      f.during(async () => {
        if (changed === 'answered')
          f.store.answerQuestion(card.question, 'Human answer', 'chat', 3);
        if (changed === 'replaced-check')
          f.db
            .prepare('UPDATE neo_questions SET retire_when_json = ? WHERE id = ?')
            .run(JSON.stringify({ ...f.check, params: { id: 'new' } }), card.question.id);
        if (changed === 'settled-ask')
          f.db.prepare("UPDATE neo_asks SET status = 'done' WHERE id = 'ask'").run();
      });
      expect(await f.retire(card.question, null, 4)).toBeNull();
      expect(f.store.getQuestion(card.question.id)?.state).toBe(
        changed === 'answered' ? 'answered' : 'open'
      );
      expect(f.notes).toEqual([]);
    } finally {
      f.db.close();
    }
  }
);

test('two simultaneous sweeps retire and notify once, while another open card keeps its hold', async () => {
  const f = fixture();
  try {
    const card = await f.ask({ retireWhen: f.check });
    await f.ask({ retireWhen: f.check, text: 'Other human choice' });
    f.store.updateTodo(f.todo, { state: 'blocked', blockedBy: 'needs-human' }, 2);
    await Promise.all([f.retire(card.question, null, 4), f.retire(card.question, null, 4)]);
    expect(f.notes).toHaveLength(1);
    expect(f.store.getTodo(f.todo.id)?.blockedBy).toBe('needs-human');
  } finally {
    f.db.close();
  }
});

test('a failed hold release rolls back retirement and sends no notice', async () => {
  const f = fixture();
  try {
    const card = await f.ask({ retireWhen: f.check });
    f.store.updateTodo(f.todo, { state: 'blocked', blockedBy: 'needs-human' }, 2);
    f.db.exec(
      "CREATE TRIGGER fail_release BEFORE UPDATE ON neo_todos BEGIN SELECT RAISE(ABORT, 'release failed'); END"
    );
    await expect(f.retire(card.question, null, 4)).rejects.toThrow('release failed');
    expect(f.store.getQuestion(card.question.id)?.state).toBe('open');
    expect(f.store.getTodo(f.todo.id)?.blockedBy).toBe('needs-human');
    expect(f.notes).toEqual([]);
  } finally {
    f.db.close();
  }
});

test('retireWhen survives migration replay and restart', async () => {
  const run = mkdtempSync(join(tmpdir(), 'question-restart-'));
  const path = join(run, 'daemon.db');
  const f = fixture(path);
  const card = await f.ask({ retireWhen: f.check });
  f.db.close();
  const reopened = new Database(path);
  try {
    runMigrations(reopened, () => {});
    expect(new NeoAskTodoRepository(reopened).getQuestion(card.question.id)?.retireWhen).toEqual(
      f.check
    );
  } finally {
    reopened.close();
    rmSync(run, { recursive: true, force: true });
  }
});

test('an unlinked coding check uses its existing reader without inventing a todo or writing todo caches', async () => {
  const f = fixture();
  try {
    const repository = new CodingTodoPrRepository(f.db);
    const pack = createCodingTodoPack(repository, async (urls) =>
      urls.map((url) => ({
        url,
        state: 'MERGED',
        checks: 'passing',
        review: 'approved',
        title: 'Merged change',
        blockers: [],
      }))
    );
    pack.schema(f.db);
    const retire = createQuestionRetirement(f.store, () => [
      { id: 'coding', describe: 'Coding', instructions: () => null, todos: pack },
    ]);
    const card = await f.ask({
      retireWhen: {
        pack: 'coding',
        kind: 'pr_merged',
        params: { urls: ['https://github.com/synthetic/qlark/pull/78'] },
      },
    });
    expect(await retire(card.question, null, 4)).toMatchObject({
      state: 'retired',
      retiredReason: '#78 merged',
    });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM pack_coding_pr_claims').get()).toEqual({ n: 0 });
    expect(f.store.getTodo(card.question.id)).toBeNull();
  } finally {
    f.db.close();
  }
});

test('a linked default follows later todo check edits and rejects the old read result', async () => {
  const f = fixture();
  try {
    const card = await f.ask({ todoId: f.todo.id });
    f.during(async () => {
      f.db
        .prepare('UPDATE neo_todos SET check_json = ? WHERE id = ?')
        .run(JSON.stringify({ ...f.check, params: { id: 'later' } }), f.todo.id);
    });
    expect(await f.retire(card.question, f.todo, 4)).toBeNull();
    expect(f.store.getQuestion(card.question.id)?.state).toBe('open');
    expect(f.notes).toEqual([]);
  } finally {
    f.db.close();
  }
});

test('an unavailable legacy pack leaves the question open', async () => {
  const f = fixture();
  try {
    const card = await f.ask({ retireWhen: f.check });
    f.db
      .prepare('UPDATE neo_questions SET retire_when_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...f.check, pack: 'unavailable' }), card.question.id);
    expect(await f.retire(f.store.getQuestion(card.question.id)!, null, 4)).toBeNull();
    expect(f.store.getQuestion(card.question.id)?.state).toBe('open');
    expect(f.notes).toEqual([]);
  } finally {
    f.db.close();
  }
});

test.each([
  { pack: 'missing-pack', kind: 'evidence', params: { path: '/synthetic/result' } },
  { pack: 'core', kind: 'evience', params: { path: '/synthetic/result' } },
  { pack: 'core', kind: 'evidence', params: { path: 'relative-result' } },
])(
  'an unusable explicit retirement check is refused before opening a card: %j',
  async (retireWhen) => {
    const f = fixture();
    try {
      expect(await f.ask({ retireWhen })).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/^check_(required|refused|unsupported):/),
      });
      expect(f.store.listQuestions('ask')).toEqual([]);
    } finally {
      f.db.close();
    }
  }
);

test('a linked coding default checks an existing branch claim before any todo cache read', async () => {
  const f = fixture();
  try {
    const url = 'https://github.com/synthetic/project/pull/78';
    const repository = new CodingTodoPrRepository(f.db);
    const pack = createCodingTodoPack(repository, async () => [
      {
        url,
        state: 'MERGED',
        checks: 'passing',
        review: 'approved',
        title: 'Merged change',
        blockers: [],
        createdAt: 2,
        mergedAt: 3,
      },
    ]);
    pack.schema(f.db);
    const todo = f.store.updateTodo(
      f.todo,
      { state: 'doing', startedAt: 1, check: { pack: 'coding', kind: 'pr_merged', params: {} } },
      1
    );
    repository.claim(todo.id, [{ url, claim: 'branch' }], 2);
    const card = await f.ask({ todoId: todo.id });
    const retire = createQuestionRetirement(f.store, () => [
      { id: 'coding', describe: 'Coding', instructions: () => null, todos: pack },
    ]);
    expect(await retire(card.question, todo, 4)).toMatchObject({
      state: 'retired',
      retiredReason: '#78 merged',
    });
    expect(await pack.check(todo)).toMatchObject({ done: true, evidence: '#78 merged' });
  } finally {
    f.db.close();
  }
});

test('a linked legacy todo without a check needs an explicit retirement condition', async () => {
  const f = fixture();
  try {
    f.store.updateTodo(f.todo, { check: null }, 2);
    expect(await f.ask({ todoId: f.todo.id })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('retire_when_required'),
    });
    expect(f.store.listQuestions('ask')).toEqual([]);
    expect(await f.ask({ todoId: f.todo.id, retireWhen: f.check })).toMatchObject({ ok: true });
  } finally {
    f.db.close();
  }
});

test('a rejected notice enqueue preserves the open card and its hold for the next sweep', async () => {
  const f = fixture();
  try {
    const card = await f.ask({ retireWhen: f.check });
    f.store.updateTodo(f.todo, { state: 'blocked', blockedBy: 'needs-human' }, 2);
    f.db.exec(
      "CREATE TRIGGER fail_notice BEFORE INSERT ON job_queue WHEN NEW.queue = 'mailbox' BEGIN SELECT RAISE(ABORT, 'notice enqueue failed'); END"
    );
    await expect(f.retire(card.question, null, 4)).rejects.toThrow('notice enqueue failed');
    expect(f.store.getQuestion(card.question.id)?.state).toBe('open');
    expect(f.store.getTodo(f.todo.id)?.blockedBy).toBe('needs-human');
    expect(f.notes).toEqual([]);
    f.db.exec('DROP TRIGGER fail_notice');
    expect(await f.retire(card.question, null, 5)).toMatchObject({ state: 'retired' });
    expect(f.store.getTodo(f.todo.id)).toMatchObject({ state: 'todo', blockedBy: null });
    expect(f.notes).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test('a committed retirement keeps its pending Neo notice across a database restart', async () => {
  const run = mkdtempSync(join(tmpdir(), 'question-notice-restart-'));
  const path = join(run, 'daemon.db');
  const f = fixture(path);
  let closed = false;
  try {
    const card = await f.ask({ retireWhen: f.check });
    await f.retire(card.question, null, 4);
    expect(f.notes).toHaveLength(1);
    f.db.close();
    closed = true;
    const reopened = new Database(path);
    try {
      expect(new NeoAskTodoRepository(reopened).getQuestion(card.question.id)?.state).toBe(
        'retired'
      );
      expect(retiredNotices(reopened)).toHaveLength(1);
      expect(retiredNotices(reopened)[0]).toContain(
        `Retired question ${card.question.id}: Fact observed with detail`
      );
    } finally {
      reopened.close();
    }
  } finally {
    if (!closed) f.db.close();
    rmSync(run, { recursive: true, force: true });
  }
});
