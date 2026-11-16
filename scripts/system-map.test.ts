import { expect, test } from 'bun:test';
import {
  buildSystemMap,
  formatImpact,
  formatWhere,
  impact,
  isSource,
  where,
  type PackageEntry,
} from './system-map.ts';

const OPERATIONS = 'packages/daemon/src/lib/todo/operations.ts';
const REPOSITORY = 'packages/daemon/src/storage/todo-repository.ts';
const READER = 'packages/daemon/src/lib/desktop/reader.ts';
const LISTENER = 'packages/daemon/src/lib/feed/listener.ts';
const CONTROLS = 'packages/web/src/todo/controls.ts';
const HANDLER = 'packages/daemon/src/lib/rpc-handlers/todo.ts';
const NAMES = 'packages/shared/src/types/operation-names/todo.ts';
const MIGRATION = 'packages/daemon/src/storage/schema/m001-todos.ts';

const packages = new Map<string, PackageEntry>([
  [
    '@fixture/shared',
    { dir: 'packages/shared', exports: { './types/*': './src/types/*.ts' }, main: 'src/mod.ts' },
  ],
]);

function fixture() {
  return buildSystemMap(
    new Map([
      [NAMES, "export const TODO_NAMES = ['todo.remove'] as const;"],
      [MIGRATION, 'export const up = `CREATE TABLE todos (id TEXT); UPDATE todos SET id = id`;'],
      [
        REPOSITORY,
        'export const remove = `DELETE FROM todos WHERE id = ?`;\nexport const all = `SELECT id FROM todos`;',
      ],
      [
        OPERATIONS,
        [
          "import { remove } from '../../storage/todo-repository.js';",
          "import type { TODO_NAMES } from '@fixture/shared/types/operation-names/todo';",
          "export const operation = defineOperation({ name: 'todo.remove', execute: remove });",
          "export const tell = (bus) => bus.publish('todo.removed', {});",
        ].join('\n'),
      ],
      [READER, 'export const count = `SELECT COUNT(*) FROM todos`;'],
      [LISTENER, "export const listen = (bus) => bus.subscribe('todo.removed', () => {});"],
      [
        CONTROLS,
        "export const remove = (hub) => invokeOperation(hub, 'todo.remove', {});\nexport const list = (hub) => hub.request('todo.list');",
      ],
      [
        HANDLER,
        "export const setup = (messageHub) => messageHub.onRequest('todo.list', () => []);",
      ],
    ]),
    packages
  );
}

test('isSource keeps package sources and drops tests and declarations', () => {
  expect(isSource('packages/daemon/src/lib/a.ts')).toBe(true);
  expect(isSource('packages/web/src/a.tsx')).toBe(true);
  expect(isSource('packages/daemon/tests/unit/a.test.ts')).toBe(false);
  expect(isSource('packages/web/src/lib/__tests__/a.ts')).toBe(false);
  expect(isSource('packages/shared/src/sdk/sdk.d.ts')).toBe(false);
  expect(isSource('scripts/system-map.ts')).toBe(false);
});

test('where lists the readers and writers of a table without migrations', () => {
  expect(where(fixture(), 'todos')).toEqual([
    { kind: 'table', name: 'todos', role: 'reads', path: READER },
    { kind: 'table', name: 'todos', role: 'reads', path: REPOSITORY },
    { kind: 'table', name: 'todos', role: 'writes', path: REPOSITORY },
  ]);
});

test('where links virtual and temporary tables', () => {
  const map = buildSystemMap(
    new Map([
      [
        MIGRATION,
        'export const up = `CREATE VIRTUAL TABLE IF NOT EXISTS todo_fts USING fts5(body); CREATE TEMP TABLE todo_scratch (id TEXT)`;',
      ],
      [
        REPOSITORY,
        'export const index = `INSERT INTO todo_fts (body) VALUES (?)`;\nexport const scratch = `SELECT id FROM todo_scratch`;',
      ],
    ])
  );
  expect(where(map, 'todo_fts')).toEqual([
    { kind: 'table', name: 'todo_fts', role: 'writes', path: REPOSITORY },
  ]);
  expect(where(map, 'todo_scratch')).toEqual([
    { kind: 'table', name: 'todo_scratch', role: 'reads', path: REPOSITORY },
  ]);
});

test('where separates the definition of an operation from its callers', () => {
  expect(formatWhere(where(fixture(), 'todo.remove'))).toBe(
    [`op todo.remove  defines  ${OPERATIONS}`, `op todo.remove  uses  ${CONTROLS}`].join('\n')
  );
});

test('where pairs RPC handlers with callers and event emitters with listeners', () => {
  const map = fixture();
  expect(where(map, 'todo.list').map((link) => [link.role, link.path])).toEqual([
    ['calls', CONTROLS],
    ['handles', HANDLER],
  ]);
  expect(where(map, 'todo.removed').map((link) => [link.role, link.path])).toEqual([
    ['emits', OPERATIONS],
    ['listens', LISTENER],
  ]);
});

test('buildSystemMap resolves relative, .js and package imports', () => {
  const map = fixture();
  expect([...(map.imports.get(OPERATIONS) ?? [])].sort()).toEqual([REPOSITORY, NAMES].sort());
  expect([...(map.importers.get(NAMES) ?? [])]).toEqual([OPERATIONS]);
});

test('impact names the files outside the plan that share an owned name', () => {
  const [item] = impact(fixture(), [OPERATIONS]);
  expect(item.known).toBe(true);
  expect(item.owned.map(({ link, peers }) => [link.name, peers.map((peer) => peer.path)])).toEqual([
    ['todo.removed', [LISTENER]],
    ['todo.remove', [CONTROLS]],
  ]);
  expect(item.nearbyWrites).toEqual(['todos']);
});

test('impact leaves out peers that are already in the plan', () => {
  const [item] = impact(fixture(), [REPOSITORY, READER, OPERATIONS]);
  expect(item.importers).toEqual([]);
  expect(item.owned).toEqual([
    { link: { kind: 'table', name: 'todos', role: 'writes', path: REPOSITORY }, peers: [] },
  ]);
});

test('formatImpact counts each outside file once and flags unknown paths', () => {
  const text = formatImpact(impact(fixture(), [REPOSITORY, 'packages/daemon/src/missing.ts']));
  expect(text).toContain('imported by 1 files outside the plan: daemon/lib/todo 1');
  expect(text).toContain(`    reads  ${READER}`);
  expect(text).toContain('packages/daemon/src/missing.ts  (not a mapped source file)');
  expect(text.endsWith('1 files outside the plan are linked by name')).toBe(true);
});
