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
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await connected;
  const db = app.db.getDatabase();
  const repo = new NeoRepository(db);
  for (const [id, repository] of [['forgotten', 'chosen/repo'], ['retained', 'kept/repo']]) {
    repo.saveProject({ id, title: id, summary: '', context: '' }, 0);
    db.prepare('INSERT INTO neo_project_workspaces(alias,project_id) VALUES (?,?)').run(`repository:github.com/${repository}`, id);
  }
  const prepare = db.prepare.bind(db);
  prepare("UPDATE neo_pack_preferences SET value_json=? WHERE pack='coding' AND key='watchedRepos'").run(JSON.stringify(['chosen/repo', 'kept/repo']));
  prepare(`INSERT INTO neo_asks(id,session_id,project_id,title,request,status,created_at,updated_at)
    VALUES ('settled','neo:synthetic','forgotten','Retained ask','Retained request','done',1,1)`).run();
  const watches = () => JSON.parse((prepare("SELECT value_json FROM neo_pack_preferences WHERE pack='coding' AND key='watchedRepos'").get() as { value_json: string }).value_json);
  assert.deepEqual(watches(), ['chosen/repo', 'kept/repo']);
  db.prepare = ((sql: string) => {
    if (/SELECT DISTINCT lower|SELECT 1 FROM neo_concerns WHERE id|SELECT 1 WHERE EXISTS|DELETE FROM neo_(?:concerns|project_workspaces)|UPDATE neo_asks SET project_id = NULL|neo_pack_preferences|SELECT canonical FROM pack_coding_repo_aliases/i.test(sql)) mainSql.push(sql);
    return prepare(sql);
  }) as typeof db.prepare;
  const send = app.db.gateway.run.bind(app.db.gateway);
  app.db.gateway.run = (async (op, args) => {
    const result = await send(op, args);
    if (op.name === 'neo.project.forget') commands.push(op.name);
    return result;
  }) as typeof app.db.gateway.run;
  prepare(`CREATE TRIGGER reject_unwatch BEFORE UPDATE ON neo_pack_preferences
    WHEN NEW.key='watchedRepos' BEGIN SELECT RAISE(ABORT,'synthetic_unwatch_failure'); END`).run();
  report.failed = await rpc('operation.invoke', { name: 'neo.project.forget', input: { projectId: 'forgotten' } }).then(value => ({ value }), error => ({ error: String(error) }));
  assert(JSON.stringify(report.failed).includes('synthetic_unwatch_failure'));
  assert(prepare("SELECT id FROM neo_concerns WHERE id='forgotten'").get());
  assert(prepare("SELECT alias FROM neo_project_workspaces WHERE project_id='forgotten'").get());
  assert.equal((prepare("SELECT project_id FROM neo_asks WHERE id='settled'").get() as { project_id: string }).project_id, 'forgotten');
  assert.deepEqual(watches(), ['chosen/repo', 'kept/repo']);
  prepare('DROP TRIGGER reject_unwatch').run();
  const start = performance.now();
  const responses = await Promise.all([rpc('operation.invoke', { name: 'neo.project.forget', input: { projectId: 'forgotten' } }), rpc('operation.invoke', { name: 'neo.project.forget', input: { projectId: 'forgotten' } })]);
  report.rpcMs = performance.now() - start;
  assert.equal(responses.filter(result => (result as { ok: boolean }).ok).length, 1);
  assert(responses.some(result => (result as { reason: string }).reason === 'project_missing'));
  assert.equal(prepare("SELECT id FROM neo_concerns WHERE id='forgotten'").get(), null);
  assert.deepEqual(watches(), ['kept/repo']);
  const settled = prepare("SELECT project_id,request FROM neo_asks WHERE id='settled'").get() as { project_id: string | null; request: string };
  assert.equal(settled.project_id, null);
  assert.equal(settled.request, 'Retained request');
  report.responses = responses;
  report.retainedWatches = watches();
  if (mode === 'before') assert(mainSql.length > 0);
  else {
    assert.equal(mainSql.length, 0, 'forget reads, deletion and watch cleanup must leave main');
    assert.equal(commands.length, 2);
    repo.saveProject({ id: 'held', title: 'Held writer', summary: '', context: '' }, 0);
    lock = spawn('/usr/bin/python3', ['-c', "import sqlite3,sys,time\ndb=sqlite3.connect(sys.argv[1]); db.execute('BEGIN IMMEDIATE'); print('locked',flush=True); time.sleep(1.2); db.rollback(); db.close()", join(run, 'data/daemon.db')], { stdio: ['ignore', 'pipe', 'pipe'] });
    const released = new Promise<void>((done, fail) => { lock!.once('error', fail); lock!.once('exit', code => code === 0 ? done() : fail(new Error('synthetic lock failed'))); });
    await new Promise<void>(done => lock!.stdout!.once('data', data => { assert(String(data).includes('locked')); done(); }));
    const writeStart = performance.now();
    const pending = rpc('operation.invoke', { name: 'neo.project.forget', input: { projectId: 'held' } });
    await new Promise(done => setTimeout(done, 40));
    const probeStart = performance.now();
    await rpc('system.health', {});
    const healthMs = performance.now() - probeStart;
    assert.equal((await pending as { ok: boolean }).ok, true);
    const writeMs = performance.now() - writeStart;
    await released;
    lock = undefined;
    report.contention = { healthMs, writeMs, affectedWriteUnder250ms: writeMs < 250 };
    assert(healthMs < 250);
    assert(writeMs > 1000);
    assert.equal(mainSql.length, 0);
    assert(maxLagMs < 1000);
  }
  report.mainSql = mainSql;
  report.commands = commands;
  report.maxLagMs = maxLagMs;
  report.verified = true;
  console.log(JSON.stringify({ mode, mainSql: mainSql.length, commands: commands.length, maxLagMs, rpcMs: report.rpcMs }));
} finally {
  lock?.kill();
  clearInterval(timer); socket.close(); await app.cleanup();
  writeFileSync(join(run, 'evidence/project-forget-writer.json'), JSON.stringify(report, null, 2));
}
