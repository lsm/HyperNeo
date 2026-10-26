import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
const shared = join(run, 'shared-temp');
const stale = join(shared, 'unrelated-worker');
const marker = join(stale, '.git/hyperneo-native-writes.json');
mkdirSync(join(stale, '.git'), { recursive: true });
mkdirSync(join(run, 'evidence'), { recursive: true });
const original = JSON.stringify({ roots: [join(run, 'source')] });
writeFileSync(marker, original);
const result = spawnSync('node_modules/.bin/vitest', ['run', 'tests/unit/1-core/drivers/worker-local-binding.test.ts'], {
  cwd: resolve('packages/daemon'), env: { ...process.env, TMPDIR: shared, TMP: shared, TEMP: shared },
  encoding: 'utf8', timeout: 60000,
});
writeFileSync(join(run, 'evidence/fixture-tests.log'), result.stdout + result.stderr);
const observed = {
  exit: result.status,
  staleMarkerUnchanged: readFileSync(marker, 'utf8') === original,
  unrelatedPolicyAbsent: !existsSync(join(stale, '.claude')),
};
writeFileSync(join(run, 'evidence/fixture-isolation.json'), JSON.stringify(observed, null, 2));
assert.equal(result.status, 0, result.stdout + result.stderr);
assert(observed.staleMarkerUnchanged && observed.unrelatedPolicyAbsent);
