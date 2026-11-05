process.env.HYPERNEO_SPACE ??= 'on';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import { legacyAttachmentFixture } from './legacy-attachment-fixture.ts';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const seed = Bun.spawn([process.execPath, fileURLToPath(new URL('./preview-resolve.ts', import.meta.url)), run, 'seed'], { env: process.env, stdout: 'pipe', stderr: 'inherit' });
assert.equal(await seed.exited, 0, await new Response(seed.stdout).text());
const app = await createDaemonApp({ config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true }, verbose: false });
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({createSocket: createLocalSocket,  url: `ws://127.0.0.1:${app.server.port}/ws`, autoReconnect: false });
hub.registerTransport(transport);
const evidence: Record<string, unknown> = { port: app.server.port };
const receipts: unknown[] = [];
try {
  assert.notEqual(app.server.port, 8399);
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await transport.initialize();
  const call = <T = Record<string, unknown>>(name: string, input: unknown) => hub.request<T>('operation.invoke', { name, input });
  const saved = legacyAttachmentFixture(() => app.db.getDatabase(), join(run, 'data'), join(run, 'home')).execute( { requestId: 'existing-attachment', context: { kind: 'todo', id: 'todo' }, path: 'report.md', title: 'Previously saved report' });
  assert(saved.accepted);
  const db = app.db.getDatabase();
  const rows = () => db.prepare('SELECT * FROM artifact_files ORDER BY artifact_id').all();
  const files = () => readdirSync(join(run, 'data/artifacts'), { recursive: true }).map(String).sort();
  const before = rows(), blobs = files();
  const original = readFileSync(join(run, 'workspace/report.md'), 'utf8');
  const request = { sourceMessageOrCard: { kind: 'message', id: 'source' }, reference: 'report.md', requestId: crypto.randomUUID() };
  for (const sourceMessageOrCard of [request.sourceMessageOrCard, { kind: 'todo', id: 'todo' }]) {
    const tap = { ...request, sourceMessageOrCard };
    for (const input of [tap, tap, { ...tap, requestId: crypto.randomUUID() }]) {
      const result = await call('artifact.reference.resolve', input);
      receipts.push(result);
      assert.equal(result.accepted, false);
      assert.equal(result.reason, 'client_upgrade_required');
      assert.match(String(result.detail), /update.*hyperneo/i);
      assert.deepEqual(rows(), before);
      assert.deepEqual(files(), blobs);
    }
  }
  const live = () => call<{ accepted: boolean; data: string; reason?: string }>('file.reference.read', { sourceMessageOrCard: { kind: 'todo', id: 'todo' }, reference: 'report.md' });
  const first = await live();
  assert(first.accepted);
  assert.equal(Buffer.from(first.data, 'base64').toString(), original);
  writeFileSync(join(run, 'workspace/report.md'), '# Edited current report\n');
  const edited = await live();
  assert(edited.accepted);
  assert.equal(Buffer.from(edited.data, 'base64').toString(), '# Edited current report\n');
  unlinkSync(join(run, 'workspace/report.md'));
  assert.equal((await live()).reason, 'missing');
  const legacy = await call<{ accepted: boolean; data: string }>('artifact.file.read', { artifactId: saved.artifact.artifactId });
  assert(legacy.accepted);
  assert.equal(Buffer.from(legacy.data, 'base64').toString(), original);
  assert.deepEqual(rows(), before);
  assert.deepEqual(files(), blobs);
  Object.assign(evidence, { passed: true, localTapsRefused: true, noNewRowsOrBlobs: true, liveReadEditDelete: true, savedAttachmentUnchanged: true });
} finally {
  await transport.close();
  await app.cleanup();
  writeFileSync(join(run, 'evidence/retire-local-tap.json'), JSON.stringify({ ...evidence, receipts, cleaned: true }, null, 2));
}
console.log(JSON.stringify(evidence));
