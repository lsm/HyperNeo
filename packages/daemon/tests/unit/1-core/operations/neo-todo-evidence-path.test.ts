import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { getDataDir } from '../../../../src/lib/data-dir.ts';
import { workerWritableRoots } from '../../../../src/lib/drivers/worker-sandbox.ts';
import { createNeoAskRecordOperations } from '../../../../src/lib/neo/ask-record-operations.ts';
import { neoEvidenceRefusal } from '../../../../src/lib/neo/core-todo-checks.ts';
import { todoEvidenceFile } from '../../../../src/lib/work-locations.ts';
import {
  createNeoTodoOperations,
  type NeoTodoControls,
} from '../../../../src/lib/neo/todo-operations.ts';
import { wireNeoTodoMutations } from '../../../../src/lib/neo/todo-mutation-operation.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { existingTodoTarget, createTodoCheckPacks } from '../../helpers/todo-check-packs.ts';

const owner: OperationCaller = { source: 'mcp', sessionId: 'neo-a', role: 'neo' };
const userFolder = '/users/me/Results';

function setup(repository: string | null, seedPeer = true) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  const packs = createTodoCheckPacks(db);
  const store = new NeoAskTodoRepository(db);
  store.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo-a',
    originMessageId: 'm1',
    title: 'Ship it',
    request: 'Ship it',
    createdAt: 1,
  });
  db.prepare('UPDATE neo_asks SET repo = ? WHERE id = ?').run(repository, 'ask');
  if (repository && seedPeer)
    store.addTodo(
      'repo-context',
      'ask',
      {
        title: 'Repository context',
        doneWhen: 'Observed',
        check: null,
        instruction: null,
        named: null,
      },
      1,
      repository
    );
  const controls = {
    userFolder,
    resolveTarget: existingTodoTarget,
    start: async () => ({ ok: false as const, reason: 'not started' }),
  } as unknown as NeoTodoControls;
  const gateway = gatewayFor(db);
  const operations = wireNeoTodoMutations(
    createNeoTodoOperations(
      store,
      new NeoTodoSessionRepository(db),
      controls,
      () => packs,
      () => null
    ),
    {
      gateway,
      write: gateway.run.bind(gateway),
      userFolder,
      packs: () => packs,
      artifact: () => null,
      stop: async () => null,
      resolveTarget: existingTodoTarget,
      advance: async () => {},
      changed: () => {},
      project: async (todos) => [...todos],
    }
  );
  const add = operations.find((op) => op.name === 'neo.todo.add')!;
  const edit = operations.find((op) => op.name === 'neo.todo.edit')!;
  const open = createNeoAskRecordOperations(
    store,
    new NeoTodoSessionRepository(db),
    controls,
    () => null,
    () => true,
    () => [],
    () => packs,
    () => null,
    async (todos) => [...todos],
    { gateway: gatewayFor(db), changed: () => {} }
  ).find((op) => op.name === 'neo.ask.open')!;
  return {
    db,
    store,
    edit: async (input: unknown) =>
      (await edit.execute(edit.inputSchema.parse(input), owner)) as {
        ok: boolean;
        reason?: string;
      },
    open: async (input: unknown) =>
      (await open.execute(open.inputSchema.parse(input), owner)) as { ok: boolean },
    add: async (params: Record<string, unknown>) =>
      (await add.execute(
        add.inputSchema.parse({
          after: [],
          askId: 'ask',
          title: 'Prove it',
          check: { pack: 'core', kind: 'evidence', params },
        }),
        owner
      )) as { ok: true; todo: NeoTodo } | { ok: false; reason: string },
  };
}

describe('neo.todo.add evidence paths', () => {
  test('a report in the user folder keeps a separate assigned completion check', async () => {
    const { add, edit, store } = setup('lsm/hyperneo');
    const added = await add({});
    if (!added.ok) throw new Error(added.reason);
    const report = `Read ${join(userFolder, 'Travel', 'report.md')}`;
    expect((await edit({ todoId: added.todo.id, done: 'reported', evidence: report })).ok).toBe(
      true
    );
    expect(store.getTodo(added.todo.id)?.report).toBe(report);
    expect(store.getTodo(added.todo.id)?.check).toEqual(added.todo.check);
  });
  test('an omitted path is assigned under the data dir and named in the completion', async () => {
    const { add } = setup('lsm/hyperneo');
    const result = await add({});
    if (!result.ok) throw new Error(result.reason);
    const path = join(getDataDir(), 'work', 'evidence', result.todo.id, 'result.md');
    expect(result.todo.check?.params).toEqual({ path });
    expect(result.todo.doneWhen).toContain(path);
  });

  test('a repo todo naming the user folder is refused and told to omit the path', async () => {
    const { add, store } = setup('lsm/hyperneo');
    const result = await add({ path: join(userFolder, 'proof.md') });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toContain('Omit');
    expect(store.listTodos('ask').map((todo) => todo.id)).toEqual(['repo-context']);
  });

  test('an ask-only legacy hint does not assign a repository to new work', async () => {
    const { add, db } = setup('lsm/hyperneo', false);
    const result = await add({ path: join(userFolder, 'itinerary.md') });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(
      db.prepare('SELECT repo FROM pack_coding_todos WHERE todo_id = ?').get(result.todo.id)
    ).toEqual({ repo: null });
  });

  test('a todo with no repo may still save a result for the human', async () => {
    const { add } = setup(null);
    expect((await add({ path: join(userFolder, 'itinerary.md') })).ok).toBe(true);
  });

  test('a repo todo may name a path outside the user folder', async () => {
    const { add } = setup('lsm/hyperneo');
    expect((await add({ path: `${userFolder}-other/proof.md` })).ok).toBe(true);
  });

  test('neo.ask.open refuses a misplaced path before recording anything', async () => {
    const { db, open } = setup(null);
    const evidence = (params: Record<string, unknown>) => ({
      pack: 'core',
      kind: 'evidence',
      params,
    });
    const result = await open({
      title: 'New work',
      request: 'New work',
      todos: [
        { after: [], title: 'First', check: evidence({}) },
        {
          after: [],
          title: 'Second',
          check: evidence({ path: join(userFolder, 'proof.md') }),
          instruction: 'Prove it',
          target: {
            verb: 'start',
            adapter: 'hyperneo',
            place: {
              machine: 'm',
              name: 'Repo',
              folder: '/repo',
              remotes: ['git@github.com:lsm/hyperneo.git'],
            },
          },
        },
      ],
    });
    const count = (table: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(result.ok).toBe(false);
    expect(count('neo_asks')).toBe(1);
    expect(count('neo_todos')).toBe(0);
  });

  test('an older todo with no repo of its own follows its ask on edit', async () => {
    const { edit, store } = setup('lsm/hyperneo', false);
    const todo = store.addTodo(
      'older',
      'ask',
      { title: 'Older', doneWhen: 'Observed', check: null, instruction: null, named: null },
      1
    );
    const result = await edit({
      todoId: todo.id,
      check: { pack: 'core', kind: 'evidence', params: { path: join(userFolder, 'proof.md') } },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('Omit');
  });

  test('a differently cased user folder is still the user folder', async () => {
    const { add } = setup('lsm/hyperneo');
    expect((await add({ path: join(userFolder.toLowerCase(), 'proof.md') })).ok).toBe(false);
    expect((await add({ path: '/USERS/ME/RESULTS/proof.md' })).ok).toBe(false);
  });

  test('an unchanged path on an existing todo keeps working', () => {
    const check = { pack: 'core', kind: 'evidence', params: { path: `${userFolder}/old.md` } };
    expect(neoEvidenceRefusal(check, 'lsm/hyperneo', userFolder, check)).toBeNull();
    expect(neoEvidenceRefusal(check, 'lsm/hyperneo', userFolder, null)).toContain('Omit');
  });

  test('a sandboxed worker cannot write another todo evidence', () => {
    const allowed = workerWritableRoots('/repo');
    expect(allowed.some((root) => todoEvidenceFile('todo').startsWith(`${root}/`))).toBe(false);
  });
});
