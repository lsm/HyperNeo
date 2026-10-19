import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import {
  CodingTodoPrRepository,
  createCodingTodoPack,
} from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import type { NeoPack } from '../../../../src/lib/neo/packs/types.ts';
import {
  readNeoTodoCompletion,
  requireNeoTodoMayFinish,
} from '../../../../src/lib/neo/todo-completion.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
import { createNeoTodoRunner } from '../../../../src/lib/neo/todo-runner.ts';
import type { OperationCaller } from '../../../../src/lib/operations/registry.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { runMigration395 } from '../../../../src/storage/schema/m395-neo-todo-pr-merged-check.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const owner: OperationCaller = { source: 'mcp', sessionId: 'neo', role: 'neo' };
const url = (n: number) => `https://github.com/lsm/HyperNeo/pull/${n}`;

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  store.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: 'm1',
    title: 'Two PRs',
    request: 'Land both PRs',
    createdAt: 1,
  });
  const states = new Map<number, NeoWorkPr['state']>([
    [1, 'MERGED'],
    [2, 'OPEN'],
  ]);
  const read = async (urls: readonly string[]): Promise<NeoWorkPr[]> =>
    urls.map((item) => {
      const n = Number(item.split('/').pop());
      return { url: item, state: states.get(n) ?? 'OPEN', checks: 'passing', review: 'none' };
    });
  const repo = new CodingTodoPrRepository(db);
  const coding = {
    id: 'coding',
    describe: 'coding',
    instructions: () => null,
    todos: createCodingTodoPack(repo, read),
  } satisfies NeoPack;
  coding.todos.schema(db);
  const told: string[] = [];
  const runner = createNeoTodoRunner({
    store,
    sessions,
    invoke: async () => ({ kind: 'completed', value: null }) as never,
    packs: () => [coding],
    tell: async (_ask, _todo, note) => {
      told.push(note);
    },
    tellAsk: async () => {},
    changed: () => {},
  });
  const ops = Object.fromEntries(
    createNeoTodoOperations(
      store,
      sessions,
      {
        start: async () => ({ ok: false as const, reason: 'not started' }),
        proceed: async () => ({ ok: false as const, reason: 'no session' }),
        retry: async () => ({ ok: false as const, reason: 'not failed' }),
        stop: async () => null,
      },
      () => [coding]
    ).map((op) => [op.name, op])
  );
  const call = async (name: string, input: unknown) =>
    (await ops[name].execute(ops[name].inputSchema.parse(input), owner)) as
      | { ok: true; todo: NeoTodo }
      | { ok: false; reason: string };
  return { db, store, states, runner, call, told, coding };
}

describe('one completion rule for Neo todos', () => {
  test('a todo with two required PRs stays not done until both merge, on every path', async () => {
    const { db, store, states, runner, call, told } = setup();
    db.prepare(
      `INSERT INTO neo_todos (id, ask_id, position, title, done_when, check_json, state, created_at, updated_at)
       VALUES ('t', 'ask', 0, 'Land both', 'Both merged', ?, 'doing', 1, 1)`
    ).run(
      JSON.stringify({ pack: 'coding', kind: 'pr_opened', params: { urls: [url(1), url(2)] } })
    );
    runMigration395(db);
    expect(store.getTodo('t')?.check?.kind).toBe('pr_merged');

    const unmet = {
      ok: false,
      reason:
        'check_unmet: coding.pr_merged is not met yet; the todo finishes on its own when it passes.',
    } as const;
    expect(
      await call('neo.todo.edit', { todoId: 't', done: 'met', evidence: 'Both opened' })
    ).toEqual(unmet);
    expect(await call('neo.todo.close', { todoId: 't', reason: 'Looks done' })).toEqual(unmet);
    await runner.checkNow(['t'], () => {});
    expect(store.getTodo('t')?.state).toBe('doing');
    expect(await call('neo.todo.edit', { todoId: 't', title: 'Land both PRs' })).toMatchObject({
      ok: true,
      todo: { state: 'doing', title: 'Land both PRs' },
    });

    states.set(2, 'MERGED');
    await runner.checkNow(['t'], () => {});
    expect(store.getTodo('t')).toMatchObject({ state: 'done', evidence: '#1 #2 merged' });
    expect(told).toEqual(['Todo "Land both PRs" is done: #1 #2 merged']);
    db.close();
  });

  test('a required PR closed unmerged with no replacement fails the todo for Neo to redo or drop', async () => {
    const { db, store, states, runner, call, told } = setup();
    const todo = store.addTodo(
      't',
      'ask',
      {
        title: 'Land both',
        doneWhen: 'Both merged',
        check: { pack: 'coding', kind: 'pr_merged', params: { urls: [url(1), url(2)] } },
        instruction: null,
        named: null,
      },
      1
    );
    states.set(2, 'CLOSED');
    const reason = 'check_failed: #2 closed without merging and no pull request replaced it';
    expect(await call('neo.todo.close', { todoId: todo.id, reason: 'done' })).toEqual({
      ok: false,
      reason,
    });
    await runner.checkNow([todo.id], () => {});
    expect(store.getTodo(todo.id)).toMatchObject({
      state: 'failed',
      reason: '#2 closed without merging and no pull request replaced it',
    });
    expect(told).toEqual([
      'Todo "Land both" failed: #2 closed without merging and no pull request replaced it',
    ]);
    db.close();
  });

  test('a todo without a pack rule closes as before', async () => {
    const { db, store, call, coding } = setup();
    const todo = store.addTodo(
      't',
      'ask',
      { title: 'Deploy', doneWhen: 'Running', check: null, instruction: null, named: null },
      1
    );
    expect(await readNeoTodoCompletion([coding], todo)).toBeNull();
    expect(requireNeoTodoMayFinish({ todo }, null)).toEqual({ value: { todo } });
    expect(await call('neo.todo.close', { todoId: todo.id, reason: 'Running' })).toMatchObject({
      ok: true,
      todo: { state: 'done', evidence: 'Running' },
    });
    db.close();
  });

  test('the core todo modules import nothing from the coding pack', () => {
    for (const file of ['todo-completion.ts', 'todo-operations.ts', 'todo-runner.ts']) {
      const source = readFileSync(
        new URL(`../../../../src/lib/neo/${file}`, import.meta.url),
        'utf8'
      );
      const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
      expect(imports.length).toBeGreaterThan(0);
      expect(imports.filter((path) => path.includes('packs/coding'))).toEqual([]);
    }
  });
});
