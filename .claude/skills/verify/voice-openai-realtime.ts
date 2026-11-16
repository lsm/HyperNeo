import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

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
const { readLocalCredential } = await import(
  '../../../packages/daemon/src/lib/pairing/local-credential.ts'
);
const seen = { appended: 0, closed: false, opening: [] as string[] };
const realtime = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((resolve) => realtime.once('listening', resolve));
realtime.on('connection', (peer) => {
  peer.on('close', () => {
    seen.closed = true;
  });
  peer.on('message', (data) => {
    const message = JSON.parse(String(data)) as { type: string; audio?: string };
    if (message.type === 'input_audio_buffer.append')
      seen.appended += Buffer.from(message.audio ?? '', 'base64').length;
    else if (message.type === 'input_audio_buffer.commit')
      peer.send(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          transcript: 'realtime heard',
        })
      );
    else seen.opening.push(message.type);
  });
});
const livePort = (realtime.address() as { port: number }).port;
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
  await call('settings.global.update', {
    updates: {
      voice: {
        enabled: true,
        endpoint: `http://127.0.0.1:${livePort}/v1/audio/transcriptions`,
        model: 'stub',
        streamEndpoint: `ws://127.0.0.1:${livePort}/v1/realtime`,
        streamProtocol: 'openai-realtime',
        mode: 'streaming',
        allowPrivateNetwork: true,
      },
    },
  });
  const started = (await call('voice.stream.start', {
    encoding: 'pcm16',
    sampleRate: 16000,
  })) as { streamId: string; via: string };
  assert.equal(started.via, 'streaming');
  await call('voice.stream.chunk', {
    streamId: started.streamId,
    audioBase64: Buffer.alloc(3200).toString('base64'),
  });
  const began = Date.now();
  const stopped = await call('voice.stream.stop', { streamId: started.streamId });
  const stopMs = Date.now() - began;
  assert.deepEqual(stopped, { text: 'realtime heard', via: 'streaming' });
  assert(stopMs < 2_000, `stop took ${stopMs} ms`);
  for (let i = 0; i < 200 && !seen.closed; i++) await new Promise((done) => setTimeout(done, 5));
  assert.equal(seen.closed, true);
  assert.equal(seen.appended, 4798);
  assert.deepEqual(seen.opening, ['session.update']);
  console.log(JSON.stringify({ started, stopped, stopMs, ...seen }, null, 2));
} finally {
  socket.close();
  await new Promise((resolve) => realtime.close(resolve));
}
