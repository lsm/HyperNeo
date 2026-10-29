import { opusFixture } from '../../../packages/daemon/tests/helpers/opus-fixture.ts';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, closeSync, writeFileSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { createServer, connect as connectTcp } from 'node:net';
import { join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';

const [mode, run] = process.argv.slice(2);
const isOpus = mode.startsWith('opus');
const transcript = (bytes: Buffer, fallback: string) => isOpus ? createHash('sha256').update(bytes).digest('hex') : fallback;
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
for (const part of ['data', 'evidence']) mkdirSync(join(run, part), { recursive: true });
const socketPort = createServer();
await new Promise<void>((done) => socketPort.listen(0, '127.0.0.1', done));
const port = (socketPort.address() as { port: number }).port;
await new Promise<void>((done) => socketPort.close(() => done()));
assert.notEqual(port, 8399);
const asr = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise<void>((done) => asr.once('listening', done));
const asrPort = (asr.address() as { port: number }).port;
const records: Array<{ chunks: Buffer[]; closed: boolean }> = [];
const clients: WebSocket[] = [];
const syntheticSecrets: string[] = [];
const observed: Record<string, unknown> = { mode, passed: false };
asr.on('connection', (socket) => {
  const record = { chunks: [] as Buffer[], closed: false };
  records.push(record);
  socket.on('close', () => { record.closed = true; });
  socket.on('message', (data, binary) => {
    if (!binary && JSON.parse(String(data)).type !== 'CloseStream') return;
    if (binary) record.chunks.push(Buffer.from(data as Buffer));
    const pcm = Buffer.concat(record.chunks);
    if (isOpus) {
      socket.send(JSON.stringify({ type: 'Results', is_final: !binary, channel: { alternatives: [{ transcript: createHash('sha256').update(pcm).digest('hex') }] } }));
      if (!binary) socket.close(1000);
      return;
    }
    const samples = [];
    for (let i = 0; i < pcm.length; i += 2) samples.push(pcm.readInt16LE(i));
    socket.send(JSON.stringify({ type: 'Results', is_final: !binary, channel: { alternatives: [{ transcript: samples.join(',') }] } }));
    if (!binary) socket.close(1000);
  });
});
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
const log = openSync(join(run, 'evidence/daemon.log'), 'w');
const daemon = spawn(process.execPath, ['packages/cli/main.ts', '--port', String(port), '--host', '127.0.0.1', '--db-path', join(run, 'data/daemon.db')], {
  env: { ...process.env, HYPERNEO_WORKSPACE_PATH: run }, stdio: ['ignore', log, log],
});
closeSync(log);
writeFileSync(join(run, 'daemon.pid'), String(daemon.pid));
const exited = new Promise<void>((done) => daemon.once('exit', () => done()));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function connect(credential?: string) {
  const url = `ws://127.0.0.1:${port}/ws`;
  const ws = credential ? new WebSocket(url, { headers: { authorization: `Bearer ${credential}` } }) : new WebSocket(url);
  clients.push(ws);
  await new Promise<void>((done, reject) => { ws.once('open', done); ws.on('error', reject); });
  const events: Array<{ isFinal: boolean; text: string }> = [];
  const pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  ws.on('message', (data) => {
    const frame = JSON.parse(String(data));
    if (frame.type === 'EVENT' && frame.method === 'voice.stream.text') events.push(frame.data);
    const entry = pending.get(frame.requestId ?? frame.id);
    if (!entry) return;
    pending.delete(frame.requestId ?? frame.id);
    if (frame.error) entry.reject(Object.assign(new Error(frame.error), { code: frame.errorCode }));
    else entry.resolve(frame.data);
  });
  ws.on('close', () => { for (const entry of pending.values()) entry.reject(new Error('synthetic connection dropped')); pending.clear(); });
  return {
    events,
    drop: () => new Promise<number>((done) => { ws.once('close', (code) => done(code)); ws.terminate(); }),
    call: (method: string, data: object) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 10_000);
      pending.set(id, { resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
      ws.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
    }),
  };
}
const pcm = (values: number[]) => Buffer.from(new Int16Array(values).buffer).toString('base64');
try {
  let ready = false;
  for (let i = 0; i < 200; i++) {
    assert.equal(daemon.exitCode, null, 'isolated daemon exited before readiness');
    ready = await new Promise<boolean>((done) => {
      const probe = connectTcp({ host: '127.0.0.1', port });
      probe.once('connect', () => { probe.destroy(); done(true); });
      probe.once('error', () => done(false));
    });
    if (ready) break;
    await sleep(100);
  }
  assert(ready, 'isolated daemon not ready');
  let first = await connect();
  await first.call('settings.global.update', { updates: { voice: {
    enabled: true, endpoint: `http://127.0.0.1:${asrPort}/v1/transcriptions`, model: 'synthetic',
    mode: 'streaming', streamEndpoint: `ws://127.0.0.1:${asrPort}/v1/listen`, streamProtocol: 'deepgram', allowPrivateNetwork: true,
  } } });
  const legacy = await first.call('voice.stream.start', { encoding: 'pcm16', sampleRate: 16_000 });
  await first.call('voice.stream.chunk', { streamId: legacy.streamId, audioBase64: pcm([7, 8]) });
  await first.call('voice.stream.chunk', { streamId: legacy.streamId, audioBase64: pcm([9]) });
  observed.legacy = await first.call('voice.stream.stop', { streamId: legacy.streamId });
  assert.deepEqual(observed.legacy, { text: transcript(Buffer.from(new Int16Array([7, 8, 9]).buffer), '7,8,9'), via: 'streaming' });
  const code = await first.call('operation.invoke', { name: 'device.pair.create', input: { kind: 'human', name: 'Synthetic phone' } });
  assert.equal(typeof code.code, 'string');
  syntheticSecrets.push(String(code.code));
  const paired = await fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.code, name: 'Synthetic phone' }) });
  assert.equal(paired.status, 200);
  const { credential } = await paired.json() as { credential: string };
  assert.equal(typeof credential, 'string');
  syntheticSecrets.push(credential);
  first = await connect(credential);
  assert.equal((await first.call('operation.invoke', { name: 'device.pair.pending', input: {} })).ok, true);
  observed.pairedIdentityConfirmed = true;
  const fixture = isOpus ? await opusFixture() : null;
  const started = await first.call('voice.stream.start', { encoding: fixture ? 'opus' : 'pcm16', sampleRate: 16_000 });
  observed.started = started;
  assert.deepEqual(started.formats, ['pcm16', 'opus']);
  const cut = fixture ? fixture.boundaries[1] + 1 : 6;
  const initial = fixture ? fixture.encoded.subarray(0, cut).toString('base64') : pcm([1, 2, 3]);
  await first.call('voice.stream.chunk', { streamId: started.streamId, audioBase64: initial, offset: 0 });
  observed.disconnectCode = await first.drop();
  assert.equal(observed.disconnectCode, 1006);
  let second = await connect(credential);
  observed.resume = await second.call('voice.stream.resume', { streamId: started.streamId });
  assert.deepEqual(observed.resume, { ok: true, receivedBytes: cut });
  assert.equal(started.resumable, true);
  await second.call('voice.stream.chunk', { streamId: started.streamId, audioBase64: initial, offset: 0 });
  await second.call('voice.stream.chunk', { streamId: started.streamId, audioBase64: fixture ? fixture.encoded.subarray(cut - 1).toString('base64') : pcm([3, 4, 5]), offset: fixture ? cut - 1 : 4 });
  observed.stopped = await second.call('voice.stream.stop', { streamId: started.streamId });
  const expectedPcm = fixture?.pcm ?? Buffer.from(new Int16Array([1, 2, 3, 4, 5]).buffer);
  assert.deepEqual(observed.stopped, { text: transcript(expectedPcm, '1,2,3,4,5'), via: 'streaming' });
  assert.deepEqual(Buffer.concat(records[1].chunks), expectedPcm);
  if (fixture) observed.bandwidth = { encodedBytes: fixture.encoded.length, decodedBytes: expectedPcm.length, encodedBytesPerMinute: fixture.encoded.length * 60, decodedSha256: createHash('sha256').update(expectedPcm).digest('hex') };
  observed.finalEvents = second.events.filter((event) => event.isFinal);
  assert.equal((observed.finalEvents as unknown[]).length, 1);
  observed.legacyReconnects = 0;
  for (let index = 0; index < 9; index++) {
    const legacyPhone = await connect(credential);
    const recording = await legacyPhone.call('voice.stream.start', { encoding: 'pcm16', sampleRate: 16_000 });
    await legacyPhone.call('voice.stream.chunk', { streamId: recording.streamId, audioBase64: pcm([index]) });
    if (index < 8) await legacyPhone.drop();
    else {
      observed.legacyReconnectFinal = await legacyPhone.call('voice.stream.stop', { streamId: recording.streamId });
      assert.deepEqual(observed.legacyReconnectFinal, { text: transcript(Buffer.from(new Int16Array([8]).buffer), '8'), via: 'streaming' });
    }
    observed.legacyReconnects = index + 1;
  }
  const guest = await connect();
  const stranger = await connect();
  const unpaired = await guest.call('voice.stream.start', { encoding: 'pcm16', sampleRate: 16_000 });
  await guest.call('voice.stream.chunk', { streamId: unpaired.streamId, audioBase64: pcm([66]) });
  await guest.drop();
  await assert.rejects(() => stranger.call('voice.stream.resume', { streamId: unpaired.streamId }), (error: Error & { code?: string }) => error.code === 'VOICE_STREAM_NOT_FOUND');
  assert.equal(unpaired.resumable, false);
  observed.unpairedTakeoverRefused = true;
  const cancelled = await second.call('voice.stream.start', { encoding: 'pcm16', sampleRate: 16_000 });
  await second.call('voice.stream.chunk', { streamId: cancelled.streamId, audioBase64: pcm([99]) });
  const cancelRecord = records.at(-1)!;
  await second.drop();
  second = await connect(credential);
  assert.deepEqual(await second.call('voice.stream.cancel', { streamId: cancelled.streamId }), { ok: true });
  for (let attempt = 0; records.some((record) => !record.closed) && attempt < 500; attempt++) await sleep(10);
  observed.detachedCancelRetired = cancelRecord.closed;
  assert.equal(observed.detachedCancelRetired, true, 'detached cancel left ASR open');
  await assert.rejects(() => second.call('voice.stream.resume', { streamId: cancelled.streamId }), (error: Error & { code?: string }) => error.code === 'VOICE_STREAM_NOT_FOUND');
  assert(records.every((record) => record.closed), 'replacement left an ASR connection open');
  observed.detachedRelaysRetired = true;
  if (!mode.endsWith('quick')) {
    const abandoned = await second.call('voice.stream.start', { encoding: fixture ? 'opus' : 'pcm16', sampleRate: 16_000 });
    await second.call('voice.stream.chunk', { streamId: abandoned.streamId, audioBase64: fixture ? initial : pcm([42]), offset: 0 });
    const disconnectedAt = Date.now();
    await second.drop();
    await sleep(119_000);
    assert.equal(records.at(-1)!.closed, false, 'paired ASR retired before its grace deadline');
    observed.aliveBeforeGraceDeadline = true;
    await sleep(2_000);
    observed.elapsedGraceMs = Date.now() - disconnectedAt;
    observed.abandonedRelayClosed = records.at(-1)!.closed;
    assert.equal(observed.abandonedRelayClosed, true, 'grace timer did not retire ASR without another RPC');
    const third = await connect(credential);
    await assert.rejects(() => third.call('voice.stream.resume', { streamId: abandoned.streamId }), (error: Error & { code?: string }) => {
      observed.expiryCode = error.code;
      return error.code === 'VOICE_STREAM_NOT_FOUND';
    });
  }
  observed.passed = true;
} catch (error) {
  observed.error = error instanceof Error ? { message: error.message, code: (error as Error & { code?: string }).code } : String(error);
  throw error;
} finally {
  for (const client of clients) client.terminate();
  for (const socket of asr.clients) socket.terminate();
  await new Promise<void>((done) => asr.close(() => done()));
  daemon.kill('SIGTERM');
  const shutdownDeadline = setTimeout(() => daemon.kill('SIGKILL'), 15_000);
  try { await exited; } finally { clearTimeout(shutdownDeadline); }
  observed.daemonExitCode = daemon.exitCode;
  const logText = readFileSync(join(run, 'evidence/daemon.log'), 'utf8');
  observed.syntheticSecretsAbsent = syntheticSecrets.every((secret) => !logText.includes(secret));
  writeFileSync(join(run, 'evidence/daemon.log'), syntheticSecrets.reduce((text, secret) => text.replaceAll(secret, '[synthetic secret redacted]'), logText));
  writeFileSync(join(run, 'evidence/voice-resumable.json'), JSON.stringify(observed, null, 2));
  assert(observed.syntheticSecretsAbsent, 'synthetic pairing secret appeared in evidence');
  assert.equal(daemon.exitCode, 0, 'isolated daemon did not shut down cleanly');
  assert(!/database (?:is|has been) closed/i.test(readFileSync(join(run, 'evidence/daemon.log'), 'utf8')), 'closed database during proof shutdown');
}
console.log(JSON.stringify(observed));
