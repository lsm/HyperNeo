import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { createOperationRpcHandler } from '../../../packages/daemon/src/lib/operations/rpc-adapter.ts';
import { readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
copyFileSync(new URL('./gh-stub.sh', import.meta.url), join(run, 'bin/gh'));
chmodSync(join(run, 'bin/gh'), 0o700);
const secret = 'synthetic-saved-voice-key';
let failRecorded = false, failLive = false, recorded = 0, live = 0, bytes = 0;
const service = createServer((request, response) => {
  recorded++;
  request.resume();
  response.writeHead(failRecorded ? 401 : 200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(failRecorded ? { error: { message: `Unauthorized: ${secret}` } } : { text: 'heard' }));
});
const sockets = new WebSocketServer({ noServer: true });
service.on('upgrade', (request, socket, head) => {
  live++;
  if (failLive) {
    const body = `Unauthorized: ${secret}`;
    socket.end(`HTTP/1.1 401 Unauthorized\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  } else sockets.handleUpgrade(request, socket, head, (peer) => {
    peer.on('message', (message, binary) => {
      if (binary) bytes += message.length;
      else if (JSON.parse(message.toString()).type === 'CloseStream') peer.close(1000);
    });
  });
});
await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
const address = service.address();
assert(address && typeof address !== 'string');
const app = await createDaemonApp({
  config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true },
  verbose: false,
});
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  const registry = app.sessionManager.getOperationRegistry();
  const rpc = createOperationRpcHandler(registry, () => ({}));
  const voice = {
    enabled: true, mode: 'batch', allowPrivateNetwork: true,
    endpoint: `http://127.0.0.1:${address.port}/transcribe`, model: 'fixture',
    live: { provider: 'deepgram', endpoint: `ws://127.0.0.1:${address.port}/listen` },
    speech: { provider: 'openai', endpoint: 'https://other.example' },
  };
  const ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`, {
    headers: { authorization: `Bearer ${await readLocalCredential()}` },
  } as unknown as string[]);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  try {
    const saved = new Promise<unknown>((resolve, reject) => {
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.requestId !== 'save' && message.id !== 'save') return;
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.data);
      };
    });
    ws.send(JSON.stringify({ id: 'save', type: 'REQ', sessionId: 'global', method: 'settings.global.update', data: { updates: { voice: { ...voice, hostKey: { host: 'other.example', apiKey: secret } } } }, timestamp: new Date().toISOString(), version: '1.0.0' }));
    assert(!JSON.stringify(await saved).includes(secret));
  } finally { ws.close(); }
  const rows = app.db.getDatabase().prepare("SELECT payload FROM job_queue WHERE queue='mailbox' AND payload LIKE '%voice key was saved%'").all() as { payload: string }[];
  assert.equal(rows.length, 1);
  assert(rows[0]!.payload.includes('other.example'));
  assert(!rows[0]!.payload.includes(secret));
  const root = await rpc({ name: 'neo.open', input: {} }, { messageId: 'proof', sessionId: 'global', method: 'operation.invoke', timestamp: 'proof' });
  assert(root.sessionId);
  const mcp = createOperationMcpHandler(registry, () => ({ sessionId: root.sessionId, role: 'neo' }));
  const call = async (name: string) => {
    const reply = await mcp({ name, input: {} });
    assert.equal(reply.isError, undefined, JSON.stringify(reply));
    return JSON.parse(reply.content[0].text);
  };
  assert.deepEqual(await call('voice.testConnection'), { ok: true });
  assert.deepEqual(await call('voice.testLive'), { ok: true });
  failRecorded = true;
  const recordedFailure = await call('voice.testConnection');
  assert.equal(recordedFailure.ok, false);
  assert.match(recordedFailure.reason, /401/);
  assert(recordedFailure.reason.includes('[key]'));
  failLive = true;
  const liveFailure = await call('voice.testLive');
  assert.equal(liveFailure.ok, false);
  assert.match(liveFailure.reason, /401/);
  assert(liveFailure.reason.includes('[key]'));
  assert.equal(recorded, 2);
  assert.equal(live, 2);
  assert.equal(bytes, 32000);
  const evidence = { recordedFailure, liveFailure, recorded, live, bytes, keySaveWake: rows.length };
  writeFileSync(join(run, 'evidence/voice-test-input.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await app.cleanup();
  for (const peer of sockets.clients) peer.terminate();
  await new Promise<void>((resolve) => sockets.close(() => resolve()));
  await new Promise<void>((resolve) => service.close(() => resolve()));
}
