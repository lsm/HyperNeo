import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
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
  await write(ref, report);
  const initial = await rpc('neo.question.get', { questionId: first.question.id });
  assert.equal(initial.answerDelivery?.length, 1, 'the worker card must expose one durable answer route');
  assert.equal(initial.answerDelivery[0].state, 'waiting');
  const manual = await rpc('neo.question.ask', {
    askId: todo.askId, todoId: todo.id, sourceSession: ref,
    kind: 'reply', text: 'A later manual clarification', replaces: first.question.id,
  });
  assert.equal(manual.ok, true, JSON.stringify(manual));
  const beforeRestart = await rpc('neo.question.get', { questionId: manual.question.id });
  assert.deepEqual(beforeRestart.answerDelivery, []);
  await app.cleanup();
  app = await createDaemonApp({ config, verbose: false });
  await app.spaceRuntimeService.ready();
  const afterRestart = await rpc('neo.question.get', { questionId: manual.question.id });
  writeFileSync(join(run, 'evidence/manual-restart.json'), JSON.stringify({ beforeRestart, afterRestart }, null, 2));
  assert.deepEqual(afterRestart.answerDelivery, [], 'restart must not synthesize a worker route for a later manual card');
  const reopenedStore = new NeoAskTodoRepository(app.db.getDatabase());
  reopenedStore.retireQuestion(reopenedStore.getQuestion(manual.question.id)!, 'Synthetic fixture complete', null, Date.now());
  const again = await createNeoWorkerQuestionWriter(reopenedStore, new NeoTodoSessionRepository(app.db.getDatabase()), () => 'zh-Hans', async () => source)(ref, report);
  assert(again.ok, JSON.stringify(again));
  first.question = again.question;
  const activeStore = reopenedStore;
  const routeId = (await rpc('neo.question.get', { questionId: first.question.id })).answerDelivery[0].id;
  const answer = await rpc('neo.question.answer', { questionId: first.question.id, answer: [report.options[0]] });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  const pending = await rpc('neo.question.get', { questionId: first.question.id });
  assert.equal(pending.answerDelivery[0].state, 'pending');
  assert.deepEqual(pending.answerDelivery[0].answer, [report.options[0]]);
  assert.equal(pending.answerDelivery[0].answeredBy, 'button');
  assert.equal(activeStore.getTodo(todo.id)?.blockedBy, 'needs-human');
  const text = `Answer to "${first.question.text}": ${report.options[0]}`;
  const input = { to: ref.id, text, idempotencyKey: routeId };
  const delivered = await rpc('message.send', input);
  assert.equal(delivered.kind, 'accepted');
  for (let i = 0; i < 5; i++) assert.deepEqual(await rpc('message.send', input), delivered);
  const conflict = await rpc('message.send', { ...input, text: 'A conflicting answer' });
  assert.equal(conflict.kind, 'rejected');
  assert.match(conflict.reason, /idempotency_conflict/);
  const changedOrigin = await rpc('message.send', { ...input, from: 'session:synthetic-neo' });
  assert.equal(changedOrigin.kind, 'accepted');
  assert.notEqual(changedOrigin.messageId, delivered.messageId);
  assert.equal(activeStore.questionAnswers.accept(routeId, delivered.messageId, Date.now()), true);
  await app.cleanup();
  app = await createDaemonApp({ config, verbose: false });
  await app.spaceRuntimeService.ready();
  assert.deepEqual(await rpc('message.send', input), delivered);
  const restored = await rpc('neo.question.get', { questionId: first.question.id });
  assert.equal(restored.answerDelivery.length, 1);
  assert.equal(restored.answerDelivery[0].id, routeId);
  assert.equal(restored.answerDelivery[0].state, 'accepted');
  assert.equal(restored.answerDelivery[0].receipt, delivered.messageId);
  assert.equal(new NeoAskTodoRepository(app.db.getDatabase()).getTodo(todo.id)?.blockedBy, 'needs-human');
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ receipts, initial, pending, restored, delivered, conflict, restartRetained: true, holdRetained: true }, null, 2));
  console.log('PASS: one durable route, immutable human answer, retry-key admission/conflict, accepted receipt survives restart; hold retained for wire slice');

} finally {
  await app.cleanup();
  for (const name of ['data', 'home', 'tmp', 'bin', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ stopped: true, temporaryDataDeleted: true }));
}
