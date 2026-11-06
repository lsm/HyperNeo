import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
await import('./ask-markdown-http.ts');
const host = '0:0:0:0:0:0:0:1';
const app = await createDaemonApp({ config: { ...getConfig({ host, port: 0, dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true }, standalone: true, verbose: false });
try {
  await app.spaceRuntimeService?.ready();
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const url = `http://[${host}]:${app.server.port}/ask/synthetic.md`;
  const cli = Bun.spawn([process.execPath, 'packages/cli/main.ts', 'read', url], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exit] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
  writeFileSync(join(run, 'evidence/ipv6-origin.json'), JSON.stringify({ host, cliExit: exit, cardRead: stdout.startsWith('# Plan the visit\n'), error: stderr }));
  assert.equal(exit, 0, stderr);
  assert(stdout.startsWith('# Plan the visit\n'));
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/ipv6-cleanup.json'), JSON.stringify({ daemonStopped: true }));
}
