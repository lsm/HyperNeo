import { describe, expect, test } from 'bun:test';
import type { NeoQuestion } from '@hyperneo/shared/types/neo-ask';
import {
  createNeoQuestionOperations,
  neoQuestionAnsweredNote,
  planNeoQuestionAnswer,
} from '../../../../src/lib/neo/question-operations.ts';
import { addNeoTodo, NeoTodoDraftSchema } from '../../../../src/lib/neo/todo-operations.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import type { ArtifactRefReader } from '../../../../src/lib/artifacts/read-operations.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const owner: OperationCaller = { source: 'mcp', sessionId: 'neo-a', role: 'neo' };
const human: OperationCaller = { source: 'rpc', principal: 'local' };

type Receipt = { ok: true; question: NeoQuestion } | { ok: false; reason: string };

function setup(
  artifact?: ArtifactRefReader,
  readSource?: Parameters<typeof createNeoQuestionOperations>[5],
  receivedHumanInput?: Parameters<typeof createNeoQuestionOperations>[3]
) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const store = new NeoAskTodoRepository(db);
  store.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo-a',
    originMessageId: 'm1',
    title: 'iOS card',
    request: 'Redo the iOS card',
    createdAt: 1,
  });
  const draft = { doneWhen: 'Merged', check: null, instruction: 'Do it', named: null };
  const fix = store.addTodo('t1', 'ask', { ...draft, title: 'List steps' }, 1);
  const rows = store.addTodo('t2', 'ask', { ...draft, title: 'Todo rows' }, 1);
  const told: string[] = [];
  const started: string[] = [];
  const refused = new Set<string>();
  const ops = Object.fromEntries(
    createNeoQuestionOperations(
      store,
      async (_ask, _question, note) => {
        told.push(note);
      },
      async (todoId) => {
        started.push(todoId);
        return refused.has(todoId)
          ? { ok: false, reason: 'already_started: this todo is removed.' }
          : { ok: true };
      },
      receivedHumanInput,
      artifact,
      readSource ??
        (async (ref) =>
          ref.id === 'missing'
            ? null
            : {
                ...ref,
                name: 'Review worker',
                label: 'Codex · Review worker',
                provider: 'Codex',
                link: `codex://threads/${ref.id}`,
              })
    ).map((op) => [op.name, op])
  );
  const call = async (name: string, input: unknown, caller = owner) =>
    (await ops[name].execute(ops[name].inputSchema.parse(input), caller)) as Receipt;
  const asked = async (input: Record<string, unknown>) => {
    const receipt = await call('neo.question.ask', { askId: 'ask', ...input });
    if (!receipt.ok) throw new Error(receipt.reason);
    return receipt.question;
  };
  const daemonStart = (startTodos: string[], text = 'Start these?') =>
    store.askQuestion(
      crypto.randomUUID(),
      'ask',
      {
        text,
        kind: 'start',
        options: null,
        multiple: false,
        noLabel: null,
        yesLabel: null,
        startTodos,
      },
      1
    );
  return { db, store, call, asked, daemonStart, told, started, refused, fix, rows };
}

describe('neo.question operations', () => {
  test('refuses a second todo question explicitly and accepts an explicit replacement', async () => {
    const h = setup();
    try {
      const first = await h.asked({ kind: 'reply', text: 'Which environment?', todoId: h.fix.id });
      const distinct = {
        askId: 'ask',
        kind: 'choice',
        text: 'Which database?',
        options: ['SQLite', 'Postgres'],
        todoId: h.fix.id,
      };
      const refused = await h.call('neo.question.ask', distinct);
      expect(refused).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/^todo_question_open:/),
      });
      expect(h.store.listQuestions('ask')).toHaveLength(1);
      expect(h.store.getQuestion(first.id)).toMatchObject({
        text: 'Which environment?',
        state: 'open',
      });
      const replacement = await h.call('neo.question.ask', { ...distinct, replaces: first.id });
      expect(replacement).toMatchObject({
        ok: true,
        question: { text: distinct.text, options: distinct.options, state: 'open' },
      });
      expect(h.store.getQuestion(first.id)?.state).toBe('retired');
      expect(h.store.listQuestions('ask').filter((q) => q.state === 'open')).toHaveLength(1);
    } finally {
      h.db.close();
    }
  });

  test('concurrent distinct todo questions produce one card and one explicit refusal', async () => {
    const h = setup();
    try {
      const results = await Promise.all(
        ['Which environment?', 'Which database?'].map((text) =>
          h.call('neo.question.ask', { askId: 'ask', kind: 'reply', text, todoId: h.fix.id })
        )
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.find((result) => !result.ok)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/^todo_question_open:/),
      });
      expect(h.store.listQuestions('ask').filter((q) => q.state === 'open')).toHaveLength(1);
    } finally {
      h.db.close();
    }
  });

  test.each(['reply', 'yesno', 'choice', 'start'] as const)(
    'refuses a %s question if its ask settles during source lookup',
    async (kind) => {
      let entered!: () => void;
      let release!: (value: NonNullable<NeoQuestion['sourceSession']>) => void;
      const reading = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const source = new Promise<NonNullable<NeoQuestion['sourceSession']>>((resolve) => {
        release = resolve;
      });
      const f = setup(undefined, async () => {
        entered();
        return source;
      });
      try {
        f.daemonStart(['t1']);
        const pending = f.call('neo.question.ask', {
          askId: 'ask',
          kind,
          text: 'Worker recommendation',
          options: ['First', 'Second'],
          noLabel: 'Wait',
          yesLabel: 'Approve',
          sourceSession: { adapter: 'codex-desktop', id: 'worker' },
          focused: true,
        });
        await reading;
        f.store.settleAsk(f.store.getAsk('ask')!, 'dropped', 'No longer needed', 2);
        release({
          adapter: 'codex-desktop',
          id: 'worker',
          name: 'Worker',
          label: 'Codex · Worker',
          provider: 'Codex',
          link: 'codex://threads/worker',
        });
        expect(await pending).toEqual({ ok: false, reason: 'ask_settled: this ask is dropped.' });
        expect(f.store.listQuestions('ask').filter((q) => q.state === 'open')).toEqual([]);
        expect(f.store.getAsk('ask')).not.toHaveProperty('focusedSession');
      } finally {
        f.db.close();
      }
    }
  );

  test('refuses an unreadable source without opening or replacing a question', async () => {
    const { asked, call, store } = setup();
    const original = await asked({ kind: 'reply', text: 'Keep this question' });
    const refused = await call('neo.question.ask', {
      askId: 'ask',
      kind: 'reply',
      text: 'New worker output',
      replaces: original.id,
      sourceSession: { adapter: 'codex-desktop', id: 'missing' },
    });
    expect(refused).toMatchObject({
      ok: false,
      reason: expect.stringContaining('source_session_unavailable'),
    });
    expect(store.listQuestions('ask')).toEqual([original]);
  });

  test('retains the source when rewording the existing start question', async () => {
    const { asked, daemonStart } = setup();
    const initial = daemonStart(['t1']);
    const question = await asked({
      kind: 'start',
      text: 'Start after the worker review?',
      sourceSession: { adapter: 'codex-desktop', id: 'source-worker' },
    });
    expect(question).toMatchObject({
      id: initial.id,
      sourceSession: { adapter: 'codex-desktop', id: 'source-worker' },
      startTodos: ['t1'],
    });
    const general = await asked({
      kind: 'start',
      text: 'A combined start question without one source',
    });
    expect(general.id).toBe(initial.id);
    expect(general).not.toHaveProperty('sourceSession');
  });

  test.each(['add', 'move'] as const)(
    'retains the captured source when an instructed todo joins through %s',
    async (operation) => {
      const { db, store, asked, call, daemonStart } = setup();
      try {
        daemonStart(['t1']);
        const question = await asked({
          kind: 'start',
          text: 'Start after the worker review?',
          sourceSession: { adapter: 'codex-desktop', id: 'source-worker' },
        });
        const draft = NeoTodoDraftSchema.parse({
          title: 'Additional work',
          doneWhen: 'Merged',
          instruction: 'Do the additional work',
          target: { verb: 'send', ref: { adapter: 'hyperneo', id: 'worker' } },
        });
        let joinedId: string;
        if (operation === 'add') {
          const result = await addNeoTodo(
            store,
            new NeoTodoSessionRepository(db),
            async () => ({ ok: false, reason: 'not started' }),
            store.getAsk('ask')!,
            draft,
            []
          );
          if (!result.ok) throw new Error(result.reason);
          joinedId = result.todo.id;
        } else {
          store.openAsk({
            id: 'other',
            sessionId: 'neo-a',
            projectId: null,
            originMessageId: null,
            title: 'Other work',
            request: 'Other work',
            createdAt: 1,
          });
          const todo = store.addTodo('moved', 'other', draft, 1);
          joinedId = store.moveTodo(todo, 'ask', '', 2).id;
        }
        expect(await call('neo.question.get', { questionId: question.id }, human)).toMatchObject({
          ok: true,
          question: {
            id: question.id,
            state: 'open',
            sourceSession: question.sourceSession,
          },
        });
        expect(store.getQuestion(question.id)?.startTodos).toEqual(['t1', joinedId]);
      } finally {
        db.close();
      }
    }
  );

  test('keeps the explicitly focused session on the ask after card retirement', async () => {
    const { asked, call, store } = setup();
    const sourceSession = { adapter: 'codex-desktop', id: 'discussion' };
    const ordinary = await asked({ kind: 'reply', text: 'Ordinary report', sourceSession });
    expect(store.getAsk('ask')).not.toHaveProperty('focusedSession');
    const ready = await asked({
      kind: 'reply',
      text: 'Prepared discussion',
      sourceSession,
      focused: true,
    });
    const captured = ready.sourceSession;
    expect(store.getAsk('ask')).toMatchObject({ focusedSession: captured });
    await call('neo.question.retire', { questionId: ready.id, reason: 'Discuss directly' });
    await call('neo.question.retire', { questionId: ordinary.id, reason: 'Superseded' });
    await asked({
      kind: 'reply',
      text: 'Unrelated worker',
      sourceSession: { ...sourceSession, id: 'other' },
    });
    expect(store.getAsk('ask')).toMatchObject({ focusedSession: captured });
    expect(store.getAsks(['ask'])[0]).toMatchObject({ focusedSession: captured });
    expect(store.listAsks(undefined, 10)[0]).toMatchObject({ focusedSession: captured });
  });

  test('refuses a focused card without a single readable session', async () => {
    const { call, store } = setup();
    for (const sourceSession of [undefined, { adapter: 'codex-desktop', id: 'missing' }]) {
      expect(
        await call('neo.question.ask', {
          askId: 'ask',
          kind: 'reply',
          text: 'Ready',
          focused: true,
          sourceSession,
        })
      ).toMatchObject({ ok: false });
    }
    expect(store.listQuestions('ask')).toEqual([]);
    expect(store.getAsk('ask')).not.toHaveProperty('focusedSession');
  });

  test('retains one explicit source session through read, answer and list payloads', async () => {
    const { asked, call, store } = setup();
    const source = { adapter: 'codex-desktop', id: 'source-worker', daemon: 'remote-machine' };
    const question = await asked({
      kind: 'yesno',
      text: 'Review the worker output?',
      noLabel: 'Wait',
      yesLabel: 'Approve',
      sourceSession: source,
    });
    expect(question).toMatchObject({ sourceSession: source });
    expect(store.getQuestion(question.id)).toMatchObject({ sourceSession: source });
    expect(await call('neo.question.get', { questionId: question.id }, human)).toMatchObject({
      question: { sourceSession: source },
    });
    expect(
      await call('neo.question.answer', { questionId: question.id, answer: 'yes' }, human)
    ).toMatchObject({ question: { state: 'answered', answer: 'yes', sourceSession: source } });
    expect(store.listQuestionsForAsks(['ask'])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: question.id,
          sourceSession: expect.objectContaining(source),
        }),
      ])
    );
    const ordinary = await asked({
      kind: 'reply',
      text: 'No single worker produced this question',
    });
    expect(ordinary).not.toHaveProperty('sourceSession');
  });

  test('keeps registered artifact references on the question card', async () => {
    const artifact = {
      daemonId: '10000000-0000-4000-8000-000000000001',
      artifactId: 'report',
      title: 'Review report',
      kind: 'markdown' as const,
      byteLength: 42,
    };
    const { store, asked, call, daemonStart } = setup((id, caller) =>
      id === artifact.artifactId && caller.sessionId === owner.sessionId ? artifact : null
    );
    for (const changed of [
      { ...artifact, artifactId: 'missing' },
      { ...artifact, title: 'Changed' },
      { ...artifact, daemonId: crypto.randomUUID() },
      { ...artifact, byteLength: 43 },
      { ...artifact, kind: 'html' },
    ]) {
      expect(
        await call('neo.question.ask', {
          askId: 'ask',
          kind: 'reply',
          text: 'Review',
          artifacts: [changed],
        })
      ).toMatchObject({
        ok: false,
        reason: expect.stringContaining('invalid_artifact_reference:'),
      });
    }
    expect(store.listQuestions('ask')).toHaveLength(0);
    const question = await asked({
      kind: 'reply',
      text: 'Please review the attached report.',
      artifacts: [artifact],
    });
    expect(question).toMatchObject({ artifacts: [artifact] });
    expect(store.getQuestion(question.id)).toMatchObject({ artifacts: [artifact] });
    expect(await call('neo.question.get', { questionId: question.id })).toMatchObject({
      question: { artifacts: [artifact] },
    });
    expect(
      await call(
        'neo.question.ask',
        {
          askId: 'ask',
          kind: 'reply',
          text: 'Foreign caller',
          artifacts: [artifact],
        },
        { ...owner, sessionId: 'other' }
      )
    ).toMatchObject({ ok: false });
    const start = daemonStart(['t1']);
    const reworded = await asked({
      kind: 'start',
      text: 'Review before starting?',
      artifacts: [artifact],
    });
    expect(reworded).toMatchObject({ id: start.id, artifacts: [artifact] });
    expect(await asked({ kind: 'start', text: 'Start these?' })).toMatchObject({
      artifacts: [artifact],
    });
    expect(
      await asked({ kind: 'start', text: 'Start without attachment?', artifacts: [] })
    ).toMatchObject({ artifacts: [] });
  });

  test('a start question starts the ticked todos', async () => {
    const { store, call, daemonStart, told, started, fix, rows } = setup();
    store.updateTodo(rows, { state: 'doing', startedAt: 2 }, 2);
    const start = daemonStart([fix.id], 'Start this?');
    expect(start).toMatchObject({ kind: 'start', startTodos: ['t1'], state: 'open' });
    const answered = await call(
      'neo.question.answer',
      { questionId: start.id, answer: [fix.id] },
      human
    );
    expect(answered.ok && answered.question).toMatchObject({
      state: 'answered',
      answer: ['t1'],
      answeredBy: 'button',
    });
    expect(told).toEqual(['The human answered "Start this?": start List steps.']);
    expect(started).toEqual(['t1']);
    expect(await call('neo.question.answer', { questionId: start.id, answer: [] }, human)).toEqual({
      ok: false,
      reason: 'question_closed: this question is answered.',
    });
  });

  test('a start question holds its todos blocked until it is answered or retired', async () => {
    const { store, call, daemonStart, started, fix, rows } = setup();
    const held = {
      state: 'blocked',
      blockedBy: 'question',
      blockedReason: 'Waiting for the human to start it.',
    } as const;
    store.updateTodo(fix, held, 2);
    store.updateTodo(rows, held, 2);
    const start = daemonStart([fix.id, rows.id], 'Start these?');
    await call('neo.question.answer', { questionId: start.id, answer: [fix.id] }, human);
    expect(started).toEqual([fix.id]);
    expect(store.getTodo(rows.id)).toMatchObject({
      state: 'todo',
      blockedBy: null,
      blockedReason: null,
    });
    store.updateTodo(store.getTodo(rows.id)!, held, 3);
    const chat = daemonStart([rows.id], 'Start this?');
    store.answerQuestion(chat, 'later', 'chat', 4);
    expect(store.getTodo(rows.id)).toMatchObject({ state: 'todo', blockedBy: null });
    store.updateTodo(store.getTodo(rows.id)!, held, 5);
    const moot = daemonStart([rows.id], 'Start this?');
    store.retireQuestion(moot, 'not needed', null, 6);
    expect(store.getTodo(rows.id)).toMatchObject({ state: 'todo', blockedBy: null });
  });

  test('tells Neo which ticked todos did not start', async () => {
    const { call, daemonStart, told, refused, fix, rows } = setup();
    refused.add(rows.id);
    const start = daemonStart([fix.id, rows.id], 'Start these?');
    await call('neo.question.answer', { questionId: start.id, answer: [fix.id, rows.id] }, human);
    expect(told).toEqual([
      'The human answered "Start these?": start List steps, Todo rows.\nThese did not start: Todo rows: already_started: this todo is removed.',
    ]);
  });

  test('yesno, choice and reply questions take only their own answers', async () => {
    const { asked, call, told } = setup();
    const yesno = await asked({
      kind: 'yesno',
      text: 'Use HyperNeo dev-1 instead?',
      noLabel: 'Keep iOS-2',
      yesLabel: 'Use HyperNeo dev-1',
    });
    expect(
      (await call('neo.question.answer', { questionId: yesno.id, answer: 'maybe' }, human)).ok
    ).toBe(false);
    await call('neo.question.answer', { questionId: yesno.id, answer: 'yes' }, human);
    const pick = await asked({ kind: 'choice', text: 'Which?', options: ['A', 'B'] });
    expect(
      (await call('neo.question.answer', { questionId: pick.id, answer: ['A', 'B'] }, human)).ok
    ).toBe(false);
    const single = await call('neo.question.answer', { questionId: pick.id, answer: 'B' }, human);
    expect(single.ok && single.question.answer).toEqual(['B']);
    const many = await asked({
      kind: 'choice',
      text: 'Which ones?',
      options: ['A', 'B', 'C'],
      multiple: true,
    });
    const none = await call('neo.question.answer', { questionId: many.id, answer: [] }, human);
    expect(none.ok && none.question.answer).toEqual([]);
    const reply = await asked({ kind: 'reply', text: 'What should it say?' });
    await call('neo.question.answer', { questionId: reply.id, answer: 'Say hi' }, human);
    expect(told).toEqual([
      'The human answered "Use HyperNeo dev-1 instead?": yes (Use HyperNeo dev-1).',
      'The human answered "Which?": B (B).',
      'The human answered "Which ones?": none.',
      'The human answered "What should it say?": Say hi.',
    ]);
  });

  test('only the human answers', async () => {
    const { call, asked } = setup();
    const reply = await asked({ kind: 'reply', text: 'Which?' });
    expect(await call('neo.question.answer', { questionId: reply.id, answer: 'x' })).toEqual({
      ok: false,
      reason: 'This action needs the user.',
    });
  });

  test('another session reads whether the human answered a question it was told about', async () => {
    const { call, asked } = setup();
    const worker: OperationCaller = { source: 'mcp', sessionId: 'worker-1' };
    const merge = await asked({
      kind: 'yesno',
      text: 'Merge it?',
      noLabel: 'Wait',
      yesLabel: 'Merge',
    });
    expect(await call('neo.question.get', { questionId: merge.id }, worker)).toMatchObject({
      ok: true,
      question: { state: 'open', answer: null },
      answeredByHuman: false,
    });
    await call('neo.question.answer', { questionId: merge.id, answer: 'yes' }, human);
    expect(await call('neo.question.get', { questionId: merge.id }, worker)).toMatchObject({
      ok: true,
      question: { text: 'Merge it?', state: 'answered', answer: 'yes' },
      answeredByHuman: true,
    });
    expect(await call('neo.question.get', { questionId: 'made-up' }, worker)).toEqual({
      ok: false,
      reason: 'not_found: no such question.',
    });
  });
});

describe("Neo's start question", () => {
  test("rewords the daemon's start question instead of opening a second one", async () => {
    const { store, asked, daemonStart, fix, rows } = setup();
    const start = daemonStart([fix.id, rows.id], 'Start these 2?');
    const reworded = await asked({ kind: 'start', text: 'Start building the design?' });
    expect(reworded).toMatchObject({
      id: start.id,
      text: 'Start building the design?',
      startTodos: [fix.id, rows.id],
      state: 'open',
    });
    expect(store.listQuestions('ask')).toHaveLength(1);
  });

  test('is refused when no start question is open, and opens none', async () => {
    const { store, call } = setup();
    expect(await call('neo.question.ask', { askId: 'ask', kind: 'start', text: 'Go?' })).toEqual({
      ok: false,
      reason:
        'no_start_question: no todo on this ask is waiting to start; add todos with an instruction and the daemon asks.',
    });
    expect(store.listQuestions('ask')).toEqual([]);
  });
});

describe('NeoAskTodoRepository.retireQuestions', () => {
  test('retires only the open questions of the ask', async () => {
    const { store, asked, call } = setup();
    const done = await asked({ kind: 'reply', text: 'Done?' });
    await call('neo.question.answer', { questionId: done.id, answer: 'yes' }, human);
    const open = await asked({ kind: 'reply', text: 'Open?' });
    store.retireQuestions('ask', 3);
    expect(store.listQuestions('ask').map((q) => [q.id, q.state])).toEqual([
      [done.id, 'answered'],
      [open.id, 'retired'],
    ]);
  });
});

describe('NeoAskTodoRepository start question pruning', () => {
  const startQuestion = (
    store: NeoAskTodoRepository,
    startTodos: string[],
    text = 'Start these 2?'
  ) =>
    store.askQuestion(
      'q-start',
      'ask',
      {
        text,
        kind: 'start',
        options: null,
        multiple: false,
        noLabel: null,
        yesLabel: null,
        startTodos,
      },
      1
    );

  test("pruning drops Neo's wording for the daemon's, and keeps it while the list holds", () => {
    const { store, fix, rows } = setup();
    startQuestion(
      store,
      [fix.id, rows.id],
      'fullstack 3 merges #7709, then fullstack 2 builds G1?'
    );
    store.updateTodo(rows, { state: 'blocked', blockedBy: 'question' }, 2);
    expect(store.getQuestion('q-start')?.text).toBe(
      'fullstack 3 merges #7709, then fullstack 2 builds G1?'
    );
    store.updateTodo(fix, { state: 'done', evidence: '#1 merged', finishedAt: 3 }, 3);
    expect(store.getQuestion('q-start')).toMatchObject({
      startTodos: ['t2'],
      text: 'Start "Todo rows"?',
    });
  });

  test('a todo a check closes leaves the open start question', () => {
    const { store, fix, rows } = setup();
    startQuestion(store, [fix.id, rows.id]);
    store.updateTodo(fix, { state: 'done', evidence: '#1 merged', finishedAt: 2 }, 2);
    expect(store.getQuestion('q-start')).toMatchObject({ state: 'open', startTodos: ['t2'] });
  });

  test('a todo started elsewhere or moved to another ask leaves it, and a moved one is asked there', () => {
    const { store, fix, rows } = setup();
    startQuestion(store, [fix.id, rows.id]);
    store.claimStart(fix, 2);
    expect(store.getQuestion('q-start')?.startTodos).toEqual(['t2']);
    store.openAsk({
      id: 'other',
      projectId: null,
      sessionId: 'neo-a',
      originMessageId: 'm2',
      title: 'Other',
      request: 'Other',
      createdAt: 1,
    });
    store.moveTodo(rows, 'other', 'lsm/other', 3);
    expect(store.getQuestion('q-start')).toMatchObject({ state: 'retired', startTodos: [] });
    expect(store.listQuestions('other')).toMatchObject([
      { kind: 'start', state: 'open', startTodos: ['t2'], text: 'Start "Todo rows"?' },
    ]);
  });

  test('once every todo it lists is done or removed, it is retired and the ask stops waiting', () => {
    const { store, fix, rows } = setup();
    startQuestion(store, [fix.id, rows.id]);
    store.updateTodo(rows, { state: 'blocked', blockedBy: 'question' }, 2);
    expect(store.getQuestion('q-start')?.startTodos).toEqual(['t1', 't2']);
    store.updateTodo(fix, { state: 'done', evidence: '#1 merged', finishedAt: 2 }, 2);
    store.updateTodo(rows, { state: 'removed', reason: 'Replaced' }, 3);
    expect(store.getQuestion('q-start')).toMatchObject({
      state: 'retired',
      retiredReason: 'nothing left to start',
      startTodos: [],
    });
    expect(store.listQuestions('ask').filter((q) => q.state === 'open')).toEqual([]);
  });
});

describe('planNeoQuestionAnswer', () => {
  test('refuses a missing question', () => {
    expect(planNeoQuestionAnswer(null, 'yes')).toEqual({
      reason: { ok: false, reason: 'not_found: no such question.' },
    });
  });
});

describe('neoQuestionAnsweredNote', () => {
  test('names the start todos by title', () => {
    expect(
      neoQuestionAnsweredNote(
        {
          id: 'q',
          askId: 'a',
          text: 'Start?',
          kind: 'start',
          options: null,
          multiple: false,
          noLabel: null,
          yesLabel: null,
          startTodos: ['t'],
          state: 'answered',
          answer: [],
          answeredBy: 'button',
          answeredAt: 1,
          retiredReason: null,
          replacedBy: null,
          createdAt: 1,
        },
        []
      )
    ).toBe('The human answered "Start?": start none.');
  });

  test('names a picked option by its letter', () => {
    expect(
      neoQuestionAnsweredNote(
        {
          id: 'q',
          askId: 'a',
          text: 'Which layout?',
          kind: 'choice',
          options: ['List', 'Cards', 'Table'],
          multiple: true,
          noLabel: null,
          yesLabel: null,
          startTodos: null,
          state: 'answered',
          answer: ['List', 'Table'],
          answeredBy: 'button',
          answeredAt: 1,
          retiredReason: null,
          replacedBy: null,
          createdAt: 1,
        },
        []
      )
    ).toBe('The human answered "Which layout?": A (List), C (Table).');
  });
});

describe('neo.question.retire and replaces', () => {
  test('Neo retires a moot open question with its reason, and the ask stops waiting', async () => {
    const { store, call, asked } = setup();
    const moot = await asked({ kind: 'reply', text: 'Allow a placeholder key?' });
    expect(store.listQuestions('ask').filter((q) => q.state === 'open')).toHaveLength(1);
    const retired = await call('neo.question.retire', {
      questionId: moot.id,
      reason: 'the root cause was found',
    });
    expect(retired).toMatchObject({
      ok: true,
      question: { state: 'retired', retiredReason: 'the root cause was found', replacedBy: null },
    });
    expect(store.listQuestions('ask').filter((q) => q.state === 'open')).toEqual([]);
    expect(await call('neo.question.retire', { questionId: moot.id, reason: 'again' })).toEqual({
      ok: true,
      question: expect.objectContaining({
        id: moot.id,
        state: 'retired',
        retiredReason: 'the root cause was found',
      }),
    });
    expect(store.getQuestion(moot.id)).toMatchObject({
      state: 'retired',
      retiredReason: 'the root cause was found',
    });
  });

  test('asking with replaces retires the old question as replaced and opens the new one', async () => {
    const { store, call, asked } = setup();
    const old = await asked({ kind: 'reply', text: 'Allow a placeholder key?' });
    const next = await asked({
      kind: 'yesno',
      text: 'Use the dev proxy instead?',
      noLabel: 'Keep',
      yesLabel: 'Switch',
      replaces: old.id,
    });
    expect(store.getQuestion(old.id)).toMatchObject({
      state: 'retired',
      retiredReason: 'replaced by the new question',
      replacedBy: next.id,
    });
    expect(
      store
        .listQuestions('ask')
        .filter((q) => q.state === 'open')
        .map((q) => q.id)
    ).toEqual([next.id]);
    const again = await call('neo.question.ask', {
      askId: 'ask',
      kind: 'reply',
      text: 'Again?',
      replaces: old.id,
    });
    expect(again).toMatchObject({ ok: true, question: { text: 'Again?', state: 'open' } });
    expect(store.getQuestion(old.id)).toMatchObject({
      state: 'retired',
      retiredReason: 'replaced by the new question',
      replacedBy: next.id,
    });
  });

  test('never retires or replaces the start question that carries the go-ahead', async () => {
    const { store, call, daemonStart, fix } = setup();
    const start = daemonStart([fix.id], 'Start this?');
    const refusal = {
      ok: false,
      reason:
        "start_question: the daemon's start question carries the human's go-ahead; only the human answers it.",
    } as const;
    expect(await call('neo.question.retire', { questionId: start.id, reason: 'moot' })).toEqual(
      refusal
    );
    expect(
      await call('neo.question.ask', {
        askId: 'ask',
        kind: 'reply',
        text: 'Swap?',
        replaces: start.id,
      })
    ).toEqual(refusal);
    expect(store.getQuestion(start.id)?.state).toBe('open');
    expect(store.listQuestions('ask')).toHaveLength(1);
  });

  test("never replaces another ask's question or a missing one, and asks nothing then", async () => {
    const { store, call, asked } = setup();
    store.openAsk({
      id: 'other',
      projectId: null,
      sessionId: 'neo-a',
      originMessageId: 'm2',
      title: 'Other',
      request: 'Other',
      createdAt: 1,
    });
    const elsewhere = (
      await call('neo.question.ask', { askId: 'other', kind: 'reply', text: 'Elsewhere?' })
    ).ok
      ? store.listQuestions('other')[0]
      : null;
    await asked({ kind: 'reply', text: 'Here?' });
    expect(
      await call('neo.question.ask', {
        askId: 'ask',
        kind: 'reply',
        text: 'Swap?',
        replaces: elsewhere!.id,
      })
    ).toEqual({
      ok: false,
      reason: `other_ask: question ${elsewhere!.id} belongs to another ask; replace only this ask's.`,
    });
    expect(
      await call('neo.question.ask', {
        askId: 'ask',
        kind: 'reply',
        text: 'Swap?',
        replaces: 'nope',
      })
    ).toEqual({ ok: false, reason: 'not_found: no question nope.' });
    expect(store.getQuestion(elsewhere!.id)?.state).toBe('open');
    expect(store.listQuestions('ask').map((q) => q.text)).toEqual(['Here?']);
  });
});

describe('question reference gates warn or omit instead of refusing', () => {
  test('omits reply references that are not received human inputs instead of refusing', async () => {
    const received = new Set(['22222222-2222-4222-8222-222222222222']);
    const { call, store, db } = setup(undefined, undefined, (_caller, id) => received.has(id));
    try {
      const valid = '22222222-2222-4222-8222-222222222222';
      const stale = '33333333-3333-4333-8333-333333333333';
      const mixed = await call('neo.question.ask', {
        askId: 'ask',
        kind: 'reply',
        text: 'Which one?',
        replyTo: [valid, stale],
      });
      expect(mixed).toMatchObject({ ok: true, question: { state: 'open', replyTo: [valid] } });
      const onlyStale = await call('neo.question.ask', {
        askId: 'ask',
        kind: 'reply',
        text: 'Only stale?',
        replyTo: [stale],
      });
      expect(onlyStale).toMatchObject({ ok: true, question: { state: 'open', replyTo: [] } });
      expect(store.listQuestions('ask')).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test('asking with replaces naming an answered question opens the new one and leaves the answer', async () => {
    const { store, call, asked } = setup();
    const old = await asked({ kind: 'reply', text: 'Pick a port?' });
    await call('neo.question.answer', { questionId: old.id, answer: '9311' }, human);
    const next = await call('neo.question.ask', {
      askId: 'ask',
      kind: 'reply',
      text: 'Pick a port for the rerun?',
      replaces: old.id,
    });
    expect(next).toMatchObject({ ok: true, question: { state: 'open' } });
    expect(store.getQuestion(old.id)).toMatchObject({
      state: 'answered',
      answer: '9311',
      replacedBy: null,
    });
    expect(store.listQuestions('ask').filter((q) => q.state === 'open')).toHaveLength(1);
  });

  test('retiring an answered question leaves the recorded answer untouched', async () => {
    const { store, call, asked } = setup();
    const decided = await asked({
      kind: 'yesno',
      text: 'Merge it?',
      noLabel: 'Wait',
      yesLabel: 'Merge',
    });
    await call('neo.question.answer', { questionId: decided.id, answer: 'yes' }, human);
    const retired = await call('neo.question.retire', {
      questionId: decided.id,
      reason: 'tidying up',
    });
    expect(retired).toMatchObject({
      ok: true,
      question: { id: decided.id, state: 'answered', answer: 'yes' },
    });
    expect(store.getQuestion(decided.id)).toMatchObject({
      state: 'answered',
      answer: 'yes',
      retiredReason: null,
    });
  });
});

describe('todo-owned question cards', () => {
  test('retains explicit todo ownership and retires only settled todo cards', async () => {
    const h = setup();
    try {
      const bound = await h.asked({ kind: 'reply', text: 'Which rows?', todoId: h.fix.id });
      const other = await h.asked({ kind: 'reply', text: 'Which style?', todoId: h.rows.id });
      const general = await h.asked({ kind: 'reply', text: 'Anything else?' });
      expect(bound).toMatchObject({ todoId: h.fix.id });
      h.store.updateTodo(h.fix, { state: 'failed' }, 3);
      expect(h.store.getQuestion(bound.id)?.state).toBe('open');
      h.store.updateTodo(h.fix, { state: 'done' }, 4);
      expect(h.store.getQuestion(bound.id)?.state).toBe('retired');
      expect(h.store.getQuestion(other.id)?.state).toBe('open');
      expect(h.store.getQuestion(general.id)?.state).toBe('open');
    } finally {
      h.db.close();
    }
  });
  test('recompute retires cards for missing or already settled todos without a new state write', async () => {
    const h = setup();
    try {
      const gone = await h.asked({ kind: 'reply', text: 'Gone?', todoId: h.fix.id });
      const done = await h.asked({ kind: 'reply', text: 'Done?', todoId: h.rows.id });
      h.db.prepare('DELETE FROM neo_todos WHERE id = ?').run(h.fix.id);
      h.db.prepare("UPDATE neo_todos SET state = 'done' WHERE id = ?").run(h.rows.id);
      await h.store.recompute(
        h.store.getTodo(h.rows.id)!,
        {},
        5,
        { state: 'no_opinion' },
        async () => {}
      );
      expect(h.store.getQuestion(gone.id)?.state).toBe('retired');
      expect(h.store.getQuestion(done.id)?.state).toBe('retired');
    } finally {
      h.db.close();
    }
  });
  test('records a foreign or settled reference while opening an ask-level question', async () => {
    const h = setup();
    try {
      h.store.openAsk({
        id: 'foreign',
        projectId: null,
        sessionId: 'neo-a',
        originMessageId: 'foreign-message',
        title: 'Foreign',
        request: 'Other request',
        createdAt: 1,
      });
      h.store.updateTodo(h.fix, { state: 'removed' }, 3);
      h.store.moveTodo(h.rows, 'foreign', '/synthetic/repo', 3);
      for (const todoId of ['unknown', h.fix.id, h.rows.id]) {
        const result = await h.call('neo.question.ask', {
          askId: 'ask',
          kind: 'reply',
          text: 'Which?',
          todoId,
        });
        expect(result).toMatchObject({
          ok: true,
          records: [expect.stringContaining('todo_closed:')],
        });
        expect(result.ok ? (result.question.todoId ?? null) : false).toBeNull();
      }
    } finally {
      h.db.close();
    }
  });
});
