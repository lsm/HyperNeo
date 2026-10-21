import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startEventLoopWatchdog } from '../../src/lib/event-loop-watchdog.ts';

const root = process.argv[2];
const enabled = process.env.HYPERNEO_NATIVE_LAG_PROFILE === '1' && process.platform === 'darwin';
const notices: unknown[] = [];
const watchdog = await startEventLoopWatchdog({
  stackPath: join(root, 'stack'),
  onNotice: (notice) => notices.push(notice),
});
assert(watchdog);
try {
  await new Promise((done) => setTimeout(done, 300));
  const started = Date.now();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  const recovered = Date.now();
  await new Promise((done) => setTimeout(done, 1800));
  assert.deepEqual(notices, []);
  const files = readdirSync(root).filter((name) => name.startsWith('stack.native-'));
  assert.equal(files.length, enabled ? 1 : 0);
  if (enabled) {
    const at = Number(files[0].match(/native-(\d+)/)?.[1]);
    assert(at >= started && at < recovered);
    assert(readFileSync(join(root, files[0]), 'utf8').includes('Call graph'));
  }
} finally {
  watchdog.stop();
}
