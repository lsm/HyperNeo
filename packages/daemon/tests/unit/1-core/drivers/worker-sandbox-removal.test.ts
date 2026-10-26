import { spawnSync } from 'node:child_process';
import { expect, test } from 'bun:test';
import { vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
import { workerRuntimeCleanupCommand } from '../../../../src/lib/drivers/worker-runtime-cleanup';

const { beforeLaunch } = vi.hoisted(() => ({ beforeLaunch: vi.fn((_args: string[]) => {}) }));
vi.mock('../../../../src/lib/runtime-spawn/index.ts', async (original) => {
  const actual = await original<typeof import('../../../../src/lib/runtime-spawn/index.ts')>();
  return {
    ...actual,
    spawnProcess: (...args: Parameters<typeof actual.spawnProcess>) => {
      beforeLaunch(args[0]);
      return actual.spawnProcess(...args);
    },
  };
});

test.skipIf(process.platform === 'win32').each(['runtime', 'child'])(
  'cleanup succeeds when a remover deletes %s before launch',
  async (scope) => {
    const root = mkdtempSync(join(tmpdir(), 'worker-removal-'));
    mkdirSync(join(root, '.git'));
    const env = await prepareWorkerSandbox(root);
    const retained = join(env.XDG_CACHE_HOME, 'locked');
    mkdirSync(retained);
    chmodSync(retained, 0o000);
    beforeLaunch.mockImplementation(() => {
      if (scope === 'runtime') chmodSync(retained, 0o700);
      rmSync(scope === 'runtime' ? join(env.TMPDIR, '..') : env.TMPDIR, {
        recursive: true,
        force: true,
      });
    });
    try {
      await releaseWorkerSandbox(root);
      expect(existsSync(env.TMPDIR)).toBe(false);
      expect(existsSync(env.XDG_CACHE_HOME)).toBe(false);
      expect(existsSync(root)).toBe(true);
    } finally {
      beforeLaunch.mockReset();
      await releaseWorkerSandbox(root);
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test.skipIf(process.platform === 'win32')(
  'cleanup OS policy refuses outside chmod after a symlink swap while permitting inside writes',
  async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'worker-swap-'));
    const root = join(fixture, 'clone');
    mkdirSync(join(root, '.git'), { recursive: true });
    const env = await prepareWorkerSandbox(root);
    const runtime = join(env.TMPDIR, '..');
    mkdirSync(join(env.TMPDIR, 'swap'));
    const outside = join(fixture, 'outside');
    const child = join(outside, 'child');
    mkdirSync(child, { recursive: true });
    chmodSync(outside, 0o755);
    chmodSync(child, 0o750);
    try {
      const args = await workerRuntimeCleanupCommand(runtime);
      args[args.indexOf('/bin/sh') + 2] = `
[ -d "$1/tmp/swap" ] || exit 1
/bin/mv "$1/tmp/swap" "$1/cache/moved" || exit 1
/bin/ln -s "$3" "$1/tmp/swap" || exit 1
/bin/chmod 700 "$1/tmp/swap" >/dev/null 2>&1
outer=$?
/bin/chmod 700 "$1/tmp/swap/child" >/dev/null 2>&1
inner=$?
printf inside > "$1/inside"
[ "$outer" -ne 0 ] && [ "$inner" -ne 0 ]
`;
      args.push(outside);
      const result = spawnSync(args[0], args.slice(1), {
        env: { PATH: '/usr/bin:/bin' },
        encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(runtime, 'inside'), 'utf8')).toBe('inside');
      expect(statSync(outside).mode & 0o777).toBe(0o755);
      expect(statSync(child).mode & 0o777).toBe(0o750);
    } finally {
      await releaseWorkerSandbox(root);
      rmSync(fixture, { recursive: true, force: true });
    }
  }
);

test.skipIf(process.platform === 'win32')(
  'missing cleanup enforcement rejects while retaining the runtime',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-missing-cleanup-'));
    mkdirSync(join(root, '.git'));
    const env = await prepareWorkerSandbox(root);
    beforeLaunch.mockImplementation((args) => {
      args[0] = join(root, 'missing-executable');
    });
    try {
      await expect(releaseWorkerSandbox(root)).rejects.toThrow('missing-executable');
      expect(existsSync(env.TMPDIR)).toBe(true);
      expect(existsSync(env.XDG_CACHE_HOME)).toBe(true);
    } finally {
      beforeLaunch.mockReset();
      await releaseWorkerSandbox(root);
      rmSync(root, { recursive: true, force: true });
    }
  }
);

test.skipIf(process.platform === 'win32').each(['file', 'symlink'])(
  'cleanup unlinks an unusable runtime %s without traversing its target',
  async (kind) => {
    const fixture = mkdtempSync(join(tmpdir(), 'worker-runtime-entry-'));
    const root = join(fixture, 'clone');
    mkdirSync(join(root, '.git'), { recursive: true });
    const env = await prepareWorkerSandbox(root);
    const runtime = join(env.TMPDIR, '..');
    const outside = join(fixture, 'outside');
    mkdirSync(outside, { mode: 0o755 });
    writeFileSync(join(outside, 'retained'), 'human bytes');
    rmSync(runtime, { recursive: true, force: true });
    if (kind === 'file') writeFileSync(runtime, 'unusable runtime');
    else symlinkSync(outside, runtime, 'dir');
    try {
      await releaseWorkerSandbox(root);
      expect(existsSync(runtime)).toBe(false);
      expect(readFileSync(join(outside, 'retained'), 'utf8')).toBe('human bytes');
      expect(statSync(outside).mode & 0o777).toBe(0o755);
    } finally {
      await releaseWorkerSandbox(root);
      rmSync(fixture, { recursive: true, force: true });
    }
  }
);

test.skipIf(process.platform === 'win32').each([1, 8192])(
  'cleanup failure preserves bounded stderr and exit status (%s output chunks)',
  async (chunks) => {
    const root = mkdtempSync(join(tmpdir(), 'worker-cleanup-diagnostic-'));
    mkdirSync(join(root, '.git'));
    const env = await prepareWorkerSandbox(root);
    beforeLaunch.mockImplementation((args) => {
      args[args.indexOf('/bin/sh') + 2] = `printf 'synthetic cleanup mount diagnostic:' >&2
      i=0; while [ "$i" -lt ${chunks} ]; do printf '0123456789abcdef' >&2; i=$((i+1)); done
      printf 'diagnostic-end' >&2; exit 23`;
    });
    try {
      const failure = await releaseWorkerSandbox(root).catch((error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain('synthetic cleanup mount diagnostic:');
      expect(failure.message).toContain('23');
      expect(failure.message.length).toBeLessThan(4600);
      if (chunks === 8192) expect(failure.message).not.toContain('diagnostic-end');
      expect(existsSync(env.TMPDIR)).toBe(true);
      expect(existsSync(env.XDG_CACHE_HOME)).toBe(true);
    } finally {
      beforeLaunch.mockReset();
      await releaseWorkerSandbox(root);
      rmSync(root, { recursive: true, force: true });
    }
  }
);
