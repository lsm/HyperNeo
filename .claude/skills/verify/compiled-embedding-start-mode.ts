import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [binary, directory] = process.argv.slice(2);
assert(binary && directory, 'expected compiled binary and fresh run directory');
const run = resolve(directory);
for (const part of ['home', 'data', 'tmp', 'bin', 'evidence']) mkdirSync(join(run, part), { recursive: true });
for (const name of ['security', 'gh', 'open', 'ps', 'claude', 'codex'])
  writeFileSync(join(run, 'bin', name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') });
const port = probe.port!;
assert.notEqual(port, 8399);
await probe.stop(true);
const child = Bun.spawn([resolve(binary), '--host', '127.0.0.1', '--port', String(port), '--db-path', join(run, 'data/daemon.db'), '--workspace', join(run, 'home/workspace')], {
  env: { HOME: join(run, 'home'), TMPDIR: join(run, 'tmp'), PATH: `${join(run, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`, NODE_ENV: 'test', HYPERNEO_DATA_DIR: join(run, 'data'), LOG_LEVEL: 'info' },
  stdout: 'pipe', stderr: 'pipe',
});
let logs = '';
const consume = async (stream: ReadableStream<Uint8Array>) => {
  for await (const chunk of stream) logs += new TextDecoder().decode(chunk);
};
const draining = Promise.all([consume(child.stdout), consume(child.stderr)]);
try {
  const deadline = Date.now() + 30000;
  let healthy = false;
  while (Date.now() < deadline && child.exitCode === null) {
    try { healthy = (await fetch(`http://127.0.0.1:${port}/neo`)).ok; } catch {}
    if (healthy) break;
    await Bun.sleep(100);
  }
  assert(healthy, 'compiled daemon did not become healthy');
  await Bun.sleep(5000);
  assert.equal(child.exitCode, null, 'daemon exited during observation');
  const starts = logs.split('\n').filter((line) => line.includes('embeddingassets') || line.includes('Embeddings ready'));
  assert.equal(starts.length, 0, `test-mode daemon started embeddings: ${starts.join('\n')}`);
  console.log('PASS: test-mode compiled daemon served /neo and did not start embeddings; count=0');
} finally {
  child.kill('SIGTERM');
  await child.exited;
  await draining;
  writeFileSync(join(run, 'evidence/daemon.log'), logs);
}
