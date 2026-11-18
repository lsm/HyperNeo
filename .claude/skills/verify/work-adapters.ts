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
  for (const input of [{}, { daemon: 'missing-daemon' }]) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'rpc.ts'), 'work.adapters', JSON.stringify(input)], {
      env: { ...process.env, VERIFY_PORT: String(app.server.port) }, stdout: 'pipe', stderr: 'inherit',
    });
    const result = JSON.parse(await new Response(child.stdout).text());
    assert.equal(await child.exited, 0);
    assert(!result.reply.error, JSON.stringify(result));
    replies.push(result.reply);
  }
  assert.equal(replies[0].ok, true);
  assert.equal(replies[1].ok, false);
  writeFileSync(join(run, 'evidence/replies.json'), JSON.stringify(replies, null, 2));
  console.log(`RPC replies: ${replies.length}`);
} finally {
  await app.cleanup();
}
