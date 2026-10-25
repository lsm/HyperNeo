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
let release = () => {};
let answer: Promise<unknown> | undefined;
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  for (const id of ['synthetic-neo', 'synthetic-worker']) await app.db.createSession({
    id, title: id, workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { model: 'synthetic', queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 },
  });
  new NeoRepository(app.db.getDatabase()).reserveBinding({ sessionId: 'synthetic-neo', projectId: null, kind: 'neo' });
  const store = new NeoAskTodoRepository(app.db.getDatabase());
  const sessions = new NeoTodoSessionRepository(app.db.getDatabase());
  store.openAsk({ id: 'synthetic-ask', sessionId: 'synthetic-neo', projectId: null, originMessageId: null, title: 'Synthetic plan', request: 'Build', createdAt: 1 });
  const write = createNeoWorkerQuestionWriter(store, sessions, () => 'en', async (ref) => ({ ...ref, name: ref.id, label: ref.id, provider: 'Synthetic', link: null }));
  const seed = async (id: string, adapter: string, worker: string) => {
    const todo = store.addTodo(id, 'synthetic-ask', { title: id, doneWhen: 'Done', instruction: null, check: null, named: null }, Date.now());
    const ref = { adapter, id: worker };
    sessions.bind(todo.id, ref, Date.now());
    store.updateTodo(todo, { state: 'doing', startedAt: Date.now() }, Date.now());
    const report = await write(ref, { todoId: todo.id, kind: 'blocked', title: 'Choose a destination', options: ['Staging', 'Production'], language: 'en', report: 'Need a destination' });
    assert(report.ok, JSON.stringify(report));
    return report.question;
  };
  const target = await seed('target', 'hyperneo', 'synthetic-worker');
  const unrelated = await seed('unrelated', 'codex-desktop', 'synthetic-unavailable-peer');
  store.answerQuestion(unrelated, ['Staging'], 'button', Date.now());
  let started = () => {};
  const stale = new Promise<void>((resolve) => { started = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const registry = app.sessionManager.getOperationRegistry();
  const get = registry.get.bind(registry);
  registry.get = (name) => {
    const definition = get(name);
    return name !== 'work.send' || !definition ? definition : { ...definition, execute: async () => {
      started(); await barrier; return { ok: false, reason: 'not_open', detail: 'Synthetic unavailable peer' };
    } };
  };
  answer = rpc('neo.question.answer', { questionId: target.id, answer: ['Staging'] });
  const first = await Promise.race([answer.then(() => 'answer-returned'), stale.then(() => 'unrelated-peer-started')]);
  const observed = { first, target: await rpc('neo.question.get', { questionId: target.id }), unrelated: await rpc('neo.question.get', { questionId: unrelated.id }) };
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
  assert.equal(first, 'answer-returned', 'an unrelated pending route must not delay this human answer RPC');
  assert.equal(store.getTodo('target')?.state, 'doing');
  assert.equal(store.getTodo('unrelated')?.blockedBy, 'needs-human');
  console.log('PASS: answer RPC returns without starting an unrelated unavailable worker');
} finally {
  release();
  await answer;
  await app.cleanup();
  for (const name of ['data', 'home', 'tmp', 'bin', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ stopped: true, temporaryDataDeleted: true }));
}
process.exit(0);
