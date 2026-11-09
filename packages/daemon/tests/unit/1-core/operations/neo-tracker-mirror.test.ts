import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import {
  NeoTrackerMirrorRepository,
  neoTrackerReads,
  neoTrackerWrites,
} from '../../../../src/storage/repositories/neo-tracker-mirror.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import {
  planNeoTrackerMirror,
  planNeoTrackerRecovery,
  neoTrackerMarker,
  readNeoTrackerMarker,
} from '../../../../src/lib/neo/tracker-mirror-plan.ts';
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

test('no enabled adapter plans nothing', () => {
  adapter.enabled = () => false;
  expect(plan()).toEqual([]);
  const facts = mirrors.facts();
  expect(planNeoTrackerMirror(facts.asks, facts.todos, facts.mirrors, [])).toEqual([]);
});

test('crash recovery binds a found marker and preserves the recorded home', () => {
  const row = { ...plan()[0].row, home: 'stored/home' };
  mirrors.put(row);
  adapter.home = () => 'changed/home';
  expect(plan()[0].item.home).toBe('stored/home');
  expect(planNeoTrackerRecovery(row, 'stored/home#1')).toEqual({ ref: 'stored/home#1' });
  expect(planNeoTrackerRecovery(row, null)).toBeNull();
});

test('a late step plans its child on the next sweep', () => {
  bindParent();
  expect(plan()).toEqual([]);
  addTodo('late');
  const child = plan()[0];
  expect(child).toMatchObject({ action: 'create', item: { marker: 'hyperneo:todo:late' } });
  mirrors.put({ ...child.row, ref: 'example/repo#2', state: 'bound' });
  expect(plan()).toMatchObject([
    { action: 'link', parent: 'example/repo#1', row: { ref: 'example/repo#2' } },
  ]);
});

test('settled ask plans closing its existing parent', () => {
  bindParent();
  db.prepare("UPDATE neo_asks SET status = 'done'").run();
  expect(plan()).toMatchObject([{ action: 'close', row: { ref: 'example/repo#1' } }]);
  const row = plan()[0].row;
  mirrors.put({ ...row, state: 'closed' });
  expect(plan()).toEqual([]);
});

test('a settled ask without a mirror creates nothing', () => {
  db.prepare("UPDATE neo_asks SET status = 'dropped'").run();
  expect(plan()).toEqual([]);
});

test('mirror storage round trips through the registered gateway', async () => {
  const gateway = gatewayFor(db);
  const row = { ...plan()[0].row, failures: 2 };
  await gateway.call(neoTrackerWrites, 'put', row);
  const facts = await gateway.call(neoTrackerReads, 'facts');
  expect(facts.mirrors).toEqual([row]);
  expect(facts.asks[0].id).toBe('ask');
});

test('marker survives the tracker body', () => {
  const owner = { kind: 'ask' as const, ask: todos.getAsk('ask')! };
  const marker = neoTrackerMarker(owner);
  expect(marker).toBe('hyperneo:ask:ask');
  expect(plan()[0].item.body).toBe(`Implement\n\n<!-- ${marker} -->`);
  expect(readNeoTrackerMarker(plan()[0].item.body)).toBe(marker);
  expect(readNeoTrackerMarker('No marker')).toBeNull();
});
