import assert from 'node:assert/strict';
import { readLocalCredential } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';

const port = process.env.VERIFY_PORT;
assert(port && port !== '8399');
assert(process.env.HYPERNEO_DATA_DIR, 'set HYPERNEO_DATA_DIR to the isolated run');
const authorizations: (string | null)[] = [];
const live = Bun.serve<undefined, undefined>({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request, server) {
    authorizations.push(request.headers.get('authorization'));
    return server.upgrade(request) ? undefined : new Response('upgrade required', { status: 426 });
  },
  websocket: {
    message(ws, message) {
      if (typeof message !== 'string' || JSON.parse(message).type !== 'CloseStream') return;
      ws.send(
        JSON.stringify({
          type: 'Results',
          is_final: true,
          channel: { alternatives: [{ transcript: 'live heard' }] },
        })
      );
      ws.close(1000);
    },
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
  const saved = (await call('settings.global.update', {
    updates: {
      voice: {
        enabled: true,
        endpoint: 'https://localhost:9/v1/audio/transcriptions',
        apiKey: 'verify-voice-key',
        model: 'stub',
        streamEndpoint: `ws://127.0.0.1:${live.port}/v1/listen`,
        mode: 'streaming',
        allowPrivateNetwork: true,
      },
    },
  })) as { settings: { voice?: { hasApiKey?: boolean; apiKeyEndpoint?: string } } };
  assert.equal(saved.settings.voice?.hasApiKey, true);
  const started = (await call('voice.stream.start', {
    encoding: 'pcm16',
    sampleRate: 16000,
  })) as { streamId: string; via: string };
  assert.equal(started.via, 'streaming');
  await call('voice.stream.chunk', {
    streamId: started.streamId,
    audioBase64: Buffer.alloc(3200).toString('base64'),
  });
  const stopped = await call('voice.stream.stop', { streamId: started.streamId });
  assert.deepEqual(stopped, { text: 'live heard', via: 'streaming' });
  assert.deepEqual(authorizations, [null]);
  console.log(
    JSON.stringify(
      { keyHost: saved.settings.voice?.apiKeyEndpoint, started, stopped, authorizations },
      null,
      2
    )
  );
} finally {
  socket.close();
  await live.stop(true);
}
