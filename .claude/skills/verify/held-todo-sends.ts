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

const root = 'neo:10000000-0000-4000-8000-000000009710';
const worker = '10000000-0000-4000-8000-000000009711';
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
    request: 'Two todos for one busy HyperNeo worker',
    sessionId: root,
    projectId: null,
    originMessageId: null,
    createdAt: at,
  });
  for (const id of ['first', 'second']) {
    const todo = store.addTodo(
      id,
      'ask',
      { title: id, doneWhen: 'Done', check: null, instruction: `Do ${id}`, named: null },
      at
    );
    sessions.create(id, { verb: 'send', ref });
    sessions.recordRef(id, ref, at);
    store.updateTodo(todo, { state: 'doing', startedAt: at, report: `${id} report` }, at);
  }
  const worksOn = (status: string) =>
    db
      .prepare('UPDATE sessions SET processing_state = ? WHERE id = ?')
      .run(JSON.stringify({ status }), worker);
  const registry = app.sessionManager.getOperationRegistry();
  const neo = { source: 'internal', role: 'neo', sessionId: root } as const;
  const send = (purpose: Record<string, unknown>, message: string) =>
    invokeOperation(registry, 'work.send', { ref, message, ...purpose }, neo);
  const sent = (id: string) => sessions.inputs.list(id).map((row) => row.message);
  const waiting = () => sessions.held.nextPerWorker().map((held) => held.todoId);

  worksOn('processing');
  const replies = [
    await send({ todoId: 'first' }, 'First task'),
    await send({ todoId: 'second' }, 'Second task'),
  ];
  for (const reply of replies)
    assert.match(JSON.stringify(reply), /"delivered":false,"held":true/);
  assert.deepEqual([sent('first'), sent('second')], [[], []], 'a busy worker gets no todo send');
  const notice = await send({ notice: true }, 'A notice is not held');
  assert.match(JSON.stringify(notice), /"ok":true/);
  assert.doesNotMatch(JSON.stringify(notice), /"held"/);
  evidence.whileBusy = { replies, notice };

  await refresh();
  assert.deepEqual([sent('first'), sent('second')], [[], []], 'held through a tick while busy');

  worksOn('idle');
  await refresh();
  assert.equal(sent('first').length, 1, 'the first send goes when the turn ends');
  assert.match(sent('first')[0], /First task/);
  assert.deepEqual(sent('second'), [], 'one todo per turn');
  assert.deepEqual(waiting(), ['second']);

  worksOn('processing');
  await refresh();
  assert.deepEqual(sent('second'), [], 'the second waits for the first turn');
  worksOn('idle');
  await refresh();
  assert.equal(sent('second').length, 1);
  assert.deepEqual(waiting(), []);
  evidence.released = { first: sent('first'), second: sent('second') };
  evidence.verified = true;
  console.log(
    'VERIFIED: todo sends wait while the worker is busy and go one per turn; a notice is not held'
  );
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
