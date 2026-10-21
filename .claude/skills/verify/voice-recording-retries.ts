import assert from 'node:assert/strict';
import { pcm16Wav } from '../../../packages/daemon/src/lib/voice/stream-relay.ts';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [run, port, asrPort, phase] = process.argv.slice(2);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.notEqual(port, '8399');
const asr = `http://127.0.0.1:${asrPort}`;
const count = async () => (await (await fetch(`${asr}/stats`)).json() as { calls: number }).calls;
async function client() {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const key = message.requestId ?? message.id;
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    if (message.error) entry.reject(new Error(String(message.error))); else entry.resolve(message.data);
  };
  socket.onclose = () => { for (const entry of pending.values()) entry.reject(new Error('synthetic phone connection dropped')); pending.clear(); };
  return {
    close: () => socket.close(1001),
    call: (method: string, data: unknown) => new Promise<unknown>((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 5_000);
      pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      socket.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
    }),
  };
}
const opened: Awaited<ReturnType<typeof client>>[] = [];
const connect = async () => { const connection = await client(); opened.push(connection); return connection; };
const requestPath = join(run, 'recording.json');
try {
  const phone = await connect();
  if (phase === 'initial' || phase === 'baseline') {
    await phone.call('settings.global.update', { updates: { voice: { enabled: true, endpoint: `${asr}/v1/audio/transcriptions`, model: 'fake', allowPrivateNetwork: true } } });
    const request = { recordingId: crypto.randomUUID(), audioBase64: Buffer.from(pcm16Wav(new Uint8Array(217.9 * 32_000))).toString('base64'), mimeType: 'audio/wav' };
    await writeFile(requestPath, JSON.stringify(request));
    const lost = phone.call('voice.transcribe', request).catch((error: Error) => ({ lost: error.message }));
    for (let attempt = 0; await count() < 1 && attempt < 100; attempt++) await Bun.sleep(10);
    assert.equal(await count(), 1);
    phone.close();
    const reconnected = await connect();
    if (phase === 'baseline') {
      const retried = await reconnected.call('voice.transcribe', request);
      const calls = await count();
      await writeFile(join(run, 'evidence', 'baseline.json'), JSON.stringify({ retried, calls, lost: await lost }, null, 2));
      assert.equal(calls, 1, 'same recording must not invoke ASR again');
    }
    const [first, concurrent] = await Promise.all([reconnected.call('voice.transcribe', request), reconnected.call('voice.transcribe', request)]);
    const replay = await reconnected.call('voice.transcribe', request);
    const calls = await count();
    await writeFile(join(run, 'evidence', 'initial.json'), JSON.stringify({ first, concurrent, replay, calls, lost: await lost }, null, 2));
    assert.deepEqual(first, { text: 'synthetic stored transcript 1' });
    assert.deepEqual(concurrent, first); assert.deepEqual(replay, first); assert.equal(calls, 1);
    await assert.rejects(() => reconnected.call('voice.transcribe', { ...request, audioBase64: Buffer.from('changed').toString('base64') }), /different audio/);
  } else if (phase === 'restarted') {
    const request = JSON.parse(await readFile(requestPath, 'utf8'));
    const replay = await phone.call('voice.transcribe', request);
    assert.deepEqual(replay, { text: 'synthetic stored transcript 1' }); assert.equal(await count(), 1);
    await phone.call('settings.global.update', { updates: { voice: { enabled: true, endpoint: `${asr}/fail`, model: 'fake', allowPrivateNetwork: true } } });
    const failed = { ...request, recordingId: crypto.randomUUID() };
    await assert.rejects(() => phone.call('voice.transcribe', failed), /synthetic ASR failure/);
    await assert.rejects(() => phone.call('voice.transcribe', failed), /synthetic ASR failure/);
    assert.equal(await count(), 2);
    await writeFile(join(run, 'evidence', 'restarted.json'), JSON.stringify({ replay, failedCalls: 1, totalCalls: 2 }, null, 2));
  } else if (phase === 'pending') {
    await fetch(`${asr}/hold`);
    const request = { ...JSON.parse(await readFile(requestPath, 'utf8')), recordingId: crypto.randomUUID() };
    await writeFile(join(run, 'pending.json'), JSON.stringify(request));
    const pending = phone.call('voice.transcribe', request).catch((error: Error) => error.message);
    for (let attempt = 0; await count() < 3 && attempt < 100; attempt++) await Bun.sleep(10);
    assert.equal(await count(), 3);
    phone.close(); await pending;
  } else {
    const request = JSON.parse(await readFile(join(run, 'pending.json'), 'utf8'));
    await assert.rejects(() => phone.call('voice.transcribe', request), /unconfirmed/);
    await assert.rejects(() => phone.call('voice.transcribe', request), /unconfirmed/);
    assert.equal(await count(), 3);
    await writeFile(join(run, 'evidence', 'interrupted.json'), JSON.stringify({ refusedUnconfirmedTwice: true, totalCalls: 3, resubmissions: 0 }, null, 2));
  }
  console.log(`PASS: ${phase}`);
} finally {
  for (const connection of opened) connection.close();
}
