import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCuChecker } from '../../../packages/daemon/src/lib/drivers/codex-cu-reaper.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(homedir(), join(run, 'home'));
const owner: { cleanup?: (() => void)[] } = {};
let argumentEvaluated = false;
owner.cleanup?.push((() => { argumentEvaluated = true; return () => {}; })());
assert.equal(argumentEvaluated, false);
let reads = 0;
const checker = createCuChecker({
  read: async () => {
    reads++;
    return { now: Date.now(), path: '', uid: 0, assertions: '', log: '', processes: '' };
  },
  auto: () => true,
  notify: async () => { throw new Error('Unexpected notification'); },
  signal: () => { throw new Error('Unexpected signal'); },
});
try {
  await checker.check();
  assert.equal(reads, 1);
} finally {
  await checker.close();
}
await checker.check();
assert.equal(reads, 1);
mkdirSync(join(run, 'evidence'), { recursive: true });
writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ pass: true, versions: process.versions, argumentEvaluated, reads, closed: true }, null, 2));
process.stdout.write('PASS: native runtime timer starts, checks and closes without OS commands\n');
