import { afterEach, beforeEach, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopStatusOperation } from '../../../../src/lib/desktop/status-operation.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const identity = { seconds: 1, microseconds: 2 };
const exitedPid = spawnSync(process.execPath, ['-e', '']).pid;
const human: OperationCaller = { source: 'rpc', principal: 'local' };
const worker = 'worker-a';
let root: string;
let directory: string;
let db: Database;
let app: Server | undefined;
let alive: boolean;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dst-'));
  directory = join(root, 'desktop/workers', worker);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  alive = true;
  db = new Database(':memory:');
  db.exec(`CREATE TABLE neo_asks(id TEXT, status TEXT);
    CREATE TABLE neo_todos(id TEXT, ask_id TEXT, title TEXT, state TEXT, approved_at INTEGER, named TEXT);
    CREATE TABLE neo_todo_sessions(todo_id TEXT, ref TEXT);
    INSERT INTO neo_asks VALUES('ask', 'open');`);
  db.prepare('INSERT INTO neo_todos VALUES(?,?,?,?,?,?)').run(
    'todo',
    'ask',
    'Book the dentist',
    'doing',
    1,
    JSON.stringify({ desktopControl: true })
  );
  db.prepare('INSERT INTO neo_todo_sessions VALUES(?,?)').run(
    'todo',
    JSON.stringify({ adapter: 'hyperneo', id: worker })
  );
});
afterEach(async () => {
  db.close();
  if (app) await new Promise<void>((resolve) => app!.close(() => resolve()));
  app = undefined;
  await rm(root, { recursive: true, force: true });
});

async function openApp() {
  app = createServer((connection) => connection.end());
  app.listen(join(root, 'desktop/control.sock'));
  await once(app, 'listening');
}
async function recordDriver() {
  await writeFile(
    join(directory, 'driver.json'),
    JSON.stringify({ pid: exitedPid, startedAt: identity }),
    {
      mode: 0o600,
    }
  );
}
async function status(input: { worker?: string }, caller = human) {
  const registry = createOperationRegistry([
    createDesktopStatusOperation(db, {
      dataDir: root,
      readIdentity: async () => (alive ? identity : null),
    }),
  ]);
  return invokeOperation(registry, 'desktop.status', input, caller);
}
const one = (state: string, todo: string | null = 'Book the dentist') => ({
  kind: 'completed',
  value: { workers: [{ worker, todo, state }] },
});

test('a worker whose todo did not turn on desktop control is off', async () => {
  db.prepare('UPDATE neo_todos SET named = ?').run('{}');
  await openApp();
  await recordDriver();
  expect(await status({ worker })).toMatchObject(one('off', null));
});

test('desktop control is unavailable while HyperNeo Desktop is not running', async () => {
  await recordDriver();
  expect(await status({ worker })).toMatchObject(one('unavailable'));
});

test('a recorded live driver is running', async () => {
  await openApp();
  await recordDriver();
  expect(await status({ worker })).toMatchObject(one('running'));
});

test('a stopped worker reads stopped once its driver is gone', async () => {
  await openApp();
  await writeFile(join(directory, 'stopped'), '', { mode: 0o600 });
  expect(await status({ worker })).toMatchObject(one('stopped'));
  await recordDriver();
  alive = false;
  expect(await status({ worker })).toMatchObject(one('stopped'));
});

test('a stop whose driver is still alive is unconfirmed', async () => {
  await openApp();
  await recordDriver();
  await writeFile(join(directory, 'stopped'), '', { mode: 0o600 });
  expect(await status({ worker })).toMatchObject(one('stop_unconfirmed'));
});

test('without a worker it reads every worker on a running todo', async () => {
  await openApp();
  await recordDriver();
  db.prepare('INSERT INTO neo_todos VALUES(?,?,?,?,?,?)').run(
    'other',
    'ask',
    'Plain',
    'doing',
    1,
    '{}'
  );
  db.prepare('INSERT INTO neo_todo_sessions VALUES(?,?)').run(
    'other',
    JSON.stringify({ adapter: 'hyperneo', id: 'worker-b' })
  );
  expect(await status({})).toMatchObject({
    kind: 'completed',
    value: {
      workers: [
        { worker, todo: 'Book the dentist', state: 'running' },
        { worker: 'worker-b', todo: null, state: 'off' },
      ],
    },
  });
});

test('agents and Neo cannot read desktop status', async () => {
  for (const caller of [
    { source: 'mcp', role: 'neo' },
    { source: 'rpc', principal: 'local', device: { deviceId: 'test-agent', kind: 'agent' } },
  ] as OperationCaller[])
    expect(await status({ worker }, caller)).not.toMatchObject({ kind: 'completed' });
});

test('a todo still starting without a worker does not break the list', async () => {
  await openApp();
  await recordDriver();
  db.prepare('INSERT INTO neo_todos VALUES(?,?,?,?,?,?)').run(
    'starting',
    'ask',
    'Starting',
    'doing',
    1,
    JSON.stringify({ desktopControl: true })
  );
  db.prepare('INSERT INTO neo_todo_sessions VALUES(?,?)').run('starting', null);
  expect(await status({})).toMatchObject(one('running'));
});

test('a live driver whose identity cannot be read is not reported stopped', async () => {
  await openApp();
  await writeFile(
    join(directory, 'driver.json'),
    JSON.stringify({ pid: process.pid, startedAt: identity }),
    { mode: 0o600 }
  );
  alive = false;
  expect(await status({ worker })).toMatchObject(one('stop_unconfirmed'));
});

test('an opted-in worker whose driver is still starting keeps its Stop', async () => {
  await openApp();
  expect(await status({ worker })).toMatchObject(one('running'));
  await recordDriver();
  await writeFile(join(directory, 'starting'), '', { mode: 0o600 });
  alive = false;
  expect(await status({ worker })).toMatchObject(one('running'));
});

test('a driver that exited without the human stop keeps its Stop', async () => {
  await openApp();
  await recordDriver();
  alive = false;
  expect(await status({ worker })).toMatchObject(one('running'));
});
