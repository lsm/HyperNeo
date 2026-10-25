import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { createNeoQuestionAnswerDelivery } from '../../../packages/daemon/src/lib/neo/question-answer-delivery.ts';
import { createSendMessageOperation } from '../../../packages/daemon/src/lib/messaging/message-send.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
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
  const seed = async (id: string, adapter: string, worker: string, daemon?: string) => {
    const todo = store.addTodo(id, 'synthetic-ask', { title: id, doneWhen: 'Done', instruction: null, check: null, named: null }, Date.now());
    const ref = { adapter, id: worker, ...(daemon ? { daemon } : {}) };
    sessions.bind(todo.id, ref, Date.now());
    store.updateTodo(todo, { state: 'doing', startedAt: Date.now() }, Date.now());
    const report = await write(ref, { todoId: todo.id, kind: 'blocked', title: 'Choose a destination', options: ['Staging', 'Production'], language: 'en', report: 'Need a destination' });
    assert(report.ok, JSON.stringify(report));
    return report.question;
  };
  const target = await seed('target', 'hyperneo', 'synthetic-worker');
  let entered = () => {};
  const admitted = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const outcomes: unknown[] = [];
  const send = createSendMessageOperation(app.db.getJobQueueRepo(), (id) => app.db.getSession(id)?.status ?? null, undefined, undefined, async () => {
    entered(); await barrier; return 'Synthetic Neo';
  });
  const registry = app.sessionManager.getOperationRegistry();
  const get = registry.get.bind(registry);
  registry.get = (name) => name !== 'message.send' ? get(name) : { ...send, execute: async (input, caller) => {
    const outcome = await send.execute(input, caller);
    outcomes.push(outcome);
    return outcome;
  } };
  const sweep = createNeoQuestionAnswerDelivery(store, sessions,
    (caller, name, input) => invokeOperation(registry, name, input, caller),
    async () => {},
    async (todo) => store.recompute(todo, {}, Date.now(), { state: 'no_opinion' }, async () => {}),
    (error) => { throw error; });
  answer = rpc('neo.question.answer', { questionId: target.id, answer: ['Staging'] });
  await admitted;
  await sweep();
  assert.match(JSON.stringify(outcomes[0]), /duplicate/);
  release();
  assert.equal((await answer as { ok: boolean }).ok, true);
  const observed = { target: await rpc('neo.question.get', { questionId: target.id }), todo: store.getTodo('target'), outcomes };
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
  assert.equal(observed.target.answerDelivery[0].state, 'accepted', 'a competing duplicate rejection must not strand the accepted answer');
  assert.equal(observed.todo?.state, 'doing');
  console.log('PASS: overlapping answer RPC and sweep retain accepted delivery and release the hold');
} finally {
  release();
  await answer;
  await app.cleanup();
  for (const name of ['data', 'home', 'tmp', 'bin', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ stopped: true, temporaryDataDeleted: true }));
}
process.exit(0);
