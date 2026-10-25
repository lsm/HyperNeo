import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';

const [mode, directory] = process.argv.slice(2);
assert(['before', 'verify'].includes(mode));
const run = resolve(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data/daemon.db')));
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'home/.gitconfig'), '[user]\n name = Synthetic\n email = synthetic@example.invalid\n[commit]\n gpgsign = false\n');
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
assert.notEqual(app.server.port, 8399);
const socket = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
const connected = new Promise<void>((done, fail) => { socket.onopen = () => done(); socket.onerror = () => fail(new Error('RPC connection failed')); });
const report: Record<string, unknown> = { mode, port: app.server.port };
const mainSql: string[] = [];
const commands: string[] = [];
let lock: ReturnType<typeof spawn> | undefined;
let maxLagMs = 0;
let previous = performance.now();
const timer = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - previous - 10); previous = now; }, 10);
const rpc = (method: string, data: unknown) => new Promise<unknown>((done, fail) => {
  const id = crypto.randomUUID();
  const timeout = setTimeout(() => { socket.removeEventListener('message', receive); fail(new Error(`${method} timed out`)); }, 15000);
  const receive = (event: MessageEvent) => {
    const reply = JSON.parse(String(event.data));
    if (reply.id !== id && reply.requestId !== id) return;
    clearTimeout(timeout); socket.removeEventListener('message', receive);
    if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
  };
  socket.addEventListener('message', receive);
  socket.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
});
type Home = { ok: true; path: string; projects: { id: string; homePath: string }[] };
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await connected;
  const db = app.db.getDatabase();
  const repo = new NeoRepository(db);
  for (let i = 0; i < 40; i++) repo.saveProject({ id: `synthetic-${i}`, title: `Synthetic ${i}`, summary: '', context: '' }, 0);
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    if (/UPDATE neo_concerns SET home_path|SELECT id, title, summary, context, revision, parent_id/i.test(sql)) mainSql.push(sql);
    return prepare(sql);
  }) as typeof db.prepare;
  const send = app.db.gateway.run.bind(app.db.gateway);
  app.db.gateway.run = (async (op, args) => {
    const result = await send(op, args);
    if (op.name === 'neo.home.reserveProjects') {
      commands.push(op.name);
      for (const row of (result as { projects: { id: string; homePath: string }[] }).projects) {
        assert.equal((prepare('SELECT home_path AS path FROM neo_concerns WHERE id = ?').get(row.id) as { path: string }).path, row.homePath);
      }
    }
    return result;
  }) as typeof app.db.gateway.run;
  const start = performance.now();
  const first = await rpc('operation.invoke', { name: 'neo.home.init', input: {} }) as Home;
  report.coldMs = performance.now() - start;
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.projects.length, 40);
  for (const project of first.projects) assert(existsSync(join(first.path, project.homePath)));
  const warm = await Promise.all([rpc('operation.invoke', { name: 'neo.home.init', input: {} }), rpc('operation.invoke', { name: 'neo.home.init', input: {} })]);
  for (const result of warm) assert.deepEqual(result, first);
  const healthStart = performance.now();
  report.health = await rpc('system.health', {});
  report.healthMs = performance.now() - healthStart;
  report.maxLagMs = maxLagMs;
  report.mainSql = mainSql;
  report.commands = commands;
  report.first = first;
  if (mode === 'before') assert(mainSql.length > 0, 'baseline must reproduce project SQL on main');
  else {
    assert.equal(mainSql.length, 0, 'reservation SELECT and UPDATE must leave main');
    assert.equal(commands.length, 3, 'one whole writer command per RPC');
    lock = spawn('/usr/bin/python3', ['-c', "import sqlite3,sys,time\ndb=sqlite3.connect(sys.argv[1]); db.execute('BEGIN IMMEDIATE'); print('locked',flush=True); time.sleep(1.2); db.rollback(); db.close()", join(run, 'data/daemon.db')], { stdio: ['ignore', 'pipe', 'pipe'] });
    const released = new Promise<void>((done, fail) => { lock!.once('error', fail); lock!.once('exit', code => code === 0 ? done() : fail(new Error('synthetic lock failed'))); });
    await new Promise<void>(done => lock!.stdout!.once('data', data => { assert(String(data).includes('locked')); done(); }));
    const writeStart = performance.now();
    const pending = rpc('operation.invoke', { name: 'neo.home.init', input: {} });
    await new Promise(done => setTimeout(done, 40));
    const probeStart = performance.now();
    await rpc('system.health', {});
    const healthMs = performance.now() - probeStart;
    assert.deepEqual(await pending, first);
    const writeMs = performance.now() - writeStart;
    await released;
    lock = undefined;
    report.contention = { healthMs, writeMs, affectedWriteUnder250ms: writeMs < 250 };
    assert(healthMs < 250);
    assert(writeMs > 1000);
    assert.equal(mainSql.length, 0);
    assert(maxLagMs < 1000);
  }
  report.maxLagMs = maxLagMs;
  report.verified = true;
  console.log(JSON.stringify({ mode, mainSql: mainSql.length, commands: commands.length, maxLagMs, coldMs: report.coldMs }));
} finally {
  lock?.kill();
  clearInterval(timer); socket.close(); await app.cleanup();
  writeFileSync(join(run, 'evidence/home-reservation.json'), JSON.stringify(report, null, 2));
}
