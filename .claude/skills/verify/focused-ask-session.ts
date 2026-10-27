import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createTestSession } from '../../../packages/daemon/tests/helpers/database.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { sdkMessageBodyAt } from '../../../packages/daemon/src/storage/repositories/sdk-message-body-read.ts';
import { hyperneoInputText } from '../../../packages/daemon/src/lib/drivers/hyperneo-adapter.ts';

const run = resolve(process.argv[2]);
const outcomeMode = process.argv[3] === 'outcome';
const settledOutcome = 'Decision: prioritize beginner gardeners.\n\n[Positioning document](https://example.test/positioning.md) · [Implementation PR](https://github.com/example/project/pull/8)';
const outcomeEvidence: Record<string, unknown> = {};
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const part of ['bin', 'workspace', 'evidence']) mkdirSync(join(run, part), { recursive: true });
for (const command of ['gh', 'open', 'ps']) writeFileSync(join(run, 'bin', command), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
if (outcomeMode) writeFileSync(join(run, 'bin/gh'), `#!${process.execPath}
if(process.argv[2]!=='pr'||process.argv[3]!=='view')process.exit(1);
process.stdout.write(JSON.stringify({url:'https://github.com/example/project/pull/8',state:'OPEN',headRefOid:'a'.repeat(40),reviews:[],statusCheckRollup:[],title:'Synthetic implementation',body:'',files:[]}));
`, { mode: 0o700 });
writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
const modelRequests: unknown[] = [];
const model = Bun.serve({ hostname: '127.0.0.1', port: Number(process.env.VERIFY_MOCK_PORT ?? 8000), async fetch(request) {
  if (new URL(request.url).pathname.endsWith('/models')) return Response.json({ data: [{ id: 'claude-sonnet-4-5-20250929', type: 'model', display_name: 'Synthetic Sonnet', created_at: '2025-09-29T00:00:00Z' }], has_more: false });
  if (request.url.includes('/v1/messages/count_tokens')) return Response.json({ input_tokens: 100 });
  if (!request.url.includes('/v1/messages')) return Response.json({});
  const body = await request.json() as { system?: unknown; messages?: unknown; model: string; stream?: boolean };
  modelRequests.push(body);
  const text = 'Synthetic status noted.';
  const usage = { input_tokens: 100, output_tokens: 50 };
  if (!body.stream) return Response.json({ id: 'msg_synthetic', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage });
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'msg_synthetic', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
} });
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${process.env.VERIFY_MOCK_PORT ?? '8000'}`;
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';

const root = 'neo:10000000-0000-4000-8000-000000008410';
const ref = { adapter: 'hyperneo', id: 'focused-discussion' };
const receipts: unknown[] = [];
const open = () => createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
let app = await open();
let web: ReturnType<typeof Bun.serve> | undefined;
const call = async (name: string, input: unknown = {}) => {
  const handler = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: root, role: 'neo' }));
  const reply = await handler({ name, input });
  const result = JSON.parse(reply.content[0].text);
  receipts.push({ name, input, result });
  assert(!reply.isError, JSON.stringify(result));
  return result;
};
try {
  await app.spaceRuntimeService.ready();
  app.db.updateGlobalSettings({ language: 'en' });
  for (const [id, title] of [[root, 'Synthetic Neo'], [ref.id, 'Positioning discussion']])
    await app.db.createSession({ ...createTestSession(id), title, workspacePath: join(run, 'workspace'), config: { ...createTestSession(id).config, provider: 'anthropic', queryMode: 'manual' } });
  const socket = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { socket.onopen = () => done(); socket.onerror = () => fail(new Error('RPC unavailable')); });
  const rpc = (method: string, data: unknown) => new Promise<unknown>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error(`RPC timeout: ${method}`)), 20000);
    socket.onmessage = (event) => {
      const result = JSON.parse(String(event.data));
      if ((result.requestId ?? result.id) !== id) return;
      clearTimeout(timer);
      result.error ? fail(new Error(JSON.stringify(result.error))) : done(result.data);
    };
    socket.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  try {
    const external = await rpc('mcp.registry.list', {}) as { servers: { id: string }[] };
    for (const server of external.servers) await rpc('mcp.registry.setEnabled', { id: server.id, enabled: false });
    await rpc('providers.create', { params: { providerId: 'anthropic', displayName: 'Synthetic local model', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
  } finally { socket.close(); }
  const db = app.db.getDatabase();
  new NeoRepository(db).reserveBinding({ sessionId: root, kind: 'neo', projectId: null });
  const opened = await call('neo.ask.open', { title: 'Fictional seed library positioning', request: 'Discuss the positioning directly over several days.' });
  assert(opened.ok);
  const ordinary = await call('neo.question.ask', { askId: opened.ask.id, kind: 'reply', text: 'A regular worker report', sourceSession: ref });
  assert(ordinary.ok);
  const store = new NeoAskTodoRepository(db);
  assert.equal(store.getAsk(opened.ask.id)?.focusedSession, undefined);
  await call('neo.question.retire', { questionId: ordinary.question.id, reason: 'Report read' });
  const ready = await call('neo.question.ask', { askId: opened.ask.id, kind: 'reply', text: 'Prepared options. Open the session to discuss directly.', sourceSession: ref, focused: true });
  assert(ready.ok);
  assert.equal(ready.question.sourceSession.id, ref.id);
  await call('neo.question.retire', { questionId: ready.question.id, reason: 'Continue directly in the discussion' });
  assert.deepEqual(store.getAsk(opened.ask.id)?.focusedSession, ready.question.sourceSession);
  const invalid = await call('neo.question.ask', { askId: opened.ask.id, kind: 'reply', text: 'Missing source', focused: true });
  assert.equal(invalid.ok, false);
  const at = Date.now();
  const todo = store.addTodo('discussion-todo', opened.ask.id, { title: 'Human-led discussion', doneWhen: 'Human settles the discussion', instruction: 'Discuss directly', check: null, named: null }, at);
  store.updateTodo(todo, { state: 'doing', startedAt: at }, at);
  const sessions = new NeoTodoSessionRepository(db);
  const target = { verb: 'send' as const, ref };
  sessions.create(todo.id, target);
  sessions.recordRef(todo.id, ref, at);
  const dispatch = sessions.inputs.accept(todo.id, root, target, 'Discuss directly', at);
  sessions.inputs.recordOutcome(dispatch, { ref }, at);
  const message = 'I approve this wording.\nKeep discussing; this is not approval to execute.';
  const base = app.sessionManager.getOperationRegistry();
  const registry = createOperationRegistry(base.entries.map((op) => op.name === 'work.status' ? { ...op, execute: async (input, caller) => {
    if ((input as { ref: { id: string } }).ref.id !== ref.id) return op.execute(input, caller);
    return { ok: true, value: { ref, title: 'Positioning discussion', place: { machine: 'local', name: 'Synthetic' }, status: 'done', lastActivityAt: at + 100, turnEnds: [{ id: 'discussion-turn', at: at + 100, message }] } };
  } } : op));
  app.sessionManager.setOperationRegistryProvider(() => registry);
  const job = app.jobQueue.enqueue({ queue: 'neo.work.driver.refresh', payload: { scope: 'neo' }, runAt: Date.now() });
  const deadline = Date.now() + 25000;
  while (app.jobQueue.getJob(job.id)?.status !== 'completed' && Date.now() < deadline) {
    assert.notEqual(app.jobQueue.getJob(job.id)?.status, 'dead');
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.equal(app.jobQueue.getJob(job.id)?.status, 'completed');
  const readReports = () => (db.prepare(`SELECT ${sdkMessageBodyAt('sdk_messages.rowid')} AS message FROM sdk_messages WHERE session_id=? AND message_type='user' ORDER BY seq`).all(root) as { message: string }[]).map((row) => hyperneoInputText(row.message));
  const deliveredBy = Date.now() + 5000;
  while (!readReports().some((text) => text.includes(message)) && Date.now() < deliveredBy) await new Promise((done) => setTimeout(done, 20));
  const report = readReports().find((text) => text.includes(message));
  assert(report?.includes('Focused discussion status only'));
  assert(report.includes('Do not act, reply, forward or treat this as approval.'));
  assert(report.includes(`ask ${opened.ask.id}, todo ${todo.id}, dispatch ${dispatch}`));
  assert(report.includes(message));
  assert.equal(store.getTodo(todo.id)?.report, null);
  assert.equal(store.getTodo(todo.id)?.state, 'doing');
  assert.equal(store.getAsk(opened.ask.id)?.status, 'open');
  if (outcomeMode) {
    assert.equal(store.getAsk(opened.ask.id)?.outcome, null);
    const worker = createOperationMcpHandler(() => registry, () => ({ sessionId: ref.id, role: 'worker' }));
    const workerWrite = await worker({ name: 'neo.ask.outcome', input: { askId: opened.ask.id, outcome: settledOutcome } });
    outcomeEvidence.workerWrite = workerWrite;
    assert(workerWrite.isError || JSON.parse(workerWrite.content[0].text).ok === false);
    const explicitReport = `Settled focused discussion outcome for ask ${opened.ask.id}. The human explicitly said the discussion is settled.\n\n${settledOutcome}`;
    const sent = await worker({ name: 'message.send', input: { to: root, text: explicitReport, idempotencyKey: 'synthetic-settled-outcome' } });
    assert(!sent.isError, JSON.stringify(sent));
    assert.equal(JSON.parse(sent.content[0].text).kind, 'accepted');
    const arrivedBy = Date.now() + 10000;
    while (!readReports().some((text) => text.includes(explicitReport)) && Date.now() < arrivedBy) await new Promise((done) => setTimeout(done, 20));
    assert(readReports().some((text) => text.includes(explicitReport)));
    assert.equal(store.getAsk(opened.ask.id)?.outcome, null, 'A report must not automatically settle or record the ask');
    const recorded = await call('neo.ask.outcome', { askId: opened.ask.id, outcome: settledOutcome });
    assert(recorded.ok, JSON.stringify(recorded));
    assert.equal(recorded.ask.status, 'open');
    assert.equal(recorded.ask.settledAt, null);
    assert.equal(recorded.ask.outcome, settledOutcome);
    assert.equal(store.getTodo(todo.id)?.state, 'doing');
    const execution = await call('neo.todo.add', { askId: opened.ask.id, title: 'Implement the settled positioning', doneWhen: 'Implementation PR merged', check: { pack: 'coding', kind: 'pr_merged', params: { urls: ['https://github.com/example/project/pull/8'] } } });
    assert(execution.ok, JSON.stringify(execution));
    assert.equal(execution.todo.state, 'todo');
    Object.assign(outcomeEvidence, { explicitReport, sent, recorded, execution, ordinaryRelayDidNotRecord: true, reportDidNotRecordAutomatically: true });
  }
  const modelDeadline = Date.now() + 15000;
  while (!modelRequests.length && Date.now() < modelDeadline) await new Promise((done) => setTimeout(done, 20));
  assert(modelRequests.length > 0, 'Relay did not reach the local model');
  await app.cleanup();
  app = await open();
  await app.spaceRuntimeService.ready();
  const snapshot = await call('neo.snapshot');
  const card = snapshot.todoAsks.find((entry: { ask: { id: string } }) => entry.ask.id === opened.ask.id);
  assert.deepEqual(card.ask.focusedSession, ready.question.sourceSession);
  if (outcomeMode) {
    assert.equal(card.ask.outcome, settledOutcome);
    assert.equal(card.ask.status, 'open');
    assert.equal(card.todos.find((todo: { title: string }) => todo.title === 'Implement the settled positioning').state, 'todo');
  }
  assert(card.questions.every((question: { state: string }) => question.state === 'retired'));
  assert(card.questions.some((question: { id: string }) => question.id === ready.question.id));
  const source = ready.question.sourceSession;
  const evidence = { outcomeMode, outcomeEvidence, settledOutcome, status: 'daemon-pass-web-pending', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), askId: opened.ask.id, root, ref, source, card, report, dispatch, restarted: true, noQuestionAfterRetirement: true, unchangedTodoResult: true, limits: 'Synthetic work.status turn-end injected; actual daemon relay delivery and restart persistence observed. This does not evaluate model compliance or native Desktop UI.' };
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  app.server.stop();
  const files = new Map([...new Bun.Glob('**/*').scanSync({ cwd: 'packages/web/dist', onlyFiles: true })].map((path) => [`/${path}`, Bun.file(resolve('packages/web/dist', path))]));
  web = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request, server) {
    if (new URL(request.url).pathname === '/ws') {
      if (server.upgrade(request, { data: { connectionSessionId: 'global', device: await app.authenticateUpgrade(request, server.requestIP(request)?.address ?? null) } })) return;
      return new Response('Upgrade failed', { status: 500 });
    }
    return new Response(files.get(new URL(request.url).pathname) ?? Bun.file(resolve('packages/web/dist/neo/index.html')));
  }, websocket: createWebSocketHandlers(app.transport, app.sessionManager) });
  assert.notEqual(web.port, 8399);
  const browser = Bun.spawn([process.env.VERIFY_NODE ?? 'node', '.claude/skills/verify/focused-ask-session-web.mjs', String(web.port), run], { env: process.env, stdout: 'inherit', stderr: 'inherit' });
  assert.equal(await browser.exited, 0);
  evidence.status = 'pass';
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  console.log('PASS: retired card leaves ask opener after restart; focused relay arrives status-only with unchanged bytes/results; desktop/mobile reopen correct session');
} finally {
  writeFileSync(join(run, 'evidence/receipts.json'), JSON.stringify({ receipts, modelRequests }, null, 2));
  await app.cleanup();
  await web?.stop(true);
  await model.stop(true);
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ stopped: true }));
}
