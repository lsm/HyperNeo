import { spawnSync } from 'node:child_process';
import { expect, test } from 'bun:test';
import { vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  prepareWorkerSandbox,
  releaseWorkerSandbox,
} from '../../../../src/lib/drivers/worker-sandbox';

const { beforeOperation, afterFailedChmod } = vi.hoisted(() => ({
  beforeOperation: vi.fn(async (_operation: string, _path: unknown) => {}),
  afterFailedChmod: vi.fn(async (_path: unknown) => {}),
}));

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    chmod: async (...args: Parameters<typeof actual.chmod>) => {
      await beforeOperation('chmod', args[0]);
      try {
        return await actual.chmod(...args);
      } catch (error) {
        await afterFailedChmod(args[0]);
        throw error;
      }
    },
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      await beforeOperation('readdir', args[0]);
      return actual.readdir(...args);
    },
  };
});

test.each(
  ['chmod', 'readdir'].flatMap((operation) =>
    ['runtime', 'child'].map((scope) => ({ operation, scope }))
  )
)(
  'release succeeds when another actor removes $scope before $operation',
  async ({ operation, scope }) => {
    const root = mkdtempSync(join(tmpdir(), 'worker-removal-'));
    mkdirSync(join(root, '.git'));
    const env = await prepareWorkerSandbox(root);
    const gone = scope === 'runtime' ? join(env.TMPDIR, '..') : join(env.TMPDIR, 'a-gone');
    const retained = join(env.TMPDIR, 'z-locked');
    mkdirSync(gone, { recursive: true });
    mkdirSync(retained);
    writeFileSync(join(retained, 'synthetic'), 'worker bytes');
    chmodSync(retained, 0o000);
    beforeOperation.mockImplementation(async (next, path) => {
      if (next === operation && String(path) === gone) {
        chmodSync(retained, 0o700);
        await rm(gone, { recursive: true, force: true });
        if (scope === 'child') chmodSync(retained, 0o000);
      }
    });
    try {
      await releaseWorkerSandbox(root);
      expect(existsSync(env.TMPDIR)).toBe(false);
      expect(existsSync(env.XDG_CACHE_HOME)).toBe(false);
      expect(existsSync(root)).toBe(true);
    } finally {
      beforeOperation.mockReset();
      if (existsSync(retained)) chmodSync(retained, 0o700);
      await releaseWorkerSandbox(root);
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test.skipIf(process.platform !== 'darwin')(
  'release succeeds when a remover wins before immutable flag recovery',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-flag-removal-'));
    mkdirSync(join(root, '.git'));
    const env = await prepareWorkerSandbox(root);
    const gone = join(env.TMPDIR, 'gone');
    mkdirSync(gone);
    writeFileSync(join(gone, 'synthetic'), 'worker bytes');
    try {
      expect(spawnSync('/usr/bin/chflags', ['uchg', gone]).status).toBe(0);
      let removed = false;
      afterFailedChmod.mockImplementation(async (path) => {
        if (String(path) === gone && !removed) {
          removed = true;
          expect(spawnSync('/usr/bin/chflags', ['-h', 'nouchg', gone]).status).toBe(0);
          await rm(gone, { recursive: true, force: true });
        }
      });
      await releaseWorkerSandbox(root);
      expect(existsSync(env.TMPDIR)).toBe(false);
      expect(existsSync(env.XDG_CACHE_HOME)).toBe(false);
      expect(existsSync(root)).toBe(true);
    } finally {
      afterFailedChmod.mockReset();
      spawnSync('/usr/bin/chflags', ['-RP', 'nouchg', join(env.TMPDIR, '..')]);
      await releaseWorkerSandbox(root);
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test.skipIf(process.platform === 'win32')(
  'cleanup never changes an unlisted directory after a worker symlink swap',
  async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'worker-swap-'));
    const root = join(fixture, 'clone');
    mkdirSync(join(root, '.git'), { recursive: true });
    const env = await prepareWorkerSandbox(root);
    const swap = join(env.TMPDIR, 'swap');
    mkdirSync(swap);
    const outside = join(fixture, 'outside');
    const child = join(outside, 'child');
    mkdirSync(child, { recursive: true });
    chmodSync(outside, 0o755);
    chmodSync(child, 0o750);
    let swapped = false;
    beforeOperation.mockImplementation(async (operation, path) => {
      if (operation === 'chmod' && String(path) === swap && !swapped) {
        swapped = true;
        renameSync(swap, join(env.XDG_CACHE_HOME, 'moved'));
        symlinkSync(outside, swap, 'dir');
      }
    });
    try {
      await releaseWorkerSandbox(root).catch(() => {});
      expect(swapped).toBe(true);
      expect(statSync(outside).mode & 0o777).toBe(0o755);
      expect(statSync(child).mode & 0o777).toBe(0o750);
    } finally {
      beforeOperation.mockReset();
      await releaseWorkerSandbox(root);
      rmSync(fixture, { recursive: true, force: true });
    }
  }
);
