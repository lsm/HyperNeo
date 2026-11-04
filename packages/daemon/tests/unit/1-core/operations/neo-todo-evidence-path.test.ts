import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { getDataDir } from '../../../../src/lib/data-dir.ts';
import { workerWritableRoots } from '../../../../src/lib/drivers/worker-sandbox.ts';
import { neoEvidenceRefusal } from '../../../../src/lib/neo/core-todo-checks.ts';
import { todoEvidenceFile } from '../../../../src/lib/work-locations.ts';
import {
  createNeoTodoOperations,
  type NeoTodoControls,
} from '../../../../src/lib/neo/todo-operations.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { existingTodoTarget, createTodoCheckPacks } from '../../helpers/todo-check-packs.ts';

const owner: OperationCaller = { source: 'mcp', sessionId: 'neo-a', role: 'neo' };
const userFolder = '/users/me/Results';

function setup(repository: string | null) {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
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
    repo: repository,
  });
  const controls = {
    userFolder,
    resolveTarget: existingTodoTarget,
    start: async () => ({ ok: false as const, reason: 'not started' }),
  } as unknown as NeoTodoControls;
  const add = createNeoTodoOperations(
    store,
    new NeoTodoSessionRepository(db),
    controls,
    () => packs,
    () => null
  ).find((op) => op.name === 'neo.todo.add')!;
  return {
    store,
    add: async (params: Record<string, unknown>) =>
      (await add.execute(
        add.inputSchema.parse({
          askId: 'ask',
          title: 'Prove it',
          check: { pack: 'core', kind: 'evidence', params },
        }),
        owner
      )) as { ok: true; todo: NeoTodo } | { ok: false; reason: string },
  };
}

describe('neo.todo.add evidence paths', () => {
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
    expect(store.listTodos('ask')).toEqual([]);
  });

  test('a todo with no repo may still save a result for the human', async () => {
    const { add } = setup(null);
    expect((await add({ path: join(userFolder, 'itinerary.md') })).ok).toBe(true);
  });

  test('a repo todo may name a path outside the user folder', async () => {
    const { add } = setup('lsm/hyperneo');
    expect((await add({ path: `${userFolder}-other/proof.md` })).ok).toBe(true);
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
