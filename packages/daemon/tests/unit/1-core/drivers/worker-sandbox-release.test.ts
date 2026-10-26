import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, test } from 'bun:test';
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

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'worker-data-'));
  process.env.HYPERNEO_DATA_DIR = dataDir;
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.HYPERNEO_DATA_DIR;
});

test('release removes only one worker scratch root and keeps evidence locations', async () => {
  const first = mkdtempSync(join(tmpdir(), 'worker-sibling-a-'));
  const second = mkdtempSync(join(tmpdir(), 'worker-sibling-b-'));
  mkdirSync(join(first, '.git'));
  mkdirSync(join(second, '.git'));
  try {
    const a = (await prepareWorkerSandbox(first)) as Record<string, string>;
    const b = (await prepareWorkerSandbox(second)) as Record<string, string>;
    writeFileSync(join(b.TMPDIR, 'sibling'), 'kept');
    await releaseWorkerSandbox(first);
    expect(existsSync(a.TMPDIR)).toBe(false);
    expect(existsSync(join(b.TMPDIR, 'sibling'))).toBe(true);
    expect(existsSync(join(dataDir, 'work', 'scratch'))).toBe(true);
    expect(existsSync(a.HYPERNEO_EVIDENCE)).toBe(true);
    expect(existsSync(a.HYPERNEO_BUILDS)).toBe(true);
    await releaseWorkerSandbox(second);
  } finally {
    await releaseWorkerSandbox(first);
    await releaseWorkerSandbox(second);
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

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

test.skipIf(process.platform !== 'darwin')(
  'releases user-immutable files and locked immutable directories',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-flags-'));
    mkdirSync(join(root, '.git'));
    const env = await prepareWorkerSandbox(root);
    const locked = join(env.TMPDIR, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'synthetic'), 'worker bytes');
    const cacheFile = join(env.XDG_CACHE_HOME, 'synthetic');
    writeFileSync(cacheFile, 'cache bytes');
    const outside = join(root, 'retained');
    writeFileSync(outside, 'retained bytes');
    symlinkSync(outside, join(env.XDG_CACHE_HOME, 'outside'));
    try {
      chmodSync(locked, 0o000);
      expect(spawnSync('/usr/bin/chflags', ['uchg', locked]).status).toBe(0);
      expect(spawnSync('/usr/bin/chflags', ['uchg,uappnd', cacheFile, outside]).status).toBe(0);
      await releaseWorkerSandbox(root);
      expect(existsSync(env.TMPDIR)).toBe(false);
      expect(existsSync(env.XDG_CACHE_HOME)).toBe(false);
      expect(spawnSync('/bin/ls', ['-ldO', outside], { encoding: 'utf8' }).stdout).toContain(
        'uchg'
      );
    } finally {
      if (existsSync(locked)) {
        spawnSync('/usr/bin/chflags', ['-h', 'nouchg,nouappnd', locked]);
        chmodSync(locked, 0o700);
      }
      spawnSync('/usr/bin/chflags', ['-RP', 'nouchg,nouappnd', env.TMPDIR]);
      spawnSync('/usr/bin/chflags', ['-h', 'nouchg,nouappnd', outside]);
      await releaseWorkerSandbox(root);
      rmSync(root, { recursive: true, force: true });
    }
  }
);
