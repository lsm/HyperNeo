import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { QueryOptionsBuilder } from '../../../packages/daemon/src/lib/agent/query-options-builder.ts';
import { ProviderService } from '../../../packages/daemon/src/lib/provider-service.ts';
import { sdkNeoWakeQueue } from '../../../packages/daemon/src/storage/repositories/sdk-message-transactions.ts';

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
const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
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
const sessionEnv = ProviderService.prototype.resolveSessionProviderEnvVars;
const modelEnv = ProviderService.prototype.getEnvVarsForModel;
ProviderService.prototype.resolveSessionProviderEnvVars = async function (...args) {
  return { ...await sessionEnv.apply(this, args), ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.port}` };
};
ProviderService.prototype.getEnvVarsForModel = async function (...args) {
  return { ...await modelEnv.apply(this, args), ANTHROPIC_BASE_URL: `http://127.0.0.1:${model.port}` };
};
QueryOptionsBuilder.prototype.build = async function (...args) {
  const options = await build.apply(this, args);
  return { ...options, sandbox: { enabled: false } };
};
const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true, disableGoalProcessing: true }, verbose: false });
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
hub.registerTransport(transport);

const dist = resolve('packages/web/dist');
const web = Bun.serve({ hostname: '127.0.0.1', port: 0,
  websocket: createWebSocketHandlers(app.transport, app.sessionManager),
  async fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === '/ws') {
      if (server.upgrade(request, { data: { connectionSessionId: 'global', device: await app.authenticateUpgrade(request, '127.0.0.1') } })) return;
      return new Response('Upgrade failed', { status: 500 });
    }
    const file = Bun.file(join(dist, path === '/neo' || path.startsWith('/neo/') ? 'neo/index.html' : path));
    return await file.exists() ? new Response(file) : new Response('Not found', { status: 404 });
  },
});
try {
  assert.notEqual(app.server.port, 8399);
  assert.notEqual(web.port, 8399);
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
  assert(ready());
  const observed: Record<string, unknown>[] = [];
  const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6kXcAAAAASUVORK5CYII=';
  for (const large of [false, true]) {
    const tag = large ? 'large' : 'small';
    const notes = Array.from({ length: large ? 35 : 2 }, (_, index) => `${tag} worker note ${String(index).padStart(2, '0')} ${large ? 'x'.repeat(2048) : ''}`);
    const noteIds: string[] = [];
    for (const [index, text] of notes.entries()) {
      const input = !large && index === 0
        ? { sessionId: root, message: { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } }] } }, from: 'session:synthetic-worker' }
        : { to: root, text, from: 'session:synthetic-worker' };
      const receipt = await hub.request<{kind:string;messageId:string}>('operation.invoke', { name: 'message.send', input });
      assert.equal(receipt.kind, 'accepted');
      noteIds.push(receipt.messageId);
    }
    if (process.argv.includes('--automatic')) {
      const heldDeadline = Date.now() + 15000;
      while (Date.now() < heldDeadline && !app.jobQueue.getLatestByPayload('neo_notes', { messageUuid: noteIds.at(-1) })) await Bun.sleep(25);
      assert(app.jobQueue.getLatestByPayload('neo_notes', { messageUuid: noteIds.at(-1) }));
      if (large) await app.db.getSDKMessageRepo().runWrite(sdkNeoWakeQueue, { flush: Date.now() + 15 * 60_000 });
      else assert.equal((await hub.request<{kind:string}>('operation.invoke', { name: 'message.send', input: { to: root, from: 'session:synthetic-worker', kind: 'blocked', text: 'Automatic wake decision needed.' } })).kind, 'accepted');
      const automaticDeadline = Date.now() + 45000;
      let consumed = false;
      while (Date.now() < automaticDeadline) {
        const id = app.jobQueue.getLatestByPayload('neo_notes', { messageUuid: noteIds[0] })?.payload.neoBatchUuid;
        consumed = typeof id === 'string' && !!app.db.getMessageByStatusAndUuid(root, 'consumed', id);
        if (consumed && app.sessionManager.getCachedSession(root)?.getProcessingState().status === 'idle') break;
        await Bun.sleep(100);
      }
      assert(consumed, 'automatic wake must deliver the worker batch before human input');
    }
    const requestId = crypto.randomUUID();
    const human = `  Human ${tag}: keep these exact words inline.\n第二行。  `;
    assert((await hub.request<{ok:boolean}>('operation.invoke', { name: 'neo.message.send', input: { sessionId: root, requestId, content: human } })).ok);
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && (!app.db.getMessageByStatusAndUuid(root, 'consumed', requestId) || app.sessionManager.getCachedSession(root)?.getProcessingState().status !== 'idle')) await Bun.sleep(100);
    assert(app.db.getMessageByStatusAndUuid(root, 'consumed', requestId));
    await Bun.sleep(500);
    const rows = app.db.getSDKMessageRepo().getSDKMessages(root, 100).messages;
    const batch = rows.find((row) => row.type === 'user' && row.uuid !== requestId && JSON.stringify(row.message.content).includes(`${tag} worker note 00`));
    const humanPrompt = app.db.getSDKMessageRepo().getDeliveryContent(root, requestId)!;
    const stored = app.db.getSDKMessageRepo().getStoredPromptsByUuid(root, requestId)[0];
    assert(stored.type === 'user');
    const sameHuman = JSON.stringify(humanPrompt.content) === JSON.stringify(stored.message.content);
    const page = await hub.request<{items:{role:string;message?:{messageId:string;text:string;fromName:string;kind:string};ask?:{requestId:string}}[]}>('operation.invoke', { name: 'neo.conversation.read', input: { conversationId: root.slice(4), limit: 100 } });
    const batchAt = page.items.findIndex((item) => item.role === 'session' && item.message?.messageId === batch?.uuid);
    const humanAt = page.items.findIndex((item) => item.role === 'human' && item.ask?.requestId === requestId);
    const requests = coordinatorBodies as {messages:{role:string;content:unknown}[]}[];
    const inlineAtModel = requests.some((body) => body.messages.some((message) => message.role === 'user' && JSON.stringify(message.content).includes(human.trim().split('\n')[0])));
    let workerFileExcludesHuman = !large;
    let allWorkerNotesInFile = !large;
    let publicReferenceMatchesModel = !large;
    if (large) {
      let reference: unknown;
      for (const request of requests) for (const message of request.messages) {
        if (message.role !== 'user') continue;
        const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content) }];
        for (const block of blocks) for (const line of (block.text ?? '').split('\n')) {
          try { const value = JSON.parse(line); if (value.handoffFiles) reference = value.handoffFiles[0]; } catch {}
        }
      }
      assert(reference, 'oversized delivery must use a handoff reference');
      publicReferenceMatchesModel = batchAt >= 0 && page.items[batchAt].message!.text.includes(JSON.stringify(reference));
      const chunks: Buffer[] = [];
      let offset = 0;
      for (;;) {
        const read = await hub.request<{kind:string;data:string;nextOffset:number;complete:boolean}>('operation.invoke', { name: 'handoff.read', input: { reference, offset } });
        assert.equal(read.kind, 'read');
        chunks.push(Buffer.from(read.data, 'base64'));
        if (read.complete) break;
        offset = read.nextOffset;
      }
      const restored = Buffer.concat(chunks).toString();
      writeFileSync(join(run, 'evidence/worker-handoff.json'), restored);
      workerFileExcludesHuman = !restored.includes(human.trim().split('\n')[0]);
      let previous = -1;
      allWorkerNotesInFile = notes.every((note) => { const at = restored.indexOf(note); const next = at > previous; previous = at; return next; });
    }
    observed.push({ size: tag, separateTranscriptInput: !!batch, humanDeliveryUnchanged: sameHuman, humanInlineAtModel: inlineAtModel, workerFileExcludesHuman, allWorkerNotesInFile, publicBatchBeforeHuman: batchAt >= 0 && batchAt < humanAt, publicSystemLabel: batchAt >= 0 && page.items[batchAt].message?.fromName === 'System-forwarded worker messages' });
    const snapshot = await hub.request<{sessionMessages:{messageId:string;text:string;kind:string}[]}>('operation.invoke', { name: 'neo.snapshot', input: {} });
    const snapshotBatch = snapshot.sessionMessages.find((message) => message.messageId === batch?.uuid);
    const persisted = app.db.getDatabase().prepare('SELECT text FROM neo_session_messages WHERE message_id=?').get(batch?.uuid ?? '') as {text:string} | null;
    Object.assign(observed.at(-1)!, {
      publicPayloadBounded: batchAt >= 0 && Buffer.byteLength(JSON.stringify(page.items[batchAt].message)) <= 65536,
      persistedPublicTextBounded: !!persisted && Buffer.byteLength(persisted.text) <= 65536,
      snapshotBatchBounded: !!snapshotBatch && Buffer.byteLength(JSON.stringify(snapshotBatch)) <= 65536,
      snapshotBatchKind: !!snapshotBatch && snapshotBatch.kind === 'worker-batch',
      publicReferenceMatchesModel,
    });
    if (!large) Object.assign(observed.at(-1)!, {
      workerImageDelivered: !!batch && JSON.stringify(batch.message.content).includes(imageData) && requests.some((body) => JSON.stringify(body.messages).includes(imageData)),
      publicWorkerTextOnly: batchAt >= 0 && !page.items[batchAt].message!.text.includes(imageData) && !page.items[batchAt].message!.text.includes('"type":"image"'),
    });
    writeFileSync(join(run, `evidence/${tag}-conversation.json`), JSON.stringify(page, null, 2));
  }
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
  const url = `http://127.0.0.1:${web.port}/neo`;
  writeFileSync(join(run, 'evidence/web.json'), JSON.stringify({ url, root }));
  console.log(JSON.stringify({ url, observed }));
  if (process.argv.includes('--hold-ui')) {
    const deadline = Date.now() + 120000;
    while (!existsSync(join(run, 'finish-ui')) && Date.now() < deadline) await Bun.sleep(100);
  }
  assert(observed.every((row) => Object.entries(row).every(([key, value]) => key === 'size' || value === true)), 'worker batches must be separate, visible and leave human input inline');
} finally {
  await transport.close();
  web.stop(true);
  await app.cleanup();
  model.stop(true);
  QueryOptionsBuilder.prototype.build = build;
  ProviderService.prototype.resolveSessionProviderEnvVars = sessionEnv;
  ProviderService.prototype.getEnvVarsForModel = modelEnv;
}

