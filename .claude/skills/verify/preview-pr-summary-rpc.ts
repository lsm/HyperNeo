import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const [directory, phase, port = '9386'] = process.argv.slice(2);
const root = realpathSync(directory);
assert.equal(process.env.NODE_ENV, 'test'); assert.equal(process.env.HOME, join(root, 'home')); assert.notEqual(port, '8399');
if (phase === 'seed') {
 const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./preview-pr-summary.ts', import.meta.url)), root, 'seed'], { env: process.env, stdout: 'pipe', stderr: 'inherit' });
 const output = await new Response(child.stdout).text(); assert.equal(await child.exited, 0, output);
 console.log('seeded isolated PR summary fixture');
} else {
 const rpc = async (input: unknown) => {
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./rpc.ts', import.meta.url)), 'artifact.reference.resolve', JSON.stringify(input)], { env: { ...process.env, VERIFY_PORT: port }, stdout: 'pipe', stderr: 'inherit' });
  const result = JSON.parse(await new Response(child.stdout).text()); assert.equal(await child.exited, 0); assert(!result.reply.error, JSON.stringify(result)); return result.reply.value ?? result.reply;
 };
 const input = { sourceMessageOrCard: { kind: 'message', id: 'source' }, reference: 'https://github.com/lsm/HyperNeo/pull/42', requestId: '11111111-1111-4111-8111-111111111111' };
 const result = await rpc(input); assert(result.accepted); assert.equal(result.pr.headSha, 'a'.repeat(40)); assert.equal(result.pr.filesTruncated, true); assert.equal(result.pr.review, 'none');
 assert.equal(result.pr.body, JSON.parse(readFileSync(join(root, 'pr.json'), 'utf8')).body);
 const first = join(root, 'evidence', 'pr-summary-rpc.json');
 if (phase === 'restart') assert.deepEqual(result, JSON.parse(readFileSync(first, 'utf8')).result); else assert.equal(phase, 'read');
 const before = readFileSync(join(root, 'evidence', 'gh.log'), 'utf8');
 assert.deepEqual(await rpc({ ...input, reference: 'https://github.com/lsm/Other/pull/42' }), { accepted: false, reason: 'unavailable' });
 assert.equal(readFileSync(join(root, 'evidence', 'gh.log'), 'utf8'), before);
 writeFileSync(phase === 'read' ? first : join(root, 'evidence', 'pr-summary-rpc-restart.json'), JSON.stringify({ result, sourceBound: true, boundRepositoryOnly: true, exactHead: true }, null, 2));
 console.log(`PASS: ${phase} bound PR summary through operation.invoke using isolated gh stub`);
}
