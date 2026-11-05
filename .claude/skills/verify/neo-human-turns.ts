import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { QueryOptionsBuilder } from '../../../packages/daemon/src/lib/agent/query-options-builder.ts';

const [mode, directory] = process.argv.slice(2);
const run = resolve(directory);
assert(['verify', 'before', 'copilot', 'copilot-before', 'copilot-busy', 'copilot-busy-before'].includes(mode));
const copilot = mode.startsWith('copilot');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const human = 'Please prepare the blue summary for this matter.';
const reply = 'Prepared the blue summary directly for the human.';
if (copilot) {
  const fixture = new URL('../../../packages/daemon/tests/fixtures/copilot-sdk.ts', import.meta.url).pathname;
  writeFileSync(join(run, 'bin/copilot'), `#!/usr/bin/env bun\nprocess.argv.push('--production-version', '--durable-inputs'); await import(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
  process.chdir(run);
}
const askId = 'human-direct-matter';
const newTitle = 'Record direct human blue-summary work';
const bodies: unknown[] = [];
let toolCalls = 0;
let reports = 0;
const text = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value);
const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (!new URL(request.url).pathname.endsWith('/v1/messages')) return Response.json({ data: [], has_more: false });
  const body = await request.json();
  bodies.push(body);
  const last = text(body.messages?.filter((message: { role: string }) => message.role === 'user').at(-1)?.content);
  const directReport = last.includes('The human worked directly') && last.includes(human);
  const hasResult = last.includes('tool_result');
  const invoke = body.tools?.find((tool: { name: string }) => tool.name.endsWith('hyperneo-operations__invoke'));
  const tool = directReport && !hasResult && invoke ? { name: invoke.name, input: { name: 'neo.todo.add', input: {
    askId, title: newTitle, check: { pack: 'core', kind: 'evidence', params: { path: join(run, 'blue-summary.txt') } },
  } } } : null;
  if (tool) { toolCalls++; reports++; }
  const id = crypto.randomUUID();
  const events = [
    ['message_start', { type: 'message_start', message: { id: `msg_${id}`, type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-6', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id, name: tool.name, input: {} } : { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) } : { type: 'text_delta', text: last.includes(human) && !directReport ? reply : 'Matter updated silently.' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
} });
process.env.HYPERNEO_USE_DEV_PROXY = '1';
process.env.VERIFY_MOCK_PORT = String(model.port);
const build = QueryOptionsBuilder.prototype.build;
QueryOptionsBuilder.prototype.build = async function (...args) {
  return { ...await build.apply(this, args), sandbox: { enabled: false } };
};
const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true }, verbose: false });
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
hub.registerTransport(transport);
const todos = new NeoAskTodoRepository(app.db.getDatabase());
const sessions = new NeoTodoSessionRepository(app.db.getDatabase());
const observed: Record<string, unknown> = { mode, daemonPort: app.server.port, model: 'scripted loopback fixture; not real-model reasoning', sandboxEnforcementVerified: false };
const wait = async (label: string, predicate: () => boolean, timeout = 45000) => {
  const end = Date.now() + timeout;
  while (!predicate() && Date.now() < end) await Bun.sleep(100);
  assert(predicate(), label);
};
const refresh = async () => {
  const job = app.jobQueue.enqueue({ queue: 'neo.work.driver.refresh', payload: { scope: 'neo' }, runAt: Date.now() });
  await wait('driver refresh completed', () => app.jobQueue.getJob(job.id)?.status === 'completed');
};
try {
  assert.notEqual(app.server.port, 8399);
  await transport.initialize();
  const { servers } = await hub.request<{ servers: { id: string }[] }>('mcp.registry.list', {});
  for (const server of servers) await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
  await hub.request('providers.create', { params: { providerId: 'anthropic', displayName: 'Loopback', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
  const root = await hub.request<{ ok: boolean; sessionId: string }>('operation.invoke', { name: 'neo.open', input: {} });
  assert(root.ok);
  const started = copilot ? await hub.request<{ ok: boolean; value: { ref: { adapter: string; id: string } } }>('operation.invoke', { name: 'work.start', input: { adapter: 'copilot-cli', place: { machine: hostname(), folder: run, name: 'Synthetic project' }, title: 'Human direct-work tester', model: 'synthetic-model', message: 'human-watch' } }) : null;
  if (started) assert(started.ok, JSON.stringify(started));
  const worker = started ? { sessionId: started.value.ref.id } : await hub.request<{ sessionId: string }>('session.create', { workspacePath: run, title: 'Human direct-work tester', worktreeMode: 'direct' });
  const workerRef = { adapter: copilot ? 'copilot-cli' : 'hyperneo', id: worker.sessionId };
  const at = Date.now();
  todos.openAsk({ id: askId, title: 'Blue summary', request: 'Keep this matter current', projectId: null, sessionId: root.sessionId, originMessageId: null, createdAt: at });
  const todo = todos.addTodo('completed-worker-todo', askId, { title: 'Prior completed work', doneWhen: 'Recorded', instruction: null, named: null, check: null }, at);
  sessions.create(todo.id, { verb: 'adopt', ref: workerRef });
  sessions.recordRef(todo.id, workerRef, at);
  sessions.recordFollowAnchor(todo.id, at);
  todos.updateTodo(todo, { state: 'done', finishedAt: at }, at);
  await Bun.sleep(20);
  if (copilot) {
    writeFileSync(join(run, 'human-request.json'), JSON.stringify({ text: human, earlierInputs: mode.includes('busy') ? 60 : 0 }));
    observed.humanSend = { boundary: 'synthetic native CLI human input; no daemon work.send', text: human };
    await wait('Copilot fixture emitted the human turn', () => existsSync(join(run, 'human-emitted')));
  } else {
    observed.humanSend = await hub.request('message.send', { sessionId: worker.sessionId, content: human });
    await wait('real worker turn completed', () => app.db.getDatabase().prepare("SELECT 1 FROM sdk_messages WHERE session_id=? AND message_type='result'").get(worker.sessionId) != null);
  }
  observed.workerStatus = await hub.request('operation.invoke', { name: 'work.status', input: { ref: workerRef, since: at } });
  await refresh();
  if (mode.endsWith('before')) {
    await Bun.sleep(500);
    assert.equal(toolCalls, 0);
    if (mode.includes('busy')) {
      assert(bodies.some((body) => text(body).includes('The human worked directly')));
      assert(!bodies.some((body) => text(body).includes('The human said: ' + human)));
      observed.reproduced = 'Newest human input lost attribution after 60 earlier inputs; no correct same-ask todo';
    } else observed.reproduced = 'Human turn in completed tracked worker reached no Neo model request';
  } else {
    await wait('Neo records direct human work as a todo', () => todos.listTodos(askId).some((item) => item.title === newTitle));
    assert.equal(toolCalls, 1);
    await wait('Neo completes the MCP turn', () => app.db.getDatabase().prepare("SELECT 1 FROM sdk_messages WHERE session_id=? AND message_type='result'").get(root.sessionId) != null);
    const count = bodies.length;
    await refresh();
    await refresh();
    await Bun.sleep(1000);
    assert.equal(toolCalls, 1);
    assert.equal(bodies.length, count, 're-observation must not create another model request');
    observed.passed = true;
  }
  Object.assign(observed, { toolCalls, reports, todos: todos.listTodos(askId), neoReceivedHumanInput: bodies.some((body) => text(body).includes('The human said: ' + human)), neoReceivedWorkerReply: bodies.some((body) => text(body).includes('The worker replied: ' + reply)), dispatchRows: sessions.inputs.list(todo.id).length });
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
  writeFileSync(join(run, 'evidence/model-bodies.json'), JSON.stringify(bodies, null, 2));
  await transport.close();
  await app.cleanup();
  model.stop(true);
  QueryOptionsBuilder.prototype.build = build;
  if (copilot && existsSync(join(run, 'calls.jsonl'))) {
    const calls = readFileSync(join(run, 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert(calls.every((call) => !call.secretPresent), 'provider credentials must not reach the Copilot peer');
    const pids = [...new Set(calls.map((call) => call.pid))];
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), /ESRCH/);
    writeFileSync(join(run, 'evidence/copilot-calls.json'), JSON.stringify(calls, null, 2));
  }
}
console.log(JSON.stringify(observed));
