import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { waitForSdkBodyCopy } from './wait-for-sdk-body-copy.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 2\n', { mode: 0o700 });
const app = await createDaemonApp({
  config: { ...getConfig({ host: '127.0.0.1', port: 0, dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true },
  standalone: true,
  verbose: false,
});
try {
  await app.spaceRuntimeService?.ready();
  await app.jobProcessor.stop();
  await waitForSdkBodyCopy(app.db.getDatabase());
  assert.notEqual(app.server.port, 8399);
  const response = await fetch(`http://127.0.0.1:${app.server.port}/ask/synthetic.md`);
  const observed = { status: response.status, body: await response.text() };
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(observed, null, 2));
  assert.equal(observed.status, 401);
  assert.equal(observed.body, 'Device pairing required');
} finally {
  await app.cleanup();
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({ daemonStopped: true }));
}
