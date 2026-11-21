import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { spawnProcess, type SpawnFn } from '../../../packages/daemon/src/lib/runtime-spawn/index.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import type { NeoSnapshot } from '../../../packages/shared/src/types/neo-snapshot.ts';

const run = resolve(process.argv.at(-1)!);
const home = join(run, 'home');
const codex = join(home, '.codex');
const data = join(run, 'data');
const tokenFile = join(data, 'codex-app-server-bridge', 'token');
assert.equal(process.platform, 'darwin');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, home);
assert.equal(process.env.HYPERNEO_DATA_DIR, data);
for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) assert.equal(process.env[key], undefined);
for (const [command, script] of Object.entries({ ps: 'exit 0', open: 'exit 1', gh: 'exit 1', claude: 'echo "[]"' })) {
  await writeFile(join(run, 'bin', command), `#!/bin/sh\n${script}\n`, { mode: 0o700 });
}
await mkdir(join(codex, 'app-server-control'), { recursive: true });
const reservation = createServer().listen(0, '127.0.0.1');
await once(reservation, 'listening');
const address = reservation.address();
assert(address && typeof address !== 'string' && address.port !== 8399);
await new Promise<void>((done) => reservation.close(() => done()));

let active = false;
let remote = false;
let environment = '';
let busyReads = 0;
let queued = 0;
const effects: string[] = [];
const server = createServer();
const sockets = new WebSocketServer({ server });
sockets.on('connection', (socket) => socket.on('message', (bytes) => {
  const { id, method } = JSON.parse(String(bytes));
  if (id === undefined) return;
  let result: unknown = {};
  if (method === 'thread/loaded/list') result = { data: ['fixture'], nextCursor: null };
  if (method === 'thread/read') {
    if (active) busyReads++;
    result = { thread: { status: { type: active ? 'active' : 'idle' } } };
  }
  if (method === 'remoteControl/status/read') result = { status: remote ? 'connected' : 'disabled' };
  if (method === 'thread/queue/add') result = { queuedSubmission: { id: `queue-${++queued}` } };
  socket.send(JSON.stringify({ id, result }));
}));
server.listen(join(codex, 'app-server-control', 'app-server-control.sock'));
await once(server, 'listening');

const spawn: SpawnFn = ([command, verb, key, value]) => {
  let code = 0;
  let output = '';
  if (command === '/bin/launchctl') {
    if (verb === 'print') code = 1;
    else if (verb === 'getenv') output = environment ? `${environment}\n` : '';
    else if (verb === 'setenv' || verb === 'unsetenv') {
      environment = verb === 'setenv' ? value : '';
      effects.push(verb);
    } else throw new Error('Unexpected launchctl action');
  } else if (command === '/usr/bin/osascript') effects.push('quit');
  else if (command === '/usr/bin/open') effects.push('open');
  else {
    assert.equal(verb, 'app-server');
    assert.equal(key, 'daemon');
    if (value === 'enable-remote-control') remote = true;
    effects.push(value);
  }
  return { stdout: new Response(output).body, stderr: null, exited: Promise.resolve(code), exitCode: code, kill() {} };
};

const config = getConfig({ host: '127.0.0.1', port: 0, dbPath: join(data, 'daemon.db') });
let app: Awaited<ReturnType<typeof createDaemonApp>>;
let running = false;
async function boot() {
  app = await createDaemonApp({ config, verbose: true, standalone: true, codexSetupSpawn: spawn });
  running = true;
}
async function stop() { await app.cleanup(); running = false; }
async function child(args: string[], env = process.env) {
  const subprocess = spawnProcess(args, { stdout: 'pipe', stderr: 'pipe', env: env as Record<string, string> });
  const [exit, output] = await Promise.all([subprocess.exited, new Response(subprocess.stdout).text()]);
  assert.equal(exit, 0, 'Fixture command exited unsuccessfully');
  return JSON.parse(output);
}
async function rpc(name: string, input = {}) {
  const result = await child([process.execPath, join(import.meta.dir, 'rpc.ts'), name, JSON.stringify(input)], {
    ...process.env, VERIFY_PORT: String(app.server.port),
  });
  assert(!result.reply.error, `${name}: ${JSON.stringify(result.reply.error)}`);
  assert.notEqual(result.reply.kind, 'failed', name);
  return result.reply.kind === 'completed' ? result.reply.value : result.reply;
}
const cli = (...flags: string[]) => child([process.execPath, 'packages/cli/main.ts', 'codex-setup', ...flags]);
const read = () => app.settingsManager.getGlobalSettings().codexAppServerBridge;
async function cards() {
  const snapshot = await rpc('neo.snapshot') as NeoSnapshot;
  return (snapshot.todoAsks ?? []).flatMap((entry) => entry.questions).filter((card) => card.state === 'open' && card.options?.includes('Set up Codex'));
}
async function until<T>(probe: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 8000;
  do {
    const result = await probe();
    if (result !== undefined) return result;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
const oneCard = () => until(async () => (await cards())[0], 'Codex setup card');
const send = () => rpc('work.send', { ref: { adapter: 'codex-desktop', id: 'fixture' }, message: 'fixture delivery' });
const seed = () => app.settingsManager.updateGlobalSettings({ codexAppServerBridge: { enabled: false, port: address.port } });

try {
  await boot();
  seed();
  assert.deepEqual(await cards(), []);
  const rollout = join(run, 'codex-rollout.jsonl');
  await writeFile(rollout, '');
  const db = new Database(join(codex, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, rollout_path TEXT);
    CREATE TABLE projects (id TEXT, name TEXT);
    CREATE TABLE project_roots (project_id TEXT, path TEXT);`);
  db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?)').run('fixture', 'Fixture', '', '', home, 'desktop', rollout);
  db.close();
  assert.equal((await send()).ok, true);
  const pending = await oneCard();
  assert(pending.text.includes('private server') && pending.text.includes('Desktop or phone'));
  assert.deepEqual(effects, []);
  await assert.rejects(stat(tokenFile), { code: 'ENOENT' });
  await stop();
  await boot();
  assert.equal((await oneCard()).id, pending.id);
  assert.equal((await cards()).length, 1);
  assert.equal((await rpc('neo.question.answer', { questionId: pending.id, answer: ['Keep current setup'] })).ok, true);
  await until(async () => read()?.decision === 'declined' ? true : undefined, 'durable decline');
  await stop();
  await boot();
  assert.equal((await send()).ok, true);
  assert.deepEqual(await cards(), []);
  assert.deepEqual(effects, []);

  seed();
  await stop();
  await boot();
  const approval = await oneCard();
  assert.notEqual(approval.id, pending.id);
  active = true;
  assert.equal((await rpc('neo.question.answer', { questionId: approval.id, answer: ['Set up Codex'] })).ok, true);
  await until(async () => busyReads > 0 && read()?.decision === 'approved' ? true : undefined, 'approved but busy');
  assert(!effects.includes('quit') && !effects.includes('enable-remote-control'));
  await stop();
  await boot();
  active = false;
  await until(async () => effects.includes('open') && read()?.decision === undefined ? true : undefined, 'resumed setup completes');
  assert.equal(effects.filter((effect) => effect === 'open').length, 1);
  assert.equal(effects.filter((effect) => effect === 'enable-remote-control').length, 1);
  assert.deepEqual(await cards(), []);

  assert.equal((await cli('--no-remote-control')).ok, true);
  remote = false;
  await stop();
  await boot();
  assert.equal((await send()).ok, true);
  assert.equal(read()?.remoteControl, 'skipped');
  assert.deepEqual(await cards(), []);
  assert.equal(effects.filter((effect) => effect === 'enable-remote-control').length, 1);
  assert.equal((await cli('--undo')).ok, true);
  await stop();
  effects.length = 0;
  await boot();
  assert.deepEqual(await cards(), []);
  assert.deepEqual(effects, []);
  console.log(JSON.stringify({ firstUseCards: 1, pendingReused: 1, declinedWithoutChanges: 1, startupCards: 1, resumedApprovals: 1, skipStayedQuiet: 1, undoStayedQuiet: 1, queued }));
} finally {
  active = false;
  if (running) await stop();
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  await new Promise<void>((done) => server.close(() => done()));
}
