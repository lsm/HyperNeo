import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createTestDb } from '../../../helpers/database.ts';
import {
  observeNeoSnapshotQueries,
  seedNeoSnapshotFixture,
} from '../../../helpers/neo-snapshot-fixture.ts';

let db: Awaited<ReturnType<typeof createTestDb>>;
let service: NeoService;
let registry: ReturnType<typeof createOperationRegistry>;
let observer: ReturnType<typeof observeNeoSnapshotQueries>;
const caller = { source: 'rpc' as const, principal: 'local' as const };

beforeEach(async () => {
  db = await createTestDb();
  seedNeoSnapshotFixture(db.getDatabase());
  service = new NeoService(
    db,
    { getOperationRegistry: () => registry } as unknown as SessionManager,
    { event: mock(() => {}) } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
  registry = createOperationRegistry(createNeoOperations(service));
  observer = observeNeoSnapshotQueries(db.getDatabase());
});
afterEach(() => {
  observer.restore();
  service.dispose();
  db.close();
});
const snapshot = (input: unknown = {}) => invokeOperation(registry, 'neo.snapshot', input, caller);
function read(outcome: Awaited<ReturnType<typeof snapshot>>): NeoSnapshot {
  expect(outcome.kind).toBe('completed');
  if (outcome.kind !== 'completed') throw new Error(outcome.message);
  return outcome.value as NeoSnapshot & { todoAsks: NonNullable<NeoSnapshot['todoAsks']> };
}

test('a 231-todo snapshot retains its rows using three child/link reads', async () => {
  const value = read(await snapshot());
  const todos = value.todoAsks.flatMap((entry) => entry.todos);
  expect(value.todoAsks).toHaveLength(50);
  expect(todos).toHaveLength(231);
  expect(value.todoAsks.flatMap((entry) => entry.questions)).toHaveLength(66);
  expect(todos.find((todo) => todo.id === 'todo-230')).toMatchObject({
    title: 'Synthetic todo 230',
    link: '/session/synthetic-230',
    instruction: 'x'.repeat(1155),
  });
  expect(observer.queries.filter((query) => query.child)).toHaveLength(3);
});

test('overlapping snapshots build once and the next read sees later edits', async () => {
  const values = (await Promise.all(Array.from({ length: 8 }, () => snapshot()))).map(read);
  expect(
    values.every((value) => value.todoAsks.flatMap((entry) => entry.todos).length === 231)
  ).toBe(true);
  expect(values.every((value) => JSON.stringify(value) === JSON.stringify(values[0]))).toBe(true);
  expect(observer.queries.filter((query) => query.build)).toHaveLength(1);
  expect(observer.queries.filter((query) => query.child)).toHaveLength(3);
  db.getDatabase()
    .prepare("UPDATE neo_todos SET title='Changed after burst' WHERE id='todo-230'")
    .run();
  observer.reset();
  const next = read(await snapshot());
  expect(
    next.todoAsks.flatMap((entry) => entry.todos).find((todo) => todo.id === 'todo-230')?.title
  ).toBe('Changed after burst');
  expect(observer.queries.filter((query) => query.build)).toHaveLength(1);
});

test('different scopes stay distinct and revision responses remain per request', async () => {
  for (const id of ['a', 'b'])
    service.repo.saveProject({ id, title: id, summary: '', context: id }, 0);
  const sql = db.getDatabase();
  sql.prepare("UPDATE neo_asks SET project_id='a' WHERE id='ask-18'").run();
  sql.prepare("UPDATE neo_asks SET project_id='b' WHERE id='ask-17'").run();
  const [a, b, all] = (
    await Promise.all([snapshot({ projectId: 'a' }), snapshot({ projectId: 'b' }), snapshot()])
  ).map(read);
  expect(a.todoAsks.map((entry) => entry.ask.id)).toEqual(['ask-18']);
  expect(b.todoAsks.map((entry) => entry.ask.id)).toEqual(['ask-17']);
  expect(all.todoAsks).toHaveLength(50);
  observer.reset();
  const [same, full] = await Promise.all([snapshot({ sinceRev: all.rev }), snapshot()]);
  expect(same).toMatchObject({ kind: 'completed', value: { unchanged: true, rev: all.rev } });
  expect(read(full).todoAsks).toHaveLength(50);
  expect(observer.queries.filter((query) => query.build)).toHaveLength(1);
});

test('a failed shared build reports failure and a later request can recover', async () => {
  const sql = db.getDatabase(),
    original = sql.prepare;
  let attempts = 0;
  sql.prepare = ((...args: Parameters<typeof original>) => {
    if (args[0].includes('FROM neo_asks WHERE (?1')) {
      attempts++;
      throw new Error('Synthetic snapshot read failure');
    }
    return original.apply(sql, args);
  }) as typeof original;
  try {
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => snapshot()));
    expect(
      outcomes.every(
        (outcome) =>
          outcome.kind === 'failed' && outcome.message.includes('Synthetic snapshot read failure')
      )
    ).toBe(true);
    expect(attempts).toBe(1);
  } finally {
    sql.prepare = original;
  }
  expect(read(await snapshot()).todoAsks).toHaveLength(50);
});
