import { beforeEach, expect, test } from 'vitest';
import { createDesktopControlOperation } from '../../../../src/lib/desktop/control-operation.ts';
import { desktopAllowed, readDesktopTodos } from '../../../../src/lib/desktop/opt-in.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import type { NeoTodoControls } from '../../../../src/lib/neo/todo-operations.ts';
import { createPackPreferenceQuestions } from '../../../../src/lib/neo/preference-questions.ts';
import { createNeoAskRecordOperations } from '../../../../src/lib/neo/ask-record-operations.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import {
  createTodoCheckPacks,
  existingTodoTarget,
  pendingTodoCheck,
} from '../../helpers/todo-check-packs.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const human: OperationCaller = { source: 'rpc', principal: 'local' };
let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const todos = new NeoAskTodoRepository(db);
  todos.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: null,
    title: 'Errands',
    request: '',
    createdAt: 1,
    desktopApps: [{ bundleId: 'com.google.Chrome', name: 'Chrome', seen: 'all' }],
  });
  for (const [index, [todo, worker, named]] of (
    [
      ['dentist', 'worker-a', null],
      ['taxes', 'worker-b', { folder: 'docs' }],
    ] as const
  ).entries()) {
    todos.addTodo(
      todo,
      'ask',
      { title: todo, doneWhen: 'Observed', check: null, instruction: null, named },
      index
    );
    db.prepare(
      "UPDATE neo_todos SET state = 'doing', approved_at = 1, desktop_apps = ? WHERE id = ?"
    ).run(JSON.stringify([{ bundleId: 'com.google.Chrome', name: 'Chrome' }]), todo);
    db.prepare('INSERT INTO neo_todo_sessions(todo_id, target, ref) VALUES(?, ?, ?)').run(
      todo,
      '{}',
      JSON.stringify({ adapter: 'hyperneo', id: worker })
    );
  }
});

const optedIn = (worker: string) => desktopAllowed(readDesktopTodos(db), worker)?.id ?? null;
function set(input: { todoId: string; on: boolean }, caller = human) {
  return invokeOperation(
    createOperationRegistry([createDesktopControlOperation(db)]),
    'desktop.control.set',
    input,
    caller
  );
}

test('desktop control is on for a todo with its own approved app', () => {
  expect([optedIn('worker-a'), optedIn('worker-b')]).toEqual(['dentist', 'taxes']);
});

test('desktop control accepts a case variant of the disclosed app', () => {
  db.prepare("UPDATE neo_todos SET desktop_apps = ? WHERE id = 'dentist'").run(
    JSON.stringify([{ bundleId: 'com.google.chrome', name: 'Chrome' }])
  );
  expect(optedIn('worker-a')).toBe('dentist');
});

test('an app approved for one todo does not reach its sibling', () => {
  db.prepare("UPDATE neo_todos SET desktop_apps = NULL WHERE id = 'taxes'").run();
  expect([optedIn('worker-a'), optedIn('worker-b')]).toEqual(['dentist', null]);
});

test('approved apps merge by bundle id and only on an open ask', async () => {
  const todos = new NeoAskTodoRepository(db);
  await todos.addAskDesktopApps('ask', [{ bundleId: 'com.google.Chrome', name: 'Chrome' }], 1);
  const ask = await todos.addAskDesktopApps(
    'ask',
    [
      { bundleId: 'com.google.Chrome', name: 'Google Chrome' },
      { bundleId: 'com.apple.mail', name: 'Mail' },
    ],
    2
  );
  expect(ask?.desktopApps).toEqual([
    { bundleId: 'com.google.Chrome', name: 'Chrome', seen: 'all' },
    { bundleId: 'com.apple.mail', name: 'Mail' },
  ]);
  db.prepare("UPDATE neo_asks SET status = 'done'").run();
  expect(
    await todos.addAskDesktopApps('ask', [{ bundleId: 'com.apple.Notes', name: 'Notes' }], 3)
  ).toBeNull();
});

test('turning desktop control off is per todo, and it turns back on', async () => {
  expect(await set({ todoId: 'taxes', on: false })).toMatchObject({
    kind: 'completed',
    value: { accepted: true, desktopControl: false },
  });
  expect([optedIn('worker-a'), optedIn('worker-b')]).toEqual(['dentist', null]);
  expect(
    JSON.parse(
      (db.prepare('SELECT named FROM neo_todos WHERE id = ?').get('taxes') as { named: string })
        .named
    )
  ).toEqual({ folder: 'docs', desktopControl: false });
  await set({ todoId: 'taxes', on: true });
  expect(optedIn('worker-b')).toBe('taxes');
});

test('a finished or unknown todo cannot turn desktop control on', async () => {
  db.prepare("UPDATE neo_todos SET state = 'done' WHERE id = 'dentist'").run();
  for (const todoId of ['dentist', 'missing'])
    expect(await set({ todoId, on: true })).toMatchObject({
      kind: 'completed',
      value: { accepted: false },
    });
  expect(
    db.prepare("SELECT named FROM neo_todos WHERE id = 'dentist'").get() as { named: null }
  ).toEqual({ named: null });
});

test('agents and Neo cannot turn desktop control back on', async () => {
  await set({ todoId: 'dentist', on: false });
  for (const caller of [
    { source: 'mcp', role: 'neo' },
    { source: 'rpc', principal: 'local', device: { deviceId: 'test-agent', kind: 'agent' } },
  ] as OperationCaller[])
    expect(await set({ todoId: 'dentist', on: true }, caller)).not.toMatchObject({
      kind: 'completed',
    });
  expect(optedIn('worker-a')).toBeNull();
});

function neoOperations() {
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  const controls: NeoTodoControls = {
    resolveTarget: existingTodoTarget,
    recompute: async (todo: Parameters<typeof store.updateTodo>[0], patch: object) =>
      store.updateTodo(todo, patch, Date.now()),
    advance: async () => {},
    proceed: async () => ({ ok: false as const, reason: 'no' }),
    retry: async () => ({ ok: false as const, reason: 'no' }),
    stop: async () => null,
  };
  const registry = createOperationRegistry([
    ...createPackPreferenceQuestions(
      db,
      store,
      () => createTodoCheckPacks(db),
      () => 'en',
      async () => {},
      () => undefined
    ),
    ...createNeoTodoOperations(
      store,
      sessions,
      controls,
      () => createTodoCheckPacks(db),
      () => null
    ),
    ...createNeoAskRecordOperations(
      store,
      sessions,
      controls,
      () => null,
      () => true,
      () => [],
      () => createTodoCheckPacks(db),
      () => null,
      undefined,
      { gateway: gatewayFor(db), changed: () => {} }
    ),
  ]);
  return registry;
}
const neo: OperationCaller = { source: 'mcp', sessionId: 'neo', role: 'neo' };
const draft = {
  title: 'Book it',
  doneWhen: 'Booked',
  check: pendingTodoCheck,
  instruction: null,
  after: [],
  named: { desktopControl: true },
};
const storedOptIns = () =>
  (db.prepare('SELECT named FROM neo_todos').all() as { named: string | null }[]).filter(
    (row) => JSON.parse(row.named ?? '{}').desktopControl !== undefined
  ).length;

test('Neo cannot turn desktop control on when it adds or opens a todo', async () => {
  const registry = neoOperations();
  expect(
    await invokeOperation(registry, 'neo.todo.add', { askId: 'ask', ...draft }, neo)
  ).not.toMatchObject({ kind: 'completed', value: { ok: true } });
  expect(
    await invokeOperation(
      registry,
      'neo.ask.propose',
      { title: 'Errand', request: 'Errand', todos: [draft] },
      neo
    )
  ).not.toMatchObject({ kind: 'completed', value: { ok: true } });
  expect(storedOptIns()).toBe(0);
});

test('desktop refusal leaves the entire ask.open todo batch unwritten', async () => {
  const store = new NeoAskTodoRepository(db);
  const before = store.listTodos('ask');
  const plain = {
    ...draft,
    title: 'Prepare booking',
    check: { ...pendingTodoCheck, params: { path: '/synthetic/prepare-booking' } },
    named: null,
  };
  const result = await invokeOperation(
    neoOperations(),
    'neo.ask.propose',
    { title: 'Errands', request: 'Errands', todos: [plain, draft] },
    neo
  );
  expect(result).toMatchObject({
    kind: 'completed',
    value: { ok: false, reason: expect.stringContaining('desktop_control_requires_permission') },
  });
  expect(store.listTodos('ask')).toEqual(before);
  expect(store.listQuestions('ask')).toEqual([]);
});

test('a worker cannot opt a todo in to desktop control', async () => {
  const outcome = await invokeOperation(
    neoOperations(),
    'neo.ask.propose',
    { title: 'Errands', request: 'Errands', todos: [draft] },
    { ...neo, role: 'workflow_worker' }
  );
  expect(outcome).toMatchObject({
    kind: 'completed',
    value: { ok: false, reason: expect.stringContaining('desktop_control_requires_permission') },
  });
  expect(storedOptIns()).toBe(0);
});

test('Neo cannot turn desktop control back on by editing a todo', async () => {
  await set({ todoId: 'dentist', on: false });
  await invokeOperation(
    neoOperations(),
    'neo.todo.edit',
    { todoId: 'dentist', named: { desktopControl: true } },
    neo
  );
  expect(optedIn('worker-a')).toBeNull();
});

test('a todo stored with desktop control in its draft keeps it off', () => {
  new NeoAskTodoRepository(db).addTodo(
    'copied',
    'ask',
    {
      title: 'Copied',
      doneWhen: 'Done',
      check: null,
      instruction: null,
      named: { desktopControl: true, folder: 'docs' },
    },
    2
  );
  expect(
    JSON.parse(
      (db.prepare("SELECT named FROM neo_todos WHERE id = 'copied'").get() as { named: string })
        .named
    )
  ).toEqual({ folder: 'docs' });
});
