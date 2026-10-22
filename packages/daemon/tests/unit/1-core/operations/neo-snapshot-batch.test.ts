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
import { z } from 'zod';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';
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
  expect(observer.queries.filter((query) => query.child)).toHaveLength(9);
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

test('RPC sharing does not mix the MCP view or bypass caller admission', async () => {
  const root = 'neo:synthetic';
  db.createSession(createTestSession(root));
  service.repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  service.repo.saveProject(
    { id: 'private', title: 'Synthetic', summary: '', context: 'RPC context' },
    0
  );
  const [rpc, mcp, refused] = await Promise.all([
    snapshot(),
    invokeOperation(registry, 'neo.snapshot', {}, { source: 'mcp', role: 'neo', sessionId: root }),
    invokeOperation(
      registry,
      'neo.snapshot',
      {},
      { source: 'mcp', role: 'worker', sessionId: 'not-root' }
    ),
  ]);
  expect(read(rpc).projects[0].context).toBe('RPC context');
  expect(read(mcp).projects[0].context).toBe('');
  expect(read(rpc).sessionMessages).toEqual([]);
  expect(read(mcp).sessionMessages).toBeUndefined();
  expect(refused).toMatchObject({ kind: 'completed', value: { ok: false } });
});

test('batched reads retain scope, row order and missing-link behavior', async () => {
  expect(service.todos.listTodosForAsks(['ask-18']).map((todo) => todo.id)).toEqual([
    'todo-0',
    'todo-50',
    'todo-100',
    'todo-150',
    'todo-200',
  ]);
  expect(service.todos.listQuestionsForAsks(['ask-18']).map((question) => question.id)).toEqual([
    'question-0',
    'question-50',
  ]);
  expect(service.todos.listTodosForAsks([])).toEqual([]);
  expect(service.todos.listQuestionsForAsks(['missing'])).toEqual([]);
  expect([...service.todoSessions.readLinksForTodos(['todo-0', 'missing'])]).toEqual([
    ['todo-0', { link: '/session/synthetic-0', remoteLink: null, worker: null }],
  ]);
  service.todos.addTodo(
    'without-session',
    'ask-18',
    {
      title: 'No session',
      doneWhen: 'Synthetic completion',
      check: null,
      named: null,
      instruction: null,
    },
    10000
  );
  expect(
    read(await snapshot())
      .todoAsks.flatMap((entry) => entry.todos)
      .find((todo) => todo.id === 'without-session')
  ).toMatchObject({ link: null, remoteLink: null });
});

test.each([3, 4, 20, 21])(
  'RPC keeps up to twenty done todos while MCP keeps three without losing asks (%i done)',
  async (doneCount) => {
    const root = 'neo:done-threshold';
    db.createSession(createTestSession(root));
    service.repo.reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
    service.repo.saveProject({ id: 'threshold', title: 'Synthetic', summary: '', context: '' }, 0);
    for (let i = 0; i < 10; i++) {
      const ask = service.todos.openAsk({
        id: `threshold-${i}`,
        projectId: 'threshold',
        sessionId: root,
        originMessageId: null,
        title: `Synthetic ask ${i}`,
        request: 'Synthetic request',
        createdAt: i,
      });
      for (let j = 0; j < doneCount; j++) {
        const todo = service.todos.addTodo(
          `threshold-${i}-${j}`,
          ask.id,
          {
            title: 'Synthetic todo',
            doneWhen: 'Synthetic completion',
            check: null,
            named: null,
            instruction: null,
          },
          i
        );
        service.todos.updateTodo(todo, { state: 'done', report: 'x'.repeat(500) }, i);
      }
      if (i === 0) service.todos.settleAsk(ask, 'done', 'Synthetic outcome', i);
    }
    const [rpc, mcp] = (
      await Promise.all([
        snapshot({ projectId: 'threshold' }),
        invokeOperation(
          registry,
          'neo.snapshot',
          { projectId: 'threshold' },
          { source: 'mcp', role: 'neo', sessionId: root }
        ),
      ])
    ).map(read);
    expect(mcp.todoAsks).toHaveLength(10);
    expect(mcp.todoAsks.every((entry) => entry.doneCount === doneCount)).toBe(true);
    expect(
      mcp.todoAsks.every((entry) => entry.todos.length === (doneCount <= 3 ? doneCount : 0))
    ).toBe(true);
    expect(mcp.trimmed).toBeUndefined();
    expect(mcp.omitted).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(mcp), 'utf8')).toBeLessThan(40_000);
    expect(rpc.todoAsks).toHaveLength(10);
    expect(rpc.todoAsks.every((entry) => entry.doneCount === doneCount)).toBe(true);
    expect(
      rpc.todoAsks.every((entry) => entry.todos.length === (doneCount <= 20 ? doneCount : 0))
    ).toBe(true);
  }
);

test('worker identity follows the adapter and current record, including notices after rename', async () => {
  const ref = { adapter: 'codex-desktop', id: 'thread-1' };
  let title = 'Claude something';
  let found = true;
  const status = defineOperation({
    name: 'work.status',
    inputSchema: z.object({ ref: z.unknown() }),
    resultSchema: z.unknown(),
    policy: { safetyClass: 'read' },
    execute: async () =>
      found ? { ok: true, value: { ref, title } } : { ok: false, reason: 'not_found' },
  });
  registry = createOperationRegistry([...createNeoOperations(service), status]);
  service.todoSessions.create('todo-230', { verb: 'send', ref });
  service.todoSessions.recordRef('todo-230', ref);
  service.sessionWatcher.sessionNotices = [
    { key: 'notice', ref, title: 'Creation-time cache', kind: 'needs_you', at: 1 },
  ];
  service.sessionWatcher.sessionNoticeGroups = [
    { id: 'group', at: 1, line: 'Historical line', notices: service.sessionNotices },
  ];
  const first = read(await snapshot());
  const worker = { ...ref, name: title, label: 'Codex · Claude something' };
  expect(
    first.todoAsks.flatMap((entry) => entry.todos).find((todo) => todo.id === 'todo-230')
  ).toMatchObject({ worker });
  expect(first.sessionNotices?.[0]).toMatchObject({ worker, title });
  expect(first.sessionNoticeGroups?.[0].line).toContain('Codex · Claude something');
  title = 'fullstack-renamed';
  const next = read(await snapshot({ sinceRev: first.rev }));
  expect(next).not.toHaveProperty('unchanged');
  expect(
    next.todoAsks.flatMap((entry) => entry.todos).find((todo) => todo.id === 'todo-230')
  ).toMatchObject({ worker: { ...ref, name: title, label: 'Codex · fullstack-renamed' } });
  expect(next.sessionNotices?.[0]).toMatchObject({ title });
  found = false;
  const removed = read(await snapshot());
  expect(removed.sessionNotices?.[0]).toMatchObject({
    title: ref.id,
    worker: { ...ref, name: null, label: 'Codex · thread-1' },
  });
  expect(
    removed.todoAsks.flatMap((entry) => entry.todos).find((todo) => todo.id === 'todo-230')
  ).toMatchObject({ worker: { ...ref, name: null, label: 'Codex · thread-1' } });
});
