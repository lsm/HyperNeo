import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { WorkTurnRepository } from '../../../packages/daemon/src/storage/repositories/work-turn-repository.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import {
  createNeoOperations,
  createNeoService,
} from '../../../packages/daemon/tests/unit/helpers/neo-service.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type { NeoTodo } from '../../../packages/shared/src/types/neo-ask.ts';
import type { NeoWorkPr } from '../../../packages/shared/src/types/neo-snapshot.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'));
mkdirSync(join(run, 'workspace'));
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
globalThis.fetch = (() => {
  throw new Error('External HTTP disabled');
}) as typeof fetch;

const realNow = Date.now;
const at = Date.now();
const HOUR = 3_600_000;
let clock = at;
Date.now = () => clock;
const evidence: Record<string, unknown> = {};
const app = await createDaemonApp({
  config: {
    ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
    disableWorktrees: true,
  },
  verbose: false,
});
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  createSocket: createLocalSocket,
  url: `ws://127.0.0.1:${app.server.port}/ws`,
});
hub.registerTransport(transport);
const service = createNeoService(app.db, app.sessionManager, app.messageHub, app.internalEventBus);
try {
  assert.notEqual(app.server.port, 8399);
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  const root = 'neo:00000000-0000-4000-8000-000000001179';
  const db = app.db.getDatabase();
  await app.db.createSession({
    id: root,
    title: 'Synthetic Neo',
    workspacePath: join(run, 'workspace'),
    createdAt: new Date(at).toISOString(),
    lastActiveAt: new Date(at).toISOString(),
    status: 'active',
    config: { queryMode: 'manual' },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
  });
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const { todos, todoSessions } = service;
  const url = (n: number) => `https://github.com/example/work/pull/${n}`;
  const until = (...urls: string[]) => ({ pack: 'coding', kind: 'pr_merged', params: { urls } });
  const rows = new Map<string, NeoWorkPr>();
  const pr = (n: number, state: NeoWorkPr['state']) =>
    rows.set(url(n), { url: url(n), state, checks: 'none', review: 'none' });
  const calls: string[][] = [];
  let pending: ((urls: readonly string[]) => Promise<NeoWorkPr[] | null>) | undefined;
  Object.assign(service, {
    readPrs: async (urls: readonly string[]) => {
      calls.push([...urls]);
      return pending ? pending(urls) : urls.flatMap((key) => rows.get(key) ?? []);
    },
  });
  const original = app.sessionManager.getOperationRegistry();
  const neoOperations = createNeoOperations(service);
  const neoNames = new Set(neoOperations.map(({ name }) => name));
  const registry = createOperationRegistry([
    ...neoOperations,
    ...original.entries
      .filter(({ name }) => !neoNames.has(name))
      .map((entry) =>
        ['work.stop', 'work.status'].includes(entry.name)
          ? {
              ...entry,
              execute: async () => ({
                ok: true,
                value: { status: 'stopped', lastActivityAt: at, stopped: true },
              }),
            }
          : entry
      ),
  ]);
  app.sessionManager.setOperationRegistryProvider(() => registry);
  await transport.connect();

  const rpc = <T>(name: string, input: object) =>
    hub.request<T>('operation.invoke', { name, input });
  const askId = (id: string) => `ask-${id}`;
  const add = (id: string, check: NeoTodo['check'] = null) => {
    todos.openAsk({
      id: askId(id),
      sessionId: root,
      projectId: null,
      originMessageId: null,
      title: id,
      request: 'Synthetic work',
      createdAt: at,
    });
    return todos.addTodo(
      id,
      askId(id),
      {
        title: id,
        doneWhen: 'Observed',
        check,
        named: null,
        instruction: null,
        approvedAt: at,
      },
      at
    );
  };
  const read = async (id: string) => {
    const result = await rpc<{ entry: { todos: NeoTodo[] } }>('neo.ask.read', { askId: askId(id) });
    const todo = result.entry.todos.find((item) => item.id === id);
    assert(todo, id);
    return todo;
  };
  const hold = (id: string, fields: object = {}) =>
    rpc<{ ok: boolean; reason?: string }>('neo.todo.hold', {
      todoId: id,
      reason: `Hold ${id}`,
      ...fields,
    });
  const held = async (id: string, ...urls: string[]) => {
    add(id);
    assert.equal((await hold(id, { until: until(...urls) })).ok, true);
  };
  const refresh = () =>
    service.todoRunner.refresh((message, error) => {
      throw new Error(message, { cause: error });
    });
  const notices = (queue: string) =>
    (
      db
        .prepare(
          `SELECT json_extract(payload, '$.message.message.content') AS text
       FROM job_queue WHERE queue = ? AND json_extract(payload, '$.to.sessionId') = ?
       ORDER BY rowid`
        )
        .all(queue, root) as { text: string }[]
    ).map(({ text }) => text);
  const wake = async () => {
    await service.sweepPacks();
    await service.sweepPacks();
  };
  const edit = async (id: string) =>
    assert.equal(
      (await rpc<{ ok: boolean }>('neo.todo.edit', { todoId: id, title: `Edited ${id}` })).ok,
      true
    );

  await held('unstarted', url(1));
  pr(9, 'OPEN');
  const started = add('started', until(url(9)));
  const ref = { adapter: 'hyperneo', id: 'synthetic-worker' };
  todoSessions.create(started.id, { verb: 'send', ref });
  todoSessions.recordRef(started.id, ref, at);
  todos.updateTodo(started, { state: 'doing', startedAt: at }, at);
  const heldStarted = await hold(started.id, { until: until(url(2)) });
  assert.equal(heldStarted.ok, true, heldStarted.reason);
  pr(1, 'MERGED');
  pr(2, 'MERGED');
  clock++;
  await refresh();
  assert.equal(
    (await read('unstarted')).state,
    'todo',
    'a named merged PR releases an unstarted todo'
  );
  const released = await read('started');
  assert.equal(released.blockedBy, 'worker');
  assert.deepEqual(todoSessions.readRef('started'), ref);
  await refresh();
  assert.equal(
    (await read('started')).blockedBy,
    'worker',
    'the released worker still needs continuing'
  );
  const digests = notices('neo_notes').filter((text) => text.includes('hold was released'));
  assert.equal(digests.length, 2, 'one digest per release after two refreshes');
  assert(digests.some((text) => text.includes(url(1))));
  assert(digests.some((text) => text.includes(url(2)) && text.includes('continue')));
  evidence.release = { calls: [...calls], digests };

  await held('merge-missing', url(1), url(3));
  pr(4, 'CLOSED');
  await held('closed-missing', url(4), url(3));
  await held('closed', url(4));
  await held('unrelated', url(5));
  const reporter = { adapter: 'hyperneo', id: 'synthetic-reporter' };
  todoSessions.create('unrelated', { verb: 'adopt', ref: reporter, boundAt: at - 1 });
  todoSessions.recordRef('unrelated', reporter, at - 1);
  const foreign = url(10);
  pr(10, 'MERGED');
  rows.get(foreign)!.createdAt = at;
  await new WorkTurnRepository(db).record(reporter, [
    {
      id: 'reported',
      startedAt: at,
      endedAt: at + 1,
      ended: 'done',
      inputs: [],
      urls: [foreign],
      finalUrls: [foreign],
      complete: true,
      cursor: JSON.stringify({ seq: 1, consumed: 1 }),
    },
  ]);
  pr(5, 'OPEN');
  add('completion', until(url(1)));
  assert.equal((await hold('completion', { until: until(url(5)) })).ok, true);
  calls.length = 0;
  await refresh();
  for (const id of ['merge-missing', 'closed-missing', 'closed', 'unrelated'])
    assert.equal((await read(id)).blockedBy, 'held', id);
  assert.equal((await read('completion')).state, 'done');
  assert(
    calls.some((urls) => urls.length === 1 && urls[0] === foreign),
    'the todo reports another merged PR'
  );
  assert(
    calls.some((urls) => urls.length === 1 && urls[0] === url(5)),
    'only the named PR is read for the hold'
  );
  assert(!calls.some((urls) => urls.includes(url(5)) && urls.includes(foreign)));
  await wake();
  const closed = () => notices('mailbox').filter((text) => text.includes('(closed)'));
  assert.equal(closed().length, 1);
  assert(closed()[0].includes(url(4)));
  assert(!notices('mailbox').some((text) => text.includes('-missing)')));
  await edit('closed');
  await wake();
  assert.equal(closed().length, 1, 'a title edit does not repeat this rung');
  clock += HOUR;
  await wake();
  assert.equal(closed().length, 2, 'one wake on the next rung');
  assert.equal(closed()[0], closed()[1], 'hold wake text is stable');
  evidence.failed = closed();

  await held('read-failed', url(6));
  const beforeFailure = await read('read-failed');
  pending = async () => null;
  await refresh();
  assert.deepEqual(await read('read-failed'), beforeFailure);
  pending = undefined;

  await held('race', url(7));
  pr(7, 'MERGED');
  const began = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<NeoWorkPr[]>();
  pending = async (urls) => {
    if (!urls.includes(url(7))) return urls.flatMap((key) => rows.get(key) ?? []);
    began.resolve();
    return finish.promise;
  };
  const racing = refresh();
  await Promise.race([
    began.promise,
    racing.then(() => {
      throw new Error('Expected a pending PR read');
    }),
  ]);
  const rehold = await hold('race', { reason: 'Replacement hold', until: until(url(8)) });
  finish.resolve([rows.get(url(7))!]);
  await racing;
  pending = undefined;
  assert.equal(rehold.ok, true);
  assert.equal((await read('race')).blockedReason, 'Replacement hold');
  evidence.pendingReadFenced = true;

  add('invalid');
  for (const input of [
    { until: until() },
    { until: { ...until(url(1)), kind: 'unknown' } },
    { until: until('not a pull request') },
  ])
    assert.match((await hold('invalid', input)).reason ?? '', /^unsupported_until:/);
  for (const input of [
    { decision: true, until: until(url(1)) },
    { decision: true, reviewAt: clock + HOUR },
    { reviewAt: clock - 1 },
    { reviewAt: clock + 31 * 24 * HOUR },
  ])
    assert.equal((await hold('invalid', input)).ok, false);
  assert.equal((await read('invalid')).state, 'todo');
  assert.equal(todos.listQuestions(askId('invalid')).length, 0);
  const reviewAt = clock + HOUR;
  assert.equal((await hold('invalid', { reviewAt })).ok, true);
  const review = () => notices('mailbox').filter((text) => text.includes('(invalid)'));
  clock = reviewAt - 1;
  await wake();
  assert.equal(review().length, 0);
  clock++;
  await wake();
  assert.equal(review().length, 1, 'the hold wakes Neo at its explicit review time');
  evidence.validation = true;

  add('legacy');
  db.exec(
    "UPDATE neo_todos SET state = 'blocked', blocked_by = 'held', blocked_reason = 'Legacy hold' WHERE id = 'legacy'"
  );
  db.exec(
    "ALTER TABLE neo_todos DROP COLUMN hold_json; DELETE FROM migration_markers WHERE key = 'migration_537'"
  );
  const migrated = clock;
  runMigrations(db, () => {});
  clock = migrated + 24 * HOUR - 1;
  runMigrations(db, () => {
    throw new Error('Already-applied migrations must not run again');
  });
  await edit('legacy');
  const legacy = () => notices('mailbox').filter((text) => text.includes('(legacy)'));
  await wake();
  assert.equal(legacy().length, 0);
  clock++;
  await wake();
  assert.equal(legacy().length, 1, 'a migrated hold reaches Neo 24 hours after migration');
  assert(legacy()[0].includes('Legacy hold'));
  await edit('legacy');
  await wake();
  assert.equal(legacy().length, 1);
  clock += HOUR;
  await wake();
  assert.equal(legacy().length, 2);
  evidence.legacy = legacy();
  console.log(`PASS: ${Object.keys(evidence).length} scenarios, ${digests.length} release digests`);
} catch (error) {
  evidence.error = String(error);
  throw error;
} finally {
  await transport.close();
  await service.dispose();
  await app.cleanup();
  Date.now = realNow;
  writeFileSync(join(run, 'evidence/todo-hold-waits.json'), JSON.stringify(evidence, null, 2));
}
