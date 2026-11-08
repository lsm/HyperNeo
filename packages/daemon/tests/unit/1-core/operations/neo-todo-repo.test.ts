import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';
import { existingTodoTarget } from '../../helpers/todo-check-packs.ts';
import { createTodoCheckPacks, pendingTodoCheck } from '../../helpers/todo-check-packs.ts';
import { describe, expect, test } from 'bun:test';
import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import { createNeoAskRecordOperations } from '../../../../src/lib/neo/ask-record-operations.ts';
import {
  CodingTodoPrRepository,
  codingTodoRepository,
  codingTodoDoneWhen,
} from '../../../../src/lib/neo/packs/coding/todo-prs.ts';
import type { NeoPack } from '../../../../src/lib/neo/pack-contract.ts';
import { createNeoTodoOperations } from '../../../../src/lib/neo/todo-operations.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const draft = {
  title: 'Fix it',
  doneWhen: 'Merged',
  check: pendingTodoCheck,
  instruction: null,
  named: null,
  start: false,
};
const recordedRepo = (db: Database, todoId: string) =>
  (
    db.prepare('SELECT repo FROM pack_coding_todos WHERE todo_id = ?').get(todoId) as {
      repo: string | null;
    } | null
  )?.repo ?? null;
const askRepo = (db: Database, askId: string) =>
  (db.prepare('SELECT repo FROM neo_asks WHERE id = ?').get(askId) as { repo: string | null }).repo;
const codingFor = (db: Database) =>
  ({
    id: 'coding',
    todos: {
      repository: (
        todo: Parameters<typeof codingTodoRepository>[0],
        scope?: Parameters<CodingTodoPrRepository['place']>[0]
      ) => codingTodoRepository(todo, [], scope && new CodingTodoPrRepository(db).place(scope)),
      doneWhen: codingTodoDoneWhen,
    },
  }) as unknown as NeoPack;
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

  test('a claimed pull request outranks a named repository', () => {
    expect(
      codingTodoRepository({ check: null, named: { repository: 'lsm/HyperNeo' } }, [
        'https://github.com/lsm/ops/pull/3',
        'https://github.com/lsm/web/pull/4',
      ])
    ).toBe('github.com/lsm/ops');
  });
});

describe('codingTodoRepository', () => {
  test('prefers explicit clues and inherits only a single sibling repository', () => {
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
      check: pendingTodoCheck,
      instruction: 'Go',
      target: { verb: 'start' as const, adapter: 'hyperneo', place },
    };
    expect(codingTodoRepository(pr, [], { ask: 'github.com/lsm/ops', peers: [] })).toBe(
      'github.com/lsm/hyperneo'
    );
    expect(codingTodoRepository(started, [], { ask: null, peers: [] })).toBe('github.com/lsm/ops');
    expect(
      codingTodoRepository(draft, [], {
        ask: 'github.com/lsm/stale',
        peers: ['github.com/lsm/makai'],
      })
    ).toBe('github.com/lsm/makai');
    expect(codingTodoRepository(draft, [], { ask: null, peers: [] })).toBeNull();
  });

  test.each([{ remotes: undefined }, { remotes: [] }, { remotes: ['not a git remote'] }])(
    'a place without a repository does not inherit the ask’s repo %j',
    ({ remotes }) => {
      const folder = { ...place, remotes };
      const started = {
        ...draft,
        check: pendingTodoCheck,
        instruction: 'Go',
        target: { verb: 'start' as const, adapter: 'hyperneo', place: folder },
      };
      const facts = { ask: 'github.com/lsm/ops', peers: [] };
      expect(codingTodoRepository(started, [], facts)).toBeNull();
      expect(
        codingTodoRepository({ ...started, named: { repository: 'synthetic/explicit' } }, [], facts)
      ).toBe('github.com/synthetic/explicit');
    }
  );
});

describe('neo.todo.add repo', () => {
  test('stores the derived repo on the todo while leaving the ask unassigned', async () => {
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
        resolveTarget: existingTodoTarget,
        recompute: async (todo, patch) => store.updateTodo(todo, patch, Date.now()),
        start: async () => ({ ok: false as const, reason: 'no' }),
        proceed: async () => ({ ok: false as const, reason: 'no' }),
        retry: async () => ({ ok: false as const, reason: 'no' }),
        stop: async () => null,
      },
      () => [codingFor(db), ...createTodoCheckPacks(db).filter((pack) => pack.id !== 'coding')],
      () => null
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
      check: pendingTodoCheck,
      named: { repository: 'lsm/HyperNeo' },
    });
    expect(recordedRepo(db, first.todo.id)).toBe('github.com/lsm/hyperneo');
    expect(askRepo(db, 'ask')).toBeNull();
    const second = await call({ askId: 'ask', ...draft, title: 'Deploy' });
    expect(recordedRepo(db, second.todo.id)).toBe('github.com/lsm/hyperneo');
    const placed = await call({
      askId: 'ask',
      ...draft,
      title: 'iOS work',
      instruction: 'Go',
      target: { verb: 'start', adapter: 'hyperneo', place: { ...place, remotes: undefined } },
    });
    expect(placed.todo.askId).toBe('ask');
    expect(recordedRepo(db, placed.todo.id)).toBeNull();
    expect(askRepo(db, 'ask')).toBeNull();
    db.close();
  });
});

describe('neo.ask.open repo', () => {
  test('keeps the ask unassigned while its first todo records the repository', async () => {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const store = new NeoAskTodoRepository(db);
    const open = createNeoAskRecordOperations(
      store,
      new NeoTodoSessionRepository(db),
      {
        resolveTarget: existingTodoTarget,
        recompute: async (todo, patch) => store.updateTodo(todo, patch, Date.now()),
        start: async () => ({ ok: false as const, reason: 'no' }),
        proceed: async () => ({ ok: false as const, reason: 'no' }),
        retry: async () => ({ ok: false as const, reason: 'no' }),
        stop: async () => null,
      },
      () => null,
      () => true,
      () => [],
      () => [codingFor(db), ...createTodoCheckPacks(db).filter((pack) => pack.id !== 'coding')],
      () => null,
      undefined,
      { gateway: gatewayFor(db), changed: () => {} }
    ).find((op) => op.name === 'neo.ask.open')!;
    const receipt = (await open.execute(
      open.inputSchema.parse({
        title: 'Fix login',
        request: 'Fix login',
        todos: [{ ...draft, named: { repository: 'lsm/HyperNeo' } }],
      }),
      { source: 'mcp', sessionId: 'neo', role: 'neo' }
    )) as { ok: true; ask: { repo: string | null } };
    expect(askRepo(db, receipt.ask.id)).toBeNull();
    db.close();
  });
});

describe('repository steps on one card', () => {
  const pr = (repo: string, n: number) => ({
    ...draft,
    title: `PR ${repo} ${n}`,
    check: {
      pack: 'coding',
      kind: 'pr_merged',
      params: { urls: [`https://github.com/lsm/${repo}/pull/${n}`] },
    },
  });
  const controls = {
    start: async () => ({ ok: false as const, reason: 'no' }),
    proceed: async () => ({ ok: false as const, reason: 'no' }),
    retry: async () => ({ ok: false as const, reason: 'no' }),
    stop: async () => null,
  };
  function setup() {
    const db = new Database(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    const store = new NeoAskTodoRepository(db);
    const sessions = new NeoTodoSessionRepository(db);
    const op = (
      ops: { name: string; inputSchema: { parse(v: unknown): unknown }; execute: Function }[],
      name: string
    ) => {
      const found = ops.find((item) => item.name === name)!;
      return async (input: unknown) =>
        found.execute(found.inputSchema.parse(input), {
          source: 'mcp',
          sessionId: 'neo',
          role: 'neo',
        });
    };
    const open = op(
      createNeoAskRecordOperations(
        store,
        sessions,
        {
          ...controls,
          resolveTarget: existingTodoTarget,
          recompute: async (todo, patch) => store.updateTodo(todo, patch, Date.now()),
        },
        () => null,
        () => true,
        () => [],
        () => [codingFor(db), ...createTodoCheckPacks(db).filter((pack) => pack.id !== 'coding')],
        undefined,
        undefined,
        { gateway: gatewayFor(db), changed: () => {} }
      ),
      'neo.ask.open'
    );
    const add = op(
      createNeoTodoOperations(
        store,
        sessions,
        {
          ...controls,
          resolveTarget: existingTodoTarget,
          recompute: async (todo, patch) => store.updateTodo(todo, patch, Date.now()),
        },
        () => [codingFor(db), ...createTodoCheckPacks(db).filter((pack) => pack.id !== 'coding')],
        () => null
      ),
      'neo.todo.add'
    );
    return { db, store, open, add };
  }

  test('one cross-repository request keeps its steps and dependencies on one open card', async () => {
    const { db, store, open, add } = setup();
    try {
      const result = await open({
        title: 'Ship across repositories',
        request: 'Keep the approved plan together',
        todos: [pr('HyperNeo', 1), { ...pr('ops', 2), after: [0] }],
      });
      expect(result.ask.status).toBe('open');
      expect(store.listChildAsks(result.ask.id)).toEqual([]);
      const steps = store.listTodos(result.ask.id);
      expect(steps.map((todo) => recordedRepo(db, todo.id))).toEqual([
        'github.com/lsm/hyperneo',
        'github.com/lsm/ops',
      ]);
      expect(steps[1].dependsOn).toEqual([steps[0].id]);
      const extra = await add({ askId: result.ask.id, ...pr('web', 3) });
      expect(extra.todo.askId).toBe(result.ask.id);
      expect(store.getAsk(result.ask.id)?.status).toBe('open');
      expect(store.listChildAsks(result.ask.id)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('a repeated mixed-repository plan keeps both same-named steps exactly once', async () => {
    const { db, store, open } = setup();
    try {
      const input = {
        title: 'Shared plan',
        request: 'Keep each result together',
        todos: [pr('HyperNeo', 1), pr('ops', 2)].map((todo) => ({ ...todo, title: 'Notes' })),
      };
      const first = await open(input);
      const again = await open(input);
      expect(again.ask.id).toBe(first.ask.id);
      expect(store.listTodos(first.ask.id).map((todo) => recordedRepo(db, todo.id))).toEqual([
        'github.com/lsm/hyperneo',
        'github.com/lsm/ops',
      ]);
      expect(store.listChildAsks(first.ask.id)).toEqual([]);
      expect(store.getAsk(first.ask.id)?.status).toBe('open');
    } finally {
      db.close();
    }
  });

  test('an existing child remains its own card when another repository is added', async () => {
    const { db, store, open, add } = setup();
    try {
      const original = await open({
        title: 'Historical plan',
        request: 'Keep history',
        todos: [pr('HyperNeo', 1)],
      });
      const child = store.openAsk({
        ...original.ask,
        id: 'legacy-child',
        parentId: original.ask.id,
        title: 'Historical child',
      });
      const existing = store.addTodo('legacy', child.id, pr('ops', 2), 2, 'github.com/lsm/ops');
      store.settleAsk(original.ask, 'done', 'Historical settlement', 3);
      const parentTodos = store.listTodos(original.ask.id);
      const added = await add({ askId: child.id, ...pr('web', 3) });
      expect(added.todo.askId).toBe(child.id);
      expect(store.getAsk(child.id)).toMatchObject({ parentId: original.ask.id, status: 'open' });
      expect(store.listChildAsks(original.ask.id).map((ask) => ask.id)).toEqual([child.id]);
      expect(store.listChildAsks(child.id)).toEqual([]);
      expect(store.getTodo(existing.id)).toEqual(existing);
      expect(store.listTodos(original.ask.id)).toEqual(parentTodos);
    } finally {
      db.close();
    }
  });
});
