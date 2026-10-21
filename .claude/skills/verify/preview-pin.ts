import { ArtifactRefSchema, ArtifactReadResultSchema } from '../../../packages/daemon/src/lib/artifacts/file-contracts.ts';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { handoffDraftDirectory, publishHandoff } from '../../../packages/daemon/src/lib/handoffs/outbox.ts';

const [port, directory, phase = 'capture'] = process.argv.slice(2);
assert(port && directory && /^\d+$/.test(port) && Number(port) > 0 && Number(port) !== 8399);
assert(phase === 'capture' || phase === 'restart');
const run = resolve(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const log = readFileSync(join(run, 'daemon.log'), 'utf8');
assert(log.includes('HyperNeo Test Server'));
assert(log.includes(`Database: ${run}/data/daemon.db`));
const evidencePath = join(run, 'evidence', 'preview-pin-capture.json');
const text = '  Synthetic preview report 🦊\n'.repeat(16000) + '\n';
async function rpc(name: string, input: unknown) {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', name, JSON.stringify(input)], {
    env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit',
  });
  const response = JSON.parse(await new Response(child.stdout).text());
  assert.equal(await child.exited, 0);
  assert(!response.reply.error, JSON.stringify(response));
  return response.reply.value ?? response.reply;
}
const reference = phase === 'capture' ? await seed() : JSON.parse(readFileSync(evidencePath, 'utf8')).reference;
async function seed() {
  const worker = `preview-pin-${randomUUID()}`;
  const drafts = handoffDraftDirectory(join(run, 'data'), worker);
  writeFileSync(join(drafts, 'report.md'), text);
  const published = await publishHandoff(join(run, 'data'), worker, 'report.md');
  assert.equal(published.kind, 'published');
  const reference = published.reference;
  renameSync(drafts, `${drafts}.retained-fixture`);
  writeFileSync(evidencePath, JSON.stringify({ reference, sourceAbsent: true }, null, 2), { flag: 'wx' });
  return reference;
}
const previewRef = ArtifactRefSchema.parse({
  daemonId: reference.daemonId, artifactId: reference.artifactId, title: reference.name,
  kind: 'markdown', byteLength: reference.byteLength,
});
const chunks: Buffer[] = [];
let offset = 0;
let complete = false;
while (!complete) {
  const read = await rpc('handoff.read', { reference, offset });
  assert.equal(read.kind, 'read');
  ArtifactReadResultSchema.parse({
    accepted: true, data: read.data, nextOffset: read.nextOffset,
    byteLength: reference.byteLength, sha256: reference.sha256, complete: read.complete,
  });
  const chunk = Buffer.from(read.data, 'base64');
  assert(chunk.length > 0 && chunk.length <= 256 * 1024);
  assert.equal(read.nextOffset, offset + chunk.length);
  chunks.push(chunk);
  offset = read.nextOffset;
  complete = read.complete;
}
const bytes = Buffer.concat(chunks);
assert.equal(bytes.toString(), text);
assert.equal(bytes.length, reference.byteLength);
assert.equal(createHash('sha256').update(bytes).digest('hex'), reference.sha256);
assert.deepEqual(await rpc('handoff.read', { reference: { ...reference, daemonId: randomUUID() } }), { kind: 'unavailable' });
writeFileSync(join(run, 'evidence', `preview-pin-${phase}-read.json`), JSON.stringify({
  phase, reference, previewRef, byteLength: bytes.length, chunks: chunks.length,
  exactBytes: true, foreignDaemonDenied: true,
}, null, 2));
console.log(`PASS: ${phase} reads complete immutable bytes through isolated daemon RPC`);
