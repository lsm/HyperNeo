import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { readDesktopBinding, runDesktopMcp } from '../../../../../cli/src/desktop-mcp.ts';
import { createDesktopMcpServer } from '../../../../src/lib/desktop/mcp-server.ts';
import { createDesktopProxy } from '../../../../src/lib/desktop/mcp-proxy.ts';

let root: string;
let db: Database;
let directory: string;
const worker = '10000000-0000-4000-8000-000000000002';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mc-'));
  directory = join(root, 'desktop/workers', worker);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('HYPERNEO_DATA_DIR', root);
  vi.stubEnv('DB_PATH', join(root, 'daemon.db'));
  db = new Database(join(root, 'daemon.db'));
  db.exec(`CREATE TABLE neo_asks(id TEXT, status TEXT);
    CREATE TABLE neo_todos(id TEXT, ask_id TEXT, state TEXT, approved_at INTEGER, named TEXT);
    CREATE TABLE neo_todo_sessions(todo_id TEXT, ref TEXT);
    INSERT INTO neo_asks VALUES('ask', 'open');`);
  db.prepare('INSERT INTO neo_todos VALUES(?,?,?,?,?)').run(
    'todo',
    'ask',
    'doing',
    1,
    JSON.stringify({ desktopControl: true })
  );
  db.prepare('INSERT INTO neo_todo_sessions VALUES(?,?)').run(
    'todo',
    JSON.stringify({ adapter: 'hyperneo', id: worker })
  );
  await writeFile(
    join(directory, 'driver.json'),
    JSON.stringify({
      pid: 123,
      startedAt: { seconds: 456, microseconds: 789 },
      socket: join(root, 'driver.sock'),
    }),
    { mode: 0o600 }
  );
});
afterEach(async () => {
  db.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

test('binding uses readonly named opt-in and the recorded worker socket', async () => {
  const before = await readFile(join(root, 'daemon.db'));
  expect(await readDesktopBinding(worker)).toEqual({
    todo_id: 'todo',
    worker_id: worker,
    driver_instance_id: '123-456-789',
    target_app_id: null,
    socket: join(root, 'driver.sock'),
  });
  expect(await readFile(join(root, 'daemon.db'))).toEqual(before);
  db.prepare('UPDATE neo_todos SET named = ?').run('{}');
  expect(await readDesktopBinding(worker)).toBeNull();
});
test('ambiguous, unapproved, remote and finished bindings are refused', async () => {
  db.prepare('INSERT INTO neo_todo_sessions VALUES(?,?)').run(
    'todo',
    JSON.stringify({ adapter: 'hyperneo', id: worker })
  );
  expect(await readDesktopBinding(worker)).toBeNull();
  db.exec('DELETE FROM neo_todo_sessions WHERE rowid = 2');
  db.exec('UPDATE neo_todos SET approved_at = NULL');
  expect(await readDesktopBinding(worker)).toBeNull();
  db.exec('UPDATE neo_todos SET approved_at = 1');
  db.prepare('UPDATE neo_todo_sessions SET ref = ?').run(
    JSON.stringify({ adapter: 'hyperneo', id: worker, daemon: 'other' })
  );
  expect(await readDesktopBinding(worker)).toBeNull();
  db.prepare('UPDATE neo_todo_sessions SET ref = ?').run(
    JSON.stringify({ adapter: 'hyperneo', id: worker })
  );
  db.exec("UPDATE neo_todos SET state = 'done'");
  expect(await readDesktopBinding(worker)).toBeNull();
});
test('stop and incomplete-start markers retain refusal and the record stays protected', async () => {
  const stop = join(directory, 'stopped');
  await mkdir(stop);
  expect(await readDesktopBinding(worker)).toBeNull();
  await rm(stop, { recursive: true });
  await mkdir(join(directory, 'starting'));
  expect(await readDesktopBinding(worker)).toBeNull();
  await rm(join(directory, 'starting'), { recursive: true });
  await chmod(join(directory, 'driver.json'), 0o644);
  expect(await readDesktopBinding(worker)).toBeNull();
});
test('MCP registration publishes only the bounded list and routes refusals', async () => {
  const audit = vi.fn();
  const dispatch = vi.fn();
  const proxy = createDesktopProxy({ binding: () => readDesktopBinding(worker), dispatch, audit });
  const server = createDesktopMcpServer(proxy);
  const client = new Client({ name: 'synthetic-client', version: '1' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverSide);
    await client.connect(clientSide);
    expect((await client.listTools()).tools).toHaveLength(12);
    expect(await client.callTool({ name: 'run_script', arguments: {} })).toMatchObject({
      isError: true,
    });
    expect(
      await client.callTool({ name: 'type_text', arguments: { text: 'synthetic-secret' } })
    ).toMatchObject({ isError: true });
    expect(dispatch).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledTimes(2);
  } finally {
    await client.close();
    await server.close();
  }
});
test('CLI registration requires a single bounded worker identifier', async () => {
  for (const args of [[], ['--worker', '../escape'], ['--worker', worker, '--socket', '/other']])
    await expect(runDesktopMcp(args)).rejects.toThrow('Usage: hyperneo desktop-mcp --worker <id>');
});

test('malformed tool-call arguments still produce one sanitized audit line', async () => {
  const audit = vi.fn();
  const dispatch = vi.fn();
  const server = createDesktopMcpServer(
    createDesktopProxy({
      binding: () => readDesktopBinding(worker),
      dispatch,
      audit,
    })
  );
  const client = new Client({ name: 'synthetic-client', version: '1' });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverSide);
    await client.connect(clientSide);
    await expect(
      client.request(
        {
          method: 'tools/call',
          params: {
            name: 'list_windows',
            arguments: null,
          },
        },
        CallToolResultSchema
      )
    ).rejects.toThrow();
    expect(audit).toHaveBeenCalledTimes(1);
    expect(JSON.parse(audit.mock.calls[0][0])).toMatchObject({
      decision: 'refused',
      reason_code: 'invalid_arguments',
      upstream_dispatched: false,
    });
    expect(dispatch).not.toHaveBeenCalled();
  } finally {
    await client.close();
    await server.close();
  }
});
