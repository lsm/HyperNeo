import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { readBoundGitBlob } from '../../../packages/daemon/src/lib/artifacts/git-blob.ts';
import { artifactCaptureOwner } from '../../../packages/daemon/src/lib/artifacts/capture-owner.ts';
import { createArtifactCaptureStore } from '../../../packages/daemon/src/lib/artifacts/capture-store.ts';
import { createArtifactRegistration } from '../../../packages/daemon/src/lib/artifacts/register-operation.ts';
import { createArtifactReferenceResolve } from '../../../packages/daemon/src/lib/artifacts/resolve-operation.ts';
const root = realpathSync(process.argv[2]); const phase = process.argv[3] ?? 'native';
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(root, 'home'));
const sha = 'a'.repeat(40); const treeSha = 'b'.repeat(40); const directorySha = 'c'.repeat(40);
const bytes = Buffer.from('# Complete immutable 🦊\n'.repeat(60000));
const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const expected = createHash('sha256').update(bytes).digest('hex');
const prefix = 'repos/lsm/hyperneo/git/';
const commitKey = `${prefix}commits/${sha}`; const rootKey = `${prefix}trees/${treeSha}`; const directoryKey = `${prefix}trees/${directorySha}`; const blobKey = `${prefix}blobs/${blobSha}`;
const entry = { path: 'report.md', mode: '100644', type: 'blob', sha: blobSha, size: bytes.length };
const original = {
 [commitKey]: { url: `https://api.github.com/${commitKey}`, sha, tree: { sha: treeSha } },
 [rootKey]: { url: `https://api.github.com/${rootKey}`, sha: treeSha, truncated: false, tree: [{ path: 'docs', mode: '040000', type: 'tree', sha: directorySha }] },
 [directoryKey]: { url: `https://api.github.com/${directoryKey}`, sha: directorySha, truncated: false, tree: [entry] },
 [blobKey]: { url: `https://api.github.com/${blobKey}`, sha: blobSha, encoding: 'base64', size: bytes.length, content: bytes.toString('base64') },
};
const fixture = (value: unknown) => writeFileSync(join(root, 'git-fixtures.json'), JSON.stringify(value));
if (phase !== 'probe') {
 const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./preview-pr-summary.ts', import.meta.url)), root, 'seed'], { env: process.env, stdout: 'pipe', stderr: 'inherit' });
 const output = await new Response(child.stdout).text(); assert.equal(await child.exited, 0, output);
 fixture(original);
 copyFileSync(fileURLToPath(new URL('./preview-git-gh.ts', import.meta.url)), join(root, 'bin', 'gh')); chmodSync(join(root, 'bin', 'gh'), 0o700);
 if (phase === 'seed') { console.log('seeded immutable Git fixtures'); process.exit(0); }
}
const target = { repository: 'github.com/lsm/hyperneo', sha, path: 'docs/report.md' };
const first = await readBoundGitBlob(target); assert(first.accepted); assert(first.bytes.equals(bytes)); assert.equal(first.sha256, expected); assert.equal(first.blobSha, blobSha);
if (phase === 'probe') { writeFileSync(join(root, 'evidence', 'git-inputs-probe.json'), JSON.stringify({ complete: true, sha256: first.sha256, blobSha, byteLength: first.bytes.length }, null, 2)); console.log('PASS: isolated immutable Git input probe'); process.exit(0); }
const calls = () => readFileSync(join(root, 'evidence', 'gh.log'), 'utf8').trim().split('\n');
const unavailable = { accepted: false, reason: 'unavailable' };
fixture({ ...original, [blobKey]: { ...original[blobKey], content: `${original[blobKey].content.match(/.{1,60}/g)!.join('\n')}\n` } }); assert((await readBoundGitBlob(target)).accepted); fixture(original);
let before = calls().length;
for (const invalid of [{ ...target, sha: 'HEAD' }, { ...target, repository: 'other.example/lsm/hyperneo' }, { ...target, path: '../report.md' }, { ...target, path: '.ssh/key.md' }, { ...target, path: 'docs%2freport.md' }]) assert.deepEqual(await readBoundGitBlob(invalid), unavailable);
assert.equal(calls().length, before);
for (const changed of [
 { ...original, [commitKey]: { ...original[commitKey], sha: 'd'.repeat(40) } },
 { ...original, [commitKey]: { ...original[commitKey], url: 'https://api.github.com/repos/other/repo/git/commits/' + sha } },
 { ...original, [rootKey]: { ...original[rootKey], url: 'https://other.example/tree' } },
 { ...original, [blobKey]: { ...original[blobKey], url: 'https://api.github.com/repos/other/repo/git/blobs/' + blobSha } },
 { ...original, [rootKey]: { ...original[rootKey], sha: 'd'.repeat(40) } },
 { ...original, [directoryKey]: { ...original[directoryKey], tree: [] } },
 { ...original, [rootKey]: { ...original[rootKey], truncated: true } },
 { ...original, [rootKey]: { ...original[rootKey], tree: [{ path: 'docs', type: 'blob', mode: '120000', sha: directorySha }] } },
 ...['120000', '160000', '040000'].map((mode) => ({ ...original, [directoryKey]: { ...original[directoryKey], tree: [{ ...entry, mode }] } })),
 { ...original, [directoryKey]: { ...original[directoryKey], tree: [entry, entry] } },
 { ...original, [blobKey]: { ...original[blobKey], content: Buffer.from('wrong bytes').toString('base64') } },
 { ...original, [blobKey]: { ...original[blobKey], content: `${original[blobKey].content}!` } },
 { ...original, [blobKey]: { ...original[blobKey], sha: 'd'.repeat(40) } },
]) { fixture(changed); const result = await readBoundGitBlob(target); assert.equal(result.accepted, false); assert.deepEqual(result, unavailable); }
fixture({ ...original, [directoryKey]: { ...original[directoryKey], tree: [{ ...entry, size: 64 * 1024 * 1024 + 1 }] } });
before = calls().length; assert.deepEqual(await readBoundGitBlob(target), { accepted: false, reason: 'size_limit', actualBytes: 64 * 1024 * 1024 + 1, limitBytes: 64 * 1024 * 1024 }); assert.equal(calls().length - before, 3);
fixture({ ...original, [rootKey]: { ...original[rootKey], tree: [{ ...original[rootKey].tree[0], path: 'x'.repeat(1100000) }] } }); assert.deepEqual(await readBoundGitBlob(target), unavailable);
fixture({ ...original, [rootKey]: { rawText: JSON.stringify(original[rootKey]) + ' '.repeat(1100000) } }); assert.deepEqual(await readBoundGitBlob(target), unavailable);
const emptySha = createHash('sha1').update('blob 0\0').digest('hex');
fixture({ ...original, [directoryKey]: { ...original[directoryKey], tree: [{ ...entry, size: 0, sha: emptySha }] }, [`${prefix}blobs/${emptySha}`]: { url: `https://api.github.com/${prefix}blobs/${emptySha}`, sha: emptySha, encoding: 'base64', size: 0, content: '' } });
const empty = await readBoundGitBlob(target); assert(empty.accepted); assert.equal(empty.bytes.length, 0);
fixture(original);
const data = join(root, 'data'); let db = new Database(join(data, 'daemon.db'));
const owner = await artifactCaptureOwner(db, data);
const input = Buffer.from(first.bytes); const pending = owner.capture(input); input.fill(0);
const saved = await pending; assert(saved.accepted); assert.equal(saved.sha256, expected); assert(readFileSync(join(data, 'artifacts', 'blobs', saved.sha256)).equals(bytes));
assert((await owner.capture(bytes)).accepted); assert.equal((await owner.inspect()).retainedBytes, bytes.length);
assert.equal((db.prepare('SELECT COUNT(*) AS n FROM artifact_files').get() as { n: number }).n, 0);
const context = { kind: 'todo' as const, id: 'todo' };
const local = await createArtifactRegistration(() => db, data, join(root, 'home')).execute({ requestId: 'local', context, path: 'report.md', title: 'Local' }, { source: 'rpc', principal: 'local' }) as { accepted: boolean };
assert(local.accepted); assert.equal((await owner.inspect()).retainedBytes, bytes.length + readFileSync(join(root, 'workspace', 'report.md')).length);
const small = await createArtifactCaptureStore(join(root, 'small-store'), { retainedBytes: 24 });
const outcomes = await Promise.all([small.capture(Buffer.alloc(16)), small.capture(Buffer.alloc(16))]); assert.equal(outcomes.filter((result) => result.accepted).length, 1); assert(outcomes.some((result) => !result.accepted && result.reason === 'quota_full')); assert.equal((await small.inspect()).reservedBytes, 0);
db.prepare(`UPDATE sdk_message_bodies SET sdk_message = ? WHERE seq=(SELECT rowid FROM sdk_messages WHERE id='source')`).run(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `https://github.com/lsm/HyperNeo/blob/${sha}/docs/report.md` }] } }));
const operation = createArtifactReferenceResolve(() => db, data, join(root, 'home'));
const result = await operation.execute(operation.inputSchema.parse({ requestId: '11111111-1111-4111-8111-111111111111', sourceMessageOrCard: { kind: 'message', id: 'source' }, reference: `https://github.com/lsm/HyperNeo/blob/${sha}/docs/report.md` }), { source: 'rpc', principal: 'local' });
assert.equal((result as { accepted: boolean }).accepted, true);
assert.equal((db.prepare('SELECT COUNT(*) AS n FROM artifact_files').get() as { n: number }).n, 2);
db.close(); db = new Database(join(data, 'daemon.db'));
assert.equal((await (await artifactCaptureOwner(db, data)).inspect()).retainedBytes, bytes.length + readFileSync(join(root, 'workspace', 'report.md')).length); db.close();
const evidence = { immutableBytes: true, objectVerified: true, noSymlink: true, bounded: true, sharedQuota: true, registrationRequired: true, restart: true, sha256: expected, blobSha, byteLength: bytes.length, ghCalls: calls().length };
writeFileSync(join(root, 'git-capture-inputs-evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
