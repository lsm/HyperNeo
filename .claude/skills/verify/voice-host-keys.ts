import assert from 'node:assert/strict';
import { readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { pcm16Wav } from '../../../packages/daemon/src/lib/voice/stream-relay.ts';

const port = process.env.VERIFY_PORT;
assert(port && port !== '8399');
const run = process.env.RUN;
assert(run);
const key = await Bun.file(`${run}/server-key.pem`).text();
const cert = await Bun.file(`${run}/server-cert.pem`).text();
const received: Array<string | null> = [];
const servers = Array.from({ length: 2 }, () => Bun.serve({
  hostname: '127.0.0.1', port: 0, tls: { key, cert },
  async fetch(request) {
    received.push(request.headers.get('authorization'));
    await request.formData();
    return Response.json({ text: 'host proof' });
  },
}));
assert(process.env.HYPERNEO_DATA_DIR, 'set HYPERNEO_DATA_DIR to the isolated run');
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
  const endpoints = servers.map((server) => `https://127.0.0.1:${server.port}/v1/audio/transcriptions`);
  const settings = {
    enabled: true, endpoint: endpoints[0], model: 'stub', allowPrivateNetwork: true,
    allowInsecureTls: true,
    live: { provider: 'deepgram', endpoint: endpoints[1].replace('https:', 'wss:') },
  };
  for (const [index, secret] of ['synthetic-first', 'synthetic-second'].entries()) {
    const result = await call('settings.global.update', { updates: { voice: {
      ...settings, hostKey: { host: new URL(endpoints[index]).host, apiKey: secret },
    } } });
    assert(!JSON.stringify(result).includes(secret));
  }
  for (const endpoint of endpoints) {
    await call('settings.global.update', { updates: { voice: { ...settings, endpoint } } });
    const response = await call('voice.transcribe', {
      audioBase64: Buffer.from(pcm16Wav(new Uint8Array(3200))).toString('base64'),
      mimeType: 'audio/wav',
    });
    assert.equal((response as { text: string }).text, 'host proof');
  }
  assert.deepEqual(received, ['Bearer synthetic-first', 'Bearer synthetic-second']);
  console.log(JSON.stringify({ settingsRepliesRedacted: true, hostRequests: received.length, correctKeys: true }));
} finally {
  socket.close();
  for (const server of servers) await server.stop(true);
}
