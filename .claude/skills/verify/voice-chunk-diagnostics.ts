import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, copyFileSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { opusFixture } from '../../../packages/daemon/tests/helpers/opus-fixture.ts';

const [run] = process.argv.slice(2);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
for (const part of ['data', 'evidence', 'bin']) mkdirSync(join(run, part), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
writeFileSync(join(run, 'bin/security'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const listener = createServer();
await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = (listener.address() as { port: number }).port;
await new Promise<void>((resolve) => listener.close(() => resolve()));
assert(![8399, 8499].includes(port));
const asr = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise<void>((resolve) => asr.once('listening', resolve));
const asrPort = (asr.address() as { port: number }).port;
assert(![8399, 8499].includes(asrPort));
asr.on('connection', (socket) => {
  socket.on('message', (_, binary) => {
    if (binary) return;
    socket.send(
      JSON.stringify({
        type: 'Results',
        is_final: true,
        channel: { alternatives: [{ transcript: 'PRIVATE_TRANSCRIPT' }] },
      })
    );
    socket.send('{"type":"Metadata"}');
    socket.close(1000);
  });
});
const logfile = join(run, 'data/voice.jsonl');
const output = openSync(join(run, 'evidence/daemon.log'), 'w');
const daemon = spawn(
  process.execPath,
  [
    'packages/cli/main.ts',
    '--port',
    String(port),
    '--host',
    '127.0.0.1',
    '--db-path',
    join(run, 'data/daemon.db'),
  ],
  {
    env: {
      ...process.env,
      HYPERNEO_LOG_FILE: logfile,
      HYPERNEO_WORKSPACE_PATH: run,
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
    },
    stdio: ['ignore', output, output],
  }
);
closeSync(output);
const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
  daemon.once('exit', (code, signal) => resolve({ code, signal }))
);
let socket: WebSocket | undefined;
const pending = new Map<
  string,
  { resolve: (data: Record<string, unknown>) => void; reject: (error: Error) => void }
>();
let failure: unknown;
try {
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    assert.equal(daemon.exitCode, null, 'isolated daemon exited before readiness');
    ready = await new Promise<boolean>((resolve) => {
      const probe = connect({ host: '127.0.0.1', port });
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });
    if (ready) break;
    await pause(100);
  }
  assert(ready, 'isolated daemon readiness');
  socket = createLocalSocket(
    `ws://127.0.0.1:${port}/ws`,
    join(run, 'data/local-rpc.credential')
  ) as unknown as WebSocket;
  await new Promise<void>((resolve, reject) => {
    socket!.once('open', resolve);
    socket!.once('error', reject);
  });
  socket.on('message', (data) => {
    const frame = JSON.parse(String(data));
    const request = pending.get(frame.requestId ?? frame.id);
    if (!request) return;
    pending.delete(frame.requestId ?? frame.id);
    if (frame.error) request.reject(new Error(String(frame.error)));
    else request.resolve(frame.data);
  });
  const call = (method: string, data: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC timeout ${method}`));
      }, 15000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket!.send(
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
  await call('settings.global.update', {
    updates: {
      voice: {
        enabled: true,
        endpoint: `http://127.0.0.1:${asrPort}/v1/audio/transcriptions`,
        model: 'synthetic',
        mode: 'streaming',
        streamEndpoint: `ws://127.0.0.1:${asrPort}/v1/listen?token=PRIVATE_ENDPOINT`,
        streamProtocol: 'deepgram',
        allowPrivateNetwork: true,
      },
    },
  });
  const pcm = await call('voice.stream.start', { encoding: 'pcm16', sampleRate: 16000 });
  await call('voice.stream.chunk', {
    streamId: pcm.streamId,
    audioBase64: Buffer.alloc(4).toString('base64'),
  });
  await pause(1100);
  await call('voice.stream.chunk', {
    streamId: pcm.streamId,
    audioBase64: Buffer.alloc(6).toString('base64'),
  });
  await call('voice.stream.cancel', { streamId: pcm.streamId });
  const fixture = await opusFixture(4);
  const opus = await call('voice.stream.start', { encoding: 'opus', sampleRate: 16000 });
  const split = fixture.boundaries[2];
  for (const audio of [fixture.encoded.subarray(0, split), fixture.encoded.subarray(split)]) {
    await call('voice.stream.chunk', {
      streamId: opus.streamId,
      audioBase64: audio.toString('base64'),
    });
  }
  await call('voice.stream.stop', { streamId: opus.streamId });
  type Event = { message: string; metadata: Record<string, unknown> };
  let events: Event[] = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    const raw = readFileSync(logfile, 'utf8');
    events = raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) =>
        ['voice.stream.close', 'voice.stream.chunk.decode', 'voice.stream.chunk.late'].includes(
          event.message
        )
      );
    if (
      events.some(
        (event) =>
          event.message === 'voice.stream.close' && event.metadata.streamId === opus.streamId
      )
    )
      break;
    await pause(50);
  }
  const close = (id: unknown) =>
    events.find(
      (event) => event.message === 'voice.stream.close' && event.metadata.streamId === id
    )!.metadata;
  assert.equal(close(pcm.streamId).receivedChunks, 2);
  assert.equal(close(pcm.streamId).receivedBytes, 10);
  assert.equal(close(pcm.streamId).audioBytes, 10);
  assert.equal(typeof close(pcm.streamId).lastChunkAt, 'number');
  assert.equal(close(opus.streamId).receivedChunks, 2);
  assert.equal(close(opus.streamId).receivedBytes, fixture.encoded.byteLength);
  const late = events.filter(
    (event) =>
      event.message === 'voice.stream.chunk.late' && event.metadata.streamId === pcm.streamId
  );
  assert.equal(late.length, 1);
  assert(Number(late[0].metadata.gapMs) > 1000);
  const decoded = events.filter((event) => event.message === 'voice.stream.chunk.decode');
  assert.equal(decoded.filter((event) => event.metadata.codec === 0).length, 2);
  assert.equal(decoded.filter((event) => event.metadata.codec === 1).length, 2);
  for (const event of [...decoded, ...late]) {
    for (const [key, value] of Object.entries(event.metadata)) {
      if (key !== 'streamId' && key !== 'argTypes')
        assert(typeof value === 'number' && Number.isFinite(value));
    }
  }
  assert(!JSON.stringify(events).includes('PRIVATE_'));
  assert(!JSON.stringify(events).includes('://'));
  writeFileSync(
    join(run, 'evidence/voice-chunk-diagnostics.json'),
    JSON.stringify(
      {
        passed: true,
        closeRecords: events.filter((event) => event.message === 'voice.stream.close').length,
        decodeRecords: decoded.length,
        lateRecords: events.filter((event) => event.message === 'voice.stream.chunk.late').length,
        privacyPassed: true,
        events,
      },
      null,
      2
    )
  );
  console.log(
    'PASS received totals, cancellation, late gap, PCM/Opus decode times and numeric privacy'
  );
} catch (error) {
  failure = error;
} finally {
  socket?.close();
  for (const client of asr.clients) client.terminate();
  await new Promise<void>((resolve) => asr.close(() => resolve()));
  daemon.kill('SIGTERM');
  const timer = setTimeout(() => daemon.kill('SIGKILL'), 15000);
  const result = await exited;
  clearTimeout(timer);
  writeFileSync(join(run, 'evidence/daemon-exit.json'), JSON.stringify(result));
  assert.deepEqual(result, { code: 0, signal: null });
}
if (failure) throw failure;
