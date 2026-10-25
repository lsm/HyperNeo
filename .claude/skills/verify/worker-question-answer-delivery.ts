import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { QueryOptionsBuilder } from '../../../packages/daemon/src/lib/agent/query-options-builder.ts';
import { request } from 'node:http';
import { sessionDoorPath } from '../../../packages/daemon/src/lib/messaging/session-door.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'bin'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
let modelTurns = 0;
const realNow = Date.now;
const coordinatorBodies: string[] = [];
let requests = 0;
const model = Bun.serve({ hostname: '127.0.0.1', port: 8000, async fetch(request) {
  if (new URL(request.url).pathname !== '/v1/messages') return Response.json({ data: [], has_more: false });
  const body = await request.json();
  writeFileSync(join(run, `evidence/model-${++requests}.json`), JSON.stringify(body, null, 2));
  if (body.tools?.some((tool: { name: string }) => tool.name === 'mcp__hyperneo-operations__invoke')) { modelTurns++; coordinatorBodies.push(JSON.stringify(body)); }
  const start = { id: `msg_${requests}`, type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-6', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
  const events = [
    ['message_start', { type: 'message_start', message: start }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Synthetic blocker triage.' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
} });
const build = QueryOptionsBuilder.prototype.build;
QueryOptionsBuilder.prototype.build = async function (...args) {
  return { ...await build.apply(this, args), sandbox: { enabled: false } };
};
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
async function workerSend(input: unknown) {
  const result = await new Promise<{ kind: string; value?: unknown }>((resolve, reject) => {
    const call = request({ socketPath: sessionDoorPath(), path: '/', method: 'POST', agent: false, headers: { 'content-type': 'application/json', connection: 'close' } }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    call.on('error', reject);
    call.end(JSON.stringify({ sender: 'synthetic-worker', name: 'message.send', input }));
  });
  receipts.push({ name: 'session-door:message.send', result });
  assert.equal(result.kind, 'completed', JSON.stringify(result));
  return result.value as { kind: string; mailboxId: string; messageId: string; files?: { byteLength: number; sha256: string }[] };
}
async function until(check: () => boolean | Promise<boolean>, message: string) {
  const end = Date.now() + 45000;
  while (!(await check()) && Date.now() < end) await Bun.sleep(100);
  assert(await check(), message);
}
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  const { servers } = await rpc('rpc:mcp.registry.list', {});
  for (const server of servers) await rpc('rpc:mcp.registry.setEnabled', { id: server.id, enabled: false });
  await rpc('rpc:providers.create', { params: { providerId: 'anthropic', displayName: 'Loopback', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
  const root = (await rpc('neo.open', {})).sessionId;
  await app.db.createSession({ id: 'synthetic-worker', title: 'Synthetic worker', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { model: 'claude-sonnet-4-6', provider: 'anthropic', maxTokens: 8192, temperature: 1 }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  let store = new NeoAskTodoRepository(app.db.getDatabase());
  const links = new NeoTodoSessionRepository(app.db.getDatabase());
  const ref = { adapter: 'hyperneo', id: 'synthetic-worker' };
  store.openAsk({ id: 'synthetic-ask', sessionId: root, projectId: null, originMessageId: null, title: 'Synthetic plan', request: 'Build', createdAt: Date.now() });
  const todo = store.addTodo('synthetic-todo', 'synthetic-ask', { title: 'Build', doneWhen: 'Built', instruction: 'Stay quiet except blockers.', check: null, named: null }, Date.now());
  links.create(todo.id, { verb: 'start', adapter: 'hyperneo', place: { machine: 'test', name: 'Synthetic' } });
  links.recordRef(todo.id, ref, Date.now());
  store.updateTodo(todo, { state: 'doing', startedAt: Date.now() }, Date.now());
  const report = async (title: string) => {
    const result = await workerSend({ to: root, kind: 'blocked', text: 'Need a decision', question: { todoId: todo.id, title, options: ['Staging', 'Production'], language: 'en' } });
    assert.equal(result.kind, 'accepted');
    return store.listQuestions(todo.askId).find((question) => question.state === 'open')!;
  };
  const question = await report('Choose a destination');
  const answer = await rpc('neo.question.answer', { questionId: question.id, answer: ['Staging'] });
  assert.equal(answer.ok, true);
  const button = await rpc('neo.question.get', { questionId: question.id });
  writeFileSync(join(run, 'evidence/button.json'), JSON.stringify({ button, todo: store.getTodo(todo.id) }, null, 2));
  assert.equal(button.answerDelivery[0].state, 'accepted', 'the human button answer must be admitted directly to the worker');
  assert.equal(store.getTodo(todo.id)?.state, 'doing');
  app.jobProcessor.start();
  await until(() => app.db.getSDKMessageRepo().getUserSendStatus(ref.id, button.answerDelivery[0].receipt) === 'consumed', 'the worker SDK must consume the button answer');
  await Bun.sleep(1000);
  await app.jobProcessor.stop();
  const chatQuestion = await report('Choose a preview');
  const requestId = crypto.randomUUID();
  const input = { sessionId: root, requestId, content: 'Use preview build 42.', replyTo: { kind: 'question', id: chatQuestion.id } };
  assert.equal((await rpc('neo.message.send', input)).ok, true);
  await until(async () => (await rpc('neo.question.get', { questionId: chatQuestion.id })).answerDelivery[0].state === 'accepted', 'the chat answer must be admitted directly to the worker');
  const chat = await rpc('neo.question.get', { questionId: chatQuestion.id });
  assert.equal(chat.answerDelivery[0].answeredBy, 'chat');
  assert.equal(store.getTodo(todo.id)?.state, 'doing');
  app.jobProcessor.start();
  await until(() => app.db.getSDKMessageRepo().getUserSendStatus(ref.id, chat.answerDelivery[0].receipt) === 'consumed', 'the worker SDK must consume the chat answer');
  await Bun.sleep(1000);
  await app.jobProcessor.stop();
  const failedQuestion = await report('Confirm the next destination');
  await app.db.updateSession(ref.id, { status: 'archived' });
  assert.equal((await rpc('neo.question.answer', { questionId: failedQuestion.id, answer: ['Production'] })).ok, true);
  const failed = await rpc('neo.question.get', { questionId: failedQuestion.id });
  assert.equal(failed.answerDelivery[0].state, 'pending');
  assert.equal(store.getTodo(todo.id)?.blockedBy, 'needs-human');
  await app.cleanup();
  app = await createDaemonApp({ config, verbose: false });
  await app.spaceRuntimeService.ready();
  store = new NeoAskTodoRepository(app.db.getDatabase());
  await app.db.updateSession(ref.id, { status: 'active' });
  app.db.getDatabase().prepare("UPDATE job_queue SET run_at = ? WHERE queue = 'neo.work.driver.refresh' AND status = 'pending'").run(Date.now());
  app.jobProcessor.start();
  await until(async () => (await rpc('neo.question.get', { questionId: failedQuestion.id })).answerDelivery[0].state === 'accepted', 'restart must retry the unavailable worker through the real refresh job');
  const recovered = await rpc('neo.question.get', { questionId: failedQuestion.id });
  await until(() => app.db.getSDKMessageRepo().getUserSendStatus(ref.id, recovered.answerDelivery[0].receipt) === 'consumed', 'the recovered answer must reach the worker SDK');
  await Bun.sleep(1000);
  await app.jobProcessor.stop();
  assert.equal((await rpc('neo.message.send', input)).ok, true);
  assert.equal((await rpc('neo.question.answer', { questionId: question.id, answer: ['Production'] })).ok, false);
  const delivered = [button, chat, recovered].map((read) => read.answerDelivery[0]);
  const counts = delivered.map((route) => app.db.getDatabase().prepare("SELECT COUNT(*) AS count FROM sdk_messages WHERE session_id = ? AND sdk_uuid = ? AND message_type = 'user'").get(ref.id, route.receipt));
  assert(counts.every((row) => row.count === 1), JSON.stringify(counts));
  assert.equal(store.getTodo(todo.id)?.state, 'doing');
  assert(coordinatorBodies.some((body) => body.includes('Staging')));
  assert(coordinatorBodies.some((body) => body.includes('Use preview build 42.')));
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ receipts, button, chat, failed, recovered, delivered, counts, hold: store.getTodo(todo.id), modelTurns, restartRetained: true }, null, 2));
  console.log('PASS: button/chat answers consumed once by worker SDK; failed delivery stays held; restart retries and resumes; Neo sees answers');
} finally {
  const ownPort = app.server.port;
  await app.cleanup();
  model.stop(true);
  QueryOptionsBuilder.prototype.build = build;
  Date.now = realNow;
  for (const port of [ownPort, 8000]) {
    const probe = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response('closed listener check') });
    probe.stop(true);
  }
  for (const name of ['data', 'home', 'tmp', 'bin', 'workspace']) rmSync(join(run, name), { recursive: true, force: true });
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ stopped: true, temporaryDataDeleted: true, listenersClosed: true }));
}

process.exit(0);
