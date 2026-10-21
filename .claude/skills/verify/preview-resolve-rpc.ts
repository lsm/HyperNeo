import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [directory, phase, port = '9386'] = process.argv.slice(2);
const root = realpathSync(directory);
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(root, 'home')); assert.notEqual(port, '8399');
if (phase === 'seed') {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./preview-resolve.ts', import.meta.url)), root, 'seed'], { env: process.env, stdout: 'pipe', stderr: 'inherit' });
  const output = await new Response(child.stdout).text(); assert.equal(await child.exited, 0, output);
  console.log('seeded isolated resolver fixture');
} else {
  const rpc = async (name: string, input: unknown) => {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./rpc.ts', import.meta.url)), name, JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit' });
    const result = JSON.parse(await new Response(child.stdout).text()); assert.equal(await child.exited, 0);
    assert(!result.reply.error, JSON.stringify(result)); return result.reply.value ?? result.reply;
  };
  const request = { sourceMessageOrCard: { kind: 'message', id: 'source' }, reference: 'report.md', requestId: '11111111-1111-4111-8111-111111111111' };
  const result = await rpc('artifact.reference.resolve', request); assert(result.accepted);
  const firstPath = join(root, 'evidence', 'resolve-rpc.json');
  if (phase === 'restart') assert.deepEqual(result, JSON.parse(readFileSync(firstPath, 'utf8')).result);
  else assert.equal(phase, 'capture');
  const missing = await rpc('artifact.reference.resolve', { ...request, reference: 'not-in-stored-source.md' });
  assert.deepEqual(missing, { accepted: false, reason: 'unavailable' });
  const id = { artifactId: result.artifact.artifactId };
  const metadata = await rpc('artifact.file.get', id); assert(metadata.accepted);
  assert(!JSON.stringify(metadata).includes(root));
  if (phase === 'capture') renameSync(join(root, 'workspace'), join(root, 'workspace.retained'));
  const read = await rpc('artifact.file.read', id); assert(read.accepted && read.complete);
  const bytes = Buffer.from(read.data, 'base64');
  assert(bytes.equals(readFileSync(join(root, 'workspace.retained', 'report.md'))));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.metadata.sha256);
  writeFileSync(phase === 'capture' ? firstPath : join(root, 'evidence', 'resolve-rpc-restart.json'), JSON.stringify({ result, sourceBound: true, exactSnapshot: true, sha256: metadata.metadata.sha256, sourceRetained: true }, null, 2));
  console.log(`PASS: ${phase} human stored-reference capture through operation.invoke`);
}
