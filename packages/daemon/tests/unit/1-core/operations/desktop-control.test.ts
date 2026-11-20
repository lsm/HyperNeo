import { beforeEach, expect, test } from 'vitest';
import { createDesktopControlOperation } from '../../../../src/lib/desktop/control-operation.ts';
import { desktopOptIn, readDesktopTodos } from '../../../../src/lib/desktop/opt-in.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { DESKTOP_CONTROL_ANSWERS } from '../../../../src/lib/neo/desktop-control-preference.ts';
import { planNeoQuestionAnswer } from '../../../../src/lib/neo/question-operations.ts';
import type { NeoQuestion } from '@hyperneo/shared/types/neo-ask';
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
    db.prepare("UPDATE neo_todos SET state = 'doing', approved_at = 1 WHERE id = ?").run(todo);
    db.prepare('INSERT INTO neo_todo_sessions(todo_id, target, ref) VALUES(?, ?, ?)').run(
      todo,
      '{}',
      JSON.stringify({ adapter: 'hyperneo', id: worker })
    );
  }
});

const optedIn = (worker: string) => desktopOptIn(readDesktopTodos(db), worker)?.id ?? null;
function set(input: { todoId: string; on: boolean }, caller = human) {
  return invokeOperation(
    createOperationRegistry([createDesktopControlOperation(db)]),
    'desktop.control.set',
    input,
    caller
  );
}

test('desktop control is off for every todo until the human turns it on', () => {
  expect([optedIn('worker-a'), optedIn('worker-b')]).toEqual([null, null]);
});

test('turning desktop control on is per todo, and it turns back off', async () => {
  expect(await set({ todoId: 'taxes', on: true })).toMatchObject({
    kind: 'completed',
    value: { accepted: true, desktopControl: true },
  });
  expect([optedIn('worker-a'), optedIn('worker-b')]).toEqual([null, 'taxes']);
  expect(
    JSON.parse(
      (db.prepare('SELECT named FROM neo_todos WHERE id = ?').get('taxes') as { named: string })
        .named
    )
  ).toEqual({ folder: 'docs', desktopControl: true });
  await set({ todoId: 'taxes', on: false });
  expect(optedIn('worker-b')).toBeNull();
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

test('agents and Neo cannot turn desktop control on', async () => {
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
      async () => {}
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
      'neo.ask.open',
      { title: 'Errand', request: 'Errand', todos: [draft] },
      neo
    )
  ).not.toMatchObject({ kind: 'completed', value: { ok: true } });
  expect(storedOptIns()).toBe(0);
});

const savePreference = (value: boolean) =>
  db
    .prepare(`INSERT OR REPLACE INTO neo_pack_preferences
    (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
    VALUES ('core', 'global', '', 'desktopControl', ?, 'human', 1)`)
    .run(JSON.stringify(value));

test('Neo opts a todo in only after the human turns asking off, and sends no preference card', async () => {
  const registry = neoOperations();
  const add = () => invokeOperation(registry, 'neo.todo.add', { askId: 'ask', ...draft }, neo);
  expect(await add()).toMatchObject({ kind: 'completed', value: { ok: false } });
  savePreference(false);
  expect(await add()).toMatchObject({ kind: 'completed', value: { ok: false } });
  expect(storedOptIns()).toBe(0);
  expect(new NeoAskTodoRepository(db).listQuestions('ask')).toEqual([]);
  savePreference(true);
  expect(await add()).toMatchObject({
    kind: 'completed',
    value: { ok: true, todo: { named: { desktopControl: true } } },
  });
  expect(storedOptIns()).toBe(1);
});

test('the per-todo desktop card takes no, this task only, or always', () => {
  const card = { state: 'open', kind: 'desktop_control', options: [...DESKTOP_CONTROL_ANSWERS] };
  for (const answer of ['No', 'Allow', 'Always allow'])
    expect(planNeoQuestionAnswer(card as NeoQuestion, answer)).toMatchObject({
      value: { answer },
    });
  expect(planNeoQuestionAnswer(card as NeoQuestion, 'Maybe')).not.toHaveProperty('value');
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
    'neo.ask.open',
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

test('a worker cannot use Neo’s desktop preference to opt a todo in', async () => {
  db.prepare(`INSERT INTO neo_pack_preferences
    (pack, scope_kind, scope_key, key, value_json, set_by, set_at)
    VALUES ('core', 'global', '', 'desktopControl', 'true', 'human', 1)`).run();
  const outcome = await invokeOperation(
    neoOperations(),
    'neo.ask.open',
    { title: 'Errands', request: 'Errands', todos: [draft] },
    { ...neo, role: 'workflow_worker' }
  );
  expect(outcome).toMatchObject({
    kind: 'completed',
    value: { ok: false, reason: expect.stringContaining('desktop_control_requires_permission') },
  });
  expect(storedOptIns()).toBe(0);
});

test('Neo cannot turn desktop control on by editing a todo', async () => {
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

let cards = 0;
function desktopCard(todoId: string) {
  const store = new NeoAskTodoRepository(db);
  const question = store.askQuestion(
    `card-${(cards += 1)}`,
    'ask',
    {
      text: 'May a worker use Calendar?',
      kind: 'desktop_control',
      options: null,
      multiple: false,
      noLabel: null,
      yesLabel: null,
      todoId,
      app: 'Calendar',
    },
    1
  );
  return { store, question };
}
const preference = () =>
  (
    db.prepare("SELECT value_json FROM neo_pack_preferences WHERE key = 'desktopControl'").get() as
      | { value_json: string }
      | undefined
  )?.value_json;
const todoNamed = (id: string) =>
  JSON.parse(
    (db.prepare('SELECT named FROM neo_todos WHERE id = ?').get(id) as { named: string | null })
      .named ?? '{}'
  );

test('answering the desktop card applies the todo opt-in and the preference itself', () => {
  for (const [todo, answer, on, saved] of [
    ['dentist', 'No', undefined, undefined],
    ['taxes', 'Allow', true, undefined],
  ] as const) {
    const { store, question } = desktopCard(todo);
    expect(store.answerQuestion(question, answer, 'button', 2)?.state).toBe('answered');
    expect(todoNamed(todo).desktopControl).toBe(on);
    expect(preference()).toBe(saved);
  }
  const { store, question } = desktopCard('dentist');
  store.answerQuestion(question, 'Always allow', 'button', 3);
  expect(todoNamed('dentist').desktopControl).toBe(true);
  expect(preference()).toBe('true');
});

test('always allow still saves the preference when the todo already finished', () => {
  db.prepare("UPDATE neo_todos SET state = 'done' WHERE id = 'dentist'").run();
  const { store, question } = desktopCard('dentist');
  store.answerQuestion(question, 'Always allow', 'button', 2);
  expect(todoNamed('dentist').desktopControl).toBeUndefined();
  expect(preference()).toBe('true');
});
