import { afterEach, beforeEach, expect, test } from 'bun:test';
import { neoStartPlace } from '../../../../src/lib/neo/start-place.ts';
import { neoTodoPlaceRefusal } from '../../../../src/lib/neo/todo-operations.ts';
import { createCodingPackTables } from '../../../../src/lib/neo/packs/coding/schema/coding-tables.ts';
import { ArtifactReferenceSourceRepository } from '../../../../src/storage/repositories/artifact-reference-source.ts';
import { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

let db: Database;
let store: NeoAskTodoRepository;
const caller = { source: 'rpc', principal: 'local', role: 'neo', sessionId: 'neo' } as const;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, () => {});
  createTables(db);
  createCodingPackTables(db);
  store = new NeoAskTodoRepository(db);
  store.openAsk({
    id: 'ask',
    title: 'Work',
    request: 'Work',
    sessionId: 'neo',
    projectId: null,
    originMessageId: null,
    repo: 'github.com/synthetic/ask',
    createdAt: 1,
  });
  store.addTodo(
    'todo',
    'ask',
    {
      title: 'Work',
      doneWhen: 'Observed',
      instruction: null,
      named: { repository: 'synthetic/named' },
      check: {
        pack: 'coding',
        kind: 'pr_merged',
        params: { urls: ['https://github.com/synthetic/check/pull/1'] },
      },
    },
    1,
    'github.com/synthetic/stored'
  );
});
afterEach(() => db.close());

test('placement admission invokes a pack even when core owns the evidence check', () => {
  const draft = {
    check: { pack: 'core', kind: 'evidence', params: { path: '/synthetic/result' } },
    instruction: 'Work',
    named: null,
    target: { verb: 'start', adapter: 'hyperneo' },
  };
  const scope = { ask: store.getAsk('ask') };
  const packs = [
    {
      todos: {
        repository: () => 'synthetic/policy',
        refuse: (received: unknown, _peers: unknown, current: unknown) => {
          expect(received).toEqual(draft);
          expect(current).toEqual(scope);
          return 'place_required: supplied by the pack';
        },
      },
    },
  ];
  expect(Reflect.apply(neoTodoPlaceRefusal, undefined, [draft, packs, scope])).toBe(
    'place_required: supplied by the pack'
  );
});

test('placement dispatch leaves completion-only pack validation to its owner', () => {
  const draft = {
    ...store.getTodo('todo')!,
    instruction: 'Work',
    target: { verb: 'start', adapter: 'hyperneo' },
  };
  const packs = [
    {
      todos: {
        refuse: () => {
          throw new Error('Only the check owner validates this check');
        },
      },
    },
  ];
  expect(
    Reflect.apply(neoTodoPlaceRefusal, undefined, [draft, packs, { ask: store.getAsk('ask') }])
  ).toBeNull();
});

test('start-place uses its supplied repository policy instead of inferring from the check', () => {
  const start = neoStartPlace({
    db,
    machine: 'local',
    workspaceRoot: '/synthetic/home',
    repository: () => null,
  });
  expect(
    Reflect.apply(start, undefined, [
      { todoId: 'todo', adapter: 'synthetic', title: 'Work', message: 'Work' },
      caller,
    ])
  ).toMatchObject({ value: { place: { folder: '/synthetic/home' } } });
});

test.each(['github.com/synthetic/stored', null, ''])(
  'artifact binding preserves stored nullish precedence: %j',
  (repo) => {
    db.prepare('UPDATE neo_todos SET repo = ? WHERE id = ?').run(repo, 'todo');
    const source = new ArtifactReferenceSourceRepository(db, 'synthetic-daemon', '/synthetic/home');
    expect(source.load({ kind: 'todo', id: 'todo' }, caller)?.bindings[0].repository).toBe(
      repo ?? 'github.com/synthetic/ask'
    );
  }
);

test('artifact binding uses its supplied repository policy', () => {
  const source = new ArtifactReferenceSourceRepository(
    db,
    'synthetic-daemon',
    '/synthetic/home',
    () => 'github.com/synthetic/policy'
  );
  expect(source.load({ kind: 'todo', id: 'todo' }, caller)?.bindings[0].repository).toBe(
    'github.com/synthetic/policy'
  );
});
