import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { Result, WorkDetail, WorkStarted } from '../../../packages/daemon/src/lib/drivers/types.ts';

const [portText, runText, mode = 'all'] = process.argv.slice(2);
assert(runText);
const run = resolve(runText);
const port = Number(portText);
assert(Number.isInteger(port) && port > 0 && port < 65536 && port !== 8399);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
assert.equal(process.env.PATH?.split(':')[0], join(run, 'bin'));
for (const dir of ['bin', 'evidence', 'workspace']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const fixture = fileURLToPath(new URL('../../../packages/daemon/tests/fixtures/copilot-sdk.ts', import.meta.url));
const installFixture = (flag = '') => writeFileSync(join(run, 'bin/copilot'), `#!/usr/bin/env bun\nprocess.argv.push('--production-version', ${JSON.stringify(flag)}); await import(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
installFixture('--idle-after-abort');
const observations: unknown[] = [];
process.chdir(run);
const config = getConfig({ port, host: '127.0.0.1', dbPath: ['relative', 'all'].includes(mode) ? 'data/daemon.db' : join(run, 'data/daemon.db') });
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
async function connect() {
  app = await createDaemonApp({ config, verbose: false });
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connection failed')); });
}
function rpc(name: string, input: unknown): Promise<unknown> {
  return new Promise((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { ws!.removeEventListener('message', receive); fail(new Error(`${name} timeout`)); }, 20000);
    const receive = (event: MessageEvent) => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      ws!.removeEventListener('message', receive);
      clearTimeout(timer); observations.push({ name, input, reply });
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    ws!.addEventListener('message', receive);
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
}
const start = async (message: string) => {
  const reply = await rpc('work.start', { adapter: 'copilot-cli', place: { machine: hostname(), folder: join(run, 'workspace'), name: 'Synthetic project' }, title: 'Synthetic Copilot work', model: 'synthetic-model', message }) as Result<WorkStarted>;
  assert(reply.ok, JSON.stringify(reply)); return reply.value;
};
const status = async (work: WorkStarted) => {
  const reply = await rpc('work.status', { ref: work.ref, receipt: work.receipt }) as Result<WorkDetail>;
  assert(reply.ok, JSON.stringify(reply)); return reply.value;
};
try {
  await connect();
  const catalog = await rpc('work.adapters', {}) as { value: { id: string; capabilities: string[]; unsupportedCapabilities?: { steer?: string } }[] };
  assert.deepEqual(catalog.value.find(adapter => adapter.id === 'copilot-cli')?.capabilities, ['find', 'start', 'send', 'queue', 'status', 'stop', 'archive']);
  if (mode === 'steer') {
    const adapter = catalog.value.find(adapter => adapter.id === 'copilot-cli')!;
    assert.match(adapter.unsupportedCapabilities?.steer ?? '', /same-turn/);
    const active = await start('hold');
    const traffic = () => readFileSync(join(run, 'workspace/calls.jsonl'), 'utf8');
    for (const ref of [active.ref, { adapter: 'copilot-cli', id: crypto.randomUUID() }]) {
      const before = traffic();
      const rejected = await rpc('work.send', { ref, message: 'NEVER_QUEUE_STEER', mode: 'steer' }) as { ok: boolean; reason: string; detail: string };
      assert.equal(rejected.ok, false);
      assert.equal(rejected.reason, 'unsupported');
      assert.equal(rejected.detail, adapter.unsupportedCapabilities!.steer);
      assert.equal(traffic(), before, 'steer must not reach the runtime');
    }
    assert.equal((await status(active)).status, 'running');
    assert.deepEqual(await rpc('work.stop', { ref: active.ref }), { ok: true, value: { stopped: true } });
    const before = traffic();
    const rejected = await rpc('work.send', { ref: active.ref, message: 'NEVER_RESUME_STEER', mode: 'steer' }) as { reason: string };
    assert.equal(rejected.reason, 'unsupported');
    assert.equal(traffic(), before, 'steer must not resume stopped work');
  }
  if (mode === 'reap' || mode === 'all') {
    for (const message of ['settled', 'error', 'late-settled']) {
      const work = await start(message);
      const calls = readFileSync(join(run, 'workspace/calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const pid = calls.findLast(call => call.method === 'session.send').pid;
      if (message === 'late-settled') writeFileSync(join(run, 'workspace/release-settlement'), 'release');
      for (let poll = 0; poll < 200; poll++) {
        try { process.kill(pid, 0); } catch { break; }
        await new Promise(done => setTimeout(done, 5));
      }
      assert.throws(() => process.kill(pid, 0), `${message} runtime was not reaped without status/stop`);
      const evidence = await status(work);
      assert.equal(evidence.status, message === 'error' ? 'failed' : 'done');
      assert.deepEqual(await rpc('work.stop', { ref: work.ref }), { ok: true, value: { stopped: false } });
      assert.deepEqual(await status(work), evidence);
      if (message === 'late-settled') {
        unlinkSync(join(run, 'workspace/release-settlement')); unlinkSync(join(run, 'workspace/settlement-emitted'));
      }
    }
  }
  if (mode === 'file' || mode === 'all') {
    const folder = join(run, 'not-a-folder');
    writeFileSync(folder, 'file');
    const refused = await rpc('work.start', { adapter: 'copilot-cli', place: { machine: hostname(), folder, name: 'Synthetic file' }, title: 'Invalid execution folder', model: 'synthetic-model', message: 'never delivered' }) as { ok: boolean; reason: string };
    assert.equal(refused.ok, false); assert.equal(refused.reason, 'invalid_place');
    assert(!existsSync(join(run, 'not-a-folder/calls.jsonl')), 'folder admission must precede runtime spawn');
  }
  if (mode === 'abort-window' || mode === 'all') {
    installFixture('--delayed-abort');
    const work = await start('hold');
    const started = Date.now();
    assert.deepEqual(await rpc('work.stop', { ref: work.ref }), { ok: true, value: { stopped: true } });
    assert(Date.now() - started > 2000, 'fixture must exercise the default two-second boundary');
    assert.equal((await status(work)).status, 'stopped');
    installFixture('--idle-after-abort');
  }
  if (mode === 'stop-terminal') {
    const finished = await start('settled');
    const before = await status(finished);
    assert.deepEqual(await rpc('work.stop', { ref: finished.ref }), { ok: true, value: { stopped: false } });
    assert.deepEqual(await status(finished), before);
  }
  const complete = await start('settled');
  assert.equal((await status(complete)).inputEvidence?.state, 'observed');
  assert.equal((await status(complete)).lastReply, 'REPLY_1');
  assert.equal((await status(complete)).status, 'done');
  if (mode === 'terminal' || mode === 'all') {
    const before = await status(complete);
    const pid = JSON.parse(readFileSync(join(run, 'workspace/calls.jsonl'), 'utf8').split('\n')[0]).pid;
    for (let poll = 0; poll < 100; poll++) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(done => setTimeout(done, 10));
    }
    assert.throws(() => process.kill(pid, 0));
    assert.deepEqual(await status(complete), before, 'completed receipt must survive runtime exit');
  }
  assert.equal(complete.link, undefined);
  assert.match(complete.watchHint ?? '', /work.status/);
  const blocked = await start('permission');
  assert.equal((await status(blocked)).status, 'needs_you');
  installFixture('--slow-stop');
  const stopped = await start('hold');
  const stopping = rpc('work.stop', { ref: stopped.ref });
  try {
    for (let poll = 0; poll < 200; poll++) {
      if (readFileSync(join(run, 'workspace/calls.jsonl'), 'utf8').includes('runtime.shutdown')) {
        const calls = readFileSync(join(run, 'workspace/calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        const sent = calls.findLast(call => call.method === 'session.send');
        if (calls.some(call => call.method === 'runtime.shutdown' && call.pid === sent.pid)) break;
      }
      await new Promise(done => setTimeout(done, 5));
    }
    const calls = readFileSync(join(run, 'workspace/calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const pid = calls.findLast(call => call.method === 'session.send').pid;
    assert(calls.some(call => call.pid === pid && call.method === 'runtime.shutdown'));
    const reading = rpc('work.status', { ref: stopped.ref, receipt: stopped.receipt });
    await rpc('work.adapters', {});
    writeFileSync(join(run, 'workspace/release-shutdown'), 'release');
    const concurrent = await reading as Result<WorkDetail>;
    assert(concurrent.ok, JSON.stringify(concurrent));
    assert.equal(concurrent.value.status, 'stopped', 'status overlapping runtime close must retain stopped');
  } finally { writeFileSync(join(run, 'workspace/release-shutdown'), 'release'); assert.deepEqual(await stopping, { ok: true, value: { stopped: true } }); }
  assert.equal((await status(stopped)).status, 'stopped');
  assert.equal((await rpc('work.send', { ref: stopped.ref, message: 'do not send', mode: 'steer' }) as { reason: string }).reason, 'unsupported');
  assert.equal((await rpc('work.stop', { ref: { adapter: 'copilot-cli', id: crypto.randomUUID() } }) as { reason: string }).reason, 'not_found');
  installFixture('--logged-out');
  const loggedOut = await rpc('work.start', { adapter: 'copilot-cli', place: complete.place, title: 'No login', model: 'synthetic-model', message: 'never delivered' }) as { ok: boolean; detail: string };
  assert.equal(loggedOut.ok, false); assert.match(loggedOut.detail, /copilot login/);
  installFixture('--no-models');
  assert.equal((await rpc('work.start', { adapter: 'copilot-cli', place: complete.place, title: 'No catalog', model: 'synthetic-model', message: 'never delivered' }) as { ok: boolean }).ok, false);
  if (mode === 'model' || mode === 'all') {
    installFixture();
    const refused = await rpc('work.start', { adapter: 'copilot-cli', place: complete.place, title: 'Unknown model', model: 'unknown-model', message: 'never delivered' }) as { ok: boolean; reason: string };
    assert.equal(refused.ok, false); assert.equal(refused.reason, 'unsupported_model');
    const calls = readFileSync(join(run, 'workspace/calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const pid = calls.at(-1).pid;
    assert(!calls.some(call => call.pid === pid && ['session.create', 'session.send'].includes(call.method)));
  }
  if (mode === 'all') {
    installFixture();
    const late = await start('late-settled');
    assert.equal(late.status, 'running');
    writeFileSync(join(run, 'workspace/release-settlement'), 'release');
    for (let poll = 0; poll < 200 && !existsSync(join(run, 'workspace/settlement-emitted')); poll++) await new Promise(done => setTimeout(done, 5));
    assert(existsSync(join(run, 'workspace/settlement-emitted')));
    assert.deepEqual(await rpc('work.stop', { ref: late.ref }), { ok: true, value: { stopped: false } });
    assert.equal((await status(late)).lastReply, 'LATE_COMPLETE_REPLY');
    const before = await status(complete);
    assert.deepEqual(await rpc('work.stop', { ref: complete.ref }), { ok: true, value: { stopped: false } });
    assert.deepEqual(await status(complete), before);
    assert.deepEqual(await rpc('work.stop', { ref: stopped.ref }), { ok: true, value: { stopped: false } });
    const calls = readFileSync(join(run, 'workspace/calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.filter(call => call.method === 'session.abort').length, 2, 'only active work may receive abort');
  }
  installFixture('--crash-on-ping');
  const disconnected = await rpc('work.start', { adapter: 'copilot-cli', place: complete.place, title: 'Synthetic lost owner', model: 'synthetic-model', message: 'hold' }) as { ok: boolean; reason: string; detail: string };
  assert.equal(disconnected.ok, false, 'a disconnected snapshot cannot return queued success');
  assert.equal(disconnected.reason, 'unreachable'); assert.match(disconnected.detail, /copilot-cli:[0-9a-f-]{36}/);
  installFixture();
  const active = await start('hold');
  ws!.close(); await app!.cleanup(); app = undefined;
  const calls = readFileSync(join(run, 'workspace/calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  for (const pid of new Set<number>(calls.map(call => call.pid))) assert.throws(() => process.kill(pid, 0), `owned runtime ${pid} survived cleanup`);
  observations.push({ cleanupPidsGone: [...new Set(calls.map(call => call.pid))], calls });
  await connect();
  assert.equal((await status(complete)).status, 'done');
  assert.equal((await status(complete)).lastReply, 'REPLY_1');
  assert.equal((await status(stopped)).status, 'stopped');
  const recovered = await rpc('work.status', { ref: active.ref, receipt: active.receipt }) as { ok: boolean; reason: string };
  assert.equal(recovered.ok, false); assert.equal(recovered.reason, 'unreachable');
  assert.equal(readFileSync(join(run, 'workspace/calls.jsonl'), 'utf8').trim().split('\n').filter(line => JSON.parse(line).method === 'session.send').length, mode === 'all' ? 10 : mode === 'reap' ? 8 : ['stop-terminal', 'abort-window', 'steer'].includes(mode) ? 6 : 5);
  console.log(`PASS public Copilot work.start/status/stop: relative DB, durable terminal replies, concurrent stop/status, model rejection, denied permission, abort evidence and no replay. ${run}/evidence/observed.json`);
} finally {
  ws?.close(); await app?.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observations, null, 2));
}
