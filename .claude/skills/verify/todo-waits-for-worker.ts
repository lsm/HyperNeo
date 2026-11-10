import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { neoFolder } from '../../../packages/daemon/src/lib/neo/folder.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const dir of ['workspace', 'evidence']) mkdirSync(join(run, dir), { recursive: true });

const root = 'neo:10000000-0000-4000-8000-000000009720';
const worker = '10000000-0000-4000-8000-000000009721';
const ref = { adapter: 'hyperneo', id: worker };
const at = Date.now() - 60_000;
const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
assert.notEqual(app.server.port, 8399);
const evidence: Record<string, unknown> = { daemonPort: app.server.port };
const session = (id: string, title: string, workspacePath: string) =>
  app.db.createSession({
    id,
    title,
    workspacePath,
    createdAt: new Date(at).toISOString(),
    lastActiveAt: new Date(at).toISOString(),
    status: 'active',
    config: { queryMode: 'manual' },
    metadata: {
      messageCount: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
    },
  });
const refresh = async () => {
  const job = app.jobQueue.enqueue({
    queue: 'neo.work.driver.refresh',
    payload: { scope: 'neo' },
    runAt: Date.now(),
  });
  const deadline = performance.now() + 25000;
  while (performance.now() < deadline) {
    const current = app.jobQueue.getJob(job.id)!;
    if (current.status === 'completed') return;
    assert.notEqual(current.status, 'dead', JSON.stringify(current));
    await new Promise((done) => setTimeout(done, 20));
  }
  throw new Error('driver refresh did not complete');
};
const stallNotice = async (db: ReturnType<typeof app.db.getDatabase>) => {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  for (const { name } of tables) {
    const columns = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[];
    for (const column of columns) {
      const row = db
        .prepare(`SELECT 1 AS hit FROM "${name}" WHERE "${column.name}" LIKE '%is stalled%' LIMIT 1`)
        .get();
      if (row) return { table: name, column: column.name };
    }
  }
  throw new Error('no stall notice was delivered');
};
try {
  const db = app.db.getDatabase();
  await session(root, 'Synthetic Neo', neoFolder());
  await session(worker, 'Synthetic worker', join(run, 'workspace'));
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  store.openAsk({
    id: 'ask',
    title: 'Busy worker',
    request: 'Todos for one busy HyperNeo worker',
    sessionId: root,
    projectId: null,
    originMessageId: null,
    createdAt: at,
  });
  for (const id of ['low', 'high', 'stuck'])
    store.addTodo(
      id,
      'ask',
      {
        approvedAt: at,
        dependsOn: [],
        title: id,
        doneWhen: 'Done',
        check: null,
        instruction: `Do ${id}`,
        named: null,
      },
      at
    );
  store.updateTodo(store.getTodo('high')!, { priority: 'high' }, at);
  const worksOn = (status: string) =>
    db
      .prepare('UPDATE sessions SET processing_state = ? WHERE id = ?')
      .run(JSON.stringify({ status }), worker);
  const registry = app.sessionManager.getOperationRegistry();
  const neo = { source: 'internal', role: 'neo', sessionId: root } as const;
  const send = (todoId: string) =>
    invokeOperation(registry, 'work.send', { ref, message: `Do ${todoId}`, todoId }, neo);
  const sent = (id: string) => sessions.inputs.list(id).map((row) => row.message);
  const todo = (id: string) => store.getTodo(id)!;
  const finish = (id: string) => store.updateTodo(todo(id), { state: 'done', finishedAt: Date.now() }, Date.now());

  worksOn('processing');
  const replies = [await send('low'), await send('high')];
  for (const reply of replies) assert.match(JSON.stringify(reply), /"reason":"worker_busy"/);
  await refresh();
  for (const id of ['low', 'high']) {
    assert.deepEqual(sent(id), [], 'a busy worker gets no todo send');
    assert.equal(todo(id).state, 'todo');
    assert.equal(todo(id).startedAt, null);
    assert.match(todo(id).reason ?? '', /^Waiting for worker hyperneo:.*outside a todo\.$/);
  }
  evidence.whileBusy = { replies, reason: todo('low').reason };

  const stuck = await send('stuck');
  assert.match(JSON.stringify(stuck), /"reason":"worker_busy"/);
  await refresh();
  sessions.recordNudge('stuck', { since: Date.now() - 61 * 60_000, nudges: 2 });
  await refresh();
  assert.equal(sessions.readNudge('stuck')?.nudges, 3, 'the stall step ran');
  assert.equal(todo('stuck').state, 'todo', 'it keeps waiting after the notice');
  evidence.stall = await stallNotice(db);
  store.updateTodo(todo('stuck'), { state: 'removed', finishedAt: Date.now() }, Date.now());

  worksOn('idle');
  await refresh();
  assert.equal(sent('high').length, 1, 'higher priority goes first');
  assert.equal(todo('high').state, 'doing');
  assert.deepEqual(sent('low'), [], 'one todo per turn');

  worksOn('processing');
  await refresh();
  assert.match(todo('low').reason ?? '', /working on "high"/);
  assert.deepEqual(sent('low'), []);
  finish('high');
  worksOn('idle');
  await refresh();
  assert.equal(sent('low').length, 1, 'the next goes when the worker is free');
  assert.equal(todo('low').reason, null);
  evidence.released = { high: sent('high'), low: sent('low') };
  evidence.verified = true;
  console.log(
    'VERIFIED: todos for a busy worker stay todo with a reason, go one per turn by priority, and a long wait tells Neo'
  );
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
