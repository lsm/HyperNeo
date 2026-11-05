import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { QueryOptionsBuilder } from '../../../packages/daemon/src/lib/agent/query-options-builder.ts';
import { handoffPromptToMailbox } from '../../../packages/daemon/src/lib/mailbox/handoff.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const requests: { last: string; fact: string | undefined }[] = [];
let holdMarker = '', held = false, release = () => {};
let hold = Promise.resolve();
const pause = (marker: string) => {
  holdMarker = marker;
  held = false;
  hold = new Promise<void>(done => { release = done; });
};
const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  if (!new URL(request.url).pathname.endsWith('/v1/messages'))
    return Response.json({ data: [], has_more: false, input_tokens: 100 });
  const body = await request.json();
  const last = JSON.stringify(body.messages?.filter((m: { role: string }) => m.role === 'user').at(-1)?.content);
  if (body.tools?.length && last && (last.includes('VOICE_') || last.includes('The human is now listening.') || last.includes('The human stopped listening.'))) {
    requests.push({ last, fact: [...last.matchAll(/\[listening: (yes|no)\]/g)].at(-1)?.[1] });
    if (holdMarker && last.includes(holdMarker)) {
      holdMarker = '';
      held = true;
      await hold;
    }
  }
  const message = { id: `msg_${crypto.randomUUID()}`, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: 'Synthetic listening proof reply.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } };
  if (!body.stream) return Response.json(message);
  const events = [
    ['message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: message.content[0].text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } }],
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
const wait = async (label: string, ready: () => boolean) => {
  const deadline = Date.now() + 60000;
  while (!ready() && Date.now() < deadline) await Bun.sleep(50);
  assert(ready(), label);
  console.log(`Verified: ${label}`);
};
const observed: Record<string, unknown> = { daemonPort: app.server.port, modelPort: model.port, model: 'scripted local endpoint through the native SDK; model speech reasoning unverified', sandboxEnforcementVerified: false };
try {
  assert.notEqual(app.server.port, 8399);
  await transport.initialize();
  const { servers } = await hub.request<{ servers: { id: string }[] }>('mcp.registry.list', {});
  for (const server of servers) await hub.request('mcp.registry.setEnabled', { id: server.id, enabled: false });
  await hub.request('providers.create', { params: { providerId: 'anthropic', displayName: 'Loopback', kind: 'built_in', authType: 'api_key', isEnabled: true, isDefault: true, sortOrder: 0 }, credentials: { apiKey: 'sk-devproxy-test-key' } });
  const root = await hub.request<{ ok: boolean; sessionId: string }>('operation.invoke', { name: 'neo.open', input: {} });
  assert(root.ok);
  const operation = (name: string, input: unknown) => hub.request('operation.invoke', { name, input });
  const listen = (enabled: boolean) => operation('neo.speech.listen', { sessionId: root.sessionId, enabled });
  const send = (content: string, inputMode = 'text', speech = false, requestId = crypto.randomUUID()) => operation('neo.message.send', { sessionId: root.sessionId, requestId, content, inputMode, speech });
  const idle = () => app.sessionManager.getCachedSession(root.sessionId)?.getProcessingState().status === 'idle';
  await send('VOICE_TYPING');
  await wait('typing reaches native model input with no listening', () => requests.some(r => r.last.includes('VOICE_TYPING') && r.fact === 'no'));
  await wait('typing turn idle', idle);
  const count = requests.length;
  await listen(true);
  await listen(false);
  await Bun.sleep(600);
  assert.equal(requests.length, count, 'idle listener changes must not start a turn');
  pause('VOICE_CASE_4');
  await send('VOICE_CASE_4');
  await wait('typed turn processing before the switch', () => held);
  assert.equal(app.sessionManager.getCachedSession(root.sessionId)?.getProcessingState().status, 'processing');
  await listen(true);
  release();
  await wait('case 4 current yes reaches native SDK via immediate injection', () => requests.some(r => r.last.includes('The human is now listening.') && r.fact === 'yes'));
  await wait('case 4 idle', idle);
  pause('VOICE_CASE_5');
  await send('VOICE_CASE_5', 'live_voice', true);
  await wait('live turn processing before leaving', () => held);
  await listen(false);
  release();
  await wait('case 5 current no reaches native SDK', () => requests.some(r => r.last.includes('The human stopped listening.') && r.fact === 'no'));
  await wait('case 5 idle', idle);
  await listen(true);
  for (const marker of ['VOICE_WORKER_REPORT', 'VOICE_SCHEDULED_WAKE']) {
    const queued = await handoffPromptToMailbox({ to: `session:${root.sessionId}`, origin: 'session:synthetic-worker', messageUuid: crypto.randomUUID(), message: { type: 'user', parent_tool_use_id: null, inputKind: 'system', neoWakeEvent: true, message: { role: 'user', content: marker } }, deliveryMode: 'immediate', jobQueue: app.jobQueue });
    assert.equal(queued.kind, 'enqueued');
    await wait(`${marker} reaches the native SDK`, () => requests.some(r => r.last.includes(marker) && r.fact === 'yes'));
    const delivered = requests.find(r => r.last.includes(marker))!;
    assert(!delivered.last.includes('before time-consuming work'));
    await wait(`${marker} idle`, idle);
  }
  await listen(false);
  const requestId = crypto.randomUUID();
  await send('VOICE_RETRY', 'text', false, requestId);
  await wait('retry case delivered', () => requests.some(r => r.last.includes('VOICE_RETRY')));
  await wait('retry case idle', idle);
  const before = requests.length;
  await send('VOICE_RETRY', 'text', false, requestId);
  await Bun.sleep(600);
  assert.equal(requests.length, before, 'intake retry must not replay prior input');
  Object.assign(observed, { passed: true, cases: [1, 4, 5, 6, 11], idleDoesNotWake: true, noReplay: true });
} finally {
  release();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ ...observed, requests }, null, 2));
  await transport.close();
  await app.cleanup();
  model.stop(true);
  QueryOptionsBuilder.prototype.build = build;
}
console.log(JSON.stringify(observed));
