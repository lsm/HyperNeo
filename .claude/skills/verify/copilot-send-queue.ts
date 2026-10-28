import { strict as assert } from 'node:assert';
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
const installFixture = (flag = '') => writeFileSync(join(run, 'bin/copilot'), `#!/usr/bin/env bun\nprocess.argv.push('--production-version', '--durable-inputs', ${JSON.stringify(flag)}); await import(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
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
const calls = () => readFileSync(join(run, 'workspace/calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const deliver = async (work: WorkStarted, message: string, queue = false) => {
  const result = await rpc(queue ? 'work.queue' : 'work.send', { ref: work.ref, message }) as Result<import('../../../packages/daemon/src/lib/drivers/types.ts').WorkDelivery>;
  assert(result.ok, JSON.stringify(result)); assert(result.value.receipt); return result.value;
};
const withReceipt = (work: WorkStarted, receipt: WorkStarted['receipt']) => ({ ...work, receipt });
async function done(work: WorkStarted) {
  for (let poll = 0; poll < 200; poll++) {
    const result = await status(work);
    if (['done', 'failed', 'stopped'].includes(result.status)) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('no terminal evidence');
}
async function restart() { ws?.close(); await app!.cleanup(); app = undefined; await connect(); }
try {
  await connect();
  if (mode === 'resume' || mode === 'all') {
    const work = await start('settled');
    const before = await done(work);
    rmSync(join(run, 'data/copilot-workers/receipts'), { recursive: true });
    await restart();
    const second = await deliver(work, 'settled');
    assert.notEqual(second.receipt!.inputId, work.receipt!.inputId);
    assert.equal((await done(withReceipt(work, second.receipt))).lastReply, 'REPLY_2');
    const latest = await rpc('work.status', { ref: work.ref }) as Result<WorkDetail>; assert(latest.ok);
    assert.equal(latest.value.lastReply, 'REPLY_2'); assert.deepEqual(latest.value.startReceipt, work.receipt);
    assert.deepEqual((await done(work)).inputEvidence, before.inputEvidence);
    await restart();
    assert.equal((await done(withReceipt(work, second.receipt))).lastReply, 'REPLY_2');
    const resumed = calls().find(call => call.method === 'session.resume');
    assert.equal(resumed.params.sessionId, work.ref.id);
    assert.equal(resumed.params.continuePendingWork, false);
    assert.deepEqual(resumed.params.availableTools, []);
  }
  if (mode === 'queue' || mode === 'all') {
    const work = await start('serial:first');
    const second = await deliver(work, 'serial:second');
    const third = await deliver(work, 'serial:long', true);
    for (const delivery of [second, third]) {
      assert.equal(delivery.delivered, false); assert.equal(delivery.queuedSubmissionId, delivery.receipt!.inputId);
      assert.equal((await status(withReceipt(work, delivery.receipt))).inputEvidence?.state, 'pending');
    }
    writeFileSync(join(run, 'workspace/release-serial'), 'release');
    assert.equal((await done(work)).lastReply, 'REPLY_serial:first');
    assert.equal((await done(withReceipt(work, second.receipt))).lastReply, 'REPLY_serial:second');
    assert.equal((await done(withReceipt(work, third.receipt))).lastReply, 'LONG_REPLY'.repeat(3000));
    await restart();
    assert.equal((await done(withReceipt(work, third.receipt))).lastReply, 'LONG_REPLY'.repeat(3000));
  }
  if (mode === 'retention' || mode === 'all') {
    const work = await start('hold');
    const early = await deliver(work, 'settled');
    for (let index = 0; index < 66; index++) await deliver(work, 'settled');
    assert.equal((await status(withReceipt(work, early.receipt))).lastReply, 'REPLY_2');
    assert.deepEqual(await rpc('work.stop', { ref: work.ref }), { ok: true, value: { stopped: true } }); await done(work); await restart();
    assert.equal((await done(withReceipt(work, early.receipt))).lastReply, 'REPLY_2');
  }
  if (mode === 'unsafe' || mode === 'all') {
    const blocked = await start('permission');
    const refused = await rpc('work.send', { ref: blocked.ref, message: 'never delivered' }) as { ok: boolean; reason: string };
    assert.equal(refused.ok, false); assert.equal(refused.reason, 'busy');
    const unfinished = await start('hold'); await restart();
    const count = calls().filter(call => call.method === 'session.send').length;
    const orphan = await rpc('work.send', { ref: unfinished.ref, message: 'do not replay' }) as { ok: boolean; reason: string };
    assert.equal(orphan.ok, false); assert.equal(orphan.reason, 'unreachable');
    const external = await rpc('work.queue', { ref: { adapter: 'copilot-cli', id: crypto.randomUUID() }, message: 'do not adopt' }) as { ok: boolean; reason: string };
    assert.equal(external.ok, false); assert.equal(external.reason, 'not_found');
    assert.equal(calls().filter(call => call.method === 'session.send').length, count);
    const completed = await start('settled'); await done(completed);
    const lost = await rpc('work.send', { ref: completed.ref, message: 'lost-ack' }) as { ok: boolean; reason: string };
    assert.equal(lost.ok, false); assert.equal(lost.reason, 'unreachable');
    const uncertainStatus = await rpc('work.status', { ref: completed.ref }) as { ok: boolean; reason: string };
    assert.equal(uncertainStatus.ok, false); assert.equal(uncertainStatus.reason, 'unreachable');
    await restart();
    const uncertain = await rpc('work.send', { ref: completed.ref, message: 'do not replay' }) as { ok: boolean; reason: string };
    assert.equal(uncertain.ok, false); assert.equal(uncertain.reason, 'unreachable');
    assert.equal((await done(completed)).lastReply, 'REPLY_1');
    assert.equal(calls().filter(call => call.method === 'session.send' && call.params.prompt === 'lost-ack').length, 1);
  }
  if (mode === 'receipt' || mode === 'all') {
    const work = await start('settled'); await done(work);
    const unknown = await rpc('work.status', { ref: work.ref, receipt: { executionId: work.ref.id, inputId: '__proto__' } }) as { ok: boolean; reason: string };
    assert.equal(unknown.ok, false); assert.equal(unknown.reason, 'not_found');
    installFixture('--no-models');
    const refused = await rpc('work.send', { ref: work.ref, message: 'never delivered' }) as { ok: boolean; reason: string };
    assert.equal(refused.ok, false); assert.equal(refused.reason, 'unsupported_model');
    assert.equal((await done(work)).lastReply, 'REPLY_1'); installFixture('--idle-after-abort');
  }
  if (mode === 'persist' || mode === 'all') {
    const work = await start('late-settled');
    const pid = calls().findLast(call => call.method === 'session.send').pid;
    mkdirSync(join(run, 'data/copilot-workers/receipts', work.ref.id, `${work.receipt!.inputId}.json.tmp`));
    writeFileSync(join(run, 'workspace/release-settlement'), 'release');
    for (let poll = 0; poll < 200; poll++) {
      try { process.kill(pid, 0); } catch { break; }
      await new Promise(done => setTimeout(done, 5));
    }
    assert.throws(() => process.kill(pid, 0), 'persistence-failed runtime must be reaped');
    const failed = await rpc('work.status', { ref: work.ref, receipt: work.receipt }) as { ok: boolean; reason: string };
    assert.equal(failed.ok, false); assert.equal(failed.reason, 'unreachable');
    await restart();
    const refused = await rpc('work.send', { ref: work.ref, message: 'do not replay' }) as { ok: boolean; reason: string };
    assert.equal(refused.ok, false); assert.equal(refused.reason, 'unreachable');
  }
  if (mode === 'writes' || mode === 'all') {
    const work = await start('hold');
    const completed = await deliver(work, 'settled');
    const pending = await deliver(work, 'queued', true);
    const file = (input: string) => join(run, 'data/copilot-workers/receipts', work.ref.id, `${encodeURIComponent(input)}.json`);
    const completePath = file(completed.receipt!.inputId); const pendingPath = file(pending.receipt!.inputId);
    const completeFd = openSync(completePath, 'r'); const pendingFd = openSync(pendingPath, 'r');
    try {
      await deliver(work, 'fragments');
      const report = Array.from({ length: 12 }, (_, index) => `FRAGMENT_${index};`).join('');
      assert.equal((await status(work)).lastReply, report);
      observations.push({ beforeAbort: { completedSameInode: statSync(completePath).ino === fstatSync(completeFd).ino, pendingSameInode: statSync(pendingPath).ino === fstatSync(pendingFd).ino } });
      assert.equal(statSync(completePath).ino, fstatSync(completeFd).ino, 'streaming must not rewrite an unchanged completed receipt');
      assert.equal(statSync(pendingPath).ino, fstatSync(pendingFd).ino, 'streaming must not rewrite an unchanged pending receipt');
      assert.deepEqual(await rpc('work.stop', { ref: work.ref }), { ok: true, value: { stopped: true } });
      assert.equal(statSync(completePath).ino, fstatSync(completeFd).ino);
      assert.notEqual(statSync(pendingPath).ino, fstatSync(pendingFd).ino, 'abort outcome must persist the changed pending receipt');
      assert.equal((await done(withReceipt(work, completed.receipt))).lastReply, 'REPLY_2');
      await restart(); assert.equal((await done(withReceipt(work, completed.receipt))).lastReply, 'REPLY_2');
    } finally { closeSync(completeFd); closeSync(pendingFd); }
  }
  if (mode === 'legacy-read' || mode === 'all') {
    const completed = await start('settled'); const active = await start('hold');
    const before = await done(completed);
    rmSync(join(run, 'data/copilot-workers/receipts'), { recursive: true });
    const generic = await rpc('work.status', { ref: completed.ref }) as Result<WorkDetail>;
    assert(generic.ok); assert.deepEqual(generic.value, before);
    assert.deepEqual(await status(completed), before);
    const activeGeneric = await rpc('work.status', { ref: active.ref }) as Result<WorkDetail>;
    assert(activeGeneric.ok); assert.equal(activeGeneric.value.status, 'running');
    assert.equal((await status(active)).status, 'running');
    await restart();
    const after = await rpc('work.status', { ref: completed.ref }) as Result<WorkDetail>;
    assert(after.ok); assert.deepEqual(after.value, before); assert.deepEqual(await status(completed), before);
    const orphan = await rpc('work.status', { ref: active.ref, receipt: active.receipt }) as { ok: boolean; reason: string };
    assert.equal(orphan.ok, false); assert.equal(orphan.reason, 'unreachable');
    assert(!existsSync(join(run, 'data/copilot-workers/receipts')));
    assert(!calls().some(call => call.method === 'session.resume' && call.params.sessionId === completed.ref.id));
  }
  if (mode === 'preflight' || mode === 'all') {
    for (const [flag, diagnostic] of [['--logged-out', 'copilot login'], ['--wrong-version', 'runtime version'], ['--resume-error', 'Synthetic resume rejection']]) {
      installFixture(); const work = await start('settled'); await done(work); installFixture(flag);
      const count = calls().filter(call => call.method === 'session.send').length;
      const refused = await rpc('work.send', { ref: work.ref, message: 'settled' }) as { ok: boolean; reason: string; detail: string };
      assert.equal(refused.ok, false); assert.equal(refused.reason, 'unreachable'); assert(refused.detail.includes(diagnostic));
      assert(!refused.detail.includes('input may be accepted')); assert(!refused.detail.includes('do not replay'));
      assert.equal(calls().filter(call => call.method === 'session.send').length, count);
      assert.equal((await done(work)).lastReply, 'REPLY_1');
      installFixture(); const retry = await deliver(work, 'settled');
      assert.equal((await done(withReceipt(work, retry.receipt))).lastReply, 'REPLY_2');
      assert.equal(calls().filter(call => call.method === 'session.send').length, count + 1);
    }
    const work = await start('settled'); await done(work);
    const sending = rpc('work.send', { ref: work.ref, message: 'held-ack' });
    try {
      for (let poll = 0; poll < 200 && !calls().some(call => call.method === 'session.send' && call.params.prompt === 'held-ack'); poll++) await new Promise(done => setTimeout(done, 5));
      assert(calls().some(call => call.method === 'session.send' && call.params.prompt === 'held-ack'));
      mkdirSync(join(run, 'data/copilot-workers', `${work.ref.id}.json.tmp`));
    } finally { writeFileSync(join(run, 'workspace/release-ack'), 'release'); }
    const refused = await sending as { ok: boolean; reason: string; detail: string };
    assert.equal(refused.ok, false); assert.equal(refused.reason, 'unreachable'); assert(refused.detail.includes('input may be accepted; do not replay'));
    await restart();
    const orphan = await rpc('work.send', { ref: work.ref, message: 'do not replay' }) as { ok: boolean; reason: string };
    assert.equal(orphan.ok, false); assert.equal(orphan.reason, 'unreachable');
  }
  const catalog = await rpc('work.adapters', {}) as { value: { id: string; capabilities: string[] }[] };
  assert.deepEqual(catalog.value.find(adapter => adapter.id === 'copilot-cli')?.capabilities, ['find', 'start', 'rename', 'send', 'queue', 'status', 'stop']);
  ws!.close(); await app!.cleanup(); app = undefined;
  const traffic = calls();
  for (const pid of new Set<number>(traffic.map(call => call.pid))) assert.throws(() => process.kill(pid, 0));
  assert(traffic.filter(call => call.method === 'session.send').every(call => call.params.mode === 'enqueue'));
  observations.push({ calls: traffic, cleanupPidsGone: [...new Set(traffic.map(call => call.pid))] });
  console.log(`PASS owned Copilot send/queue: terminal resume, ordered pending consumption, full receipt replies, durable rollover/restart and no uncertain replay. ${run}/evidence/observed.json`);
} finally {
  ws?.close(); await app?.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observations, null, 2));
}
