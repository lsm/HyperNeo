import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import type { FindWorkResultSchema } from '../../../packages/daemon/src/lib/drivers/find-operation.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import type { z } from 'zod';

const run = process.argv.at(-1)!;
const [mode, binary] = process.argv.slice(2, -1);
assert(['fixture', 'absent', 'signed-out'].includes(mode));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const workspaceRoot = join(run, 'workspace');
const evidence = join(run, 'evidence');
mkdirSync(workspaceRoot);
mkdirSync(evidence);
const bin = join(run, 'home/.local/bin');
mkdirSync(bin, { recursive: true });
const executable = join(bin, 'agy');
const journal = join(evidence, 'requests.jsonl');
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
if (mode === 'signed-out') {
  assert(isAbsolute(binary));
  symlinkSync(binary, executable);
}
if (mode === 'fixture') {
  process.env.HTTPS_PROXY = 'http://proxy.example.test:8080';
  process.env.ANTIGRAVITY_FIXTURE_PARENT_ONLY = 'parent';
  writeFileSync(executable, `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
assert.deepEqual(process.argv.slice(2), ['acp', '--disable-telemetry']);
for await (const line of createInterface({ input: process.stdin })) {
  const {id, method, params} = JSON.parse(line);
  appendFileSync(${JSON.stringify(journal)}, JSON.stringify({method, params}) + '\\n');
  if (method === 'initialize') await Bun.sleep(2_500);
  const cwd = ${JSON.stringify(workspaceRoot)};
  const result = method === 'initialize'
    ? {protocolVersion: 1, agentCapabilities: {sessionCapabilities: {list: {}}}}
    : params.cursor === 'next'
      ? {sessions: [{sessionId: 'agy-b', title: 'Find this session', cwd, updatedAt: '2026-08-05T00:00:00Z'}]}
      : {sessions: [{sessionId: 'agy-a', title: 'First session', cwd}], nextCursor: 'next'};
  assert(['initialize', 'session/list'].includes(method));
  assert.equal(process.env.HTTPS_PROXY, 'http://proxy.example.test:8080');
  assert.equal(process.env.ANTIGRAVITY_FIXTURE_PARENT_ONLY, undefined);
  process.stdout.write(JSON.stringify({jsonrpc: '2.0', id, result}) + '\\n');
}
`, { mode: 0o700 });
}

const app = await createDaemonApp({
  config: {
    ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db'), workspaceRoot }),
    disableWorktrees: true,
    disableGoalProcessing: true,
  },
  verbose: false,
});
const hub = new MessageHub({ defaultSessionId: 'global' });
let closed = Promise.resolve();
const transport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  autoReconnect: false,
  createSocket: (url) => {
    const socket = createLocalSocket(url);
    closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve(), { once: true }));
    return socket;
  },
});
hub.registerTransport(transport);
const results: Record<string, unknown> = { mode };
try {
  assert(![8399, 8499].includes(app.server.port));
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await transport.connect();
  const adapter = 'antigravity-cli';
  const catalog = await hub.request<{ ok: boolean; value: { id: string; capabilities: string[] }[] }>(
    'operation.invoke', { name: 'work.adapters', input: {} }
  );
  assert(catalog.ok);
  const registered = catalog.value.find((entry) => entry.id === adapter);
  results.catalog = registered ?? null;
  if (mode === 'absent') assert.equal(registered, undefined);
  else assert.deepEqual(registered?.capabilities, ['find']);

  if (mode !== 'absent') {
    const found = await hub.request<z.infer<typeof FindWorkResultSchema>>('operation.invoke', {
      name: 'work.find', input: { adapters: [adapter], text: 'Find this session', folder: workspaceRoot, limit: 1, localOnly: true },
    });
    results.found = found;
    if (mode === 'signed-out') {
      assert.equal(found.places.flatMap((place) => place.work).length, 0);
      assert.deepEqual(found.unreachable, [{ source: adapter, reason: 'Sign in to Antigravity CLI before listing its sessions.' }]);
    } else {
      assert.deepEqual(found.unreachable, []);
      const work = found.places.flatMap((place) => place.work);
      assert.equal(work.length, 1);
      assert.deepEqual(work[0].ref, { id: 'agy-b', adapter });
      assert.equal(work[0].title, 'Find this session');
      assert.equal(work[0].place.folder, workspaceRoot);
      const requests = readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(requests.map((request) => request.method), ['initialize', 'session/list', 'session/list']);
      assert.deepEqual(requests[2].params, { cwd: workspaceRoot, cursor: 'next' });
      results.requests = requests.length;
    }
  }
  results.passed = true;
  console.log(JSON.stringify({ mode, passed: true, operations: mode === 'absent' ? 1 : 2 }));
} finally {
  await transport.close();
  await closed;
  hub.cleanup();
  await app.cleanup();
  writeFileSync(join(evidence, 'antigravity-find.json'), JSON.stringify(results, null, 2));
}
