import { afterEach, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { createCoreTodoPack } from '../../../../src/lib/neo/core-todo-checks.ts';
import {
  createNeoTodoOperations,
  NeoTodoDraftSchema,
} from '../../../../src/lib/neo/todo-operations.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
function fixture() {
  const db = new Database(':memory:');
  cleanup.push(() => db.close());
  runMigrations(db, () => {});
  createTables(db);
  const store = new NeoAskTodoRepository(db);
  store.openAsk({
    id: 'ask',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    title: 'Observe result',
    request: 'Observe',
    createdAt: 1,
  });
  const ops = createNeoTodoOperations(
    store,
    new NeoTodoSessionRepository(db),
    {
      recompute: async (todo, patch) => store.updateTodo(todo, patch, Date.now()),
      start: async () => ({ ok: false as const, reason: 'no worker' }),
      proceed: async () => ({ ok: false as const, reason: 'no worker' }),
      retry: async () => ({ ok: false as const, reason: 'no worker' }),
      stop: async () => null,
    },
    () => [createCoreTodoPack(db, async () => false)],
    () => null
  );
  const call = async (name: string, input: unknown) => {
    const op = ops.find((op) => op.name === name)!;
    return (await op.execute(op.inputSchema.parse(input), {
      source: 'mcp',
      role: 'neo',
      sessionId: 'neo',
    })) as { ok: boolean; todo?: NeoTodo; reason?: string };
  };
  return { store, ops, call };
}
const check = { pack: 'core', kind: 'evidence', params: { path: '/synthetic/result.txt' } };

test('new todo inputs require a check and expose no free-text completion input', () => {
  expect(NeoTodoDraftSchema.safeParse({ title: 'Verify', doneWhen: 'Remember it' }).success).toBe(
    false
  );
  expect(NeoTodoDraftSchema.safeParse({ title: 'Verify', check: null }).success).toBe(false);
  const parsed = NeoTodoDraftSchema.parse({ title: 'Verify', check, doneWhen: 'Ignore this' });
  expect(parsed).not.toHaveProperty('doneWhen');
});

test('add derives completion text and rejects unsupported check packs and kinds', async () => {
  const { call, store } = fixture();
  const added = await call('neo.todo.add', { askId: 'ask', title: 'Verify', check });
  expect(added).toMatchObject({
    ok: true,
    todo: { doneWhen: 'File /synthetic/result.txt exists.', check },
  });
  for (const invalid of [
    { ...check, pack: 'unknown' },
    { ...check, kind: 'typo' },
  ])
    expect(
      await call('neo.todo.add', { askId: 'ask', title: 'Invalid', check: invalid })
    ).toMatchObject({ ok: false });
  expect(store.listTodos('ask')).toHaveLength(1);
});

test('legacy rows remain readable and a check edit replaces their old completion wording', async () => {
  const { call, store, ops } = fixture();
  const legacy = store.addTodo(
    'legacy',
    'ask',
    { title: 'Old', doneWhen: 'Remember it', check: null, instruction: null, named: null },
    1
  );
  expect(store.getTodo(legacy.id)).toMatchObject({ check: null, doneWhen: 'Remember it' });
  const edit = ops.find((op) => op.name === 'neo.todo.edit')!;
  expect(edit.inputSchema.parse({ todoId: legacy.id, doneWhen: 'Override' })).not.toHaveProperty(
    'doneWhen'
  );
  const edited = await call('neo.todo.edit', { todoId: legacy.id, check });
  expect(edited).toMatchObject({
    ok: true,
    todo: { check, doneWhen: 'File /synthetic/result.txt exists.' },
  });
});
