import { afterEach, beforeEach, expect, test } from 'bun:test';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { neoTodoRepository } from '../../../../src/lib/neo/pack-contract.ts';
import { neoTodoPolicies } from '../../../../src/lib/neo/packs/todo-policies.ts';

let db: Database;
let store: NeoAskTodoRepository;
const draft = { title: 'Work', doneWhen: 'Observed', check: null, instruction: null, named: null };
const ask = (id: string, repo: string | null) => {
  store.openAsk({
    id,
    title: id,
    request: id,
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    createdAt: 1,
  });
  db.prepare('UPDATE neo_asks SET repo = ? WHERE id = ?').run(repo, id);
};
const decide = (scope: Parameters<typeof neoTodoRepository>[2], start = draft) =>
  neoTodoRepository(start, neoTodoPolicies(db), scope);
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  store = new NeoAskTodoRepository(db);
  ask('history', 'github.com/synthetic/history');
  ask('mixed', null);
});
afterEach(() => db.close());

test('core asks and todos carry no repository field', () => {
  const todo = store.addTodo('own', 'history', draft, 2, 'github.com/synthetic/own');
  expect(todo).not.toHaveProperty('repo');
  expect(store.getTodo('own')).not.toHaveProperty('repo');
  expect(store.getAsk('history')).not.toHaveProperty('repo');
});

test('the coding pack reads stored places from its own facts given only ids', () => {
  store.addTodo('own', 'history', draft, 2, 'github.com/synthetic/own');
  store.addTodo('historical', 'history', draft, 2);
  expect(decide({ ask: { id: 'history' }, todo: { id: 'own' } })).toBe('github.com/synthetic/own');
  expect(decide({ ask: { id: 'history' }, todo: { id: 'historical' } })).toBe(
    'github.com/synthetic/history'
  );
  store.addTodo('empty', 'history', draft, 2, '');
  expect(decide({ ask: { id: 'history' }, todo: { id: 'empty' }, start: true })).toBe(
    'github.com/synthetic/history'
  );
});

test('new drafts inherit one distinct recorded sibling repository only', () => {
  expect(decide({ ask: { id: 'mixed' } })).toBeNull();
  store.addTodo('one', 'mixed', draft, 2, 'github.com/synthetic/one');
  expect(decide({ ask: { id: 'mixed' } })).toBe('github.com/synthetic/one');
  store.addTodo('two', 'mixed', draft, 2, 'github.com/synthetic/two');
  expect(decide({ ask: { id: 'mixed' } })).toBeNull();
  expect(decide({ ask: { id: 'history' } })).toBeNull();
});
