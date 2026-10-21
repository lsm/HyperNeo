import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

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
const scope = join(run, 'home/Library/Application Support/Claude/claude-code-sessions/synthetic/account');
for (const dir of ['bin', 'evidence', 'workspace']) mkdirSync(join(run, dir), { recursive: true });
mkdirSync(scope, { recursive: true });
const fixture = fileURLToPath(new URL('../../../packages/daemon/tests/fixtures/claude-link-cli.ts', import.meta.url));
writeFileSync(join(run, 'bin/claude'), `#!/usr/bin/env bun\nawait import(${JSON.stringify(fixture)});\n`, { mode: 0o700 });
writeFileSync(join(run, 'bin/script'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const evidence: unknown[] = [];
const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
let ws: WebSocket | undefined;
try {
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('connection failed')); });
  const rpc = (name: string, input: unknown) => new Promise<unknown>((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error(`${name} timeout`)), 15000);
    ws!.onmessage = event => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer); evidence.push({ name, input, reply });
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const started = await rpc('work.start', { adapter: 'claude-desktop', place: { machine: hostname(), folder: join(run, 'workspace'), name: 'Synthetic project' }, title: 'Synthetic CLI worker', message: 'Synthetic task only' }) as { ok: boolean; value: { ref: { id: string }; link?: string; watchHint?: string } };
  assert.equal(started.ok, true);
  const ref = started.value.ref;
  const sessionId = ref.id.replace(/^local_/, '');
  assert(!existsSync(join(scope, `${ref.id}.json`)));
  const assertPending = (value: { link?: string; watchHint?: string }) => { assert.equal(value.link, undefined, 'unregistered CLI worker must not advertise a Desktop link'); assert.match(value.watchHint ?? '', /work.status/); };
  assertPending(started.value);
  const status = await rpc('work.status', { ref }) as typeof started;
  assert.equal(status.ok, true); assertPending(status.value);
  const pending = await rpc('work.find', { adapters: ['claude-desktop'], id: ref.id, localOnly: true }) as { places: { work: typeof started.value[] }[] };
  assert.equal(pending.places.flatMap(p => p.work).length, 1);
  assertPending(pending.places[0].work[0]);
  writeFileSync(join(scope, `${ref.id}.json`), JSON.stringify({ sessionId: ref.id, cliSessionId: sessionId, cwd: join(run, 'workspace'), title: 'Synthetic CLI worker', lastActivityAt: Date.now(), isArchived: false }));
  const registered = await rpc('work.find', { adapters: ['claude-desktop'], id: ref.id, localOnly: true }) as typeof pending;
  assert.equal(registered.places[0].work[0].link, `claude://claude.ai/epitaxy/${ref.id}`);
  assert.equal(registered.places[0].work[0].watchHint, undefined);
  const registeredStatus = await rpc('work.status', { ref }) as typeof started;
  assert.equal(registeredStatus.value.link, `claude://claude.ai/epitaxy/${ref.id}`);
  evidence.push({ registeredWithoutDaemonRestart: true, cliSessionId: sessionId });
  console.log(`PASS: real work.start/status/find withhold an unregistered Desktop link, then expose it after a synthetic Desktop record appears. ${run}/evidence/observed.json`);
} finally {
  ws?.close();
  const pidFile = join(run, 'evidence/worker-pid');
  if (existsSync(pidFile)) { try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGTERM'); } catch {} }
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
}
