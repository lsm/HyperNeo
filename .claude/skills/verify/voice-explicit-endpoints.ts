import assert from 'node:assert/strict';
import { pcm16Wav } from '../../../packages/daemon/src/lib/voice/stream-relay.ts';

const port = process.env.VERIFY_PORT;
assert(port && port !== '8399');
const requests: string[] = [];
const asr = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    requests.push(url.pathname + url.search);
    await request.formData();
    return Response.json({ text: 'Explicit batch URL received' });
  },
});
const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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
  const results: unknown[] = [];
  for (const path of ['/speech/v1?language=zh', '/custom/audio/transcriptions/?x=1']) {
    await call('settings.global.update', {
      updates: {
        voice: {
          enabled: true,
          endpoint: `http://127.0.0.1:${asr.port}${path}`,
          streamEndpoint: '',
          model: 'stub',
          mode: 'streaming',
          allowPrivateNetwork: true,
        },
      },
    });
    const started = (await call('voice.stream.start', {
      encoding: 'pcm16',
      sampleRate: 16000,
    })) as { streamId: string; via: string };
    assert.equal(started.via, 'batch');
    await call('voice.stream.chunk', {
      streamId: started.streamId,
      audioBase64: Buffer.alloc(3200).toString('base64'),
    });
    const stopped = await call('voice.stream.stop', { streamId: started.streamId });
    assert.deepEqual(stopped, { text: 'Explicit batch URL received', via: 'batch' });
    assert.equal(requests.at(-1), path);
    results.push({ path, started, stopped });
  }
  const direct = await call('voice.transcribe', {
    audioBase64: Buffer.from(pcm16Wav(new Uint8Array(3200))).toString('base64'),
    mimeType: 'audio/wav',
  });
  assert.equal((direct as { text: string }).text, 'Explicit batch URL received');
  console.log(JSON.stringify({ results, direct, requests }, null, 2));
} finally {
  socket.close();
  await asr.stop(true);
}
