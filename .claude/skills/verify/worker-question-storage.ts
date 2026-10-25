import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { createNeoWorkerQuestionWriter } from '../../../packages/daemon/src/lib/neo/question-operations.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'bin'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n');
chmodSync(join(run, 'bin/gh'), 0o700);
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const config = getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') });
let app = await createDaemonApp({ config, verbose: false });
const receipts: unknown[] = [];
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'rpc.ts'), name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: String(app.server.port) }, stdout: 'pipe', stderr: 'inherit',
  });
  const result = JSON.parse(await new Response(child.stdout).text());
  assert.equal(await child.exited, 0);
  assert(!result.reply.error, JSON.stringify(result));
  receipts.push({ name, result });
  return result.reply.value ?? result.reply;
}
try {
  await app.spaceRuntimeService.ready();
  const db = app.db.getDatabase();
  for (const id of ['synthetic-neo', 'synthetic-worker'])
    db.prepare(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, ?, ?, '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z', 'active', '{}', '{}')`).run(id, id, join(run, 'workspace'));
  new NeoRepository(db).reserveBinding({ sessionId: 'synthetic-neo', projectId: null, kind: 'neo' });
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  store.openAsk({ id: 'synthetic-ask', sessionId: 'synthetic-neo', projectId: null, originMessageId: null, title: 'Synthetic plan', request: 'Choose a deployment', createdAt: 1 });
  const ref = { adapter: 'hyperneo', id: 'synthetic-worker' };
  const source = { ...ref, name: 'Synthetic worker', label: 'HyperNeo · Synthetic worker', provider: 'Synthetic', link: '/session/synthetic-worker' };
  const write = createNeoWorkerQuestionWriter(store, sessions, () => 'zh-Hans', async () => source);
  const todo = store.addTodo('synthetic-todo', 'synthetic-ask', { title: 'Deploy', doneWhen: 'Deployed', instruction: null, check: null, named: null }, 1);
  sessions.bind(todo.id, ref, 2);
  store.updateTodo(todo, { state: 'doing', startedAt: 2 }, 2);
  const report = { todoId: todo.id, kind: 'blocked', title: '选择部署环境', options: ['部署到测试环境', '部署到生产环境'], language: 'zh-Hans', report: 'Original unmodified worker report' };
  const first = await write(ref, report);
  assert(first.ok, JSON.stringify(first));
  receipts.push({ stored: first });
  const repeats = await Promise.all(Array.from({ length: 10 }, () => write(ref, report)));
  assert(repeats.every((r) => r.ok && r.question.id === first.question.id));
  const refused = await write({ ...ref, id: 'stranger' }, report);
  assert(!refused.ok);
  const read = await rpc('neo.question.get', { questionId: first.question.id });
  assert.equal(read.question.text, report.title);
  assert.deepEqual(read.question.sourceSession, source);
  assert.equal(read.question.document, report.report);
  const distinct = await rpc('neo.question.ask', {
    askId: todo.askId, todoId: todo.id, kind: 'reply', text: 'A distinct new question',
  });
  assert.equal(distinct.ok, false, 'a distinct question must be refused, never silently replaced by the old card');
  assert.match(distinct.reason, /^todo_question_open:/);
  const snapshot = await rpc('neo.snapshot', {});
  const entry = snapshot.todoAsks.find((e: { ask: { id: string } }) => e.ask.id === todo.askId);
  assert(entry, JSON.stringify(snapshot));
  assert.equal(entry.questions.filter((q: { todoId: string; state: string }) => q.todoId === todo.id && q.state === 'open').length, 1);
  assert.equal(entry.todos.find((t: { id: string }) => t.id === todo.id).blockedBy, 'needs-human');
  await app.cleanup();
  app = await createDaemonApp({ config, verbose: false });
  await app.spaceRuntimeService.ready();
  const restored = new NeoAskTodoRepository(app.db.getDatabase());
  restored.updateTodo(restored.getTodo(todo.id)!, { state: 'doing', report: 'Routine activity' }, 9);
  await restored.recompute(restored.getTodo(todo.id)!, {}, 10, { state: 'done', evidence: 'Routine completion' }, async () => {});
  assert.equal(restored.getTodo(todo.id)?.blockedBy, 'needs-human');
  assert.equal(restored.getTodo(todo.id)?.state, 'blocked');
  const after = await rpc('neo.question.get', { questionId: first.question.id });
  assert.equal(after.question.state, 'open');
  assert.deepEqual(after.question.sourceSession, source);
  const hold = restored.getTodo(todo.id);
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ receipts, refused, repeats: repeats.length, hold, restartRetained: true }, null, 2));
  console.log('PASS: Chinese card and validated source visible over RPC; ten repeats share one card; restart and routine completion retain needs-human hold');
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ stopped: true }));
}
