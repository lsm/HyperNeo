import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [binaryPath, directory] = process.argv.slice(2);
const deviceCommands = process.argv.includes('--device-commands');
const run = resolve(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
for (const part of ['bin', 'data', 'workspace', 'evidence', 'tmp']) mkdirSync(join(run, part), { recursive: true });
for (const command of ['security', 'gh', 'open', 'ps'])
  writeFileSync(join(run, 'bin', command), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/security'), "#!/bin/sh\nprintf \"unexpected-discovery\\n\" >> \"$HYPERNEO_DATA_DIR/security-attempts\"\nexit 1\n", { mode: 0o700 });
writeFileSync(join(run, 'bin/claude'), '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o700 });
const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('unused') });
const port = probe.port;
assert.notEqual(port, 8399);
await probe.stop(true);
const child = Bun.spawn([resolve(binaryPath), '--host', '127.0.0.1', '--port', String(port), '--db-path', join(run, 'data/daemon.db'), '--workspace', join(run, 'workspace')], {
  env: { HOME: join(run, 'home'), PATH: process.platform === 'win32' ? join(run, 'bin') : `${join(run, 'bin')}:/usr/bin:/bin:/usr/sbin`, USERPROFILE: join(run, 'home'), SystemRoot: process.env.SystemRoot, TMPDIR: join(run, 'tmp'), TEMP: join(run, 'tmp'), TMP: join(run, 'tmp'), HYPERNEO_DATA_DIR: join(run, 'data'), NODE_ENV: 'test', LOG_LEVEL: 'info', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
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
  if (deviceCommands) {
    const cli = async (args: string[]) => {
      const command = Bun.spawn([resolve(binaryPath), ...args], { env: { HOME: join(run, 'home'), PATH: `${join(run, 'bin')}:/usr/bin:/bin:/usr/sbin`, NODE_ENV: 'test', HYPERNEO_DATA_DIR: join(run, 'data'), HYPERNEO_SESSION_DOOR: join(run, 'data/session-door.sock') }, stdout: 'pipe', stderr: 'pipe' });
      const timeout = setTimeout(() => command.kill('SIGKILL'), 15000);
      try {
        const [out, err, exit] = await Promise.all([new Response(command.stdout).text(), new Response(command.stderr).text(), command.exited]);
        return { out, err, exit };
      } finally { clearTimeout(timeout); }
    };
    const help = await cli(['--help']), empty = await cli(['devices']), pair = await cli(['pair', '--name', 'Synthetic phone']);
    const commands: Record<string, unknown> = { help: { exit: help.exit, listsPair: help.out.includes('hyperneo pair'), listsDevices: help.out.includes('hyperneo devices') }, devices: { exit: empty.exit, error: empty.err }, pair: { exit: pair.exit, error: pair.err } };
    writeFileSync(join(run, 'evidence/commands.json'), JSON.stringify(commands, null, 2));
    assert.equal(help.exit, 0); assert(help.out.includes('hyperneo pair') && help.out.includes('hyperneo devices'), 'Compiled --help must list device commands');
    assert.equal(empty.exit, 0, empty.err); assert.deepEqual(JSON.parse(empty.out).devices, []);
    assert.equal(pair.exit, 0, pair.err);
    const code = JSON.parse(pair.out);
    assert.equal(code.ok, true); assert.equal(code.approval, 'approved'); assert.equal(typeof code.code, 'string');
    const claim = await fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.code, name: 'Synthetic phone' }) });
    assert.equal(claim.status, 200);
    const paired = await claim.json() as { deviceId: string; kind: string; credential: string };
    assert.equal(paired.kind, 'human');
    const listed = await cli(['devices']); assert.equal(listed.exit, 0, listed.err);
    const devices = JSON.parse(listed.out).devices as { id: string; name: string; kind: string }[];
    assert.deepEqual(devices.map(({ id, name, kind }) => ({ id, name, kind })), [{ id: paired.deviceId, name: 'Synthetic phone', kind: 'human' }]);
    assert(!listed.out.includes(paired.credential));
    const revoked = await cli(['devices', 'revoke', paired.deviceId]); assert.equal(revoked.exit, 0, revoked.err); assert.equal(JSON.parse(revoked.out).ok, true);
    const final = await cli(['devices']); assert.equal(final.exit, 0, final.err); assert.equal(typeof JSON.parse(final.out).devices[0].revokedAt, 'number');
    commands.paired = { count: devices.length, name: 'Synthetic phone', kind: paired.kind, credentialDisclosed: false, revoked: true };
    commands.verified = true;
    writeFileSync(join(run, 'evidence/commands.json'), JSON.stringify(commands, null, 2));
  }
  await new Promise((done) => setTimeout(done, 1500));
  observed = { status: 'pass', port, binary: resolve(binaryPath), build, limits: 'Startup and worker loading only; embedding inference and native Desktop are not exercised.' };
} finally {
  ws?.close(); child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  const exit = await child.exited; clearTimeout(timer);
  const logs = `${await stdout}\n${await stderr}`;
  writeFileSync(join(run, 'evidence/daemon.log'), logs);
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ pid: child.pid, exit, stopped: true }));
  assert(logs.includes('OAuth refresh scheduler skipped: test daemon without the human login'), 'real compiled usesHumanLogin must disable human login');
  assert(!existsSync(join(run, 'data/security-attempts')), 'test mode must not attempt credential discovery');
  assert(!existsSync(join(run, 'data/logs/daemon.db.jsonl')), 'test config must not enable the default structured log file');
  assert(!logs.includes('ModuleNotFound'), 'Compiled worker module is missing');
  assert(!logs.includes('embedding worker crashed'), 'Embedding worker failed to execute');
  assert(!logs.includes('Unexpected use of reserved word') && !logs.includes('daemon runs without an event-loop watchdog'), 'Watchdog did not load as JavaScript');
}
writeFileSync(join(run, 'evidence/build.json'), JSON.stringify(observed, null, 2));
console.log('PASS: compiled binary starts, system.build is healthy, and workers load without missing-module or raw-TypeScript errors');
