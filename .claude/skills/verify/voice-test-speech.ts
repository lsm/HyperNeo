import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { ProviderCredentialManager } from '../../../packages/daemon/src/lib/credentials/provider-credential-manager.ts';
import { withVoiceCredentialLock } from '../../../packages/daemon/src/lib/rpc-handlers/voice-credential-lock.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
copyFileSync(new URL('./gh-stub.sh', import.meta.url), join(run, 'bin/gh'));
chmodSync(join(run, 'bin/gh'), 0o700);
let failing = false;
let requests = 0;
const secret = 'synthetic-saved-voice-key';
const newSecret = 'synthetic-new-voice-key';
let hold: Promise<void> | undefined;
let started: (() => void) | undefined;
const tts = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    assert.equal(new URL(request.url).pathname, '/v1/audio/speech');
    const body = await request.json() as { input: string; response_format: string };
    assert(body.input.length > 0);
    assert.equal(body.response_format, 'pcm');
    requests++;
    started?.();
    await hold;
    return failing
      ? new Response(`Unauthorized: ${secret} ${newSecret}`, { status: 401 })
      : new Response(new Uint8Array([1, 0, 2, 0]), { headers: { 'content-type': 'audio/pcm' } });
  },
});
const app = await createDaemonApp({
  config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true },
  verbose: false,
});
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await app.settingsManager.updateGlobalSettingsAsync({
    voice: { enabled: true, endpoint: '', model: '', speech: { provider: 'openai', endpoint: `http://127.0.0.1:${tts.port}` } },
  });
  await ProviderCredentialManager.create(app.db.getDatabase()).storeApiKey('voice-transcription:other.example', secret);
  const registry = app.sessionManager.getOperationRegistry();
  const mcp = createOperationMcpHandler(registry, () => ({ sessionId: 'synthetic-neo', role: 'neo' }));
  const call = async () => {
    const reply = await mcp({ name: 'voice.testSpeech', input: {} });
    assert.equal(reply.isError, undefined);
    return JSON.parse(reply.content[0].text);
  };
  const success = await call();
  assert.deepEqual(success, { ok: true });
  failing = true;
  const failure = await call();
  assert.equal(failure.reason.includes(secret), false);
  let release!: () => void;
  hold = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  const pending = call();
  await waiting;
  try {
    await Promise.race([
      withVoiceCredentialLock(() => ProviderCredentialManager.create(app.db.getDatabase()).storeApiKey('voice-transcription:new.example', newSecret)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('credential write blocked')), 1000)),
    ]);
  } finally {
    release();
  }
  const concurrent = await pending;
  assert.deepEqual(concurrent, { ok: false, reason: 'HTTP 401: Unauthorized: [key] [key]' });
  assert.equal(requests, 3);
  const evidence = { success, concurrent, requests };
  writeFileSync(join(run, 'evidence/voice-test-speech.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await app.cleanup();
  await tts.stop(true);
}
