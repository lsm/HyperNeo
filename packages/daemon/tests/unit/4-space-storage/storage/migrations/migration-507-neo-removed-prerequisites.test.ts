import { describe, expect, test } from 'bun:test';
import { planNeoRemovedPrerequisiteAnswer } from '../../../../../src/lib/neo/todo-removal.ts';
import { neoTodoStartRefusal } from '../../../../../src/lib/neo/todo-start-gate.ts';
import { NeoAskTodoRepository } from '../../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../../src/storage/schema/index.ts';
import { runMigration507 } from '../../../../../src/storage/schema/m507-neo-removed-prerequisites.ts';
import { Database } from '../../../../../src/storage/sqlite-compat.ts';

const edges = (db: Database) =>
  Object.fromEntries(
    (
      db.prepare('SELECT id, depends_on AS dependsOn FROM neo_todos').all() as {
        id: string;
        dependsOn: string | null;
      }[]
    ).map((row) => [row.id, row.dependsOn && JSON.parse(row.dependsOn)])
  );

const cards = (db: Database) =>
  (
    db
      .prepare(
        'SELECT ask_id AS askId, kind, options, todos, cause FROM neo_questions WHERE cause IS NOT NULL'
      )
      .all() as { askId: string; kind: string; options: string; todos: string; cause: string }[]
  ).map((row) => ({ ...row, options: JSON.parse(row.options), todos: JSON.parse(row.todos) }));

describe('runMigration507', () => {
  test('moves or drops cancelled edges and cards the unstarted, once', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE neo_asks (id TEXT PRIMARY KEY, parent_id TEXT, status TEXT);
      CREATE TABLE neo_todos (id TEXT PRIMARY KEY, ask_id TEXT, position INTEGER, title TEXT,
        state TEXT, started_at INTEGER, depends_on TEXT, replaced_by TEXT, created_at INTEGER,
        updated_at INTEGER);
      CREATE TABLE neo_questions (id TEXT PRIMARY KEY, ask_id TEXT, text TEXT, kind TEXT,
        options TEXT, state TEXT DEFAULT 'open', todos TEXT DEFAULT '[]', created_at INTEGER);
      INSERT INTO neo_asks VALUES ('ask', NULL, 'open'), ('settled', NULL, 'done');
      INSERT INTO neo_todos VALUES
        ('gone', 'ask', 0, 'gone', 'removed', NULL, NULL, NULL, 1, 1),
        ('implicit', 'ask', 1, 'implicit', 'todo', NULL, '["gone"]', NULL, 1, 1),
        ('stored', 'ask', 2, 'stored', 'blocked', NULL, '["gone"]', NULL, 1, 1),
        ('running', 'ask', 3, 'running', 'doing', 5, '["gone","stored"]', NULL, 1, 1),
        ('listed', 'ask', 4, 'listed', 'todo', NULL, '["gone"]', NULL, 1, 1),
        ('swapped', 'ask', 5, 'swapped', 'removed', NULL, '[]', 'next', 1, 1),
        ('next', 'ask', 6, 'next', 'todo', NULL, '[]', NULL, 1, 1),
        ('handed', 'ask', 7, 'handed', 'todo', NULL, '["swapped"]', NULL, 1, 1),
        ('finished', 'ask', 8, 'finished', 'done', 5, NULL, NULL, 1, 1),
        ('before', 'settled', 0, 'before', 'removed', NULL, NULL, NULL, 1, 1),
        ('old', 'settled', 1, 'old', 'failed', NULL, NULL, NULL, 1, 1);
      INSERT INTO neo_questions (id, ask_id, text, kind, todos, created_at) VALUES
        ('start', 'ask', 'Start?', 'start', '["listed"]', 1);
    `);
    runMigration507(db);
    runMigration507(db);
    expect(edges(db)).toEqual({
      gone: null,
      implicit: ['gone'],
      stored: ['gone'],
      running: ['stored'],
      listed: ['gone'],
      swapped: [],
      next: [],
      handed: ['next'],
      finished: null,
      before: null,
      old: null,
    });
    expect(cards(db)).toEqual([
      {
        askId: 'ask',
        kind: 'choice',
        options: ['Continue', 'Remove these'],
        todos: ['implicit', 'stored'],
        cause: 'removed_prerequisite',
      },
    ]);
    db.close();
  });

  test('a migrated todo behind a removed prerequisite starts only after the card says Continue', () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const store = new NeoAskTodoRepository(db);
    const home = store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'ask',
      request: 'Synthetic request',
      createdAt: 1,
    });
    for (const id of ['first', 'second'])
      store.addTodo(
        id,
        'ask',
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
    db.exec(`
      UPDATE neo_todos SET state = 'removed' WHERE id = 'first';
      UPDATE neo_todos SET depends_on = '["first"]' WHERE id = 'second';
      ALTER TABLE neo_questions DROP COLUMN cause;
    `);
    runMigration507(db);
    const refusal = () =>
      neoTodoStartRefusal(
        store.getTodo('second')!,
        store.listFamilyTodos('ask'),
        store.gateQuestions(home)
      );
    expect(store.getTodo('second')?.dependsOn).toEqual(['first']);
    expect(refusal()).toContain('not_ready');
    const [card] = store.listQuestions('ask');
    expect(card).toMatchObject({ cause: 'removed_prerequisite', todos: ['second'], state: 'open' });
    store.answerQuestion(
      card,
      ['Continue'],
      'button',
      5,
      undefined,
      undefined,
      planNeoRemovedPrerequisiteAnswer(card, store.listFamilyTodos('ask'), ['Continue'], 5)
    );
    expect(store.getTodo('second')?.dependsOn).toEqual([]);
    expect(refusal()).toBeNull();
    db.close();
  });
});
