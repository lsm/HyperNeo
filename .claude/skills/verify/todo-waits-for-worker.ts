import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type { NeoSnapshot } from '../../../packages/shared/src/types/neo-snapshot.ts';
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
for (const dir of ['workspace', 'evidence', 'bin']) mkdirSync(join(run, dir), { recursive: true });
const gh = join(run, 'bin/gh');
copyFileSync(new URL('./github-ledger-gh.ts', import.meta.url), gh);
chmodSync(gh, 0o700);

const root = 'neo:10000000-0000-4000-8000-000000009720';
const worker = '10000000-0000-4000-8000-000000009721';
const ref = { adapter: 'hyperneo', id: worker };
const at = Date.now() - 60_000;
const pr = 'https://github.com/synthetic/ledger/pull/7';
writeFileSync(join(run, 'fixture.json'), JSON.stringify({ phase: 'baseline', scenario: 'head', now: at }));
const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
assert.notEqual(app.server.port, 8399);
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  createSocket: createLocalSocket,
  url: `ws://127.0.0.1:${app.server.port}/ws`,
});
hub.registerTransport(transport);
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
  const assign = (todoId: string) => sessions.write('queueOn', todoId, ref, `Do ${todoId}`);
  const sent = (id: string) => sessions.inputs.list(id).map((row) => row.message);
  const todo = (id: string) => store.getTodo(id)!;
  const finish = (id: string) => store.updateTodo(todo(id), { state: 'done', finishedAt: Date.now() }, Date.now());

  await invokeOperation(registry, 'work.status', { ref }, neo);
  worksOn('processing');
  await assign('low');
  await assign('high');
  await refresh();
  for (const id of ['low', 'high']) {
    assert.deepEqual(sent(id), [], 'a busy worker gets no todo send');
    assert.equal(todo(id).state, 'todo');
    assert.equal(todo(id).startedAt, null);
    assert.match(todo(id).reason ?? '', /^Waiting for worker hyperneo:.*outside a todo\.$/);
  }
  evidence.whileBusy = { assigned: ['low', 'high'], reason: todo('low').reason };

  assert.equal(await assign('stuck'), 'instruction');
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
  await transport.connect();
  const queueItem = async (id: string) => {
    const snapshot = await hub.request<NeoSnapshot>('operation.invoke', { name: 'neo.snapshot', input: {} });
    const item = snapshot.humanQueue?.items.find((item) => 'todoId' in item && item.todoId === id);
    assert(item && 'todoId' in item, id);
    return item;
  };
  assert.equal((await queueItem('high')).step, 'working');
  assert.equal((await queueItem('low')).waitingOn, 'queue');
  worksOn('queued');
  await refresh();
  const queuedWorker = await queueItem('high');
  assert.equal(queuedWorker.owner, 'worker');
  assert.equal(queuedWorker.step, 'waiting');
  assert.equal(queuedWorker.waitingOn, 'queue');

  store.updateTodo(todo('high'), { check: { pack: 'coding', kind: 'pr_merged', params: { urls: [pr] } } }, Date.now());
  db.prepare(`INSERT INTO pack_coding_pr_ledger
    (repo, number, title, branch, head, state, state_since, read_at)
    VALUES ('synthetic/ledger', 7, 'Synthetic PR', 'work', ?, 'waiting_ci', ?, ?)`).run('a'.repeat(40), at, at);
  worksOn('idle');
  await refresh();
  const reserved = todo('low').reason;
  assert.equal(reserved, `Waiting for worker hyperneo:${worker}, which is idle but kept by "high" while ${pr} is open.`);
  const review = await queueItem('high');
  assert.equal(review.step, 'waiting');
  assert.equal(review.waitingOn, 'review');
  const reservedWakes = () =>
    (db.prepare(`SELECT json_extract(payload, '$.message.message.content') AS text
      FROM job_queue WHERE queue = 'mailbox' AND json_extract(payload, '$.to.sessionId') = ?
        AND instr(payload, 'idle but kept by') > 0 ORDER BY rowid`).all(root) as { text: string }[])
      .map(({ text }) => text);
  assert.deepEqual(reservedWakes(), []);
  sessions.recordNudge('low', { since: Date.now() - 61 * 60_000, nudges: 2 });
  await refresh();
  await refresh();
  const wakes = reservedWakes();
  assert.equal(wakes.length, 1);
  assert.match(wakes[0], /add a replacement todo.*then remove this todo with replacedBy/);
  evidence.reservation = { reserved, queuedWorker, review, wakes };

  finish('high');
  worksOn('idle');
  await refresh();
  assert.equal(sent('low').length, 1, 'the next goes when the worker is free');
  assert.equal(todo('low').reason, null);
  evidence.released = { high: sent('high'), low: sent('low') };
  evidence.verified = true;
  console.log(
    'VERIFIED: worker waits preserve priority, the Inbox RPC distinguishes working and waiting, and an idle reservation wakes Neo once'
  );
} finally {
  await transport.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
