import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [run, daemonPort, asrPort] = process.argv.slice(2);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.notEqual(daemonPort, '8399');
let drop = false;
let batches = 0;
const asr = Bun.serve({
  hostname: '127.0.0.1',
  port: Number(asrPort),
  fetch(request, server) {
    if (new URL(request.url).pathname === '/v1/listen') {
      return server.upgrade(request) ? undefined : new Response('upgrade required', { status: 400 });
    }
    batches++;
    return Response.json({ text: 'PRIVATE_TRANSCRIPT_TEXT' });
  },
  websocket: {
    message(socket, message) {
      if (typeof message !== 'string') {
        if (drop) socket.close(1011, 'PRIVATE_TRANSCRIPT_TEXT');
        else socket.send(JSON.stringify({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'PRIVATE_TRANSCRIPT_TEXT' }] } }));
      } else {
        socket.send(JSON.stringify({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'PRIVATE_TRANSCRIPT_TEXT' }] } }));
        socket.close(1000);
      }
    },
  },
});
const socket = new WebSocket(`ws://127.0.0.1:${daemonPort}/ws`);
const pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
let textReceived = false;
socket.onmessage = (event) => {
  const message = JSON.parse(String(event.data));
  if (message.method === 'voice.stream.text') textReceived = true;
  const entry = pending.get(message.requestId ?? message.id);
  if (entry) {
    pending.delete(message.requestId ?? message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.data);
  }
};
const call = (method: string, data: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
  const id = crypto.randomUUID();
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 10_000);
  pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
  socket.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
});
try {
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const configure = (streamEndpoint: string, mode = 'auto') => call('settings.global.update', { updates: { voice: {
    enabled: true, endpoint: `http://127.0.0.1:${asrPort}/v1/audio/transcriptions`, model: 'stub', mode,
    streamEndpoint, streamProtocol: 'deepgram', allowPrivateNetwork: true,
  } } });
  const endpoint = `ws://127.0.0.1:${asrPort}/v1/listen?token=PRIVATE_ENDPOINT_TOKEN`;
  await configure(endpoint);
  const exercise = async () => {
    const started = await call('voice.stream.start', { encoding: 'pcm16', sampleRate: 16_000 });
    for (let index = 0; index < 3; index++) {
      await call('voice.stream.chunk', { streamId: started.streamId, audioBase64: Buffer.alloc(3200).toString('base64') });
      await Bun.sleep(40);
    }
    return { started, stopped: await call('voice.stream.stop', { streamId: started.streamId }) };
  };
  const streaming = await exercise();
  assert.equal(streaming.stopped.via, 'streaming');
  assert(textReceived);
  drop = true;
  const interrupted = await exercise();
  assert.equal(interrupted.stopped.via, 'batch');
  assert.equal(batches, 1);
  await configure('ws://127.0.0.1:1/v1/listen');
  const unavailable = await exercise();
  assert.equal(unavailable.started.via, 'batch');
  assert.equal(batches, 2);
  await configure('ws://127.0.0.1:1/v1/listen', 'streaming');
  await assert.rejects(() => call('voice.stream.start', { encoding: 'pcm16', sampleRate: 16_000 }), /unavailable/);
  drop = false;
  await configure(endpoint);
  const disconnected = await call('voice.stream.start', { encoding: 'pcm16', sampleRate: 16_000 });
  await call('voice.stream.chunk', { streamId: disconnected.streamId, audioBase64: Buffer.alloc(3200).toString('base64') });
  socket.close(1001, 'PRIVATE_CLIENT_TEXT');
  await new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }));
  let logs: Array<{ module: string; message: string; metadata: Record<string, unknown> }> = [];
  for (let attempt = 0; attempt < 40; attempt++) {
    const raw = await readFile(join(run, 'data', 'voice.jsonl'), 'utf8');
    logs = raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((event) => ['hyperneo:daemon:voice', 'hyperneo:daemon:websocket'].includes(event.module));
    if (logs.some((event) => event.message === 'voice.stream.close' && event.metadata.reason === 'client_disconnected')
      && logs.some((event) => event.message === 'voice.stream.end' && event.metadata.streamId === disconnected.streamId)) break;
    await Bun.sleep(50);
  }
  const streamLogs = (streamId: unknown) => logs.filter((event) => event.metadata.streamId === streamId);
  assert(streamLogs(streaming.started.streamId).some((event) => event.message === 'voice.stream.stop' && event.metadata.via === 'streaming' && event.metadata.audioBytes === 9600 && event.metadata.audioDurationMs === 300));
  assert(streamLogs(interrupted.started.streamId).some((event) => event.message === 'voice.asr.close' && event.metadata.code === 1011 && event.metadata.reason === 'server_error'));
  assert(streamLogs(interrupted.started.streamId).some((event) => event.message === 'voice.asr.close' && event.metadata.peerReasonBytes === Buffer.byteLength('PRIVATE_TRANSCRIPT_TEXT')), 'persist the actual peer reason byte count under Bun');
  const streamEnd = (streamId: unknown) => streamLogs(streamId).find((event) => event.message === 'voice.stream.end');
  const interruptedEnd = streamEnd(interrupted.started.streamId);
  assert(interruptedEnd && interruptedEnd.metadata.closedBy === 'server' && interruptedEnd.metadata.code === 1011 && interruptedEnd.metadata.reason === 'server_error', 'log the server 1011 close on the stream-end line');
  assert.equal(typeof interruptedEnd.metadata.durationMs, 'number');
  assert.equal(typeof interruptedEnd.metadata.sinceLastAudioMs, 'number');
  const streamingEnd = streamEnd(streaming.started.streamId);
  assert(streamingEnd && streamingEnd.metadata.closedBy === 'server' && streamingEnd.metadata.code === 1000, 'log the normal server close on the stream-end line');
  assert.equal(typeof streamingEnd.metadata.sinceLastResultMs, 'number');
  const disconnectedEnd = streamEnd(disconnected.streamId);
  assert(disconnectedEnd && disconnectedEnd.metadata.closedBy === 'client' && disconnectedEnd.metadata.code === 1000, 'log the client close on the stream-end line');
  assert(streamLogs(interrupted.started.streamId).some((event) => event.message === 'voice.stream.stop' && event.metadata.fallbackReason === 'asr_disconnected' && event.metadata.via === 'batch'));
  assert(streamLogs(unavailable.started.streamId).some((event) => event.message === 'voice.stream.open' && event.metadata.fallbackReason === 'asr_unavailable'));
  assert(logs.some((event) => event.message === 'voice.stream.open' && event.metadata.status === 'refused'));
  assert(logs.some((event) => event.message === 'voice.asr.error'));
  const opened = logs.find((event) => event.message === 'client.websocket.open');
  assert(opened?.metadata.clientId);
  assert(logs.some((event) => event.message === 'client.websocket.close' && event.metadata.clientId === opened.metadata.clientId && event.metadata.code === 1001));
  assert(streamLogs(disconnected.streamId).some((event) => event.message === 'voice.stream.close' && event.metadata.reason === 'client_disconnected' && event.metadata.audioBytes === 3200));
  assert(!JSON.stringify(logs).includes('PRIVATE_'));
  await writeFile(join(run, 'evidence', 'voice-diagnostics.json'), JSON.stringify({ streaming: streaming.started, interrupted: interrupted.started, unavailable: unavailable.started, batchCalls: batches, privacyPassed: true, logs }, null, 2));
  console.log('PASS: streaming, forced ASR disconnect, batch fallback, refused start, client close, stream-end close attribution and metadata-only persisted logs');
} finally {
  socket.close();
  asr.stop(true);
}
