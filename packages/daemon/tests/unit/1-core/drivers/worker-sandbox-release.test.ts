import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  prepareWorkerSandbox,
  releaseWorkerSandbox,
} from '../../../../src/lib/drivers/worker-sandbox';

test.skipIf(process.platform === 'win32')(
  'releases nonempty chmod-000 runtime directories without touching symlink targets',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-release-'));
    mkdirSync(join(root, '.git'));
    const env = await prepareWorkerSandbox(root);
    const locked = join(env.TMPDIR, 'locked');
    const nested = join(locked, 'nested');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'synthetic'), 'worker bytes');
    const outside = join(root, 'retained');
    mkdirSync(outside, { mode: 0o500 });
    symlinkSync(outside, join(env.XDG_CACHE_HOME, 'outside'));
    chmodSync(nested, 0o000);
    chmodSync(locked, 0o000);
    try {
      await releaseWorkerSandbox(root);
      expect(existsSync(env.TMPDIR)).toBe(false);
      expect(existsSync(env.XDG_CACHE_HOME)).toBe(false);
      expect(statSync(outside).mode & 0o777).toBe(0o500);
      expect(existsSync(root)).toBe(true);
      await releaseWorkerSandbox(root);
    } finally {
      if (existsSync(locked)) {
        chmodSync(locked, 0o700);
        chmodSync(nested, 0o700);
      }
      await releaseWorkerSandbox(root);
      chmodSync(outside, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  }
);
