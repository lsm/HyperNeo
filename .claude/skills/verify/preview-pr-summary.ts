import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
import { createArtifactReferenceResolve } from '../../../packages/daemon/src/lib/artifacts/resolve-operation.ts';
import { readBoundPrSummary } from '../../../packages/daemon/src/lib/artifacts/pr-summary.ts';
import { createOperationRegistry } from '../../../packages/daemon/src/lib/operations/registry.ts';
import { invokeOperation } from '../../../packages/daemon/src/lib/operations/invoke.ts';
const root = realpathSync(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(root, 'home'));
for (const dir of ['bin', 'evidence']) mkdirSync(join(root, dir), { recursive: true });
copyFileSync(fileURLToPath(new URL('./gh-stub.sh', import.meta.url)), join(root, 'bin', 'gh')); chmodSync(join(root, 'bin', 'gh'), 0o700);
const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./preview-resolve.ts', import.meta.url)), root, 'seed'], { env: process.env, stdout: 'pipe', stderr: 'inherit' });
const output = await new Response(child.stdout).text(); assert.equal(await child.exited, 0, output);
const data = join(root, 'data'); let db = new Database(join(data, 'daemon.db'));
const url = 'https://github.com/lsm/HyperNeo/pull/42'; const sha = 'a'.repeat(40);
function source(text = `[PR](${url})`) { db.prepare(`UPDATE sdk_message_bodies SET sdk_message = ? WHERE seq = (SELECT rowid FROM sdk_messages WHERE id='source')`).run(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })); }
source(); db.prepare(`UPDATE neo_todos SET repo = 'github.com/lsm/hyperneo' WHERE id='todo'`).run();
const raw = { url, title: 'Synthetic design PR', body: '# Complete untrusted body\n<script>inert string</script>', state: 'OPEN', headRefOid: sha,
 reviews: [{ state: 'APPROVED', commit: { oid: 'b'.repeat(40) }, author: { login: 'reviewer' } }], statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], changedFiles: 3,
 files: [{ path: 'docs/report.md', additions: 10, deletions: 2 }] };
const fixture = (value: unknown) => writeFileSync(join(root, 'pr.json'), JSON.stringify(value)); fixture(raw);
if (process.argv[3] === 'seed') { db.close(); console.log('seeded bound PR fixture'); process.exit(0); }
const human = { source: 'rpc' as const, principal: 'local' as const };
const request = { sourceMessageOrCard: { kind: 'message' as const, id: 'source' }, reference: url, requestId: '11111111-1111-4111-8111-111111111111' };
let registry = createOperationRegistry([createArtifactReferenceResolve(() => db, data, join(root, 'home'))]);
async function call(input = request, catalog = registry) {
 const result = await invokeOperation(catalog, 'artifact.reference.resolve', input, human);
 assert.equal(result.kind, 'completed', JSON.stringify(result));
 return (result as { kind: 'completed'; value: { accepted: boolean; reason: string; pr: { title: string; body: string; headSha: string; filesTruncated: boolean; files: unknown[]; review: string; checks: string } } }).value;
}
const unavailable = { accepted: false, reason: 'unavailable' };
const first = await call(); assert(first.accepted); assert.equal(first.pr.headSha, sha); assert.equal(first.pr.review, 'none'); assert.equal(first.pr.checks, 'passing');
assert.equal(first.pr.body, raw.body); assert.equal(first.pr.title, raw.title); assert.equal(first.pr.filesTruncated, true); assert.equal(first.pr.files.length, 1);
const calls = () => readFileSync(join(root, 'evidence', 'gh.log'), 'utf8').trim().split('\n');
assert(calls().every((line) => line.includes('gh pr view 42 --repo github.com/lsm/hyperneo --json ')));
let before = calls().length;
assert.deepEqual(await call({ ...request, reference: 'https://github.com/lsm/Other/pull/42' }), unavailable); assert.equal(calls().length, before);
source('[PR](https://github.com/lsm/Other/pull/42)'); assert.deepEqual(await call({ ...request, reference: 'https://github.com/lsm/Other/pull/42' }), unavailable); assert.equal(calls().length, before); source();
for (const invalid of [
 { ...raw, url: 'https://other.example/lsm/HyperNeo/pull/42' }, { ...raw, headRefOid: 'HEAD' },
 { ...raw, body: 'x'.repeat(65537) }, { ...raw, body: '界'.repeat(65536) },
 { ...raw, files: [{ path: '../outside.md', additions: 1, deletions: 0 }] },
 { ...raw, changedFiles: 0 }, { ...raw, changedFiles: 2, files: [raw.files[0], raw.files[0]] },
 { ...raw, files: Array.from({ length: 1001 }, (_, i) => ({ path: `docs/${i}.md`, additions: 1, deletions: 0 })) },
]) { fixture(invalid); assert.deepEqual(await call(), unavailable); }
writeFileSync(join(root, 'pr.json'), '{ invalid JSON'); assert.deepEqual(await call(), unavailable);
fixture({ ...raw, body: 'x'.repeat(1100000) }); assert.deepEqual(await call(), unavailable);
renameSync(join(root, 'pr.json'), join(root, 'pr.retained.json')); assert.deepEqual(await call(), unavailable); fixture(raw);
source('[PR](https://unconfigured.example/lsm/HyperNeo/pull/42)'); db.prepare(`UPDATE neo_todos SET repo = 'unconfigured.example/lsm/hyperneo' WHERE id='todo'`).run();
before = calls().length; assert.deepEqual(await call({ ...request, reference: 'https://unconfigured.example/lsm/HyperNeo/pull/42' }), unavailable); assert.equal(calls().length, before);
source(); db.prepare(`UPDATE neo_todos SET repo = 'github.com/lsm/hyperneo' WHERE id='todo'`).run();
const changing = createOperationRegistry([createArtifactReferenceResolve(() => db, data, join(root, 'home'), undefined, async (target) => {
 const result = await readBoundPrSummary(target); source('Reference removed'); return result;
})]);
assert.deepEqual(await call(request, changing), unavailable); source();
assert.equal((db.prepare('SELECT COUNT(*) AS n FROM artifact_files').get() as { n: number }).n, 0); assert(!existsSync(join(data, 'artifacts')));
db.close(); db = new Database(join(data, 'daemon.db'));
registry = createOperationRegistry([createArtifactReferenceResolve(() => db, data, join(root, 'home'))]);
const next = { ...raw, headRefOid: 'b'.repeat(40), changedFiles: 1 }; fixture(next);
const second = await call(); assert(second.accepted); assert.equal(second.pr.headSha, next.headRefOid); assert.equal(second.pr.review, 'approved'); assert.equal(second.pr.filesTruncated, false); assert.equal(first.pr.headSha, sha);
db.close();
const evidence = { sourceBound: true, knownRepository: true, boundedMetadata: true, exactHead: true, noByteCapture: true, revoked: true, restart: true, first, second, ghCalls: calls().length };
writeFileSync(join(root, 'pr-summary-evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
