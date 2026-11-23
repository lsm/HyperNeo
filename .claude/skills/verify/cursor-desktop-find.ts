import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { cursorDesktopStatePath } from '../../../packages/daemon/src/lib/drivers/cursor-desktop-discovery.ts';
import type { FindWorkResultSchema } from '../../../packages/daemon/src/lib/drivers/find-operation.ts';
import type { Result } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import type { z } from 'zod';

const [portText, schema, run] = process.argv.slice(2);
const port = Number(portText);
assert(run && Number.isInteger(port) && port > 0 && port !== 8399);
const home = join(run, 'home');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, home);
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const state = cursorDesktopStatePath(home);
const folder = '/synthetic/Project with # characters';
const adapter = 'cursor-desktop';
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
process.chdir(run);
const app = await createDaemonApp({
  config: getConfig({ port, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
let socket: WebSocket | undefined;
let fixture: Database | undefined;
let calls = 0;
try {
  const ws = createLocalSocket(`ws://127.0.0.1:${port}/ws`);
  socket = ws;
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('Isolated RPC connection failed'));
  });
  function rpc<T>(name: string, input: object): Promise<T> {
    calls++;
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name} timed out`)), 20_000);
      const receive = (event: MessageEvent) => {
        const reply = JSON.parse(String(event.data));
        if (reply.id !== id && reply.requestId !== id) return;
        clearTimeout(timer);
        ws.removeEventListener('message', receive);
        if (reply.error) reject(new Error(JSON.stringify(reply.error)));
        else resolve(reply.data);
      };
      ws.addEventListener('message', receive);
      ws.send(JSON.stringify({
        id, type: 'REQ', sessionId: 'global', method: 'operation.invoke',
        data: { name, input }, timestamp: new Date().toISOString(), version: '1.0.0',
      }));
    });
  }
  async function desktopCapabilities() {
    const result = await rpc<Result<{ id: string; capabilities: string[] }[]>>('work.adapters', {});
    assert(result.ok);
    return result.value.find(({ id }) => id === adapter)?.capabilities;
  }
  assert.equal(await desktopCapabilities(), undefined);
  mkdirSync(dirname(state), { recursive: true });
  fixture = new Database(state);
  fixture.exec(schema === '-' ? `
    CREATE TABLE composerHeaders (
      composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER,
      lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER, recency INTEGER,
      checkpointAt INTEGER, subagentTypeName TEXT, value BLOB
    );
  ` : readFileSync(schema, 'utf8'));
  fixture.exec('PRAGMA journal_mode=WAL');
  const insert = fixture.prepare(`
    INSERT INTO composerHeaders (composerId, workspaceId, isArchived, isSubagent, recency, value)
    VALUES (?, 'workspace', ?, ?, ?, ?)
  `);
  for (const [id, title, archived, subagent, scheme] of [
    ['desktop-open', 'Native Desktop title', 0, 0, 'file'],
    ['desktop-archived', '', 1, 0, 'file'],
    ['desktop-child', 'Child', 0, 1, 'file'],
    ['desktop-remote', 'SSH', 0, 0, 'vscode-remote'],
  ] as const)
    insert.run(id, archived, subagent, 1_790_000_000_000,
      JSON.stringify({ composerId: id, name: title, workspaceIdentifier: { id: 'workspace', uri: { scheme, path: folder } } }));
  const wal = readFileSync(`${state}-wal`);
  assert.deepEqual(await desktopCapabilities(), ['find']);
  async function find(query: object = {}) {
    const result = await rpc<z.infer<typeof FindWorkResultSchema>>('work.find', {
      adapters: [adapter], localOnly: true, ...query,
    });
    assert.deepEqual(result.unreachable, []);
    return result.places.flatMap((place) => place.work);
  }
  const open = await find({ folder, text: 'native desktop' });
  assert.deepEqual(open.map(({ ref, title, place }) => [ref.id, title, place.folder]),
    [['desktop-open', 'Native Desktop title', folder]]);
  const all = await find({ includeClosed: true });
  assert.equal(all.length, 2);
  const [archived] = await find({ includeClosed: true, idPrefix: 'desktop-arch' });
  assert.equal(archived?.title, 'Untitled Cursor session');
  assert.equal(archived?.archived, true);
  assert.deepEqual(readFileSync(`${state}-wal`), wal);
  process.stdout.write(`Cursor Desktop: ${calls} RPC calls, ${all.length} sessions, WAL unchanged\n`);
} finally {
  socket?.close();
  await app.cleanup();
  fixture?.close();
}
