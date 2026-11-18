import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pcm16Wav } from '../../../packages/daemon/src/lib/voice/stream-relay.ts';

const port = process.env.VERIFY_PORT ?? '';
assert(/^[1-9]\d{0,4}$/.test(port) && Number(port) <= 65535 && port !== '8399', 'bad VERIFY_PORT');
assert.equal(process.env.NODE_ENV, 'test', 'run with NODE_ENV=test');
assert(process.env.RUN && existsSync(process.env.RUN), 'set RUN to the owned verify run');
const run = realpathSync(process.env.RUN);
assert(existsSync(join(run, 'daemon.pid')), 'RUN has no daemon launched by launch.sh');
assert.equal(
  realpathSync(process.env.HYPERNEO_DATA_DIR ?? run),
  join(run, 'data'),
  'HYPERNEO_DATA_DIR must be the data directory of RUN'
);
assert(!process.env.HYPERNEO_SPEECH_URL, 'run without the environment speech base');
const { readLocalCredential } = await import(
  '../../../packages/daemon/src/lib/pairing/local-credential.ts'
);
const requests: { path: string; type: string | null; riff: boolean }[] = [];
const deepgram = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const body = new Uint8Array(await request.arrayBuffer());
    requests.push({
      path: url.pathname + url.search,
      type: request.headers.get('content-type'),
      riff: new TextDecoder().decode(body.subarray(0, 4)) === 'RIFF',
    });
    if (url.pathname === '/v1/listen')
      return Response.json({
        results: { channels: [{ alternatives: [{ transcript: 'deepgram heard' }] }] },
      });
    return Response.json({ tts: [{ canonical_name: 'aura-2-thalia-en' }] });
  },
});
const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
  headers: { authorization: `Bearer ${await readLocalCredential()}` },
} as unknown as string[]);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
const pending = new Map<
  string,
  { resolve: (data: unknown) => void; reject: (error: Error) => void }
>();
socket.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  const handler = pending.get(message.requestId ?? message.id);
  if (!handler) return;
  pending.delete(message.requestId ?? message.id);
  if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
  else handler.resolve(message.data);
};
function call(method: string, data: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    pending.set(id, { resolve, reject });
    socket.send(
      JSON.stringify({
        id,
        type: 'REQ',
        sessionId: 'global',
        method,
        data,
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      })
    );
  });
}
try {
  const base = `http://127.0.0.1:${deepgram.port}`;
  await call('settings.global.update', {
    updates: {
      voice: {
        enabled: true,
        endpoint: '',
        model: '',
        allowPrivateNetwork: true,
        recorded: { provider: 'deepgram', endpoint: `${base}/v1/listen`, model: 'nova-3' },
        speech: { provider: 'deepgram', endpoint: base },
      },
    },
  });
  const transcribed = await call('voice.transcribe', {
    audioBase64: Buffer.from(pcm16Wav(new Uint8Array(3200))).toString('base64'),
    mimeType: 'audio/wav',
  });
  assert.equal((transcribed as { text: string }).text, 'deepgram heard');
  const catalog = await call('operation.invoke', { name: 'neo.speech.catalog', input: {} });
  assert.equal(JSON.stringify(catalog).includes('"aura-2-thalia-en"'), true, JSON.stringify(catalog));
  assert.deepEqual(requests, [
    { path: '/v1/listen?model=nova-3', type: 'audio/wav', riff: true },
    { path: '/v1/models', type: null, riff: false },
  ]);
  console.log(JSON.stringify({ transcribed, catalog, requests }, null, 2));
} finally {
  socket.close();
  await deepgram.stop(true);
}
