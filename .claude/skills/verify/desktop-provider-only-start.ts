import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const folder = join(run, 'project');
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(folder, { recursive: true });
assert.equal(spawnSync('git', ['init', '-q', '--initial-branch=dev', folder]).status, 0);
const evidence: unknown[] = [];
const app = await createDaemonApp({
  config: {
    ...getConfig({
      port: 0,
      host: '127.0.0.1',
      dbPath: join(run, 'data/daemon.db'),
      workspaceRoot: folder,
    }),
    disableWorktrees: true,
  },
  verbose: false,
});
try {
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase();
  const store = new NeoAskTodoRepository(db);
  store.openAsk({
    id: 'synthetic-ask',
    projectId: null,
    sessionId: 'synthetic-neo',
    originMessageId: null,
    title: 'Synthetic',
    request: 'Synthetic',
    createdAt: 1,
  });
  const todo = {
    title: 'Desktop',
    doneWhen: 'Synthetic',
    check: null,
    instruction: 'Synthetic',
    named: null,
  };
  store.addTodo('todo-desktop', 'synthetic-ask', todo, 1);
  const sessions = () =>
    (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
  const before = sessions();
  const input = {
    adapter: 'hyperneo',
    place: { machine: hostname(), folder, name: 'Synthetic' },
    title: 'Synthetic desktop worker',
    message: 'Synthetic instruction',
    todoId: 'todo-desktop',
    provider: 'glm',
  };
  for (const caller of [
    {
      source: 'internal',
      sessionId: 'synthetic-neo',
      role: 'neo',
      workerTemplate: 'worker.desktop',
    },
    { source: 'internal', sessionId: 'synthetic-neo', role: 'neo' },
  ] as const) {
    const outcome = await invokeOperation(
      app.sessionManager.getOperationRegistry(),
      'work.start',
      input,
      caller
    );
    evidence.push({ caller, input, outcome });
    assert.equal(outcome.kind, 'completed', JSON.stringify(outcome));
    const value = (outcome as { value: { ok: boolean; reason?: string; detail?: string } }).value;
    assert.deepEqual([value.ok, value.reason], [false, 'identity_required'], JSON.stringify(value));
    assert.match(String(value.detail), /missing: model, effort/);
  }
  assert.equal(sessions(), before, 'A refused start created a session');
  evidence.push({ sessionsBefore: before, sessionsAfter: sessions() });
  console.log(
    'PASS: a Neo desktop-template start naming only a provider is refused identity_required before any session exists.'
  );
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  await app.cleanup();
}
