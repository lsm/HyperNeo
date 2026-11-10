import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { captureGitArtifact } from '../../../packages/daemon/src/lib/artifacts/git-capture.ts';
import { readArtifactChunk } from '../../../packages/daemon/src/lib/artifacts/read-snapshot.ts';
import { createArtifactReadOperations } from '../../../packages/daemon/src/lib/artifacts/read-operations.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { artifactCaptureOwner } from '../../../packages/daemon/src/lib/artifacts/capture-owner.ts';
import type { ArtifactRef, ArtifactReadResult } from '../../../packages/shared/src/types/artifact-file.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const data = join(run, 'data');
const app = await createDaemonApp({
  config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(data, 'daemon.db') }), disableWorktrees: true },
  verbose: false,
});
await app.jobProcessor.stop();
assert(![8399, 8499].includes(app.server.port));
const db = app.db.getDatabase();
const workspace = join(run, 'workspace');
mkdirSync(workspace);
const context = { kind: 'todo' as const, id: 'video' };
const sessions = new NeoTodoSessionRepository(db);
const worker = { source: 'mcp' as const, role: 'direct_task_worker' as const, sessionId: 'worker' };
function movie(brand: string, length = 600_007) {
  const bytes = Buffer.alloc(length, 0x55);
  bytes.writeUInt32BE(24, 0); bytes.write('ftyp', 4); bytes.write(brand, 8);
  bytes.writeUInt32BE(0, 12); bytes.write(brand, 16); bytes.write(brand, 20);
  return bytes;
}
async function capture(bytes: Buffer, path: string) {
  const result = await captureGitArtifact(db, data, {
    repository: 'github.com/example/video', sha: 'a'.repeat(40), path, context,
  }, randomUUID(), async () => true, async () => ({
    accepted: true, bytes, sha256: createHash('sha256').update(bytes).digest('hex'),
    blobSha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
  }));
  return result as { accepted: boolean; artifact: ArtifactRef; reason?: string };
}
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./rpc.ts', import.meta.url)), name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: String(app.server.port) }, stdout: 'pipe', stderr: 'inherit',
  });
  const output = await new Response(child.stdout).text();
  assert.equal(await child.exited, 0, output);
  const { reply } = JSON.parse(output);
  assert(!reply.error, JSON.stringify(reply));
  return reply.value ?? reply;
}
try {
  await app.db.createSession({ id: 'worker', title: 'Synthetic video', workspacePath: workspace,
    createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), status: 'active',
    config: { queryMode: 'manual' }, metadata: { messageCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, totalCost: 0, toolCallCount: 0 } });
  const work = new NeoAskTodoRepository(db);
  work.openAsk({ id: 'ask', projectId: null, sessionId: 'neo', originMessageId: null, title: 'Synthetic videos', request: '', createdAt: 1 });
  work.addTodo('video', 'ask', { title: 'Video', instruction: null, named: null, check: null, doneWhen: 'Done' }, 2);
  sessions.create('video', { verb: 'start', adapter: 'hyperneo', place: { machine: 'local', name: 'Synthetic', folder: workspace } });
  sessions.recordRef('video', { adapter: 'hyperneo', id: 'worker' });
  const bytes = movie('mp42');
  const first = await capture(bytes, 'clip.mp4');
  assert(first.accepted, JSON.stringify(first)); assert.equal(first.artifact.kind, 'video');
  const mov = await capture(movie('qt  '), 'clip.mov');
  assert(mov.accepted); assert.equal(mov.artifact.kind, 'video');
  const id = { artifactId: first.artifact.artifactId };
  const metadata = await rpc('artifact.file.get', id);
  assert.equal(metadata.metadata.artifact.kind, 'video');
  assert.equal((await rpc('artifact.file.list', { context })).artifacts.length, 2);
  const chunks: Buffer[] = [];
  for (let offset = 0; ;) {
    const chunk = await rpc('artifact.file.read', { ...id, offset, maxBytes: 262144 });
    assert(chunk.accepted); const decoded = Buffer.from(chunk.data, 'base64');
    assert(decoded.length <= 262144); assert.equal(chunk.nextOffset, offset + decoded.length);
    chunks.push(decoded); offset = chunk.nextOffset; if (chunk.complete) break;
  }
  assert.equal(chunks.length, 3); assert(Buffer.concat(chunks).equals(bytes));
  assert.equal(createHash('sha256').update(Buffer.concat(chunks)).digest('hex'), metadata.metadata.sha256);
  const eof = await rpc('artifact.file.read', { ...id, offset: bytes.length });
  assert.equal(eof.data, ''); assert.equal(eof.complete, true);
  const unavailable = { accepted: false, reason: 'unavailable' };
  assert.deepEqual(await rpc('artifact.file.read', { ...id, offset: bytes.length + 1 }), unavailable);
  const invalid = await invokeOperation(createOperationRegistry(createArtifactReadOperations(() => db, data)), 'artifact.file.read', { ...id, maxBytes: 262145 }, worker);
  assert.equal(invalid.kind, 'failed');
  const registry = createOperationRegistry(createArtifactReadOperations(() => db, data));
  async function call(catalog = registry, caller = worker) {
    const result = await invokeOperation(catalog, 'artifact.file.read', { ...id, maxBytes: 1 }, caller);
    assert.equal(result.kind, 'completed', JSON.stringify(result));
    return (result as { kind: 'completed'; value: ArtifactReadResult }).value;
  }
  assert.deepEqual(await call(registry, { ...worker, sessionId: 'foreign' }), unavailable);
  const inFlight = createOperationRegistry(createArtifactReadOperations(() => db, data, async (...args) => {
    const result = await readArtifactChunk(...args);
    sessions.recordRef('video', { adapter: 'hyperneo', id: 'replacement' });
    return result;
  }));
  assert.deepEqual(await call(inFlight), unavailable);
  sessions.recordRef('video', { adapter: 'hyperneo', id: 'worker' });
  const owner = await artifactCaptureOwner(db, data);
  const before = (await owner.inspect()).retainedBytes;
  assert.deepEqual(await capture(movie('mp42', 16 * 1024 * 1024 + 1), 'large.mp4'), { accepted: false, reason: 'size_limit' });
  assert.equal((await owner.inspect()).retainedBytes, before);
  const exact = await capture(movie('mp42', 16 * 1024 * 1024), 'limit.mp4');
  assert(exact.accepted);
  assert.equal((await rpc('artifact.file.read', { artifactId: exact.artifact.artifactId, offset: 16 * 1024 * 1024 - 1, maxBytes: 1 })).complete, true);
  assert.equal((await capture(Buffer.from('not a video'), 'invalid.mp4')).reason, 'unsupported_type');
  const blob = join(data, 'artifacts/blobs', metadata.metadata.sha256);
  const corrupted = readFileSync(blob); corrupted[corrupted.length - 1] ^= 1;
  chmodSync(blob, 0o600); writeFileSync(blob, corrupted);
  assert.deepEqual(await rpc('artifact.file.read', { ...id, maxBytes: 1 }), unavailable);
  const evidence = { registeredMp4: true, registeredMov: true, chunks: chunks.length,
    byteLength: bytes.length, exactBytes: true, rangeBoundaries: true, wholeSnapshotHash: true,
    foreignWorkerRefused: true, authorityRechecked: true, sizeCap: 16 * 1024 * 1024,
    exactCapAccepted: true, overCapNotRetained: true, invalidHeaderRefused: true, port: app.server.port };
  writeFileSync(join(run, 'evidence/registered-video.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: true, ...evidence }));
} finally {
  await app.cleanup();
}
