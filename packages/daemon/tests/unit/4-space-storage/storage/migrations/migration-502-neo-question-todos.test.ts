import { describe, expect, test } from 'bun:test';
import { neoTodoStartRefusal } from '../../../../../src/lib/neo/todo-start-gate.ts';
import { NeoAskTodoRepository } from '../../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration502 } from '../../../../../src/storage/schema/m502-neo-question-todos.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

const lists = (db: Database) =>
  Object.fromEntries(
    (
      db.prepare('SELECT id, todos FROM neo_questions').all() as { id: string; todos: string }[]
    ).map((row) => [row.id, (JSON.parse(row.todos) as string[]).sort()])
  );

const draft = {
  text: 'Which release?',
  kind: 'reply' as const,
  options: null,
  multiple: false,
  noLabel: null,
  yesLabel: null,
  startTodos: null,
};

function world() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const store = new NeoAskTodoRepository(db);
  const ask = (id: string, parentId?: string) =>
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
  const step = (id: string, askId: string) =>
    store.addTodo(
      id,
      askId,
      {
        title: id,
        doneWhen: 'Observed',
        check: null,
        instruction: 'Continue',
        named: null,
        approvedAt: 1,
      },
      1
    );
  return { db, store, ask, step };
}

describe('runMigration502', () => {
  test('lists the todos each card covers and is safe to run twice', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE neo_asks (id TEXT PRIMARY KEY, parent_id TEXT);
      CREATE TABLE neo_todos (id TEXT PRIMARY KEY, ask_id TEXT, state TEXT, blocked_by TEXT,
        started_at INTEGER);
      CREATE TABLE neo_questions (id TEXT PRIMARY KEY, ask_id TEXT, kind TEXT, state TEXT,
        todo_id TEXT, start_todos TEXT);
      INSERT INTO neo_asks VALUES ('ask', NULL), ('child', 'ask'), ('other', NULL);
      INSERT INTO neo_todos VALUES
        ('waiting', 'ask', 'todo', NULL, NULL),
        ('held', 'ask', 'blocked', 'held', NULL),
        ('asked', 'ask', 'blocked', 'question', 5),
        ('running', 'ask', 'doing', NULL, 5),
        ('stuck', 'ask', 'blocked', 'check', 5),
        ('finished', 'ask', 'done', NULL, 5),
        ('child-step', 'child', 'todo', NULL, NULL),
        ('elsewhere', 'other', 'todo', NULL, NULL);
      INSERT INTO neo_questions VALUES
        ('start', 'ask', 'start', 'open', NULL, '["waiting","held"]'),
        ('one', 'ask', 'reply', 'open', 'running', NULL),
        ('whole', 'ask', 'reply', 'open', NULL, NULL),
        ('answered', 'ask', 'reply', 'answered', NULL, NULL),
        ('child-card', 'child', 'reply', 'open', NULL, NULL);
    `);
    runMigration502(db);
    runMigration502(db);
    expect(lists(db)).toEqual({
      start: ['held', 'waiting'],
      one: ['running'],
      whole: ['asked', 'child-step', 'held', 'waiting'],
      answered: [],
      'child-card': ['child-step'],
    });
    db.close();
  });

  test('an approved todo under an open ask-level question is still held after the switch', () => {
    const { db, store, ask, step } = world();
    const home = ask('ask');
    step('approved', 'ask');
    store.askQuestion('legacy', 'ask', draft, 2);
    db.exec('ALTER TABLE neo_questions DROP COLUMN todos');
    runMigration502(db);
    expect(store.getQuestion('legacy')?.todos).toEqual(['approved']);
    expect(
      neoTodoStartRefusal(
        store.getTodo('approved')!,
        store.listFamilyTodos('ask'),
        store.gateQuestions(home)
      )
    ).toContain('question_open');
    db.close();
  });
});

describe('NeoAskTodoRepository.askQuestion', () => {
  test('a card opened without a todo lists the unstarted todos it holds, child asks included', () => {
    const { db, store, ask, step } = world();
    ask('ask');
    ask('child', 'ask');
    step('waiting', 'ask');
    step('child-step', 'child');
    store.claimStart(step('running', 'ask'), 2);
    expect(store.askQuestion('whole', 'ask', draft, 3).todos.sort()).toEqual([
      'child-step',
      'waiting',
    ]);
    db.close();
  });

  test('a card for one todo lists that todo, and a Start card lists its steps', () => {
    const { db, store, ask, step } = world();
    ask('ask');
    step('first', 'ask');
    step('second', 'ask');
    expect(store.askQuestion('one', 'ask', { ...draft, todoId: 'second' }, 3).todos).toEqual([
      'second',
    ]);
    expect(
      store.askQuestion('start', 'ask', { ...draft, kind: 'start', startTodos: ['first'] }, 3).todos
    ).toEqual(['first']);
    store.extendStartQuestion('start', ['first', 'second'], 'Start both?', 4);
    expect(store.getQuestion('start')?.todos).toEqual(['first', 'second']);
    db.close();
  });
});
