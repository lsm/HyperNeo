import { handoffPromptToMailbox } from '../../../packages/daemon/src/lib/mailbox/handoff.ts';
import type { MailboxEntry } from '../../../packages/daemon/src/lib/mailbox/entry.ts';
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

  const ready = () => app.db.getDatabase().prepare("SELECT 1 FROM migration_markers WHERE key='sdk_message_bodies_copy_v1:complete'").get();
  const readyDeadline = Date.now() + 15000;
  while (!ready() && Date.now() < readyDeadline) await Bun.sleep(25);
  assert(ready(), 'startup body copy did not finish');
  const replies = [];
  for (let i = 0; i < 20; i++) replies.push(await hub.request('operation.invoke', { name: 'message.send', input: { to: root, text: `chatty-${String(i).padStart(2, '0')}`, from: 'session:synthetic-worker' } }));
  await Bun.sleep(2500);
  const burst = { accepted: replies.filter((r: unknown) => (r as {kind: string}).kind === 'accepted').length, neoTurns: modelTurns };
  writeFileSync(join(run, 'evidence/burst.json'), JSON.stringify(burst, null, 2));
  assert.equal(burst.accepted, 20, 'all chatty messages must be retained');
  assert.equal(burst.neoTurns, 0, 'free-form messages must wait');
  const queuedStatuses = [];
  for (const receipt of replies as { messageId: string }[]) queuedStatuses.push(await hub.request('operation.invoke', { name: 'message.status', input: { sessionId: root, messageId: receipt.messageId } }));
  writeFileSync(join(run, 'evidence/queued-statuses.json'), JSON.stringify(queuedStatuses));
  assert(queuedStatuses.every((value) => (value as {status: string}).status === 'queued'), 'parked messages must not report delivered');
  for (const kind of ['blocked', 'question']) {
    const before = modelTurns;
    await app.jobProcessor.stop();
    const receipt = await hub.request<{kind: string; messageId: string}>('operation.invoke', { name: 'message.send', input: { to: root, text: `Ordinary words for ${kind}`, kind, from: 'session:synthetic-worker' } });
    assert.equal(receipt.kind, 'accepted');
    const packet = app.jobQueue.listActiveByPayload('mailbox', { 'to.sessionId': root, messageUuid: receipt.messageId })[0].payload as unknown as MailboxEntry;
    app.jobProcessor.start();
    const deadline = Date.now() + 45000;
    const expected = before + (kind === 'blocked' ? 2 : 1);
    while ((modelTurns < expected || !app.db.getMessageByStatusAndUuid(root, 'consumed', receipt.messageId)) && Date.now() < deadline) await Bun.sleep(100);
    assert.equal(modelTurns, expected, `${kind} must start Neo immediately after its separate batch`);
    await Bun.sleep(1000);
    if (kind === 'blocked') {
      const source = app.db.getSDKMessageRepo().getStoredPromptsByUuid(root, receipt.messageId)[0];
      assert(source.type === 'user');
      assert.deepEqual(source.message.content, packet.message.message.content);
      const replay = await handoffPromptToMailbox({ to: `session:${encodeURIComponent(root)}`, origin: packet.origin, messageUuid: packet.messageUuid, message: packet.message, jobQueue: app.jobQueue });
      assert(replay.kind === 'enqueued');
      const retryJob = () => app.db.getDatabase().prepare("SELECT status,error FROM job_queue WHERE queue='mailbox' AND json_extract(payload, '$.id')=?").get(replay.id) as { status: string; error: string | null };
      const retryDeadline = Date.now() + 10000;
      while (retryJob().status !== 'completed' && !retryJob().error && Date.now() < retryDeadline) await Bun.sleep(50);
      writeFileSync(join(run, 'evidence/batch-retry.json'), JSON.stringify(retryJob()));
      assert.equal(retryJob().status, 'completed');
      assert.equal(retryJob().error, null);
      assert.equal(modelTurns, expected);
      const readStatuses = [];
      for (const note of replies as { messageId: string }[]) readStatuses.push(await hub.request('operation.invoke', { name: 'message.status', input: { sessionId: root, messageId: note.messageId } }));
      writeFileSync(join(run, 'evidence/read-statuses.json'), JSON.stringify(readStatuses));
      assert(readStatuses.every((value) => (value as { status: string }).status === 'delivered'));
    }
  }
  const firstRequest = JSON.stringify(coordinatorBodies[0]);
  let previous = -1;
  for (let i = 0; i < 20; i++) {
    const at = firstRequest.indexOf(`chatty-${String(i).padStart(2, '0')}`);
    assert(at > previous, 'the first model request must contain every queued note in order');
    previous = at;
  }
  assert(!firstRequest.includes('Ordinary words for blocked'));
  assert(JSON.stringify(coordinatorBodies[1]).includes('Ordinary words for blocked'));
  for (const text of ['human-queued-a', 'human-queued-b']) await hub.request('operation.invoke', { name: 'message.send', input: { to: root, text, from: 'session:synthetic-worker' } });
  const human = await hub.request<{ok: boolean}>('operation.invoke', { name: 'neo.message.send', input: { sessionId: root, requestId: crypto.randomUUID(), content: 'Human asks now.' } });
  assert(human.ok);
  const humanDeadline = Date.now() + 45000;
  while (modelTurns < 5 && Date.now() < humanDeadline) await Bun.sleep(100);
  assert.equal(modelTurns, 5);
  const workerRequest = JSON.stringify(coordinatorBodies[3]);
  assert(workerRequest.includes('human-queued-a') && !workerRequest.includes('Human asks now.'));
  const humanRequest = JSON.stringify(coordinatorBodies[4]);
  assert(humanRequest.includes('human-queued-a') && humanRequest.includes('human-queued-b') && humanRequest.includes('Human asks now.'));
  await Bun.sleep(1000);
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ burst, orderedNotesInFirstRequest: 20, blocked: 1, question: 1, humanWithPendingBatch: 1, finalTurns: modelTurns }));
  console.log(JSON.stringify({ burst, orderedNotesInFirstRequest: 20, blocked: 1, question: 1, humanWithPendingBatch: 1, finalTurns: modelTurns }));
} finally {
  await transport.close();
  await app.cleanup();
  model.stop(true);
  QueryOptionsBuilder.prototype.build = build;
}
