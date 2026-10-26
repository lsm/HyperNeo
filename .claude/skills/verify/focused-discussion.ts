import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { NEO_FOCUSED_DISCUSSION } from '../../../packages/prompts/src/mod.ts';
import { createTestSession } from '../../../packages/daemon/tests/helpers/database.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const dir of ['bin', 'workspace/docs', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
for (const command of ['gh', 'open', 'ps']) writeFileSync(join(run, 'bin', command), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
const humanWords = 'Help me choose the positioning for a fictional balcony seed library. I want to discuss the trade-offs. Use a HyperNeo session.';
const docs = '[Brief](docs/brief.md)';
const decisions = 'Earlier decision: prioritize first-time balcony gardeners; keep a calm, practical tone.';
writeFileSync(join(run, 'workspace/docs/brief.md'), '# Fictional brief\nA tiny seed library for first-time balcony gardeners.\n');
const seed = `Prepare for a human-led discussion.\nHuman's words (verbatim):\n${humanWords}\nLinked docs: ${docs}\n${decisions}\nPrepare clear questions and options, then report what is prepared. Wait for the human to discuss directly. FOCUSED_PREP_FIXTURE`;
const report = 'Prepared three positioning options: a practical starter library, a seasonal growing companion, or a neighborhood seed exchange. Questions: prioritize ease, continuity, or community? Ready for the human discussion.';
let enter!: () => void, release!: () => void;
const entered = new Promise<void>((resolve) => { enter = resolve; });
const prepared = new Promise<void>((resolve) => { release = resolve; });
const modelRequests: unknown[] = [];
const strings = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value ?? '');
const model = Bun.serve({ hostname: '127.0.0.1', port: 8000, async fetch(request) {
  if (new URL(request.url).pathname.endsWith('/models')) return Response.json({ data: [{ id: 'claude-sonnet-4-5-20250929', type: 'model', display_name: 'Synthetic Sonnet', created_at: '2025-09-29T00:00:00Z' }], has_more: false });
  if (request.url.includes('/v1/messages/count_tokens')) return Response.json({ input_tokens: 100 });
  if (!request.url.includes('/v1/messages')) return Response.json({});
  const body = await request.json() as { system?: unknown; messages?: unknown; model: string; stream?: boolean };
  modelRequests.push(body);
  const worker = !strings(body.system).includes('You are Neo,') && strings(body.messages).includes('FOCUSED_PREP_FIXTURE');
  if (worker) {
    for (const text of [humanWords, docs, decisions]) assert(strings(body.messages).includes(text), text);
    enter(); await prepared;
  }
  const text = worker ? report : 'Synthetic status received.';
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
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:8000';
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db'), workspaceRoot: join(run, 'workspace') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
app.server.stop();
const files = new Map([...new Bun.Glob('**/*').scanSync({ cwd: 'packages/web/dist', onlyFiles: true })].map((path) => [`/${path}`, Bun.file(resolve('packages/web/dist', path))]));
const web = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request, server) {
  if (new URL(request.url).pathname === '/ws') {
    if (server.upgrade(request, { data: { connectionSessionId: 'global', device: await app.authenticateUpgrade(request, server.requestIP(request)?.address ?? null) } })) return;
    return new Response('Upgrade failed', { status: 500 });
  }
  return new Response(files.get(new URL(request.url).pathname) ?? Bun.file(resolve('packages/web/dist/neo/index.html')));
}, websocket: createWebSocketHandlers(app.transport, app.sessionManager) });
const receipts: unknown[] = [];
let ws: WebSocket | undefined;
try {
  await app.spaceRuntimeService.ready();
  app.db.updateGlobalSettings({ language: 'en' });
  assert.notEqual(web.port, 8399);
  ws = new WebSocket(`ws://127.0.0.1:${web.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connect')); });
  const pending = new Map<string, (reply: { data: unknown; error?: unknown }) => void>();
  ws.onmessage = (event) => { const reply = JSON.parse(String(event.data)); pending.get(reply.requestId ?? reply.id)?.(reply); };
  const rpc = (method: string, data: unknown) => new Promise<unknown>((done, fail) => {
    const id = crypto.randomUUID(); const timer = setTimeout(() => { pending.delete(id); fail(new Error(`RPC timeout: ${method}`)); }, 30000);
    pending.set(id, (reply) => { clearTimeout(timer); pending.delete(id); reply.error ? fail(new Error(JSON.stringify(reply.error))) : done(reply.data); });
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const external = await rpc('mcp.registry.list', {}) as { servers: { id: string }[] };
  for (const server of external.servers) await rpc('mcp.registry.setEnabled', { id: server.id, enabled: false });
  await rpc('providers.create', { params: { providerId: 'anthropic', displayName: 'Synthetic local model', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
  const root = await rpc('operation.invoke', { name: 'neo.open', input: {} }) as { ok: boolean; sessionId: string };
  assert(root.ok);
  assert(app.db.getSession(root.sessionId)?.config.systemPrompt?.includes(NEO_FOCUSED_DISCUSSION));
  const anchorId = crypto.randomUUID();
  await app.db.createSession({ ...createTestSession(anchorId), title: 'Discussion context project', workspacePath: join(run, 'workspace'), config: { ...createTestSession(anchorId).config, queryMode: 'manual' } });
  const handler = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: root.sessionId, role: 'neo' }));
  const call = async (name: string, input: unknown = {}) => {
    const reply = await handler({ name, input }); const value = JSON.parse(reply.content[0].text);
    receipts.push({ name, input, value }); assert(!reply.isError, JSON.stringify(value)); return value;
  };
  const adapters = await call('work.adapters');
  assert(adapters.value.some((adapter: { id: string; capabilities: string[] }) => adapter.id === 'hyperneo' && adapter.capabilities.includes('start')));
  const found = await call('work.find', { text: 'Discussion context project' });
  const place = found.places.find((group: { place: { folder?: string } }) => group.place.folder === join(run, 'workspace'))?.place;
  assert(place, JSON.stringify(found));
  const opened = await call('neo.ask.open', { title: 'Fictional seed library positioning', request: humanWords });
  assert(opened.ok, JSON.stringify(opened));
  const added = await call('neo.todo.add', { askId: opened.ask.id, title: 'Focused positioning discussion', doneWhen: 'Prepared options discussed with the human', instruction: seed, target: { verb: 'start', adapter: 'hyperneo', place }, start: true });
  assert(added.ok && added.todo.state === 'doing', JSON.stringify(added));
  const snapshot = await call('neo.snapshot');
  const entry = snapshot.todoAsks.find((entry: { ask: { id: string } }) => entry.ask.id === opened.ask.id);
  assert.equal(entry.questions.length, 0);
  const worker = entry.todos.find((todo: { id: string }) => todo.id === added.todo.id).worker;
  assert(worker?.id && worker.id !== anchorId && worker.id !== root.sessionId);
  await new Promise<void>((done, fail) => { const timer = setTimeout(() => fail(new Error('worker did not reach local model')), 30000); entered.then(() => { clearTimeout(timer); done(); }, fail); });
  release();
  let status;
  const deadline = Date.now() + 30000;
  do {
    status = await call('work.status', { ref: { adapter: worker.adapter, id: worker.id } });
    if (status.value?.lastReply === report) break;
    await new Promise((done) => setTimeout(done, 100));
  } while (Date.now() < deadline);
  assert.equal(status.value?.lastReply, report);
  const question = await call('neo.question.ask', { askId: opened.ask.id, kind: 'reply', text: '**Prepared for discussion**\n\n- Three positioning options and trade-offs.\n- Questions to choose the direction.\n\nOpen the session to discuss directly.', sourceSession: { adapter: worker.adapter, id: worker.id } });
  assert(question.ok, JSON.stringify(question));
  const final = await call('neo.snapshot');
  const card = final.todoAsks.find((entry: { ask: { id: string } }) => entry.ask.id === opened.ask.id);
  assert.equal(card.questions.length, 1);
  assert.equal(card.questions[0].sourceSession.id, worker.id);
  assert.equal(card.questions[0].sourceSession.link, `/session/${worker.id}`);
  const saved = { status: 'daemon-pass-web-pending', sourceCommit: (await import('node:child_process')).execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), root: root.sessionId, askId: opened.ask.id, todoId: added.todo.id, worker, question, card, humanWords, docs, decisions, seed, report, noReadyCardOnStart: true, receipts, modelRequests, limits: 'Scripted routing and loopback model prove prompt delivery and existing flows, not spontaneous model judgment or native Desktop behavior.' };
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(saved, null, 2));
  const browser = Bun.spawn([process.env.VERIFY_NODE ?? 'node', '.claude/skills/verify/focused-discussion-web.mjs', String(web.port), run], { env: process.env, stdout: 'inherit', stderr: 'inherit' });
  assert.equal(await browser.exited, 0);
  saved.status = 'pass';
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(saved, null, 2));
  console.log('PASS: fresh tracked HyperNeo session receives complete discussion seed, prepares through actual SDK/local model, and one source-linked card opens its session');
} finally {
  writeFileSync(join(run, 'evidence/attempt.json'), JSON.stringify({ receipts, modelRequests }, null, 2));
  release(); ws?.close(); await app.cleanup(); await web.stop(true); await model.stop(true);
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ stopped: true }));
}
