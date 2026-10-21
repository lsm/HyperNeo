import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync, linkSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createTables, runMigrations } from '../../../packages/daemon/src/storage/schema/index.ts';
import { createArtifactRegistration } from '../../../packages/daemon/src/lib/artifacts/register-operation.ts';
import type { ArtifactRef, ArtifactFileMetadata } from '../../../packages/shared/src/types/artifact-file.ts';
import { readArtifactChunk } from '../../../packages/daemon/src/lib/artifacts/read-snapshot.ts';
import { createArtifactReadOperations } from '../../../packages/daemon/src/lib/artifacts/read-operations.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
import { createOperationRegistry, type OperationCaller } from '../../../packages/daemon/src/lib/operations/registry.ts';
const root = realpathSync(resolve(process.argv[2] ?? ''));
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(root, 'home'));
const data = join(root, 'data');
const workspace = join(root, 'workspace');
mkdirSync(data); mkdirSync(workspace);
const dbPath = join(data, 'reads.db');
const db = new Database(dbPath);
runMigrations(db, () => {}); createTables(db);
const work = new NeoAskTodoRepository(db);
work.openAsk({ id: 'ask', projectId: null, sessionId: 'neo', originMessageId: 'm', title: 'Synthetic', request: 'Synthetic', createdAt: 1 });
for (const id of ['todo', 'other']) work.addTodo(id, 'ask', { title: id, doneWhen: '', check: null, instruction: '', named: null }, 1);
const sessions = new NeoTodoSessionRepository(db);
for (const id of ['todo', 'other']) {
 sessions.create(id, { verb: 'start', adapter: 'hyperneo', place: { machine: 'local', name: 'Synthetic', folder: workspace } });
 sessions.recordRef(id, { adapter: 'hyperneo', id: `${id}-worker` });
 db.prepare(`INSERT INTO sessions (id,title,workspace_path,created_at,last_active_at,status,config,metadata) VALUES (?,'Synthetic',?,'now','now','active','{}','{}')`).run(`${id}-worker`,workspace);
}
const worker: OperationCaller = { source: 'mcp', role: 'direct_task_worker', sessionId: 'todo-worker' };
const human: OperationCaller = { source: 'rpc', principal: 'local' };
const context = { kind: 'todo', id: 'todo' };
const registration = createArtifactRegistration(() => db, data, join(root, 'home'));
const registry = createOperationRegistry([registration, ...createArtifactReadOperations(() => db, data)]);
async function call(name: string, input: unknown, caller = worker, catalog = registry) {
 const result = await invokeOperation(catalog, name, input, caller);
 assert.equal(result.kind, 'completed', JSON.stringify(result));
 return (result as { kind: 'completed'; value: { accepted: boolean; artifact: ArtifactRef; metadata: ArtifactFileMetadata; artifacts: ArtifactRef[]; nextCursor: string | null; data: string; nextOffset: number; complete: boolean } }).value;
}
const bytes = Buffer.from('# Complete synthetic 🦊\n'.repeat(25000));
writeFileSync(join(workspace, 'report.md'), bytes);
const refs = [];
for (let index = 0; index < 3; index++) refs.push((await call('artifact.file.register', { requestId: `r${index}`, context, path: 'report.md', title: `Report ${index}` })).artifact);
const first = refs[0];
const metadata = await call('artifact.file.get', { artifactId: first.artifactId });
assert.deepEqual(metadata.metadata.artifact, first);
assert.deepEqual(metadata.metadata.context, context);
assert.equal(metadata.metadata.sourcePath, 'report.md');
assert(!JSON.stringify(metadata).includes(workspace));
const unavailable = { accepted: false, reason: 'unavailable' };
for (const name of ['artifact.file.get', 'artifact.file.read']) {
 assert.deepEqual(await call(name, { artifactId: first.artifactId }, { ...worker, sessionId: 'foreign' }), unavailable);
 assert.deepEqual(await call(name, { artifactId: 'missing' }), unavailable);
}
assert.deepEqual(await call('artifact.file.list', { context }, { ...worker, sessionId: 'foreign' }), unavailable);
const all = [];
let cursor;
do {
 const page = await call('artifact.file.list', { context, limit: 1, ...(cursor ? { cursor } : {}) });
 assert.equal(page.artifacts.length, 1); all.push(...page.artifacts); cursor = page.nextCursor;
} while (cursor);
assert.deepEqual(new Set(all.map((ref) => ref.artifactId)), new Set(refs.map((ref) => ref.artifactId)));
const foreign = (await call('artifact.file.register', { requestId: 'foreign', context: { kind: 'todo', id: 'other' }, path: 'report.md', title: 'Other' }, human)).artifact;
assert.deepEqual(await call('artifact.file.list', { context, cursor: foreign.artifactId }), unavailable);
writeFileSync(join(workspace, 'empty.md'), '');
const empty = (await call('artifact.file.register', { requestId: 'empty', context: { kind: 'todo', id: 'other' }, path: 'empty.md', title: 'Empty' }, human)).artifact;
assert.deepEqual(await call('artifact.file.read', { artifactId: empty.artifactId }, human), {
 accepted: true, data: '', nextOffset: 0, byteLength: 0, sha256: createHash('sha256').digest('hex'), complete: true,
});
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
writeFileSync(join(workspace, 'image.png'), png);
const image = (await call('artifact.file.register', { requestId: 'image', context: { kind: 'todo', id: 'other' }, path: 'image.png', title: 'Image' }, human)).artifact;
assert.equal(image.kind, 'image');
assert(Buffer.from((await call('artifact.file.read', { artifactId: image.artifactId }, human)).data, 'base64').equals(png));
renameSync(workspace, `${workspace}.retained`);
const chunks = [];
let offset = 0;
for (;;) {
 const chunk = await call('artifact.file.read', { artifactId: first.artifactId, offset, maxBytes: 65537 });
 assert.equal(chunk.accepted, true); const decoded = Buffer.from(chunk.data, 'base64');
 assert(decoded.length <= 65537); assert.equal(chunk.nextOffset, offset + decoded.length);
 chunks.push(decoded); offset = chunk.nextOffset; if (chunk.complete) break;
}
assert(Buffer.concat(chunks).equals(bytes));
assert.equal(createHash('sha256').update(Buffer.concat(chunks)).digest('hex'), metadata.metadata.sha256);
assert.deepEqual(await call('artifact.file.read', { artifactId: first.artifactId, offset: bytes.length + 1 }), unavailable);
assert.deepEqual(await call('artifact.file.read', { artifactId: first.artifactId, offset: bytes.length }), { accepted: true, data: '', nextOffset: bytes.length, complete: true, byteLength: bytes.length, sha256: metadata.metadata.sha256 });
for (const invalidInput of [{ maxBytes: 262145 }, { maxBytes: 0 }, { offset: -1 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { path: '/outside' }, { sha256: metadata.metadata.sha256 }]) {
 const invalid = await invokeOperation(registry, 'artifact.file.read', { artifactId: first.artifactId, ...invalidInput }, worker);
 assert.equal(invalid.kind, 'failed');
}
assert.equal((await invokeOperation(registry, 'artifact.file.list', { context, limit: 51 }, worker)).kind, 'failed');
assert.deepEqual((await call('artifact.file.get', { artifactId: first.artifactId }, human)).metadata, metadata.metadata);
assert.deepEqual((await call('artifact.file.get', { artifactId: first.artifactId }, { source: 'mcp', role: 'neo', sessionId: 'neo' })).metadata, metadata.metadata);
assert.deepEqual(await call('artifact.file.get', { artifactId: first.artifactId }, { source: 'mcp', role: 'neo', sessionId: 'other' }), unavailable);
const inFlight = createOperationRegistry(createArtifactReadOperations(() => db, data, async (...args) => {
 const result = await readArtifactChunk(...args);
 sessions.recordRef('todo', { adapter: 'hyperneo', id: 'replacement' });
 return result;
}));
assert.deepEqual(await call('artifact.file.read', { artifactId: first.artifactId }, worker, inFlight), unavailable);
for (const name of ['artifact.file.get', 'artifact.file.read']) assert.deepEqual(await call(name, { artifactId: first.artifactId }), unavailable);
assert.deepEqual(await call('artifact.file.list', { context }), unavailable);
sessions.recordRef('todo', { adapter: 'hyperneo', id: 'todo-worker' });
db.close();
const reopened = new Database(dbPath, { readonly: true });
const restarted = createOperationRegistry(createArtifactReadOperations(() => reopened, data));
assert.deepEqual(await call('artifact.file.get', { artifactId: first.artifactId }, worker, restarted), metadata);
assert.equal((await call('artifact.file.read', { artifactId: first.artifactId }, worker, restarted)).accepted, true);
const blob = join(data, 'artifacts', 'blobs', metadata.metadata.sha256);
linkSync(blob, join(data, 'artifacts', 'staging', 'retained-stage-proof'));
assert.equal((await call('artifact.file.read', { artifactId: first.artifactId }, worker, restarted)).accepted, true);
chmodSync(blob, 0o600); const corrupt = Buffer.from(bytes); corrupt[corrupt.length-1] ^= 1; writeFileSync(blob, corrupt);
assert.deepEqual(await call('artifact.file.read', { artifactId: first.artifactId, maxBytes: 1 }, worker, restarted), unavailable);
assert(readFileSync(blob).equals(corrupt));
renameSync(blob, `${blob}.retained-corrupt`);
const outside = join(root, 'outside-snapshot.md'); writeFileSync(outside, bytes);
symlinkSync(outside, blob);
assert.deepEqual(await call('artifact.file.read', { artifactId: first.artifactId }, worker, restarted), unavailable);
reopened.close();
const evidence = { exactBytes: true, boundedReads: true, scopedPagination: true, authorityRechecked: true,
 tamperingRefused: true, sourceIndependent: true, restartPreserved: true, readonlyMetadata: true, first, metadata, byteLength: bytes.length };
writeFileSync(join(root, 'read-evidence.json'), JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence));
