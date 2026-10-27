import { afterEach, expect, test } from 'bun:test';
import { vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  type Stats,
} from 'node:fs';
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
  vi.stubEnv('HOME', join(dataDir, 'home'));
  Object.defineProperty(process, 'platform', { value: target, configurable: true });
  if (sharedModes) {
    Object.defineProperty(process, 'getuid', {
      value: target === 'win32' ? undefined : () => 501,
      configurable: true,
    });
    vi.mocked(lstat).mockResolvedValue({
      mode: 0o40777,
      uid: 501,
      isDirectory: () => true,
    } as Stats);
  } else {
    if (uid) Object.defineProperty(process, 'getuid', uid);
    else Reflect.deleteProperty(process, 'getuid');
    vi.mocked(lstat).mockImplementation((path) => realLstat!(path));
  }
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

test('worker gh configuration preserves public settings without copying host credentials', async () => {
  fixture('darwin', false);
  const home = join(dataDir, 'synthetic-home');
  vi.stubEnv('HOME', home);
  mkdirSync(join(home, '.config/gh'), { recursive: true });
  await writeFile(join(home, '.config/gh/config.yml'), 'git_protocol: ssh\n');
  await writeFile(
    join(home, '.config/gh/hosts.yml'),
    'github.com:\n  oauth_token: synthetic-only\n'
  );
  const env = await prepareWorkerSandbox(root);
  expect(env.GH_CONFIG_DIR).toBeTruthy();
  expect(await readFile(join(env.GH_CONFIG_DIR, 'config.yml'), 'utf8')).toBe('git_protocol: ssh\n');
  expect(existsSync(join(env.GH_CONFIG_DIR, 'hosts.yml'))).toBe(false);
  await prepareWorkerSandbox(root);
  expect(await readFile(join(env.GH_CONFIG_DIR, 'config.yml'), 'utf8')).toBe('git_protocol: ssh\n');
});

test('runtime preparation tolerates shared work locations with ordinary modes', async () => {
  const data = fixture('darwin', false);
  const shared = join(data, 'worktrees', 'acme', 'demo');
  mkdirSync(shared, { recursive: true });
  chmodSync(shared, 0o755);
  const env = (await prepareWorkerSandbox(root)) as Record<string, string>;
  expect(env.HYPERNEO_WORKTREES).toBe(join(data, 'worktrees'));
  expect(env.TMPDIR.startsWith(join(data, 'work', 'scratch'))).toBe(true);
});

test('repairs existing owned scratch and cache modes without losing their contents', async () => {
  fixture('darwin', false);
  const paths = workerSandboxPaths(root);
  for (const path of [paths.TMPDIR, paths.XDG_CACHE_HOME]) {
    mkdirSync(path, { recursive: true, mode: 0o755 });
    chmodSync(path, 0o755);
    await writeFile(join(path, 'retained'), 'worker bytes');
  }
  await prepareWorkerSandbox(root);
  for (const path of [paths.TMPDIR, paths.XDG_CACHE_HOME]) {
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(await readFile(join(path, 'retained'), 'utf8')).toBe('worker bytes');
  }
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

test('POSIX workers still refuse directories owned by another user', async () => {
  fixture('linux');
  vi.mocked(lstat).mockResolvedValue({ uid: 502, isDirectory: () => true } as Stats);
  await expect(prepareWorkerSandbox(root)).rejects.toThrow('owned private directories');
});
