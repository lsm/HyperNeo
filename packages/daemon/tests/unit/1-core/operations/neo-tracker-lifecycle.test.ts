import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTrackerMirrorRepository } from '../../../../src/storage/repositories/neo-tracker-mirror.ts';
import { planNeoTrackerMirror } from '../../../../src/lib/neo/tracker-mirror-plan.ts';
import type { NeoTrackerAdapter } from '../../../../src/lib/neo/pack-contract.ts';

let db: Database, todos: NeoAskTodoRepository, mirrors: NeoTrackerMirrorRepository;
let adapter: NeoTrackerAdapter;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  todos = new NeoAskTodoRepository(db);
  mirrors = new NeoTrackerMirrorRepository(db);
  todos.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: null,
    title: 'Plan',
    request: 'Implement',
    createdAt: 1,
  });
  adapter = {
    id: 'fixture',
    enabled: () => true,
    home: () => 'example/repo',
    find: async () => null,
    create: async () => {
      throw new Error('Planner cannot create');
    },
    link: async () => {
      throw new Error('Planner cannot link');
    },
    close: async () => {
      throw new Error('Planner cannot close');
    },
  };
});
afterEach(() => db.close());
const plan = () => {
  const facts = mirrors.facts();
  return planNeoTrackerMirror(facts.asks, facts.todos, facts.mirrors, [adapter]);
};
const bindParent = () => {
  const row = plan()[0].row;
  mirrors.put({ ...row, ref: 'example/repo#1', state: 'bound' });
};
const addTodo = (id: string) =>
  todos.addTodo(
    id,
    'ask',
    { title: id, instruction: null, named: null, check: null, doneWhen: 'Done' },
    2
  );

const bindChild = () => {
  bindParent();
  addTodo('child');
  mirrors.put({
    ...plan()[0].row,
    ref: 'example/repo#2',
    state: 'bound',
    parentRef: 'example/repo#1',
  });
};

test('done todo closes its child as completed', () => {
  bindChild();
  db.prepare("UPDATE neo_todos SET state = 'done'").run();
  expect(plan()).toMatchObject([
    { action: 'close', outcome: 'completed', row: { ownerId: 'child' } },
  ]);
});

for (const state of ['removed', 'closed_unverified']) {
  test(`${state} todo closes its child as not_planned`, () => {
    bindChild();
    db.prepare('UPDATE neo_todos SET state = ?').run(state);
    expect(plan()).toMatchObject([
      { action: 'close', outcome: 'not_planned', row: { ownerId: 'child' } },
    ]);
  });
}

test('failed todo keeps its child open', () => {
  bindChild();
  db.prepare("UPDATE neo_todos SET state = 'failed'").run();
  expect(plan()).toEqual([]);
});

test('settled ask closes open children before the parent', () => {
  bindChild();
  db.prepare("UPDATE neo_asks SET status = 'done'").run();
  expect(plan()).toMatchObject([
    { action: 'close', outcome: 'not_planned', row: { ownerId: 'child' } },
  ]);
  mirrors.put({ ...plan()[0].row, state: 'closed' });
  expect(plan()).toMatchObject([
    { action: 'close', outcome: 'completed', row: { ownerId: 'ask' } },
  ]);
});

test('a closed row is never recreated when its todo becomes active again', () => {
  bindChild();
  const child = mirrors.facts().mirrors.find((row) => row.ownerId === 'child')!;
  db.prepare("UPDATE neo_todos SET state = 'done'").run();
  mirrors.put({ ...child, state: 'closed' });
  db.prepare("UPDATE neo_todos SET state = 'doing'").run();
  expect(plan()).toEqual([]);
});

test('closed owners are loaded in one bounded query', () => {
  bindChild();
  const child = mirrors.facts().mirrors.find((row) => row.ownerId === 'child')!;
  mirrors.put({ ...child, state: 'closed' });
  mirrors.put({ ...child, ownerId: 'historical', state: 'closed' });
  const prepare = spyOn(db, 'prepare');
  try {
    const facts = mirrors.facts();
    expect(facts.mirrors.filter((row) => row.state === 'closed').map((row) => row.ownerId)).toEqual(
      ['child']
    );
    expect(
      prepare.mock.calls.filter(([sql]) => sql.includes('FROM json_each(?) AS owner'))
    ).toHaveLength(1);
  } finally {
    prepare.mockRestore();
  }
});

test('a dropped ask closes its parent as not_planned after its children', () => {
  bindChild();
  db.prepare("UPDATE neo_asks SET status = 'dropped'").run();
  expect(plan()).toMatchObject([
    { action: 'close', outcome: 'not_planned', row: { ownerId: 'child' } },
  ]);
  mirrors.put({ ...plan()[0].row, state: 'closed' });
  expect(plan()).toMatchObject([
    { action: 'close', outcome: 'not_planned', row: { ownerId: 'ask' } },
  ]);
});

test('a capped row of a settled ask is not loaded, and a current owner never creates a duplicate', () => {
  bindChild();
  const rows = mirrors.facts().mirrors;
  const child = rows.find((row) => row.ownerId === 'child')!;
  const parent = rows.find((row) => row.ownerId === 'ask')!;
  mirrors.put({ ...child, failures: 3 });
  expect(mirrors.facts().mirrors.find((row) => row.ownerId === 'child')?.failures).toBe(3);
  expect(plan()).toEqual([]);
  db.prepare("UPDATE neo_asks SET status = 'done'").run();
  mirrors.put({ ...parent, state: 'closed' });
  const facts = mirrors.facts();
  expect(facts.asks).toEqual([]);
  expect(facts.todos).toEqual([]);
  expect(facts.mirrors).toEqual([]);
});
