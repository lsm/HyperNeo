import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { Result, WorkDetail, WorkStarted } from '../../../packages/daemon/src/lib/drivers/types.ts';

const [portText, runText] = process.argv.slice(2);
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
const config = getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') });
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
    const timer = setTimeout(() => fail(new Error(`${name} timeout`)), 20000);
    ws!.onmessage = event => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer); observations.push({ name, input, reply });
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
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
  const catalog = await rpc('work.adapters', {}) as { value: { id: string; capabilities: string[] }[] };
  assert.deepEqual(catalog.value.find(adapter => adapter.id === 'copilot-cli')?.capabilities, ['find', 'start', 'status', 'stop']);
  const complete = await start('settled');
  assert.equal((await status(complete)).inputEvidence?.state, 'observed');
  assert.equal((await status(complete)).lastReply, 'REPLY_1');
  assert.equal((await status(complete)).status, 'done');
  assert.equal(complete.link, undefined);
  assert.match(complete.watchHint ?? '', /work.status/);
  const blocked = await start('permission');
  assert.equal((await status(blocked)).status, 'needs_you');
  const stopped = await start('hold');
  assert.deepEqual(await rpc('work.stop', { ref: stopped.ref }), { ok: true, value: { stopped: true } });
  assert.equal((await status(stopped)).status, 'stopped');
  assert.equal((await rpc('work.send', { ref: stopped.ref, message: 'do not send' }) as { reason: string }).reason, 'unsupported');
  assert.equal((await rpc('work.stop', { ref: { adapter: 'copilot-cli', id: crypto.randomUUID() } }) as { reason: string }).reason, 'not_found');
  installFixture('--logged-out');
  const loggedOut = await rpc('work.start', { adapter: 'copilot-cli', place: complete.place, title: 'No login', model: 'synthetic-model', message: 'never delivered' }) as { ok: boolean; detail: string };
  assert.equal(loggedOut.ok, false); assert.match(loggedOut.detail, /copilot login/);
  installFixture('--no-models');
  assert.equal((await rpc('work.start', { adapter: 'copilot-cli', place: complete.place, title: 'No catalog', model: 'synthetic-model', message: 'never delivered' }) as { ok: boolean }).ok, false);
  installFixture();
  const active = await start('hold');
  ws!.close(); await app!.cleanup(); app = undefined;
  const calls = readFileSync(join(run, 'workspace/calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  for (const pid of new Set<number>(calls.map(call => call.pid))) assert.throws(() => process.kill(pid, 0), `owned runtime ${pid} survived cleanup`);
  observations.push({ cleanupPidsGone: [...new Set(calls.map(call => call.pid))], calls });
  await connect();
  const recovered = await rpc('work.status', { ref: active.ref, receipt: active.receipt }) as { ok: boolean; reason: string };
  assert.equal(recovered.ok, false); assert.equal(recovered.reason, 'unreachable');
  assert.equal(readFileSync(join(run, 'workspace/calls.jsonl'), 'utf8').trim().split('\n').filter(line => JSON.parse(line).method === 'session.send').length, 4);
  console.log(`PASS public Copilot work.start/status/stop: reply, denied permission, abort evidence, cleanup and no restart replay. ${run}/evidence/observed.json`);
} finally {
  ws?.close(); await app?.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observations, null, 2));
}
