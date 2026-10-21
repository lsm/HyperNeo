import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [directory, phase, port = '9386'] = process.argv.slice(2);
const root = realpathSync(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(root, 'home'));
assert.notEqual(port, '8399');
const text = '# Synthetic streamed report 🦊\n'.repeat(25000);
if (phase === 'seed') {
 const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./preview-register.ts', import.meta.url)), root, 'seed'], { env: process.env, stdout: 'pipe', stderr: 'inherit' });
 const output = await new Response(child.stdout).text(); assert.equal(await child.exited, 0, output);
 writeFileSync(join(root, 'workspace', 'report.md'), text);
 console.log('seeded isolated read fixture');
} else {
 const rpc = async (name: string, input: unknown) => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./rpc.ts', import.meta.url)), name, JSON.stringify(input)], {
   env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit',
  });
  const result = JSON.parse(await new Response(child.stdout).text()); assert.equal(await child.exited, 0);
  assert(!result.reply.error, JSON.stringify(result)); return result.reply.value ?? result.reply;
 };
 const evidencePath = join(root, 'evidence', 'read-rpc.json');
 const registered = phase === 'capture' ? await rpc('artifact.file.register', { requestId: 'read-rpc', context: { kind: 'todo', id: 'todo' }, path: 'report.md', title: 'Streamed report' }) : JSON.parse(readFileSync(evidencePath, 'utf8')).registered;
 assert(registered.accepted);
 const id = { artifactId: registered.artifact.artifactId };
 const metadata = await rpc('artifact.file.get', id); assert(metadata.accepted);
 assert(!JSON.stringify(metadata).includes(root));
 assert.deepEqual(metadata.metadata.context, { kind: 'todo', id: 'todo' });
 const listed = await rpc('artifact.file.list', { context: { kind: 'todo', id: 'todo' }, limit: 1 });
 assert.deepEqual(listed.artifacts, [registered.artifact]); assert.equal(listed.nextCursor, null);
 if (phase === 'capture') renameSync(join(root, 'workspace'), join(root, 'workspace.retained'));
 else assert.equal(phase, 'restart');
 const chunks: Buffer[] = []; let offset = 0;
 for (;;) {
  const chunk = await rpc('artifact.file.read', { ...id, offset, maxBytes: 65537 }); assert(chunk.accepted);
  const bytes = Buffer.from(chunk.data, 'base64'); assert(bytes.length <= 65537);
  assert.equal(chunk.nextOffset, offset + bytes.length); chunks.push(bytes); offset = chunk.nextOffset;
  if (chunk.complete) break;
 }
 const complete = Buffer.concat(chunks); assert.equal(complete.toString(), text);
 assert.equal(createHash('sha256').update(complete).digest('hex'), metadata.metadata.sha256);
 const unavailable = { accepted: false, reason: 'unavailable' };
 for (const name of ['artifact.file.get', 'artifact.file.read']) assert.deepEqual(await rpc(name, { artifactId: 'missing' }), unavailable);
 assert.deepEqual(await rpc('artifact.file.list', { context: { kind: 'todo', id: 'missing' } }), unavailable);
 writeFileSync(phase === 'capture' ? evidencePath : join(root, 'evidence', 'read-rpc-restart.json'), JSON.stringify({ registered, metadata, byteLength: complete.length, sha256: metadata.metadata.sha256, exactBytes: true, sourceRenamed: true }, null, 2));
 console.log(`PASS: ${phase} authorized metadata/list/full bounded download through operation.invoke`);
}
