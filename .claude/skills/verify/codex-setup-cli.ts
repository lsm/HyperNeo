import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';
import { spawnProcess, type SpawnFn } from '../../../packages/daemon/src/lib/runtime-spawn/index.ts';

const run = resolve(process.argv.at(-1)!);
const home = join(run, 'home');
const data = join(run, 'data');
const tokenFile = join(data, 'codex-app-server-bridge', 'token');
assert.equal(process.platform, 'darwin');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, home);
assert.equal(process.env.HYPERNEO_DATA_DIR, data);
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) assert.equal(process.env[key], undefined);

const socketDir = join(home, '.codex', 'app-server-control');
const agents = join(home, 'Library', 'LaunchAgents');
await mkdir(socketDir, { recursive: true });
await mkdir(agents, { recursive: true });
const legacy = new Set(['ai.hyperneo.codex-app-setup', 'ai.hyperneo.codex-app-forwarder']);
for (const label of legacy) await writeFile(join(agents, `${label}.plist`), 'fixture');

let environment: string | null = 'ws://127.0.0.1:47912/rpc';
let active = true;
let remoteEnabled = false;
let busy = Promise.withResolvers<void>();
const effects: string[] = [];
const fixture = createServer();
const sockets = new WebSocketServer({ server: fixture });
sockets.on('connection', (socket) => socket.on('message', (payload) => {
  const { id, method } = JSON.parse(String(payload));
  if (id === undefined) return;
  let result: unknown = {};
  if (method === 'thread/loaded/list') result = { data: ['fixture'], nextCursor: null };
  if (method === 'thread/read') {
    result = { thread: { status: { type: active ? 'active' : 'idle' } } };
    if (active) busy.resolve();
  }
  if (method === 'remoteControl/status/read') result = { status: remoteEnabled ? 'connected' : 'disabled' };
  socket.send(JSON.stringify({ id, result }));
}));
fixture.listen(join(socketDir, 'app-server-control.sock'));
await once(fixture, 'listening');

const spawn: SpawnFn = ([command, verb, key, value]) => {
  let code = 0;
  let output = '';
  if (command === '/bin/launchctl') {
    const label = key.split('/').at(-1)!;
    if (verb === 'getenv') output = environment === null ? '' : `${environment}\n`;
    else if (verb === 'print') code = legacy.has(label) ? 0 : 1;
    else if (verb === 'bootout') { legacy.delete(label); effects.push('bootout'); }
    else if (verb === 'setenv' || verb === 'unsetenv') {
      environment = verb === 'setenv' ? value : null;
      effects.push(verb);
    } else throw new Error('Unexpected launchctl verb');
  } else if (command === '/usr/bin/osascript') effects.push('quit');
  else if (command === '/usr/bin/open') effects.push('open');
  else {
    assert.equal(verb, 'app-server');
    assert.equal(key, 'daemon');
    if (value === 'enable-remote-control') remoteEnabled = true;
    effects.push(value);
  }
  return { stdout: new Response(output).body, stderr: null, exited: Promise.resolve(code), exitCode: code, kill() {} };
};

const config = getConfig({ host: '127.0.0.1', port: 0, dbPath: join(data, 'daemon.db') });
const boot = () => createDaemonApp({ config, verbose: true, standalone: true, codexSetupSpawn: spawn });
const logs: string[] = [];
const off = subscribeToStructuredLogs((record) => { logs.push(JSON.stringify(record)); });
const cli = async (...flags: string[]) => {
  const child = spawnProcess([process.execPath, 'packages/cli/main.ts', 'codex-setup', ...flags], { stdout: 'pipe', stderr: 'pipe' });
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  logs.push(output, errors);
  assert.equal(code, 0, 'codex-setup CLI failed');
  const reply = JSON.parse(output);
  assert.equal(reply.ok, true);
  return reply;
};
const dial = (url: string) =>
  new Promise<boolean>((done) => {
    const socket = new WebSocket(url, { handshakeTimeout: 1500 });
    let opened = false;
    socket.on('error', () => {});
    socket.once('open', () => {
      opened = true;
      socket.terminate();
    });
    socket.once('close', () => done(opened));
  });
let app: Awaited<ReturnType<typeof boot>> | undefined;
try {
  const reservation = createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((done) => reservation.close(() => done()));
  app = await boot();
  app.settingsManager.updateGlobalSettings({ codexAppServerBridge: { enabled: false, port: address.port } });
  const setup = cli('--no-remote-control');
  await Promise.race([busy.promise, setup]);
  assert.equal(effects.includes('bootout'), false);
  active = false;
  assert.equal((await setup).removed.length, 2);
  assert.deepEqual(effects, ['bootout', 'bootout', 'start', 'setenv', 'quit', 'open']);
  assert.equal(app.settingsManager.getGlobalSettings().codexAppServerBridge?.remoteControl, 'skipped');
  const first = String(environment);
  assert(await dial(first));
  const tokens = [await readFile(tokenFile, 'utf8')];
  await cli('--no-remote-control');
  const rotated = String(environment);
  tokens.push(await readFile(tokenFile, 'utf8'));
  assert(first !== rotated && !(await dial(first)) && await dial(rotated));
  await app.cleanup();
  app = undefined;
  effects.length = 0;
  environment = null;
  app = await boot();
  assert.deepEqual(effects, ['setenv', 'start']);
  assert(String(environment) === rotated);
  assert(await dial(rotated));
  busy = Promise.withResolvers<void>();
  active = true;
  const undoMigration = cli('--undo');
  await Promise.race([busy.promise, undoMigration]);
  assert(String(environment) === rotated);
  assert(await dial(rotated));
  active = false;
  await undoMigration;
  assert.equal(environment, null);
  assert.equal(await dial(rotated), false);
  await assert.rejects(stat(tokenFile), { code: 'ENOENT' });
  assert.equal(app.settingsManager.getGlobalSettings().codexAppServerBridge?.decision, 'declined');
  environment = 'ws://distinct.example/';
  app.settingsManager.updateGlobalSettings({ codexAppServerBridge: { enabled: false, port: address.port, decision: 'declined' } });
  await cli();
  tokens.push(await readFile(tokenFile, 'utf8'));
  await cli();
  tokens.push(await readFile(tokenFile, 'utf8'));
  assert.equal(effects.filter((effect) => effect === 'enable-remote-control').length, 1);
  const undo = await cli('--undo');
  assert(undo.message.includes('disable-remote-control'));
  assert.equal(environment, 'ws://distinct.example/');
  assert.equal(remoteEnabled, true);
  assert.equal(logs.some((line) => tokens.some((token) => line.includes(token))), false);
  console.log(JSON.stringify({ cliExitCodes: 0, commands: 6, migrated: 2, busyDeferrals: 2, loginReapplications: 1, rotations: 2, undoModes: 2, tokenLogHits: 0 }));
} finally {
  active = false;
  off();
  await app?.cleanup();
  for (const client of sockets.clients) client.terminate();
  sockets.close();
  await new Promise<void>((done) => fixture.close(() => done()));
}
