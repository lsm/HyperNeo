import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const config = { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true };
const app = await createDaemonApp({ config, verbose: false });
try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  const replies = [];
  const url = 'https://example.invalid/owner/repo/pull/1';
  const head = 'a'.repeat(40);
  const ref = { adapter: 'human', id: 'missing' };
  const actor = { kind: 'human', id: 'missing' };
  for (const [name, input] of [
    ['neo.coding.assign', { todoId: 'missing', url, head, acceptanceContract: 'proof', stage: 'review', candidates: [] }],
    ['neo.coding.merge.prepare', { todoId: 'missing', url }],
    ['neo.coding.pr.file', { context: { kind: 'todo', id: 'missing' }, pr: 'example/repo#1', path: 'README.md', headSha: head, requestId: '00000000-0000-4000-8000-000000000001' }],
    ['neo.coding.result', { todoId: 'missing', ref, fact: { url, head, stage: 'review', actor, verdict: 'pass', acceptanceContract: 'proof', evidence: ['proof'] } }],
    ['neo.coding.merge.retry', { url, head }],
    ['neo.coding.smoke', { todoId: 'missing', url, head, smoke: { actor, ref, mergeCommit: head, verdict: 'pass', evidence: ['proof'] } }],
  ] as const) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'rpc.ts'), name, JSON.stringify(input)], {
      env: { ...process.env, VERIFY_PORT: String(app.server.port) }, stdout: 'pipe', stderr: 'inherit',
    });
    const result = JSON.parse(await new Response(child.stdout).text());
    assert.equal(await child.exited, 0);
    assert(!result.reply.error, JSON.stringify(result));
    replies.push(result.reply);
  }
  assert.deepEqual(replies, [
    { ok: false, reason: 'A live coding todo with a linked author and PR is required.' },
    { accepted: false, reason: 'GitHub PR host is not allowed.' },
    { accepted: false, reason: 'unavailable' },
    { ok: false, reason: 'stage_assignment_mismatch' },
    { accepted: false, reason: 'Only Neo can accept a stopped daemon merge report.' },
    { accepted: false, reason: 'stage_assignment_mismatch' },
  ]);
  writeFileSync(join(run, 'evidence/replies.json'), JSON.stringify(replies, null, 2));
  console.log(`RPC replies: ${replies.length}`);
} finally {
  await app.cleanup();
}
