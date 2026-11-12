import { describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { neoWorkCounts, projectNeoAskEntries } from '../../../../src/lib/neo/ask-entries.ts';
import { planNeoBlockCards } from '../../../../src/lib/neo/block-cards.ts';
import { neoTodoStartRefusal } from '../../../../src/lib/neo/todo-start-gate.ts';
import {
  NEO_TODO_STALLED_CARD_TAIL,
  neoTodoAwaitsHuman,
  neoTodoPlace,
} from '../../../../src/lib/neo/todo-state.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const card = (state: 'open' | 'answered' | 'retired', todos: string[]) => ({ state, todos });

const stored = (
  id: string,
  blockedBy: NeoTodo['blockedBy'],
  patch: Partial<NeoTodo> = {}
): Parameters<typeof planNeoBlockCards>[0][number] => ({
  id,
  askId: 'ask',
  title: id,
  state: 'blocked',
  blockedBy,
  blockedReason: `${id} reason`,
  startedAt: 5,
  report: null,
  ...patch,
});

describe('neoTodoPlace', () => {
  test('a live todo waits on the human exactly when an open card covers it', () => {
    const step = (state: NeoTodo['state'], patch: Partial<NeoTodo> = {}) => ({
      id: 'step',
      state,
      blockedBy: null,
      startedAt: null,
      ...patch,
    });
    const rows = [
      step('todo'),
      step('doing', { startedAt: 5 }),
      step('blocked', { blockedBy: 'check', startedAt: 5 }),
      step('blocked', { blockedBy: 'question' }),
      step('blocked', { blockedBy: 'question', startedAt: 5 }),
      step('failed', { startedAt: 5 }),
      step('done', { startedAt: 5 }),
      step('removed'),
    ];
    const places = (cards: ReturnType<typeof card>[]) =>
      rows.map((row) => neoTodoPlace(row, cards));
    expect(places([card('open', ['other', 'step'])])).toEqual([
      ...Array.from({ length: 6 }, () => 'waiting' as const),
      null,
      null,
    ]);
    expect(places([card('answered', ['step']), card('open', ['other']), card('open', [])])).toEqual(
      ['queued', 'running', null, 'queued', 'running', null, null, null]
    );
  });
});

describe('planNeoBlockCards', () => {
  test('gives a stored block its own card unless a recorded fact ties an open card to it', () => {
    const cards = [
      { text: 'Which release?', todos: ['asked', 'unrelated', 'lost', 'gone'], bound: [] },
      { text: 'Which database?', todos: ['reported'], bound: ['reported'] },
      { text: `"quiet"${NEO_TODO_STALLED_CARD_TAIL}`, todos: ['quiet'], bound: [] },
    ];
    const plan = planNeoBlockCards(
      [
        stored('asked', 'question'),
        stored('reported', 'needs-human'),
        stored('lost', 'needs-human', { report: 'The worker asked which database to use.' }),
        stored('quiet', 'stalled'),
        stored('gone', 'stalled'),
        stored('unrelated', 'check'),
        stored('broken', 'failure'),
        stored('offline', 'environment', { blockedReason: null }),
        stored('idle', 'worker'),
        stored('parked', 'held', { startedAt: null }),
        stored('paused', 'held'),
        stored('running', null, { state: 'doing' }),
      ],
      cards
    );
    expect(plan.map((item) => [item.todoId, item.text, item.options, item.document])).toEqual([
      ['lost', '"lost": lost reason', null, 'The worker asked which database to use.'],
      ['gone', '"gone": gone reason', null, null],
      ['unrelated', '"unrelated": unrelated reason', null, null],
      ['broken', '"broken": broken reason', null, null],
      ['offline', '"offline": It is blocked.', null, null],
      ['idle', '"idle": idle reason', null, null],
      ['parked', '"parked" is on hold: parked reason', ['Start', 'Remove'], null],
      ['paused', '"paused" is on hold: paused reason', ['Resume', 'Remove'], null],
    ]);
    expect(plan.map((item) => [item.askId, item.kind])).toEqual([
      ...Array.from({ length: 6 }, () => ['ask', 'reply']),
      ['ask', 'choice'],
      ['ask', 'choice'],
    ]);
  });

  test('a todo with a failed check and an unrelated open question is still held by its check card after that question is answered', () => {
    const question = { text: 'Which release?', todos: ['ship'], bound: [] };
    const [check] = planNeoBlockCards(
      [stored('ship', 'check', { blockedReason: 'check_failed: the build is red' })],
      [question]
    );
    expect(check).toMatchObject({ todoId: 'ship', text: '"ship": check_failed: the build is red' });
    const migrated = { id: 'ship', state: 'doing' as const, blockedBy: null, startedAt: 5 };
    const checkCard = card('open', [check!.todoId]);
    expect(neoTodoPlace(migrated, [card('open', question.todos), checkCard])).toBe('waiting');
    expect(neoTodoPlace(migrated, [card('answered', question.todos), checkCard])).toBe('waiting');
    expect(
      neoTodoPlace(migrated, [card('answered', question.todos), card('answered', ['ship'])])
    ).toBe('running');
  });
});

describe('projectNeoAskEntries', () => {
  test('the sections, the counts and the runner agree on a child todo that a parent card covers', () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const store = new NeoAskTodoRepository(db);
    const sessions = new NeoTodoSessionRepository(db);
    const open = (id: string, parentId?: string) =>
      store.openAsk({
        id,
        projectId: null,
        sessionId: 'neo',
        originMessageId: null,
        title: id,
        request: 'Synthetic request',
        createdAt: 1,
        ...(parentId ? { parentId } : {}),
      });
    open('parent');
    const child = open('child', 'parent');
    store.addTodo(
      'step',
      'child',
      {
        title: 'step',
        doneWhen: 'Observed',
        check: null,
        instruction: 'Continue',
        named: null,
        approvedAt: 1,
      },
      1
    );
    db.prepare('INSERT INTO neo_todo_sessions (todo_id, target) VALUES (?, ?)').run(
      'step',
      JSON.stringify({
        verb: 'start',
        adapter: 'hyperneo',
        place: { machine: 'local', name: 'Fixture', folder: '/synthetic' },
      })
    );
    const asked = store.askQuestion(
      'card',
      'parent',
      {
        text: 'Which release?',
        kind: 'reply',
        options: null,
        multiple: false,
        noLabel: null,
        yesLabel: null,
        startTodos: null,
      },
      2
    );
    expect(asked.todos).toEqual(['step']);
    const read = () => {
      const snapshot = store.snapshot(undefined, 10, true);
      const step = store.getTodo('step')!;
      return {
        section: projectNeoAskEntries(snapshot.asks, snapshot.facts, []).find(
          (entry) => entry.ask.id === 'child'
        )?.state,
        needsYou: neoWorkCounts(
          snapshot.openWork.todos,
          snapshot.openWork.questions,
          snapshot.openWork.awaitingNeo
        ).needsYou,
        place: neoTodoPlace(step, store.todoCards(step)),
        refused: neoTodoStartRefusal(
          step,
          store.listFamilyTodos('child'),
          store.gateQuestions(child)
        )?.split(':')[0],
        awaits: neoTodoAwaitsHuman(step, store.todoCards(step)),
        queued: sessions.queueFacts().candidates.map((candidate) => candidate.id),
      };
    };
    expect(read()).toEqual({
      section: 'waiting',
      needsYou: 2,
      place: 'waiting',
      refused: 'question_open',
      awaits: true,
      queued: [],
    });
    expect(store.updateTodo(store.getTodo('step')!, {}, 3).blockedBy).toBe('question');
    store.answerQuestion(store.getQuestion('card')!, 'The next one', 'button', 4);
    expect(read()).toEqual({
      section: 'doing',
      needsYou: 0,
      place: 'queued',
      refused: undefined,
      awaits: false,
      queued: ['step'],
    });
    expect(store.updateTodo(store.getTodo('step')!, {}, 5)).toMatchObject({
      state: 'todo',
      blockedBy: null,
    });
    expect(read()).toMatchObject({ section: 'todo', place: 'queued', queued: ['step'] });
    db.close();
  });
});
