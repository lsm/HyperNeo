import { describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { createNeoAskRecordOperations } from '../../../../src/lib/neo/ask-record-operations.ts';
import { codingTodoRepository } from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import type { NeoPack } from '../../../../src/lib/neo/packs/types.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
import { neoTodoRepo } from '../../../../src/lib/neo/todo-repo.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const draft = {
  title: 'Fix it',
  doneWhen: 'Merged',
  check: null,
  instruction: null,
  named: null,
  start: false,
};
const coding = {
  id: 'coding',
  todos: { repository: codingTodoRepository },
} as unknown as NeoPack;
const place = {
  machine: 'laptop',
  name: 'ops',
  folder: '/focus/ops',
  remotes: ['git@github.com:lsm/Ops.git'],
};

describe('codingTodoRepository', () => {
  test('reads the repo of a named pull request, then of a named repository', () => {
    expect(
      codingTodoRepository({
        check: {
          pack: 'coding',
          kind: 'pr_merged',
          params: { urls: ['https://github.com/lsm/HyperNeo/pull/7650'] },
        },
        named: null,
      })
    ).toBe('github.com/lsm/hyperneo');
    expect(
      codingTodoRepository({ check: null, named: { repository: 'lsm/open-agent-protocol' } })
    ).toBe('github.com/lsm/open-agent-protocol');
    expect(codingTodoRepository({ check: null, named: { engine: 'codex' } })).toBeNull();
  });
});

describe('neoTodoRepo', () => {
  test('prefers the pack, then the start place’s git remote, then the ask’s repo', () => {
    const pr = {
      ...draft,
      check: {
        pack: 'coding',
        kind: 'pr_merged',
        params: { urls: ['https://github.com/lsm/HyperNeo/pull/1'] },
      },
    };
    const started = {
      ...draft,
      instruction: 'Go',
      target: { verb: 'start' as const, adapter: 'hyperneo', place },
    };
    expect(neoTodoRepo(pr, [coding], { repo: 'github.com/lsm/ops' })).toBe(
      'github.com/lsm/hyperneo'
    );
    expect(neoTodoRepo(started, [coding], { repo: null })).toBe('github.com/lsm/ops');
    expect(neoTodoRepo(draft, [coding], { repo: 'github.com/lsm/makai' })).toBe(
      'github.com/lsm/makai'
    );
    expect(neoTodoRepo(draft, [coding], { repo: null })).toBeNull();
  });
});

describe('neo.todo.add repo', () => {
  test('stores the derived repo on the todo, and on an ask that had none', async () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const store = new NeoAskTodoRepository(db);
    store.openAsk({
      id: 'ask',
      projectId: null,
      sessionId: 'neo',
      originMessageId: null,
      title: 'Attach PRs',
      request: 'Attach PRs',
      createdAt: 1,
    });
    const add = createNeoTodoOperations(
      store,
      new NeoTodoSessionRepository(db),
      {
        start: async () => ({ ok: false as const, reason: 'no' }),
        proceed: async () => ({ ok: false as const, reason: 'no' }),
        retry: async () => ({ ok: false as const, reason: 'no' }),
        stop: async () => null,
      },
      () => [coding]
    ).find((op) => op.name === 'neo.todo.add')!;
    const call = async (input: unknown) =>
      (await add.execute(add.inputSchema.parse(input), {
        source: 'mcp',
        sessionId: 'neo',
        role: 'neo',
      })) as { ok: true; todo: NeoTodo };
    const first = await call({
      askId: 'ask',
      ...draft,
      named: { repository: 'lsm/HyperNeo' },
    });
    expect(first.todo.repo).toBe('github.com/lsm/hyperneo');
    expect(store.getAsk('ask')?.repo).toBe('github.com/lsm/hyperneo');
    const second = await call({ askId: 'ask', ...draft, title: 'Deploy' });
    expect(second.todo.repo).toBe('github.com/lsm/hyperneo');
    db.close();
  });
});

describe('neo.ask.open repo', () => {
  test('returns the ask with the repo its first todo gave it', async () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const store = new NeoAskTodoRepository(db);
    const open = createNeoAskRecordOperations(
      store,
      new NeoTodoSessionRepository(db),
      {
        start: async () => ({ ok: false as const, reason: 'no' }),
        proceed: async () => ({ ok: false as const, reason: 'no' }),
        retry: async () => ({ ok: false as const, reason: 'no' }),
        stop: async () => null,
      },
      () => null,
      () => true,
      () => [],
      () => [coding]
    ).find((op) => op.name === 'neo.ask.open')!;
    const receipt = (await open.execute(
      open.inputSchema.parse({
        title: 'Fix login',
        request: 'Fix login',
        todos: [{ ...draft, named: { repository: 'lsm/HyperNeo' } }],
      }),
      { source: 'mcp', sessionId: 'neo', role: 'neo' }
    )) as { ok: true; ask: { repo: string | null } };
    expect(receipt.ask.repo).toBe('github.com/lsm/hyperneo');
    db.close();
  });
});
