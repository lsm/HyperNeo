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
const coordinatorBodies: unknown[] = [];
let modelTurns = 0;
let modelRequests = 0;
const model = Bun.serve({ hostname: '127.0.0.1', port: 8000, async fetch(req) {
  if (new URL(req.url).pathname !== '/v1/messages') return Response.json({ data: [], has_more: false });
  const body = await req.json();
  writeFileSync(join(run, `evidence/model-${++modelRequests}.json`), JSON.stringify(body, null, 2));
  if (body.tools?.some((tool: { name: string }) => tool.name === 'mcp__hyperneo-operations__invoke')) { modelTurns++; coordinatorBodies.push(body); }
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

  const receipts = [];
  for (let i = 0; i < 120; i++) receipts.push(await hub.request<{kind: string}>('operation.invoke', { name: 'message.send', input: { to: root, text: `large-note-${String(i).padStart(3, '0')} ${'x'.repeat(2048)}`, from: 'session:synthetic-worker' } }));
  assert(receipts.every((value) => value.kind === 'accepted'));
  await hub.request('operation.invoke', { name: 'message.send', input: { to: root, text: 'Bounded blocker', kind: 'blocked', from: 'session:synthetic-worker' } });
  const deadline = Date.now() + 45000;
  while (coordinatorBodies.length < 2 && Date.now() < deadline) await Bun.sleep(100);
  assert.equal(coordinatorBodies.length, 2);
  const request = coordinatorBodies[0] as { messages: {role: string; content: unknown}[] };
  const content = request.messages.filter((message) => message.role === 'user').at(-1)!.content;
  const bytes = Buffer.byteLength(JSON.stringify(content));
  writeFileSync(join(run, 'evidence/bounds.json'), JSON.stringify({ accepted: receipts.length, promptBytes: bytes, maxBytes: 65536 }));
  assert(bytes <= 65536, `batch prompt is unbounded: ${bytes} bytes`);
  const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content) }];
  let reference: unknown;
  for (const block of blocks as { type?: string; text?: string }[]) for (const line of (block.text ?? '').split('\n')) {
    try { const value = JSON.parse(line); if (value.handoffFiles) reference = value.handoffFiles[0]; } catch {}
  }
  assert(reference, 'model prompt must carry the complete handoff reference');
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const read = await hub.request<{ kind: string; data: string; nextOffset: number; complete: boolean }>('operation.invoke', { name: 'handoff.read', input: { reference, offset } });
    assert.equal(read.kind, 'read');
    chunks.push(Buffer.from(read.data, 'base64'));
    if (read.complete) break;
    assert(read.nextOffset > offset);
    offset = read.nextOffset;
  }
  const restored = Buffer.concat(chunks).toString();
  let previous = -1;
  for (let i = 0; i < 120; i++) {
    const at = restored.indexOf(`large-note-${String(i).padStart(3, '0')} ${'x'.repeat(2048)}`);
    assert(at > previous, 'every original note and byte must survive in order');
    previous = at;
  }
  assert(!restored.includes('Bounded blocker'));
  const resultDeadline = Date.now() + 10000;
  const resultCount = () => (app.db.getDatabase().prepare("SELECT COUNT(*) AS n FROM sdk_messages WHERE session_id=? AND message_type='result'").get(root) as {n: number}).n;
  while (resultCount() < 2 && Date.now() < resultDeadline) await Bun.sleep(100);
  assert.equal(resultCount(), 2);
  assert.equal(coordinatorBodies.length, 2);
  assert(JSON.stringify(coordinatorBodies[1]).includes('Bounded blocker'));;
  const observed = { accepted: receipts.length, promptBytes: bytes, restoredBytes: Buffer.byteLength(restored), restoredNotes: 120, hashVerifiedRead: true, coordinatorTurns: modelTurns };
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed));
  console.log(JSON.stringify(observed));
} finally {
  await transport.close();
  await app.cleanup();
  model.stop(true);
  QueryOptionsBuilder.prototype.build = build;
}
