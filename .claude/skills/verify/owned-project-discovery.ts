import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, chmodSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { recordStartedWork } from '../../../packages/daemon/src/storage/work-started-sessions.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
for (const dir of ['home/.codex', 'bin', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
copyFileSync('.claude/skills/verify/gh-stub.sh', join(run, 'bin/gh'));
chmodSync(join(run, 'bin/gh'), 0o755);
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
const folders = ['foreign', 'owned', 'tool-only'].map((name) => {
  const folder = join(run, 'home', name);
  mkdirSync(folder);
  execFileSync('git', ['init', '-q', folder]);
  execFileSync('git', ['-C', folder, '-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', `Synthetic ${name}`]);
  execFileSync('git', ['-C', folder, 'remote', 'add', 'origin', `https://example.test/team/${name}.git`]);
  return folder;
});
const state = new Database(join(run, 'home/.codex/state_5.sqlite'));
state.exec(`CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, rollout_path TEXT);
  CREATE TABLE projects (id TEXT, name TEXT, updated_at_ms INTEGER);
  CREATE TABLE project_roots (project_id TEXT, path TEXT);`);
for (const [i, folder] of folders.entries()) {
  state.prepare('INSERT INTO projects VALUES (?, ?, ?)').run(`project-${i}`, `Synthetic ${i}`, 1);
  state.prepare('INSERT INTO project_roots VALUES (?, ?)').run(`project-${i}`, folder);
  if (i < 2) state.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    i === 0 ? 'foreign' : 'owned', `Synthetic ${i}`, '', '', folder, 'desktop', 0, 1, '/synthetic-missing.jsonl'
  );
}
state.close();
const listener = createServer();
await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
const port = (listener.address() as { port: number }).port;
await new Promise<void>((done) => listener.close(() => done()));
assert(port !== 8399);
const calls: unknown[] = [];
const cases: { name: string; passed: boolean; error?: string }[] = [];
const app = await createDaemonApp({ config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
let socket: WebSocket | undefined;
try {
  await app.spaceRuntimeService.ready();
  socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((done, fail) => { socket!.onopen = () => done(); socket!.onerror = () => fail(new Error('WebSocket failed')); });
  const rpc = (method: string, data: unknown): Promise<any> => new Promise((done, fail) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => fail(new Error(`${method} timeout`)), 20000);
    socket!.onmessage = ({ data: raw }) => {
      const reply = JSON.parse(String(raw));
      if (reply.id !== id && reply.requestId !== id) return;
      clearTimeout(timer); calls.push({ method, data, reply });
      if (reply.error) fail(new Error(JSON.stringify(reply.error))); else done(reply.data);
    };
    socket!.send(JSON.stringify({ id, type: 'REQ', sessionId: 'global', method, data, timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const invoke = (name: string, input: unknown) => rpc('operation.invoke', { name, input });
  const check = async (name: string, action: () => Promise<void>) => {
    try { await action(); cases.push({ name, passed: true }); }
    catch (error) { cases.push({ name, passed: false, error: String(error) }); }
  };
  const raw = app.db.getDatabase();
  const externalProjects = () => raw.prepare("SELECT id,title,context FROM neo_concerns WHERE id <> 'inbox' ORDER BY id").all() as { id: string; title: string; context: string }[];
  const aliases = () => raw.prepare('SELECT alias, project_id FROM neo_project_workspaces ORDER BY alias').all() as { alias: string; project_id: string }[];
  const find = () => invoke('work.find', { adapters: ['codex-desktop'], localOnly: true, limit: 50 });
  const discovery = await find();
  await check('foreign work remains discoverable without creating projects', async () => {
    assert(discovery.places.some((group: any) => group.work.some((item: any) => item.ref.id === 'foreign')));
    assert.equal(externalProjects().length, 0); assert.equal(aliases().length, 0);
  });
  const explicit = await invoke('neo.project.save', { title: 'Explicit', summary: '', context: 'Keep', expectedRevision: 0 });
  assert.equal(explicit.ok, true);
  const explicitId = explicit.project.id;
  await rpc('settings.global.update', { updates: { workFeedScope: 'all' } });
  await find();
  await check('all feed scope does not enroll machine-wide projects', async () => {
    assert.deepEqual(externalProjects(), [{ id: explicitId, title: 'Explicit', context: 'Keep' }]);
    assert.equal(aliases().length, 0);
  });
  raw.prepare('INSERT INTO neo_project_workspaces VALUES (?, ?)').run('git:legacy-retained', explicitId);
  recordStartedWork(raw, { adapter: 'codex-desktop', id: 'owned' });
  await find();
  await check('owned work creates only its own project and aliases', async () => {
    assert.equal(externalProjects().length, 2);
    const mapped = aliases();
    assert(mapped.some(({ alias }) => alias.endsWith('\u0000owned')));
    assert(!mapped.some(({ alias }) => alias.includes(folders[0]) || alias.includes(folders[2]) || alias.endsWith('\u0000foreign')));
  });
  await check('explicit project and existing aliases survive', async () => {
    assert(externalProjects().some((project) => project.id === explicitId && project.context === 'Keep'));
    assert(aliases().some((entry) => entry.alias === 'git:legacy-retained' && entry.project_id === explicitId));
  });
  writeFileSync(join(run, 'evidence/projects.json'), JSON.stringify({ projects: externalProjects(), aliases: aliases() }, null, 2));
  assert(cases.every((item) => item.passed), JSON.stringify(cases));
} finally {
  socket?.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ port, cases, calls, resourcesClosed: true }, null, 2));
}
console.log(`PASS ${run}/evidence/observed.json`);
