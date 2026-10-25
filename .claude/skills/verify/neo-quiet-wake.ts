import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { z } from '../../../packages/daemon/node_modules/zod/index.js';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createNeoService } from '../../../packages/daemon/src/lib/neo/packs/runtime.ts';
import { createOperationRegistry, defineOperation } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { readCodexTurn, type CodexThreadDetail } from '../../../packages/daemon/src/lib/drivers/codex-desktop-adapter.ts';
import { QueryOptionsBuilder } from '../../../packages/daemon/src/lib/agent/query-options-builder.ts';
import type { SessionManager } from '../../../packages/daemon/src/lib/session/session-manager.ts';

const run = resolve(process.argv[2] ?? '');
assert(process.argv[2] && process.env.NODE_ENV === 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'evidence'), { recursive: true });
mkdirSync(join(run, 'bin'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
process.env.PATH = `${run}/bin:${process.env.PATH}`;
let modelTurns = 0;
let modelRequests = 0;
const model = Bun.serve({ hostname: '127.0.0.1', port: 8000, async fetch(req) {
  if (new URL(req.url).pathname !== '/v1/messages') return Response.json({ data: [], has_more: false });
  const body = await req.json();
  writeFileSync(join(run, `evidence/model-${++modelRequests}.json`), JSON.stringify(body, null, 2));
  if (body.tools?.some((tool: { name: string }) => tool.name === 'mcp__hyperneo-operations__invoke')) modelTurns++;
  const start = { id: `msg_${modelTurns}`, type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-6', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
  const events = [
    ['message_start', { type: 'message_start', message: start }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Synthetic human reply.' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
} });
const build = QueryOptionsBuilder.prototype.build;
QueryOptionsBuilder.prototype.build = async function (...args) {
  const options = await build.apply(this, args);
  return { ...options, sandbox: { enabled: false } };
};
const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
hub.registerTransport(transport);
let service: ReturnType<typeof createNeoService> | undefined;
try {
  assert.notEqual(app.server.port, 8399);
  await transport.initialize();
  const { servers } = await hub.request<{ servers: { id: string }[] }>('mcp.registry.list', {});
  for (const server of servers) await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
  await hub.request('providers.create', { params: { providerId: 'anthropic', displayName: 'Loopback', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
  const opened = await hub.request<{ ok: boolean; sessionId: string }>('operation.invoke', { name: 'neo.open', input: {} });
  assert(opened.ok);
  const root = opened.sessionId;
  let turnEnds: Awaited<ReturnType<typeof readCodexTurn>>['turnEnds'] = [];
  const registry = createOperationRegistry([defineOperation({ name: 'work.status', description: 'Synthetic status source', inputSchema: z.unknown(), resultSchema: z.unknown(), policy: { safetyClass: 'read' }, execute: async () => ({ ok: true, value: { status: 'running', lastActivityAt: Date.now(), turnEnds } }) })]);
  service = createNeoService(app.db, { getOperationRegistry: () => registry } as unknown as SessionManager, app.messageHub, app.internalEventBus);
  const ref = { adapter: 'codex-desktop', id: 'synthetic-worker' };
  const now = Date.now();
  const ask = service.todos.openAsk({ id: 'synthetic-ask', projectId: null, sessionId: root, originMessageId: 'synthetic-origin', title: 'Discussion', request: 'Discuss', createdAt: now });
  const todo = service.todos.addTodo('synthetic-todo', ask.id, { title: 'Discuss', doneWhen: 'Human decides', instruction: null, named: null, check: null }, now);
  service.todos.updateTodo(todo, { state: 'doing', startedAt: now }, now);
  service.todoSessions.bind(todo.id, ref, now);
  const dispatch = await service.todoSessions.inputs.accept(todo.id, root, { verb: 'send', ref }, 'Discuss', now);
  await service.todoSessions.inputs.recordOutcome(dispatch, { ref }, now);
  const rolloutPath = join(run, 'rollout.jsonl');
  const heartbeat = '<heartbeat>\n<automation_id>reviewbot-test</automation_id>\n<decision>DONT_NOTIFY</decision>\n<message>TEST remains healthy</message>\n</heartbeat>';
  writeFileSync(rolloutPath, JSON.stringify({ type: 'event_msg', timestamp: new Date(now + 1).toISOString(), payload: { type: 'task_complete', turn_id: 'heartbeat', last_agent_message: heartbeat } }));
  turnEnds = (await readCodexTurn({ thread: { rolloutPath }, roots: [] } as unknown as CodexThreadDetail)).turnEnds;
  if (!process.argv.includes('--reproduce')) assert.equal(turnEnds?.[0].notify, false);
  await service.todoRunner.refresh((message, error) => { throw new Error(message, { cause: error }); });
  const heartbeatId = `neo-todo-turn:${todo.id}:${dispatch}:heartbeat`;
  if (process.argv.includes('--reproduce')) {
    const deadline = Date.now() + 15000;
    while (!modelTurns && Date.now() < deadline) await Bun.sleep(100);
    writeFileSync(join(run, 'evidence/reproduction.json'), JSON.stringify({ heartbeatNeoTurns: modelTurns, expected: 0 }, null, 2));
    assert.equal(modelTurns, 0, 'quiet heartbeat woke Neo');
  }
  assert(app.db.getSDKMessageRepo().findMessageIdByUuid(root, heartbeatId));
  await Bun.sleep(1500);
  assert.equal(modelTurns, 0);
  assert.equal(modelRequests, 0);
  service.todos.focusAsk(ask.id, { ...ref, name: 'Discussion', label: 'Discussion', provider: 'Codex', link: 'codex://threads/synthetic-worker' }, Date.now());
  turnEnds = [{ id: 'focused', at: now + 2, message: 'Prepared discussion.' }];
  await service.todoRunner.refresh((message, error) => { throw new Error(message, { cause: error }); });
  const focusedId = `neo-todo-turn:${todo.id}:${dispatch}:focused`;
  assert(app.db.getSDKMessageRepo().findMessageIdByUuid(root, focusedId));
  await Bun.sleep(1500);
  assert.equal(modelTurns, 0);
  assert.equal(modelRequests, 0);
  assert.equal(app.jobQueue.listActiveByPayload('mailbox', { 'to.sessionId': root }).length, 0);
  const requestId = crypto.randomUUID();
  const receipt = await hub.request<{ ok: boolean }>('operation.invoke', { name: 'neo.message.send', input: { sessionId: root, requestId, content: 'Hello from the synthetic human.' } });
  assert(receipt.ok);
  const deadline = Date.now() + 45000;
  const results = () => app.db.getDatabase().prepare("SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id=? AND message_type='result'").get(root) as { n: number };
  while (!results().n && Date.now() < deadline) await Bun.sleep(100);
  assert.equal(results().n, 1);
  assert.equal(modelTurns, 1);
  const observed = { daemonPort: app.server.port, heartbeat: { recorded: heartbeatId, neoTurns: 0 }, focusedStatus: { recorded: focusedId, neoTurns: 0 }, human: { requestId, neoTurns: modelTurns, results: results().n, totalRequestsIncludingTitle: modelRequests }, sandboxEnforcementVerified: false };
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
  console.log(JSON.stringify(observed));
} finally {
  service?.dispose();
  await transport.close();
  await app.cleanup();
  model.stop(true);
  QueryOptionsBuilder.prototype.build = build;
}
