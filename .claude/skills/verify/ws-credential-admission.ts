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
const evidence: Record<string, unknown> = {};
const app = await createDaemonApp({
  config: { ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), disableWorktrees: true },
  verbose: false,
});
try {
  await app.jobProcessor.stop();
  assert.notEqual(app.server.port, 8399);
  const anonymous = new WebSocket(`ws://127.0.0.1:${app.server.port}/ws`);
  const opened = await new Promise<boolean>((resolve) => {
    anonymous.onopen = () => resolve(true);
    anonymous.onerror = () => resolve(false);
  });
  anonymous.close();
  evidence.anonymousOpened = opened;
  assert.equal(opened, false, 'anonymous WebSocket must not be admitted');
  for (const [name, headers] of [
    ['anonymous', {}],
    ['unknown', { authorization: 'Bearer not-a-paired-device' }],
    ['proxied-browser', { origin: 'https://daemon.example', host: 'daemon.example' }],
  ] as const) {
    const response = await fetch(`http://127.0.0.1:${app.server.port}/ws`, { headers });
    evidence[name] = response.status;
    assert.equal(response.status, 401, `${name} must be refused before WebSocket upgrade`);
  }
  evidence.verified = true;
} finally {
  await app.cleanup();
  evidence.resourcesStopped = true;
  writeFileSync(join(run, 'evidence/ws-credential-admission.json'), JSON.stringify(evidence, null, 2));
}
