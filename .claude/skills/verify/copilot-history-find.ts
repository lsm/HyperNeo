import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { Result, WorkStarted } from '../../../packages/daemon/src/lib/drivers/types.ts';

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
const acp = fileURLToPath(new URL('../../../packages/daemon/tests/fixtures/copilot-acp.ts', import.meta.url));
writeFileSync(join(run, 'bin/copilot'), `#!/usr/bin/env bun\nif (process.argv.includes('--acp')) await import(${JSON.stringify(acp)}); else { process.argv.push('--production-version', '--durable-inputs'); await import(${JSON.stringify(fixture)}); }\n`, { mode: 0o700 });
mkdirSync(join(run, 'home/evidence'), { recursive: true });
writeFileSync(join(run, 'home/copilot-list.json'), '[]');
const observations: unknown[] = [];
process.chdir(run);
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
const calls = () => readFileSync(join(run, 'workspace/calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
async function restart() { ws?.close(); await app!.cleanup(); app = undefined; await connect(); }
try {
  await connect();
  const work = await start('history');
  writeFileSync(join(run, 'home/copilot-list.json'), JSON.stringify([
    { sessionId: work.ref.id, cwd: join(run, 'workspace'), title: 'Wrong external title', updatedAt: new Date().toISOString() },
    { sessionId: 'external-read-only', cwd: join(run, 'workspace'), title: 'External task', updatedAt: '2026-01-01T00:00:00Z' },
  ]));
  const read = await rpc('work.read', { sessionId: work.ref.id, before: 10, after: 10 }) as Result<{ turns: { messageId: string; role: string; text: string }[] }>;
  assert(read.ok, JSON.stringify(read));
  assert.deepEqual(read.value.turns.map(t => t.role), ['user', 'tool', 'tool', 'assistant']);
  assert.equal(read.value.turns.at(-1)?.text, 'HISTORY_REPLY');
  const found = await rpc('work.find', { adapters: ['copilot-cli'], folder: join(run, 'workspace'), includeClosed: true, localOnly: true }) as { places: { work: { ref: { id: string }; status: string; title: string }[] }[] };
  const items = found.places.flatMap(p => p.work);
  assert.deepEqual(items.filter(w => w.ref.id === work.ref.id).map(w => [w.title, w.status]), [['Synthetic Copilot work', 'done']]);
  assert.equal(items.filter(w => w.ref.id === 'external-read-only').length, 1);
  const prior = calls().length;
  await restart();
  assert.deepEqual(await rpc('work.read', { sessionId: work.ref.id, before: 10, after: 10 }), read);
  assert(!calls().slice(prior).some(c => ['session.resume', 'session.create', 'session.send'].includes(c.method)));
  const external = await rpc('work.send', { ref: { adapter: 'copilot-cli', id: 'external-read-only' }, message: 'must not send' }) as Result<unknown>;
  assert(!external.ok && external.reason === 'not_found');
  console.log(`PASS: owned Copilot work.read/find through isolated daemon; evidence ${run}/evidence/observed.json`);
} finally {
  ws?.close(); await app?.cleanup();
  const pids = existsSync(join(run, 'workspace/calls.jsonl')) ? [...new Set(calls().map(c => c.pid))] : [];
  await new Promise(done => setTimeout(done, 100));
  const remaining = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
  observations.push({ ownedPids: pids, remaining });
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observations, null, 2));
  assert.deepEqual(remaining, []);
}
