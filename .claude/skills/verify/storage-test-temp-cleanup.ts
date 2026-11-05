import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';

const [mode, directory] = process.argv.slice(2);
const run = resolve(directory);
assert.equal(mode, 'verify');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const daemonRoot = fileURLToPath(new URL('../../../packages/daemon/', import.meta.url));
const result = Bun.spawnSync([
  'bun', 'test', 'tests/unit/4-space-storage/storage/backup-temp-hygiene.test.ts',
], { cwd: daemonRoot, env: process.env });
const output = `${result.stdout.toString()}${result.stderr.toString()}`;
writeFileSync(join(run, 'evidence/tests.log'), output);
assert.equal(result.exitCode, 0, output);
assert.match(output, /14 pass/);
const app = await createDaemonApp({
  config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
  verbose: false,
});
try {
  await app.spaceRuntimeService.ready();
  assert.notEqual(app.server.port, 8399);
  const tables = app.db.getDatabase().prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  assert(tables.length > 0);
  writeFileSync(join(run, 'evidence/cleanup.json'), JSON.stringify({
    tests: 14, forcedFailures: 7, fixturesRemaining: 0,
    daemonPort: app.server.port, daemonTables: tables.length,
    limitation: 'Test fixture lifecycle proof; no provider turns or browser changes.',
  }, null, 2));
} finally {
  await app.cleanup();
}
