import { afterEach, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, type Stats } from 'node:fs';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  prepareWorkerSandbox,
  workerSandboxPaths,
} from '../../../../src/lib/drivers/worker-sandbox';

var realLstat: typeof lstat | undefined;
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  realLstat = actual.lstat;
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const uid = Object.getOwnPropertyDescriptor(process, 'getuid')!;
let root: string;
let dataDir: string;
afterEach(async () => {
  rmSync(dataDir, { recursive: true, force: true });
  Object.defineProperty(process, 'platform', platform);
  if (uid) Object.defineProperty(process, 'getuid', uid);
  else Reflect.deleteProperty(process, 'getuid');
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function fixture(target: string, sharedModes = true) {
  root = mkdtempSync(join(tmpdir(), 'worker-portability-'));
  mkdirSync(join(root, '.git'));
  dataDir = mkdtempSync(join(tmpdir(), 'worker-data-'));
  vi.stubEnv('HYPERNEO_DATA_DIR', dataDir);
  Object.defineProperty(process, 'platform', { value: target, configurable: true });
  Object.defineProperty(process, 'getuid', {
    value: target === 'win32' ? undefined : () => 501,
    configurable: true,
  });
  if (sharedModes)
    vi.mocked(lstat).mockResolvedValue({
      mode: 0o40777,
      uid: 501,
      isDirectory: () => true,
    } as Stats);
  else vi.mocked(lstat).mockImplementation((path) => realLstat!(path));
  return dataDir;
}

test('worker output locations are derived from the data root', async () => {
  const data = fixture('darwin', false);
  const env = workerSandboxPaths(root) as Record<string, string>;
  expect(env.HYPERNEO_WORKTREES).toBe(join(data, 'worktrees'));
  expect(env.HYPERNEO_EVIDENCE.startsWith(join(data, 'work', 'evidence'))).toBe(true);
  expect(env.HYPERNEO_BUILDS.startsWith(join(data, 'work', 'builds'))).toBe(true);
  expect(env.TMPDIR.startsWith(join(data, 'work', 'scratch'))).toBe(true);
  expect(env.TMP).toBe(env.TMPDIR);
  expect(env.TEMP).toBe(env.TMPDIR);
  expect(env.CLAUDE_CODE_TMPDIR).toBe(env.TMPDIR);
  expect(env.XDG_CACHE_HOME.startsWith(env.TMPDIR)).toBe(true);
  const sibling = workerSandboxPaths(`${root}-sibling`) as Record<string, string>;
  expect(sibling.TMPDIR).not.toBe(env.TMPDIR);
  expect(sibling.HYPERNEO_EVIDENCE).not.toBe(env.HYPERNEO_EVIDENCE);
  expect(sibling.HYPERNEO_BUILDS).not.toBe(env.HYPERNEO_BUILDS);
  expect(sibling.HYPERNEO_WORKTREES).toBe(env.HYPERNEO_WORKTREES);
});

test('runtime preparation creates every work location on demand', async () => {
  fixture('darwin', false);
  const env = (await prepareWorkerSandbox(root)) as Record<string, string>;
  for (const path of [
    env.HYPERNEO_WORKTREES,
    env.HYPERNEO_EVIDENCE,
    env.HYPERNEO_BUILDS,
    env.TMPDIR,
    env.XDG_CACHE_HOME,
  ]) {
    expect(existsSync(path)).toBe(true);
  }
  await writeFile(join(env.TMPDIR, 'probe'), 'synthetic');
  expect(await readFile(join(env.TMPDIR, 'probe'), 'utf8')).toBe('synthetic');
});

test('Windows workers accept synthesized NTFS modes under the data root', async () => {
  const data = fixture('win32');
  const paths = workerSandboxPaths(root) as Record<string, string>;
  expect(paths.TMPDIR.startsWith(join(data, 'work', 'scratch'))).toBe(true);
  const env = (await prepareWorkerSandbox(root)) as Record<string, string>;
  await writeFile(join(env.TMPDIR, 'probe'), 'synthetic');
  expect(await readFile(join(env.TMPDIR, 'probe'), 'utf8')).toBe('synthetic');
});

test('Windows runtime preparation does not reject synthesized group and other bits', async () => {
  fixture('win32');
  await expect(prepareWorkerSandbox(root)).resolves.toHaveProperty('TMPDIR');
});

test('POSIX workers still refuse shared directory modes', async () => {
  fixture('linux');
  await expect(prepareWorkerSandbox(root)).rejects.toThrow('owned private directories');
});
