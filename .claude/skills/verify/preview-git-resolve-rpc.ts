import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [directory, phase, port = '9386'] = process.argv.slice(2); const root = realpathSync(directory);
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(root, 'home')); assert.notEqual(port, '8399');
if (phase === 'seed') {
 const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./preview-git-resolve.ts', import.meta.url)), root, 'seed'], { env: process.env, stdout: 'pipe', stderr: 'inherit' });
 const output = await new Response(child.stdout).text(); assert.equal(await child.exited, 0, output); appendFileSync(join(root, 'evidence', 'gh.log'), ''); console.log('seeded isolated Git resolution');
} else {
 async function rpc(operation: string, input: unknown) {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./rpc.ts', import.meta.url)), operation, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit' });
  const result = JSON.parse(await new Response(child.stdout).text()); assert.equal(await child.exited, 0); assert(!result.reply.error, JSON.stringify(result)); return result.reply.value ?? result.reply;
 }
 const sha = 'a'.repeat(40); const expected = Buffer.from('# Complete immutable 🦊\n'.repeat(60000));
 const hash = createHash('sha256').update(expected).digest('hex');
 const input = { sourceMessageOrCard: { kind: 'message', id: 'source' }, reference: `https://github.com/lsm/HyperNeo/blob/${sha}/docs/report.md`, requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
 const before = readFileSync(join(root, 'evidence', 'gh.log'), 'utf8');
 const result = await rpc('artifact.reference.resolve', input); assert(result.accepted); const id = { artifactId: result.artifact.artifactId };
 const metadata = await rpc('artifact.file.get', id); assert(metadata.accepted); assert.equal(metadata.metadata.revision.kind, 'commit'); assert.equal(metadata.metadata.revision.commitSha, sha); assert.equal(metadata.metadata.sha256, hash); assert(!JSON.stringify(metadata).includes(root));
 const chunks: Buffer[] = []; let offset = 0;
 for (;;) { const chunk = await rpc('artifact.file.read', { ...id, offset }); assert(chunk.accepted); assert.equal(chunk.sha256, hash); const bytes = Buffer.from(chunk.data, 'base64'); assert(bytes.length <= 256 * 1024); chunks.push(bytes); offset = chunk.nextOffset; if (chunk.complete) break; }
 assert(Buffer.concat(chunks).equals(expected));
 const first = join(root, 'evidence', 'git-resolution-rpc.json');
 if (phase === 'restart') {
  assert.deepEqual(result, JSON.parse(readFileSync(first, 'utf8')).result); assert.deepEqual(metadata, JSON.parse(readFileSync(first, 'utf8')).metadata);
  assert.equal(readFileSync(join(root, 'evidence', 'gh.log'), 'utf8'), before);
 } else {
  assert.equal(phase, 'read');
  const selection = { ...input, reference: 'https://github.com/lsm/HyperNeo/pull/42', requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', file: { path: 'docs/report.md', headSha: sha } };
  const picked = await rpc('artifact.reference.resolve', selection); assert(picked.accepted);
  const originalPr = JSON.parse(readFileSync(join(root, 'pr.json'), 'utf8'));
  writeFileSync(join(root, 'pr.json'), JSON.stringify({ ...originalPr, headRefOid: 'd'.repeat(40) }));
  assert.deepEqual(await rpc('artifact.reference.resolve', selection), { accepted: false, reason: 'source_changed' });
  assert.equal((await rpc('artifact.file.get', { artifactId: picked.artifact.artifactId })).metadata.revision.commitSha, sha);
  writeFileSync(join(root, 'pr.json'), JSON.stringify(originalPr));
  const log = readFileSync(join(root, 'evidence', 'gh.log'), 'utf8');
  assert.deepEqual(await rpc('artifact.reference.resolve', { ...input, reference: input.reference.replace('HyperNeo', 'Other') }), { accepted: false, reason: 'unavailable' });
  assert.equal(readFileSync(join(root, 'evidence', 'gh.log'), 'utf8'), log);
 }
 writeFileSync(phase === 'read' ? first : join(root, 'evidence', 'git-resolution-rpc-restart.json'), JSON.stringify({ result, metadata, completeBytes: expected.length, sha256: hash, immutableHead: true, registeredRead: true }, null, 2));
 console.log(`PASS: ${phase} complete immutable Git snapshot through isolated operation.invoke`);
}
