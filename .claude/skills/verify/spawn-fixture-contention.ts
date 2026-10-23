import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const [scenario, mode, path] = process.argv.slice(2), run = resolve(path);
assert(['space', 'task'].includes(scenario));
assert(['before', 'verify'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert(!existsSync(join(run, 'data')));
assert.equal(process.env.GH_TOKEN, undefined);
assert.equal(process.env.GITHUB_TOKEN, undefined);
for (const dir of ['bin', 'evidence', 'workspace']) mkdirSync(join(run, dir), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
process.env.PATH = `${join(run, 'bin')}:${process.env.PATH}`;
execFileSync('git', ['init', '--initial-branch=main', join(run, 'workspace')], { stdio: 'ignore' });
const network = globalThis.fetch;
globalThis.fetch = (() => { throw new Error('Real HTTP refused'); }) as typeof fetch;
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let ws: WebSocket | undefined;
let worker: Worker | undefined;
const evidence: Record<string, unknown> = { scenario, mode };
try {
  app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const db = app.db.getDatabase();
  db.exec('CREATE TABLE synthetic_writer (value INTEGER); INSERT INTO synthetic_writer VALUES (0)');
  ws = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  await new Promise<void>((done, fail) => { ws!.onopen = () => done(); ws!.onerror = () => fail(new Error('RPC unavailable')); });
  const rpc = (method: string, data: unknown) => new Promise<any>((done, fail) => {
    const id = crypto.randomUUID(), timer = setTimeout(() => fail(new Error('RPC deadline')), 15000);
    ws!.onmessage = event => { const m = JSON.parse(String(event.data)); if (m.id !== id && m.requestId !== id) return; clearTimeout(timer); done(m); };
    ws!.send(JSON.stringify({ id, type: 'REQ', method, data, sessionId: 'global', timestamp: new Date().toISOString(), version: '1.0.0' }));
  });
  const createSpace = () => rpc('space.create', { name: 'Synthetic contention', workspacePath: join(run, 'workspace'), autonomyLevel: 1 });
  let spaceId: string | undefined;
  if (scenario === 'task') {
    const reply = await createSpace(); assert(!reply.error, JSON.stringify(reply)); spaceId = reply.data.id;
  }
  const barrier = new SharedArrayBuffer(8), state = new Int32Array(barrier);
  worker = new Worker(new URL('./spawn-fixture-writer.ts', import.meta.url).href, { type: 'module' });
  let ready!: () => void, committed!: (value: unknown) => void;
  const readiness = new Promise<void>(done => { ready = done; });
  const completion = new Promise<unknown>(done => { committed = done; });
  worker.onmessage = event => { if (event.data.ready) ready(); else committed(event.data); };
  worker.onerror = event => { ready(); committed({ error: event.message }); };
  worker.postMessage({ dbPath: join(run, 'data/daemon.db'), barrier });
  await readiness;
  const prepare = db.prepare.bind(db);
  let armed = true;
  db.prepare = ((sql: string, ...rest: unknown[]) => {
    const statement = prepare(sql, ...rest as []);
    const selected = scenario === 'space' ? sql === 'SELECT * FROM spaces WHERE workspace_path = ?' : sql.includes('MAX(task_number)');
    return !selected ? statement : new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property !== 'get') return typeof value === 'function' ? value.bind(target) : value;
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args);
          if (armed) {
            armed = false; Atomics.store(state, 0, 1); Atomics.notify(state, 0);
            evidence.writerFinishedBeforeInsert = Atomics.wait(state, 1, 0, 100) !== 'timed-out';
          }
          return result;
        };
      },
    });
  }) as typeof db.prepare;
  let reply;
  try {
    reply = scenario === 'space' ? await createSpace() : await rpc('operation.invoke', { name: 'task.create', input: { spaceId, title: 'Synthetic spawn fixture' } });
  } finally { db.prepare = prepare; }
  evidence.reply = reply;
  evidence.writer = await completion;
  evidence.writerValue = db.prepare('SELECT value FROM synthetic_writer').get();
  evidence.spaceCount = db.prepare('SELECT COUNT(*) AS count FROM spaces').get();
  evidence.taskCount = db.prepare('SELECT COUNT(*) AS count FROM space_tasks').get();
  assert.equal(armed, false);
  assert.deepEqual(evidence.writer, { committed: true });
  if (mode === 'before') assert.match(typeof reply.error === 'string' ? reply.error : reply.error?.message ?? '', /database is locked/i);
  else assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  evidence.verified = true;
  console.log(JSON.stringify(evidence));
} finally {
  writeFileSync(join(run, 'evidence/contention.json'), JSON.stringify(evidence, null, 2));
  worker?.terminate(); ws?.close(); await app?.cleanup(); globalThis.fetch = network;
}
