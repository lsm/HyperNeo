process.env.HYPERNEO_SPACE ??= 'on';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { CLIENT_EVENT_SCHEMAS } from '../../../packages/daemon/src/lib/operations/client-event-schemas.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const directory of ['workspace', 'bin', 'evidence']) mkdirSync(join(run, directory), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const network = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert(['127.0.0.1', 'localhost'].includes(url.hostname), 'external requests disabled');
  return network(input, init);
}) as typeof fetch;
let failAudio = false;
const frames: Record<string, unknown[]> = {};
const evidence: Record<string, unknown> = { passed: false };
const hub = new MessageHub({ defaultSessionId: 'global' });
for (const name of Object.keys(CLIENT_EVENT_SCHEMAS)) hub.onEvent(name, data => (frames[name] ??= []).push(data));
const wait = async (check: () => boolean, label: string) => {
  for (let index = 0; index < 500 && !check(); index++) await new Promise(done => setTimeout(done, 20));
  assert(check(), label);
};
const operation = <T>(name: string, input: unknown) => hub.request<T>('operation.invoke', { name, input });
const speechTypes = () => (frames['neo.speech'] ?? []).map(frame => (frame as { type: string }).type);
let stopAudio = () => {};
let stopAsr = () => {};
let closeDaemon = async () => {};
let closeClient = async () => {};
try {
const audio = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => failAudio
  ? new Response('synthetic failure', { status: 503 })
  : new Response(Buffer.alloc(3840), { headers: { 'content-type': 'audio/pcm' } }) });
stopAudio = () => { audio.stop(true); };
const asr = Bun.serve({ hostname: '127.0.0.1', port: 0,
  fetch(request, server) { return server.upgrade(request) ? undefined : new Response('synthetic ASR'); },
  websocket: { message(ws, data) {
    const final = typeof data === 'string' && data.includes('CloseStream');
    if (typeof data !== 'string' || final) ws.send(JSON.stringify({ type: 'Results', is_final: final, channel: { alternatives: [{ transcript: 'Public event fixture' }] } }));
    if (final) ws.close();
  } },
});
stopAsr = () => { asr.stop(true); };
process.env.HYPERNEO_SPEECH_URL = audio.url.origin;
const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true }, verbose: false });
closeDaemon = () => app.cleanup();
const transport = new WebSocketClientTransport({ url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
closeClient = () => transport.close();
hub.registerTransport(transport);
  assert.notEqual(app.server.port, 8399);
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  const sessionId = 'neo:10000000-0000-4000-8000-000000000001';
  await app.db.createSession({ id: sessionId, title: 'Public payload fixture', workspacePath: join(run, 'workspace'), createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active', config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  new NeoRepository(app.db.getDatabase()).reserveBinding({ sessionId, kind: 'neo', projectId: null });
  await transport.initialize();
  await hub.request('channel.join', { channel: 'session:conv:public-event-fixture' });
  await app.stateManager.broadcastSessionStateChange('conv:public-event-fixture');
  await hub.request('settings.global.update', { updates: { language: 'zh-Hans', voice: { enabled: true, endpoint: `${audio.url.origin}/v1/audio/transcriptions`, streamEndpoint: `ws://127.0.0.1:${asr.port}/v1/listen`, model: 'fixture', mode: 'streaming', streamProtocol: 'deepgram', allowPrivateNetwork: true } } });
  const mcp = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId, role: 'neo' }));
  const publication = await mcp({ name: 'neo.publication.publish', input: { requestId: 'public-event', verbatim: true, fullText: 'Public publication payload fixture.' } });
  assert(JSON.parse(publication.content[0].text).accepted, JSON.stringify(publication));
  const subscribed = await hub.request<{ ok: boolean }>('liveQuery.subscribe', { queryName: 'messages.bySession', params: [sessionId, 50], subscriptionId: 'phone-message-view' });
  assert(subscribed.ok);
  await wait(() => !!frames['liveQuery.snapshot']?.length, 'snapshot arrives');
  assert(await app.db.saveSDKMessage(sessionId, { type: 'user', uuid: '20000000-0000-4000-8000-000000000001', session_id: sessionId, parent_tool_use_id: null, message: { role: 'user', content: 'Public message payload' } }));
  await wait(() => !!frames['liveQuery.delta']?.length, 'message delta arrives');
  const started = await hub.request<{ streamId: string }>('voice.stream.start', { encoding: 'pcm16', sampleRate: 16_000 });
  assert(started.streamId);
  await hub.request('voice.stream.chunk', { streamId: started.streamId, audioBase64: Buffer.alloc(3200, 1).toString('base64') });
  await wait(() => !!frames['voice.stream.text']?.length, 'voice text arrives');
  await hub.request('voice.stream.stop', { streamId: started.streamId });
  const say = async (requestId: string) => {
    const response = await mcp({ name: 'neo.speech.say', input: { requestId, text: 'Public spoken payload' } });
    assert(JSON.parse(response.content[0].text).ok);
  };
  assert((await operation<{ ok: boolean }>('neo.speech.listen', { sessionId, enabled: true })).ok);
  await say('text');
  await wait(() => speechTypes().includes('say'), 'say arrives');
  assert((await operation<{ ok: boolean }>('neo.speech.listen', { sessionId, enabled: false })).ok);
  await wait(() => speechTypes().includes('stop'), 'stop arrives');
  assert((await operation<{ ok: boolean }>('neo.speech.listen', { sessionId, enabled: true, audio: true })).ok);
  await say('audio');
  await wait(() => speechTypes().includes('end'), 'audio completion arrives');
  failAudio = true;
  await say('failure');
  await wait(() => speechTypes().includes('failed'), 'audio failure arrives');
  const surface = JSON.parse(readFileSync(new URL('../../../api-surface.json', import.meta.url), 'utf8'));
  const phone = JSON.parse(readFileSync(new URL('../../../api-phone-methods.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(CLIENT_EVENT_SCHEMAS).sort(), phone.events);
  for (const [method, schema] of Object.entries(CLIENT_EVENT_SCHEMAS)) {
    await wait(() => !!frames[method]?.length, `${method} arrives`);
    assert(surface.events.includes(method));
    assert(surface.eventSchemas[method]);
    for (const frame of frames[method]) assert(schema.safeParse(frame).success, `${method}: ${JSON.stringify(schema.safeParse(frame))}`);
  }
  assert.deepEqual([...new Set(speechTypes())].sort(), ['audio', 'end', 'failed', 'say', 'stop']);
  assert((frames['liveQuery.delta'] as { added?: unknown[] }[]).some(frame => frame.added?.length));
  evidence.passed = true;
  evidence.realWebSocket = true;
  evidence.validatedFrames = Object.fromEntries(Object.entries(frames).map(([name, values]) => [name, values.length]));
  evidence.speechVariants = [...new Set(speechTypes())].sort();
  evidence.producers = ['real message subscription and repository mutation', 'settings RPC and session projection', 'MCP publication notification', 'speech RPC/MCP with local audio success/failure', 'voice RPC with local ASR'];
  evidence.limitations = ['Synthetic data and local audio/ASR; no physical phone or production GPU.', 'Query-specific row contents and additional state metadata remain open.'];
} finally {
  let cleaned = false;
  try {
    await closeClient(); hub.cleanup(); await closeDaemon(); cleaned = true;
  } finally {
    stopAudio(); stopAsr(); globalThis.fetch = network;
    evidence.resourcesStopped = cleaned; evidence.frames = frames;
    writeFileSync(join(run, 'evidence/api-events.json'), JSON.stringify(evidence, null, 2));
  }
}
console.log(JSON.stringify(evidence));
