import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

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
let answers = true;
const requests: string[] = [];
const tts = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return answers
      ? Response.json({ data: [{ id: 'fake-voice' }] })
      : new Response('not found', { status: 404 });
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
const voiceSettings = (speech?: { provider: 'openai'; endpoint: string }) =>
  call('settings.global.update', {
    updates: { voice: { enabled: true, endpoint: '', model: '', ...(speech ? { speech } : {}) } },
  });
const catalog = () => call('operation.invoke', { name: 'neo.speech.catalog', input: {} });
try {
  await voiceSettings({ provider: 'openai', endpoint: `http://127.0.0.1:${tts.port}` });
  const own = await catalog();
  assert.equal(JSON.stringify(own).includes('"fake-voice"'), true, JSON.stringify(own));
  answers = false;
  const published = await catalog();
  assert.equal(JSON.stringify(published).includes('"alloy"'), true, JSON.stringify(published));
  await voiceSettings();
  const cleared = await catalog();
  assert.equal(
    JSON.stringify(cleared).includes('speech_backend_not_configured'),
    true,
    JSON.stringify(cleared)
  );
  assert.deepEqual(requests, ['GET /v1/audio/voices', 'GET /v1/audio/voices']);
  console.log(JSON.stringify({ own, published, cleared, requests }, null, 2));
} finally {
  socket.close();
  await tts.stop(true);
}
