import { describe, expect, test } from 'bun:test';
import type { NeoQuestion } from '@hyperneo/shared/types/neo-ask';
import {
  createNeoQuestionOperations,
  neoQuestionAnsweredNote,
  planNeoQuestionAnswer,
} from '../../../../src/lib/neo/question-operations.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const owner: OperationCaller = { source: 'mcp', sessionId: 'neo-a', role: 'neo' };
const human: OperationCaller = { source: 'rpc', principal: 'local' };

type Receipt = { ok: true; question: NeoQuestion } | { ok: false; reason: string };

function setup() {
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
  const ops = Object.fromEntries(
    createNeoQuestionOperations(
      store,
      async (_ask, _question, note) => {
        told.push(note);
      },
      async (todoId) => started.push(todoId)
    ).map((op) => [op.name, op])
  );
  const call = async (name: string, input: unknown, caller = owner) =>
    (await ops[name].execute(ops[name].inputSchema.parse(input), caller)) as Receipt;
  const asked = async (input: Record<string, unknown>) => {
    const receipt = await call('neo.question.ask', { askId: 'ask', ...input });
    if (!receipt.ok) throw new Error(receipt.reason);
    return receipt.question;
  };
  return { db, store, call, asked, told, started, fix, rows };
}

describe('neo.question operations', () => {
  test('a start question lists only not-started todos and starts the ticked ones', async () => {
    const { store, call, asked, told, started, fix, rows } = setup();
    store.updateTodo(rows, { state: 'doing', startedAt: 2 }, 2);
    expect(
      await call('neo.question.ask', {
        askId: 'ask',
        kind: 'start',
        text: 'Start these?',
        todos: [fix.id, rows.id],
      })
    ).toEqual({ ok: false, reason: 'not_startable: t2 is not a not-started todo on this ask.' });
    const start = await asked({ kind: 'start', text: 'Start this?', todos: [fix.id] });
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
      'The human answered "Which?": B.',
      'The human answered "Which ones?": none.',
      'The human answered "What should it say?": Say hi.',
    ]);
  });

  test('only the human answers, and another Neo session cannot ask on the ask', async () => {
    const { call, asked } = setup();
    const reply = await asked({ kind: 'reply', text: 'Which?' });
    expect(await call('neo.question.answer', { questionId: reply.id, answer: 'x' })).toEqual({
      ok: false,
      reason: 'This action needs the user.',
    });
    expect(
      await call(
        'neo.question.ask',
        { askId: 'ask', kind: 'reply', text: 'x' },
        { source: 'mcp', sessionId: 'neo-b', role: 'neo' }
      )
    ).toEqual({ ok: false, reason: 'not_owner: another Neo session owns this ask.' });
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
          createdAt: 1,
        },
        []
      )
    ).toBe('The human answered "Start?": start none.');
  });
});
