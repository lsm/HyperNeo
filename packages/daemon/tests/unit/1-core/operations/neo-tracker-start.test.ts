import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { DbGateway } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { NeoTrackerMirrorRepository } from '../../../../src/storage/repositories/neo-tracker-mirror.ts';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import type { NeoTrackerAdapter } from '../../../../src/lib/neo/pack-contract.ts';

let db: Database, store: NeoAskTodoRepository, sessions: NeoTodoSessionRepository;
let mirrors: NeoTrackerMirrorRepository, gateway: DbGateway;
let enabled: boolean, sends: string[], notes: string[];
let runner: ReturnType<typeof createNeoTodoRunner>;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  store = new NeoAskTodoRepository(db);
  sessions = new NeoTodoSessionRepository(db);
  mirrors = new NeoTrackerMirrorRepository(db);
  gateway = new DbGateway(':memory:', db);
  enabled = true;
  sends = [];
  notes = [];
  const tracker: NeoTrackerAdapter = {
    id: 'synthetic',
    enabled: () => enabled,
    home: () => 'example/repo',
    find: async () => null,
    create: async () => ({ ref: 'example/repo#1' }),
    link: async () => true,
    close: async () => true,
  };
  runner = createNeoTodoRunner({
    store,
    sessions,
    write: (op, args) => gateway.run(op, args),
    packs: () => [{ id: 'synthetic', describe: 'Synthetic tracker', tracker }],
    limits: () => ({ running: 9, perGroup: 9 }),
    changed: () => {},
    tell: async (_ask, _todo, note) => {
      notes.push(note);
    },
    invoke: async (_caller, name) => {
      if (name === 'work.send' || name === 'work.start') sends.push(name);
      return {
        kind: 'completed',
        value: {
          ok: true,
          value: { status: 'done', delivered: true, ref: { adapter: 'hyperneo', id: 'worker' } },
        },
      };
    },
  });
  store.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'synthetic',
    originMessageId: null,
    title: 'Plan',
    request: 'Work',
    createdAt: 1,
  });
  store.addTodo(
    'todo',
    'ask',
    {
      title: 'Step',
      instruction: 'Work',
      named: null,
      check: null,
      doneWhen: 'Done',
      approvedAt: 1,
      dependsOn: [],
    },
    2
  );
  sessions.create('todo', { verb: 'send', ref: { adapter: 'hyperneo', id: 'worker' } });
});
afterEach(async () => {
  await gateway.close();
  db.close();
});
const row = (failures: number, ref: string | null = null) =>
  mirrors.put({
    ownerKind: 'todo',
    ownerId: 'todo',
    tracker: 'synthetic',
    home: 'example/repo',
    ref,
    parentRef: null,
    state: ref ? 'bound' : 'creating',
    failures,
    updatedAt: 3,
  });

test.each(['start', 'send'])('an unbound mirror holds every start path (%s)', async (verb) => {
  db.prepare('UPDATE neo_todo_sessions SET target=? WHERE todo_id=?').run(
    JSON.stringify(
      verb === 'start'
        ? { verb, adapter: 'hyperneo' }
        : { verb, ref: { adapter: 'hyperneo', id: 'worker' } }
    ),
    'todo'
  );
  await runner.fill();
  expect(sends).toEqual([]);
  expect(store.getTodo('todo')?.state).toBe('todo');
  expect(await runner.start('todo')).toMatchObject({
    ok: false,
    reason: expect.stringContaining('tracker_pending:'),
  });
  expect(sends).toEqual([]);
  row(0, 'example/repo#1');
  await runner.fill();
  expect(sends).toEqual([`work.${verb}`]);
});

test('three failures release the hold and say so', async () => {
  row(2);
  expect(await runner.start('todo')).toMatchObject({
    ok: false,
    reason: expect.stringContaining('tracker_pending:'),
  });
  row(3);
  await runner.fill();
  expect(sends).toEqual(['work.send']);
  expect(notes.some((note) => note.includes('Tracker item is missing'))).toBe(true);
});

test('no tracker never holds', async () => {
  enabled = false;
  await runner.fill();
  expect(sends).toEqual(['work.send']);
  expect(notes).toEqual([]);
});
