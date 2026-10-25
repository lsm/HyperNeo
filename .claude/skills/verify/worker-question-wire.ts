import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { createNeoTodoRunner } from '../../../packages/daemon/src/lib/neo/todo-runner.ts';
import { QueryOptionsBuilder } from '../../../packages/daemon/src/lib/agent/query-options-builder.ts';

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
let requests = 0;
const model = Bun.serve({ hostname: '127.0.0.1', port: 8000, async fetch(request) {
  if (new URL(request.url).pathname !== '/v1/messages') return Response.json({ data: [], has_more: false });
  const body = await request.json();
  writeFileSync(join(run, `evidence/model-${++requests}.json`), JSON.stringify(body, null, 2));
  if (body.tools?.some((tool: { name: string }) => tool.name === 'mcp__hyperneo-operations__invoke')) modelTurns++;
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
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  const { servers } = await rpc('rpc:mcp.registry.list', {});
  for (const server of servers) await rpc('rpc:mcp.registry.setEnabled', { id: server.id, enabled: false });
  await rpc('rpc:providers.create', { params: { providerId: 'anthropic', displayName: 'Loopback', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
  const root = (await rpc('neo.open', {})).sessionId;
  assert(root);
  const db = app.db.getDatabase();
  for (const id of ['synthetic-worker'])
    db.prepare(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?, ?, ?, '2026-10-25T00:00:00Z', '2026-10-25T00:00:00Z', 'active', '{}', '{}')`).run(id, id, join(run, 'workspace'));
  const store = new NeoAskTodoRepository(db);
  const sessions = new NeoTodoSessionRepository(db);
  store.openAsk({ id: 'synthetic-ask', sessionId: root, projectId: null, originMessageId: null, title: 'Synthetic plan', request: 'Build', createdAt: 1 });
  const ref = { adapter: 'hyperneo', id: 'synthetic-worker' };
  const todo = store.addTodo('synthetic-todo', 'synthetic-ask', { title: 'Build', doneWhen: 'Built', instruction: 'Stay quiet. No routine progress pings.', check: null, named: null }, 1);
  sessions.create(todo.id, { verb: 'start', adapter: 'hyperneo', place: { machine: 'test', name: 'Synthetic' } });
  sessions.recordRef(todo.id, ref, 2);
  store.updateTodo(todo, { state: 'doing', startedAt: 2 }, 2);
  const input = { to: root, from: 'session:synthetic-worker', kind: 'blocked', text: 'Original worker blocker', question: { todoId: todo.id, title: 'Choose a destination', options: ['Staging', 'Production'], language: 'en' } };
  if (process.argv[3] === 'old') store.askQuestion('old-card', todo.askId, {
    todoId: todo.id, text: input.question.title, document: input.text, kind: 'choice', options: input.question.options,
    multiple: false, noLabel: null, yesLabel: null, startTodos: null,
    sourceSession: { ...ref, name: 'Synthetic worker', label: 'HyperNeo · Synthetic worker', provider: 'Synthetic', link: null },
  }, 1);
  const first = await rpc('message.send', input);
  assert.equal(first.kind, 'accepted');
  const question = store.listQuestions(todo.askId)[0];
  assert(question, 'message.send must create a human card before returning');
  assert.equal(store.getTodo(todo.id)?.blockedBy, 'needs-human');
  assert.equal(question.document, input.text);
  assert.equal(question.sourceSession?.id, ref.id);
  for (let i = 0; i < 8; i++) assert.deepEqual(await rpc('message.send', { ...input, text: `Repeat ${i}` }), first);
  const wakes = () => app.db.getJobQueueRepo().listActiveByPayload('mailbox', { 'to.sessionId': root });
  assert.equal(wakes().length, 1);
  const wake = wakes()[0];
  app.jobProcessor.start();
  const deadline = Date.now() + 45000;
  while ((modelTurns === 0 || app.db.getJobQueueRepo().getJob(wake.id)?.status !== 'completed') && Date.now() < deadline) await Bun.sleep(100);
  assert.equal(modelTurns, 1, 'the real mailbox must wake Neo exactly once');
  assert.equal(app.db.getJobQueueRepo().getJob(wake.id)?.status, 'completed');
  await Bun.sleep(1000);
  await app.jobProcessor.stop();
  assert.deepEqual(await rpc('message.send', { ...input, kind: 'question' }), first);
  assert.equal(wakes().length, 0, 'consuming a wake must not allow repeats to create another');
  await app.cleanup();
  app = await createDaemonApp({ config, verbose: false });
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  assert.deepEqual(await rpc('message.send', input), first);
  await Bun.sleep(1000);
  assert.equal(modelTurns, 1, 'restart and repeats must not wake Neo again');
  const restored = new NeoAskTodoRepository(app.db.getDatabase());
  const links = new NeoTodoSessionRepository(app.db.getDatabase());
  assert.equal(restored.listQuestions(todo.askId).length, 1);
  assert.equal(wakes().length, 0);
  const reminders: string[] = [];
  const runner = createNeoTodoRunner({ store: restored, sessions: links, packs: () => [], changed: () => {},
    invoke: async (_caller, name) => { reminders.push(name); return { kind: 'completed', value: { ok: true, value: { ref, title: 'Stopped', place: { machine: 'test', name: 'Test' }, status: 'stopped', lastActivityAt: 1 } } }; },
    tell: async () => { reminders.push('tell'); },
  });
  await runner.refresh((message, error) => { throw new Error(`${message}: ${error}`); });
  assert(!reminders.includes('work.send'));
  assert(!reminders.includes('tell'));
  const read = await rpc('neo.question.get', { questionId: question.id });
  assert.equal(read.question.state, 'open');
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ receipts, question, hold: restored.getTodo(todo.id), reminders, consumedWakeId: wake.id, modelTurns, oldCard: process.argv[3] === 'old', restartRetained: true }, null, 2));
  console.log('PASS: message.send creates a held card and one real Neo turn; repeats and restart do not re-wake; held todo receives no runner nudge');
} finally {
  await app.cleanup();
  model.stop(true);
  QueryOptionsBuilder.prototype.build = build;
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ stopped: true }));
}
