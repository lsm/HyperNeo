import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../../../packages/daemon/src/storage/sqlite-compat.ts';
const [directory, phase, port = '9386'] = process.argv.slice(2);
const root = realpathSync(directory);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(root, 'home'));
assert.notEqual(port, '8399');
const workspace = join(root, 'workspace');
const text = '# Synthetic 🦊\nComplete bytes\n';
const input = { requestId: 'request', context: { kind: 'todo', id: 'todo' }, path: 'report.md', title: 'Report' };
const evidence = join(root, 'evidence', 'register-rpc.json');
const rpc = async (params: unknown) => {
  const child = Bun.spawn(['bun', '.claude/skills/verify/rpc.ts', 'artifact.file.register', JSON.stringify(params)], {
    env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit',
  });
  const result = JSON.parse(await new Response(child.stdout).text());
  assert.equal(await child.exited, 0);
  assert(!result.reply.error, JSON.stringify(result));
  return result.reply.value ?? result.reply;
};
const receipt = await rpc(input);
assert.equal(receipt.accepted, true, JSON.stringify(receipt));
assert(!JSON.stringify(receipt).includes(workspace));
assert.deepEqual(await rpc(input), receipt);
if (phase === 'capture') {
  assert.deepEqual(await rpc({ ...input, path: '../outside.md' }), { accepted: false, reason: 'unsafe_path' });
  assert.deepEqual(await rpc({ ...input, path: '.env' }), { accepted: false, reason: 'sensitive_path' });
  assert.deepEqual(await rpc({ ...input, path: join(workspace, 'report.md'), context: { kind: 'todo', id: 'foreign' } }), { accepted: false, reason: 'unavailable' });
  writeFileSync(join(workspace, 'report.md'), '# Changed synthetic bytes\n');
  const version2 = await rpc(input);
  assert.equal(version2.accepted, true);
  assert.notEqual(version2.artifact.artifactId, receipt.artifact.artifactId);
  renameSync(join(workspace, 'report.md'), join(workspace, 'retained-source.md'));
  assert.deepEqual(await rpc(input), version2);
  const db = new Database(join(root, 'data', 'daemon.db'), { readonly: true });
  const metadata = db.prepare('SELECT sha256, byte_length FROM artifact_files WHERE artifact_id = ?').get(receipt.artifact.artifactId) as { sha256: string; byte_length: number };
  db.close();
  const bytes = readFileSync(join(root, 'data', 'artifacts', 'blobs', metadata.sha256));
  assert.equal(bytes.toString(), text);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), metadata.sha256);
  assert.equal(bytes.length, metadata.byte_length);
  writeFileSync(evidence, JSON.stringify({ receipt, version2, metadata, sourceRetained: true }, null, 2));
} else {
  assert.equal(phase, 'restart');
  assert.deepEqual(receipt, JSON.parse(readFileSync(evidence, 'utf8')).version2);
  writeFileSync(join(root, 'evidence', 'register-rpc-restart.json'), JSON.stringify({ sameReceipt: true, receipt }));
}
console.log(`PASS: registration ${phase} through isolated daemon operation.invoke`);
