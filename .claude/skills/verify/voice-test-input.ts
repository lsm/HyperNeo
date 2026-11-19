import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { ProviderCredentialManager } from '../../../packages/daemon/src/lib/credentials/provider-credential-manager.ts';

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
    peer.on('message', (message, binary) => { if (binary) bytes += message.length; });
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
  await app.settingsManager.updateGlobalSettingsAsync({ voice: {
    enabled: true, mode: 'batch', allowPrivateNetwork: true,
    endpoint: `http://127.0.0.1:${address.port}/transcribe`, model: 'fixture',
    live: { provider: 'deepgram', endpoint: `ws://127.0.0.1:${address.port}/listen` },
  } });
  await ProviderCredentialManager.create(app.db.getDatabase()).storeApiKey('voice-transcription:other.example', secret);
  const mcp = createOperationMcpHandler(app.sessionManager.getOperationRegistry(), () => ({ sessionId: 'synthetic-neo', role: 'neo' }));
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
  const evidence = { recordedFailure, liveFailure, recorded, live, bytes };
  writeFileSync(join(run, 'evidence/voice-test-input.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await app.cleanup();
  for (const peer of sockets.clients) peer.terminate();
  await new Promise<void>((resolve) => sockets.close(() => resolve()));
  await new Promise<void>((resolve) => service.close(() => resolve()));
}
