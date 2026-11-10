import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { mock } from 'bun:test';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import * as adapterModule from '../../../packages/daemon/src/lib/drivers/codex-desktop-adapter.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { driverWorkCall, NeoTodoTargetSchema } from '../../../packages/daemon/src/lib/neo/driver-work.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
const home = join(run, 'home', '.codex');
const folder = join(run, 'project');
const linkedFolder = join(run, 'user-linked-worktree');
const longFolder = join(run, 'q'.repeat(73));
mkdirSync(home, { recursive: true });
mkdirSync(folder, { recursive: true });
mkdirSync(linkedFolder, { recursive: true });
mkdirSync(longFolder, { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
const statePath = join(home, 'state_5.sqlite');
const db = new Database(statePath);
db.exec(`CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT, source TEXT, archived INTEGER, updated_at_ms INTEGER, rollout_path TEXT);
CREATE TABLE projects (id TEXT, name TEXT, updated_at_ms INTEGER);
CREATE TABLE project_roots (project_id TEXT, path TEXT);`);
const rollout = join(run, 'rollout.jsonl');
writeFileSync(rollout, '');
db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('synthetic', 'Codex project 1', '', '', folder, 'desktop', 0, 1, rollout);
db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('unrelated', 'Codex other 1', '', '', join(run, 'unrelated'), 'desktop', 0, 1, rollout);
db.close();
const checkoutFolders: string[] = [];
const calls: unknown[] = [];
let closed = 0;
let opened = 0;
let concurrentMode = false;
let concurrentStarts = 0;
let entered!: () => void;
const firstNaming = new Promise<void>((resolve) => { entered = resolve; });
let release!: () => void;
const hold = new Promise<void>((resolve) => { release = resolve; });
const create = adapterModule.createCodexDesktopAdapter;
mock.module('../../../packages/daemon/src/lib/drivers/codex-desktop-adapter.ts', () => ({
  ...adapterModule,
  createCodexDesktopAdapter: (deps: Parameters<typeof create>[0]) => create({
    ...deps,
    prepareExecution: undefined,
    gitCheckout: async path => { checkoutFolders.push(path); return path === linkedFolder ? { repo: folder, linked: true } : null; },
    appServer: async () => { throw new Error('Desktop is closed'); },
    bootstrapServer: async () => { opened++; let released = false; return ({
      call: async (method, params) => {
        calls.push({ method, params });
        if (concurrentMode && method === 'thread/start') {
          const id = `concurrent-${++concurrentStarts}`;
          const state = new Database(statePath);
          try { state.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, '', '', '', String(params.cwd), 'desktop', 0, 1, rollout); }
          finally { state.close(); }
          return { thread: { id } };
        }
        if (concurrentMode && method === 'thread/name/set') {
          if (params.threadId === 'concurrent-1') { entered(); await hold; }
          const state = new Database(statePath);
          try { state.prepare('UPDATE threads SET name = ?, title = ? WHERE id = ?').run(String(params.name), String(params.name), String(params.threadId)); }
          finally { state.close(); }
        }
        return method === 'thread/start' ? { thread: { id: 'synthetic' } } : {};
      },
      close: () => { if (!released) closed++; released = true; },
    }); },
    prepareDesktopProject: async () => 'synthetic-project',
    startDesktopTurn: async () => {},
  }),
}));
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const { getConfig } = await import('../../../packages/daemon/src/config.ts');
const app = await createDaemonApp({ config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true }, verbose: false });
try {
  await app.jobProcessor.stop();
  assert(![8399, 8499].includes(app.server.port));
  const registry = app.sessionManager.getOperationRegistry();
  const caller = { source: 'rpc' as const, principal: 'local' };
  const target = NeoTodoTargetSchema.parse({ verb: 'start', adapter: 'codex-desktop', place: { machine: hostname(), folder, name: 'Synthetic' }, sessionTitle: 'Codex hyperneo 2' });
  const call = driverWorkCall(target, { title: 'Task-specific title', instruction: 'Synthetic instruction' });
  const started = await invokeOperation(registry, call.name, call.input, caller);
  assert.equal(started.kind, 'completed', JSON.stringify(started));
  assert.deepEqual((started as { value: { ok: boolean; value: { title: string } } }).value.ok, true, JSON.stringify(started));
  assert.equal((started as { value: { value: { title: string } } }).value.value.title, 'Codex hyperneo 2');
  const unnamed = driverWorkCall({ ...target, sessionTitle: undefined }, { title: 'Never use this task title', instruction: 'Synthetic instruction' });
  const generic = await invokeOperation(registry, unnamed.name, unnamed.input, caller);
  assert.equal(generic.kind, 'completed', JSON.stringify(generic));
  assert.equal((generic as { value: { value: { title: string } } }).value.value.title, 'Codex project 2');
  const renamed = await invokeOperation(registry, 'work.rename', { ref: { adapter: 'codex-desktop', id: 'synthetic' }, title: 'Codex hyperneo 3' }, caller);
  assert.equal(renamed.kind, 'completed', JSON.stringify(renamed));
  assert.deepEqual((renamed as { value: unknown }).value, { ok: true, value: { renamed: true, title: 'Codex hyperneo 3' } });
  concurrentMode = true;
  const first = invokeOperation(registry, unnamed.name, unnamed.input, caller);
  await firstNaming;
  const second = invokeOperation(registry, unnamed.name, unnamed.input, caller);
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  const concurrent = await Promise.all([first, second]);
  const titles = concurrent.map((outcome) => {
    assert.equal(outcome.kind, 'completed', JSON.stringify(outcome));
    return (outcome as { value: { value: { title: string } } }).value.value.title;
  });
  assert.deepEqual(titles, ['Codex project 2', 'Codex project 3']);
  const saved = new Database(statePath);
  try { assert.deepEqual(saved.prepare("SELECT name FROM threads WHERE id LIKE 'concurrent-%' ORDER BY id").all().map((row) => (row as { name: string }).name), titles); }
  finally { saved.close(); }
  const state = new Database(statePath);
  const longTitle = `Codex ${'q'.repeat(73)} 1`;
  try {
    state.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('linked', 'Codex project 4', '', '', linkedFolder, 'desktop', 0, 1, rollout);
    state.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('long', longTitle, '', '', longFolder, 'desktop', 0, 1, rollout);
  } finally { state.close(); }
  const linked = await invokeOperation(registry, unnamed.name, unnamed.input, caller);
  assert.equal((linked as {value:{value:{title:string}}}).value.value.title, 'Codex project 5');
  const longInput = { ...unnamed.input, place: { machine: hostname(), folder: longFolder, name: 'Long project' } };
  const longName = await invokeOperation(registry, unnamed.name, longInput, caller);
  assert.equal((longName as {value:{value:{title:string}}}).value.value.title, `Codex ${'q'.repeat(73)} 2`);
  const duplicate = await invokeOperation(registry, unnamed.name, { ...longInput, sessionTitle: longTitle }, caller);
  assert.equal((duplicate as {value:{ok:boolean}}).value.ok, false);
  assert.match((duplicate as {value:{detail:string}}).value.detail, /already in use/);
  const missingState = new Database(statePath);
  try {
    missingState.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('missing', 'Codex project 6', '', '', join(run, 'deleted-worktree'), 'desktop', 0, 1, rollout);
  } finally { missingState.close(); }
  const afterDeletion = await invokeOperation(registry, unnamed.name, unnamed.input, caller);
  assert.equal((afterDeletion as {value:{value:{title:string}}}).value.value.title, 'Codex project 7');
  const missingDuplicate = await invokeOperation(registry, unnamed.name, { ...unnamed.input, sessionTitle: 'Codex project 6' }, caller);
  assert.equal((missingDuplicate as {value:{ok:boolean}}).value.ok, false);
  assert.match((missingDuplicate as {value:{detail:string}}).value.detail, /already in use/);
  assert(!checkoutFolders.includes(join(run, 'unrelated')));
  assert.equal(closed, opened);
  assert(opened >= 2);
  writeFileSync(join(run, 'evidence', 'codex-session-title.json'), JSON.stringify({ started, generic, concurrent, renamed, linked, longName, duplicate, afterDeletion, missingDuplicate, calls, checkoutFolders, closed, boundary: 'Synthetic Codex servers; real daemon operation registry; no native Desktop or model turn' }, null, 2));
} finally {
  await app.cleanup();
}
