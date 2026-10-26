import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, appendFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { createNeoWorkerQuestionWriter } from '../../../packages/daemon/src/lib/neo/question-operations.ts';

const [mode, runText] = process.argv.slice(2);
assert(['codex', 'remote'].includes(mode));
const run = resolve(runText);
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
let refused = true;
writeFileSync(join(run, 'bin/ps'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/open'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const peer = createServer();
const sockets = new WebSocketServer({ server: peer });
const seen: unknown[] = [];
sockets.on('connection', (socket) => socket.on('message', (bytes) => {
  const request = JSON.parse(String(bytes)); seen.push(request);
  if (request.id === undefined) return;
  if (mode === 'remote') {
    if (request.data.name === 'work.send') peerInputs.push(request.data.input.message);
    socket.send(JSON.stringify({ id: crypto.randomUUID(), type: 'RSP', requestId: request.id, sessionId: 'global', method: request.method, timestamp: new Date().toISOString(), version: '1.0.0', data: { ok: true, value: request.data.name === 'work.send' ? { delivered: true } : { ref: { adapter: 'codex-desktop', id: 'synthetic' }, title: 'Synthetic worker', place: { machine: 'synthetic', name: 'Synthetic' }, status: 'running', lastActivityAt: Date.now() } } }));
    return;
  }
  if (request.method === 'turn/start' && refused) {
    socket.send(JSON.stringify({ id: request.id, error: { code: -32600, message: 'thread synthetic already has an active writer' } }));
    return;
  }
  if (request.method === 'turn/start') {
    const text = request.params.input[0].text; peerInputs.push(text);
    appendFileSync(rollout, JSON.stringify({ type: 'response_item', timestamp: new Date().toISOString(), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n');
  }
  const result = request.method === 'thread/turns/list' ? { data: [] } : request.method === 'turn/start' ? { turn: { id: 'accepted-turn' } } : {};
  socket.send(JSON.stringify({ id: request.id, result }));
  if (request.method === 'turn/start') socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 'synthetic', turn: { id: 'accepted-turn' } } }));
}));
mkdirSync(join(codexHome, 'app-server-control'), { recursive: true });
if (mode === 'codex') await new Promise<void>((resolve) => peer.listen(join(codexHome, 'app-server-control/app-server-control.sock'), resolve));
else await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve));
const address = peer.address();
const port = address && typeof address !== 'string' ? address.port : 0;
const url = `ws://127.0.0.1:${port}`;
if (mode === 'remote') await new Promise<void>((resolve) => peer.close(() => resolve()));
const config = getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') });
const app = await createDaemonApp({ config, verbose: false });
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'rpc.ts'), name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: String(app.server.port) }, stdout: 'pipe', stderr: 'inherit' });
  const result = JSON.parse(await new Response(child.stdout).text());
  assert.equal(await child.exited, 0); assert(!result.reply.error, JSON.stringify(result));
  return result.reply.value ?? result.reply;
}
try {
  await app.spaceRuntimeService.ready(); await app.jobProcessor.stop();
  await app.db.createSession({ id: 'synthetic-neo', title: 'Synthetic Neo', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  new NeoRepository(app.db.getDatabase()).reserveBinding({ sessionId: 'synthetic-neo', projectId: null, kind: 'neo' });
  if (mode === 'remote') await rpc('daemon.attach', { daemonId: 'synthetic-remote', url });
  const store = new NeoAskTodoRepository(app.db.getDatabase());
  store.openAsk({ id: 'synthetic-ask', sessionId: 'synthetic-neo', projectId: null, originMessageId: null, title: 'Synthetic plan', request: 'Build', createdAt: Date.now() });
  const todo = store.addTodo('synthetic-todo', 'synthetic-ask', { title: 'Build', doneWhen: 'Built', instruction: null, check: null, named: null }, Date.now());
  const ref = { adapter: 'codex-desktop', id: 'synthetic', ...(mode === 'remote' ? { daemon: 'synthetic-remote' } : {}) };
  new NeoTodoSessionRepository(app.db.getDatabase()).bind(todo.id, ref, Date.now());
  store.updateTodo(todo, { state: 'doing', startedAt: Date.now() }, Date.now());
  const write = createNeoWorkerQuestionWriter(store, new NeoTodoSessionRepository(app.db.getDatabase()), () => 'en', async (source) => ({ ...source, name: 'Synthetic', label: 'Synthetic', provider: 'Synthetic', link: null }));
  const report = await write(ref, { todoId: todo.id, kind: 'blocked', title: 'Choose a destination', options: ['Staging', 'Production'], language: 'en', report: 'Need a decision' });
  assert(report.ok);
  await rpc('neo.question.answer', { questionId: report.question.id, answer: ['Staging'] });
  const before = await rpc('neo.question.get', { questionId: report.question.id });
  const send = await rpc('work.send', { ref, message: 'Synthetic refusal control' });
  writeFileSync(join(run, 'evidence/refused.json'), JSON.stringify({ mode, before, send, seen, peerInputs }, null, 2));
  assert.equal(before.answerDelivery[0].state, 'pending');
  assert.equal(store.getTodo(todo.id)?.blockedBy, 'needs-human');
  assert.equal(before.answerDelivery[0].receipt, null, 'a proved refusal must clear its claim for retry');
  assert.equal(send.notSent, true);
  assert.equal(peerInputs.length, 0);
  refused = false;
  if (mode === 'remote') {
    await new Promise<void>((resolve) => peer.listen(port, '127.0.0.1', resolve));
    await rpc('daemon.attach', { daemonId: 'synthetic-remote', url });
  }
  const db = app.db.getDatabase();
  db.prepare("UPDATE job_queue SET run_at = ? WHERE status = 'pending'").run(Date.now() + 3600000);
  db.prepare("UPDATE job_queue SET run_at = ? WHERE queue = 'neo.work.driver.refresh' AND status = 'pending'").run(Date.now());
  await app.jobProcessor.tick(); await app.jobProcessor.stop();
  const after = await rpc('neo.question.get', { questionId: report.question.id });
  assert.equal(after.answerDelivery[0].state, 'accepted');
  assert.equal(store.getTodo(todo.id)?.state, 'doing');
  assert.equal(peerInputs.length, 1);
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ mode, before, send, after, seen, peerInputs, todo: store.getTodo(todo.id) }, null, 2));
  console.log(`PASS: ${mode} proved refusal clears its claim, holds until retry, then accepts one input and resumes`);
} finally {
  await app.cleanup();
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  if (peer.listening) await new Promise<void>((resolve) => peer.close(() => resolve()));
  for (const name of ['data', 'home', 'tmp', 'bin', 'workspace', 'peer-rollout.jsonl']) rmSync(join(run, name), { recursive: true, force: true });
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ stopped: true, temporaryDataDeleted: true }));
}
process.exit(0);
