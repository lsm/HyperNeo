import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { syntheticCodexDesktop } from './codex-desktop-peer.ts';
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
const codexHome = join(run, 'home/.codex');
mkdirSync(codexHome, { recursive: true });
const rollout = join(run, 'peer-rollout.jsonl');
writeFileSync(rollout, '');
const native = new Database(join(codexHome, 'state_5.sqlite'));
native.exec(`CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, rollout_path TEXT);
CREATE TABLE projects (id TEXT, name TEXT); CREATE TABLE project_roots (project_id TEXT, path TEXT);`);
native.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)').run('synthetic', 'Synthetic worker', '', '', join(run, 'workspace'), 'desktop', Date.now(), rollout);
native.close();
const peerInputs: string[] = [];
const delayed: string[] = [];
let loseReply = false;
const record = (text: string) => appendFileSync(rollout, JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'message', role: 'user', id: crypto.randomUUID(), content: [{ type: 'input_text', text }] } }) + '\n');
const startPeer = () => syntheticCodexDesktop(run, {
  start: (request) => {
    const text = request.params.turnStart.request.input[0].text;
    peerInputs.push(text);
    if (loseReply) delayed.push(text); else record(text);
    return `accepted-${peerInputs.length}`;
  },
  dropReply: (method) => loseReply && method === 'thread-follower-start-turn',
});
let stopPeer: (() => Promise<void>) | undefined = await startPeer();
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
  const first = await seed('target', 'codex-desktop', 'synthetic');
  assert.equal((await rpc('neo.question.answer', { questionId: first.id, answer: ['Staging'] })).ok, true);
  const immediate = await rpc('neo.question.get', { questionId: first.id });
  writeFileSync(join(run, 'evidence/immediate.json'), JSON.stringify(immediate, null, 2));
  assert.equal(immediate.answerDelivery[0].state, 'accepted', 'external card answers must reach their assigned worker directly');
  assert.equal(store.getTodo('target')?.state, 'doing');
  const next = async (title: string) => {
    const reported = await write({ adapter: 'codex-desktop', id: 'synthetic' }, { todoId: 'target', kind: 'blocked', title, options: ['Staging', 'Production'], language: 'en', report: 'Need another decision' });
    assert(reported.ok); return reported.question;
  };
  const refresh = async () => {
    const db = app.db.getDatabase();
    db.prepare("UPDATE job_queue SET run_at = ? WHERE status = 'pending'").run(Date.now() + 3600000);
    db.prepare("UPDATE job_queue SET run_at = ? WHERE queue = 'neo.work.driver.refresh' AND status = 'pending'").run(Date.now());
    await app.jobProcessor.tick();
    await app.jobProcessor.stop();
  };
  await stopPeer(); stopPeer = undefined;
  const refusedQuestion = await next('Choose after a refused send');
  await rpc('neo.question.answer', { questionId: refusedQuestion.id, answer: ['Production'] });
  const refused = await rpc('neo.question.get', { questionId: refusedQuestion.id });
  assert.equal(refused.answerDelivery[0].state, 'pending');
  assert.equal(refused.answerDelivery[0].receipt, null, 'a definite pre-dispatch refusal must release its claim for retry');
  assert.equal(store.getTodo('target')?.blockedBy, 'needs-human');
  stopPeer = await startPeer();
  await refresh();
  const retried = await rpc('neo.question.get', { questionId: refusedQuestion.id });
  assert.equal(retried.answerDelivery[0].state, 'accepted');
  assert.equal(store.getTodo('target')?.state, 'doing');
  loseReply = true;
  const uncertainQuestion = await next('Choose the destination for this worker after the pending dependency is resolved'.padEnd(80, '?'));
  await rpc('neo.question.answer', { questionId: uncertainQuestion.id, answer: ['Staging'] });
  const uncertain = await rpc('neo.question.get', { questionId: uncertainQuestion.id });
  assert.equal(uncertain.answerDelivery[0].state, 'pending');
  assert.equal(peerInputs.length, 3);
  await app.cleanup();
  app = await createDaemonApp({ config, verbose: false });
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop();
  await refresh();
  const waiting = await rpc('neo.question.get', { questionId: uncertainQuestion.id });
  assert.equal(waiting.answerDelivery[0].state, 'pending');
  assert.equal(peerInputs.length, 3, 'restart must not blindly resend a lost acknowledgement');
  for (const text of delayed) record(text);
  await refresh();
  const reconciled = await rpc('neo.question.get', { questionId: uncertainQuestion.id });
  const restartedStore = new NeoAskTodoRepository(app.db.getDatabase());
  writeFileSync(join(run, 'evidence/reconciliation.json'), JSON.stringify({ reconciled, status: await rpc('work.status', { ref: { adapter: 'codex-desktop', id: 'synthetic' } }), peerInputs }, null, 2));
  assert.equal(reconciled.answerDelivery[0].state, 'accepted');
  assert.equal(restartedStore.getTodo('target')?.state, 'doing');
  await refresh();
  assert.equal(peerInputs.length, 3);
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ immediate, refused, retried, uncertain, waiting, reconciled, peerInputs, receipts, todo: restartedStore.getTodo('target') }, null, 2));
  console.log('PASS: external answers deliver once, retry a definite refusal, and reconcile lost acknowledgements after restart without resending');
} finally {
  await app.cleanup();
  await stopPeer?.();
  for (const name of ['data', 'home', 'tmp', 'bin', 'workspace', 'peer-rollout.jsonl']) rmSync(join(run, name), { recursive: true, force: true });
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ stopped: true, temporaryDataDeleted: true }));
}
process.exit(0);
