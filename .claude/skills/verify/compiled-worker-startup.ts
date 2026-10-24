import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [binaryPath, directory] = process.argv.slice(2);
const run = resolve(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const part of ['bin', 'data', 'workspace', 'evidence', 'tmp']) mkdirSync(join(run, part), { recursive: true });
for (const command of ['security', 'gh', 'open', 'ps'])
  writeFileSync(join(run, 'bin', command), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('unused') });
const port = probe.port;
assert.notEqual(port, 8399);
await probe.stop(true);
const child = Bun.spawn([resolve(binaryPath), '--host', '127.0.0.1', '--port', String(port), '--db-path', join(run, 'data/daemon.db'), '--workspace', join(run, 'workspace')], {
  env: { HOME: join(run, 'home'), PATH: process.platform === 'win32' ? join(run, 'bin') : `${join(run, 'bin')}:/usr/bin:/bin:/usr/sbin`, USERPROFILE: join(run, 'home'), SystemRoot: process.env.SystemRoot, TEMP: join(run, 'tmp'), TMP: join(run, 'tmp'), HYPERNEO_DATA_DIR: join(run, 'data'), NODE_ENV: 'test', LOG_LEVEL: 'info', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
  stdout: 'pipe', stderr: 'pipe',
});
const stdout = new Response(child.stdout).text();
const stderr = new Response(child.stderr).text();
let ws: WebSocket | undefined;
let observed: Record<string, unknown> | undefined;
try {
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline && child.exitCode === null) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/`)).ok; } catch {}
    if (ready) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert(ready, `Compiled binary failed to start; exit=${child.exitCode}`);
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('WS unavailable')); });
  const id = crypto.randomUUID();
  const build = await new Promise<Record<string, unknown>>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('system.build timeout')), 10000);
    ws!.onmessage = (event) => { const result = JSON.parse(String(event.data)); if ((result.requestId ?? result.id) !== id) return; clearTimeout(timer); result.error ? fail(new Error(JSON.stringify(result.error))) : done(result.data); };
    ws!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method: 'operation.invoke', data: { name: 'system.build', input: {} }, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  assert.equal(build.health, 'ok');
  assert.equal(build.pid, child.pid);
  await new Promise((done) => setTimeout(done, 1500));
  observed = { status: 'pass', port, binary: resolve(binaryPath), build, limits: 'Startup and worker loading only; embedding inference and native Desktop are not exercised.' };
} finally {
  ws?.close(); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  const exit = await child.exited; clearTimeout(timer);
  const logs = `${await stdout}\n${await stderr}`;
  writeFileSync(join(run, 'evidence/daemon.log'), logs);
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ pid: child.pid, exit, stopped: true }));
  assert(!logs.includes('ModuleNotFound'), 'Compiled worker module is missing');
  assert(!logs.includes('embedding worker crashed'), 'Embedding worker failed to execute');
  assert(!logs.includes('Unexpected use of reserved word') && !logs.includes('daemon runs without an event-loop watchdog'), 'Watchdog did not load as JavaScript');
}
writeFileSync(join(run, 'evidence/build.json'), JSON.stringify(observed, null, 2));
console.log('PASS: compiled binary starts, system.build is healthy, and workers load without missing-module or raw-TypeScript errors');
