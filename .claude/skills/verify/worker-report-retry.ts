import { handoffPromptToMailbox } from '../../../packages/daemon/src/lib/mailbox/handoff.ts';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { QueryOptionsBuilder } from '../../../packages/daemon/src/lib/agent/query-options-builder.ts';

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

try {
  assert.notEqual(app.server.port, 8399);
  await transport.initialize();
  const { servers } = await hub.request<{ servers: { id: string }[] }>('mcp.registry.list', {});
  for (const server of servers) await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
  await hub.request('providers.create', { params: { providerId: 'anthropic', displayName: 'Loopback', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
  const opened = await hub.request<{ ok: boolean; sessionId: string }>('operation.invoke', { name: 'neo.open', input: {} });
  assert(opened.ok);
  const root = opened.sessionId;
  const args = { to: `session:${encodeURIComponent(root)}`, origin: 'session:synthetic-worker', messageUuid: crypto.randomUUID(), jobQueue: app.jobQueue };
  const message = { type: 'user' as const, parent_tool_use_id: null, inputKind: 'task' as const, workerReportKind: 'done' as const, message: { content: 'Synthetic identical worker report.' } };
  await handoffPromptToMailbox({ ...args, message });
  const firstDeadline = Date.now() + 45000;
  const results = () => (app.db.getDatabase().prepare("SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id=? AND message_type='result'").get(root) as { n: number }).n;
  while (!results() && Date.now() < firstDeadline) await Bun.sleep(100);
  assert.equal(results(), 1);
  const retry = await handoffPromptToMailbox({ ...args, message: { ...message, workerReportKind: 'blocked' } });
  assert.equal(retry.kind, 'enqueued');
  if (retry.kind !== 'enqueued') throw new Error(retry.reason);
  const job = () => app.db.getDatabase().prepare("SELECT status,error FROM job_queue WHERE queue='mailbox' AND json_extract(payload, '$.id')=?").get(retry.id) as {status: string; error: string | null};
  const retryDeadline = Date.now() + 10000;
  while (job().status !== 'completed' && !job().error && Date.now() < retryDeadline) await Bun.sleep(50);
  const historyRows = (app.db.getDatabase().prepare('SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id=? AND sdk_uuid=?').get(root, args.messageUuid) as { n: number }).n;
  const observed = { retry: job(), coordinatorTurns: modelTurns, results: results(), historyRows };
  assert.equal(historyRows, 1);
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
  assert.equal(observed.retry.error, null);
  assert.equal(observed.retry.status, 'completed');
  await Bun.sleep(1000);
  assert.equal(modelTurns, 1);
  assert.equal(results(), 1);
  console.log(JSON.stringify(observed));
} finally {
  await transport.close();
  await app.cleanup();
  model.stop(true);
  QueryOptionsBuilder.prototype.build = build;
}
