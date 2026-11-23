import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { FindWorkResultSchema } from '../../../packages/daemon/src/lib/drivers/find-operation.ts';
import type { Result } from '../../../packages/daemon/src/lib/drivers/types.ts';
import { subscribeToStructuredLogs } from '../../../packages/daemon/src/lib/logger.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type { z } from 'zod';

const run = process.argv.at(-1)!;
const home = join(run, 'home');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, home);
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const args = process.argv.slice(2, -1);
const desktopOnly = args.includes('--desktop-only');
const metadataPath = args.find((arg) => arg !== '--desktop-only');
const observed = metadataPath ? JSON.parse(readFileSync(metadataPath, 'utf8')) : {
  title: 'Desktop fixture', source: '', origin: 'antigravity',
};
assert(typeof observed.title === 'string' && observed.title.trim());
assert.deepEqual(Object.keys(observed).sort(), ['origin', 'source', 'title']);
const desktop = 'antigravity-desktop';
const cli = 'antigravity-cli';
const state = join(home, '.gemini', 'antigravity', 'conversation_summaries.db');
const workspace = join(run, 'Project # café %20');
const alternate = join(run, 'Another project');
mkdirSync(workspace);
mkdirSync(alternate);
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
writeFileSync(join(run, 'bin/agy'), `#!/usr/bin/env bun
import { createInterface } from 'node:readline';
if (process.argv[2] === '--version') { console.log('1.5.15'); process.exit(0); }
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  const result = method === 'initialize'
    ? { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {} } } }
    : { sessions: [
        { sessionId: 'desktop-proof', cwd: ${JSON.stringify(home)}, title: ${JSON.stringify(observed.title)} },
        { sessionId: 'desktop-workspace', cwd: ${JSON.stringify(workspace)}, title: 'Project conversation' },
        { sessionId: 'cli-copy', cwd: ${JSON.stringify(workspace)}, title: 'Imported CLI copy' },
        { sessionId: 'desktop-child', cwd: ${JSON.stringify(workspace)}, title: 'Child' },
        { sessionId: 'desktop-remote', cwd: ${JSON.stringify(home)}, title: 'SSH' },
      ] };
  console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
}
`, { mode: 0o700 });

const app = await createDaemonApp({
  config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true, disableGoalProcessing: true },
  verbose: false,
});
const hub = new MessageHub({ defaultSessionId: 'global' });
let closed = Promise.resolve();
const socket = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
  createSocket(url) {
    const connection = createLocalSocket(url);
    closed = new Promise<void>((resolve) => connection.addEventListener('close', () => resolve(), { once: true }));
    return connection;
  },
});
hub.registerTransport(socket);
let fixture: Database | undefined;
let operations = 0;
let catalogReads = 0;
const unsubscribe = subscribeToStructuredLogs((event) => {
  if (event.module === 'hyperneo:daemon:sqlite.worker' && event.message === 'sqlite.worker.request' &&
    event.metadata.operation === desktop && event.metadata.outcome === 'ok') catalogReads++;
});
const rpc = <T>(name: string, input: object) => {
  operations++;
  return hub.request<T>('operation.invoke', { name, input });
};
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await socket.connect();
  const capabilities = async () => {
    const result = await rpc<Result<{ id: string; capabilities: string[] }[]>>('work.adapters', {});
    assert(result.ok);
    if (!desktopOnly) assert(result.value.some(({ id, capabilities }) => id === cli && capabilities.includes('find')), 'fixture CLI discovery adapter');
    return result.value.find(({ id }) => id === desktop)?.capabilities;
  };
  assert.equal(await capabilities(), undefined);
  mkdirSync(dirname(state), { recursive: true });
  fixture = new Database(state);
  fixture.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL,
      app_data_dir TEXT NOT NULL, workspace_uris TEXT NOT NULL,
      last_modified_time DATETIME NOT NULL, parent_conversation_id TEXT NOT NULL, nesting_depth INTEGER NOT NULL
    );`);
  const insert = fixture.prepare('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const localUrls = [pathToFileURL(workspace).href, pathToFileURL(alternate).href];
  const urls = JSON.stringify(localUrls);
  const remoteUrl = 'vscode-remote://ssh-remote+host/project';
  const mixedUrls = JSON.stringify([remoteUrl, ...localUrls]);
  insert.run('desktop-proof', observed.title, observed.source, observed.origin, '', '2026-06-02 12:00:00+00:00', '', 0);
  insert.run('desktop-workspace', 'Project conversation', '', 'antigravity', mixedUrls, '2026-06-01 12:00:00+00:00', '', 0);
  insert.run('cli-copy', 'Imported CLI copy', 'CORTEX_TRAJECTORY_SOURCE_CLI', 'antigravity', urls, '2026-06-03 12:00:00+00:00', '', 0);
  insert.run('cli-index', 'CLI profile', '', 'antigravity-cli', urls, '2026-06-04 12:00:00+00:00', '', 0);
  insert.run('desktop-child', 'Child', '', 'antigravity', urls, '2026-06-05 12:00:00+00:00', 'desktop-workspace', 1);
  insert.run('desktop-remote', 'SSH', '', 'antigravity', JSON.stringify([remoteUrl]), '2026-06-06 12:00:00+00:00', '', 0);
  const wal = readFileSync(`${state}-wal`);
  assert.deepEqual(await capabilities(), ['find']);
  const find = async (adapters: string[], input: object = {}) => {
    const result = await rpc<z.infer<typeof FindWorkResultSchema>>('work.find', { adapters, localOnly: true, ...input });
    assert.deepEqual(result.unreachable, []);
    return result.places.flatMap((place) => place.work);
  };
  const all = await find(desktopOnly ? [desktop] : [desktop, cli]);
  assert.deepEqual(all.map(({ ref }) => [ref.adapter, ref.id]).sort(), [
    ...(desktopOnly ? [] : [[cli, 'cli-copy']]),
    [desktop, 'desktop-proof'], [desktop, 'desktop-workspace'],
  ]);
  const exact = await find([desktop], { id: 'desktop-proof' });
  assert.deepEqual(exact.map(({ title, place }) => [title, place.folder]), [[observed.title, undefined]]);
  if (!desktopOnly) assert.deepEqual(await find([cli], { id: 'desktop-proof' }), []);
  const project = await find([desktop], { folder: alternate, text: 'another project', limit: 1 });
  assert.deepEqual(project.map(({ ref, place }) => [ref.id, place.folder]), [['desktop-workspace', alternate]]);
  assert.deepEqual((await find([desktop], { idPrefix: 'desktop-work', limit: 1 })).map(({ ref, place }) => [ref.id, place.folder]), [['desktop-workspace', workspace]]);
  assert.deepEqual((await find([desktop], { limit: 1 })).map(({ ref }) => ref.id), ['desktop-proof']);
  assert(catalogReads > 0, 'successful catalog reads have the antigravity-desktop operation label');
  assert.deepEqual(readFileSync(`${state}-wal`), wal);
  const proof = { passed: true, operations, catalogReads, desktopWork: all.filter(({ ref }) => ref.adapter === desktop).length, cliCopies: all.filter(({ ref }) => ref.adapter === cli).length, walUnchanged: true, confirmedTitle: exact[0]?.title };
  mkdirSync(join(run, 'evidence'), { recursive: true });
  writeFileSync(join(run, 'evidence', 'antigravity-desktop-find.json'), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
} finally {
  unsubscribe();
  await socket.close();
  await closed;
  hub.cleanup();
  await app.cleanup();
  fixture?.close();
}
