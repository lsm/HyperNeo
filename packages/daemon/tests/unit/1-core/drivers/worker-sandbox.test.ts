import { afterEach, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, type Stats } from 'node:fs';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  prepareWorkerSandbox,
  releaseWorkerSandbox,
  workerSandboxPaths,
} from '../../../../src/lib/drivers/worker-sandbox';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const uid = Object.getOwnPropertyDescriptor(process, 'getuid')!;
let root: string;
afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(lstat).mockImplementation(actual.lstat);
  await releaseWorkerSandbox(root);
  Object.defineProperty(process, 'platform', platform);
  if (uid) Object.defineProperty(process, 'getuid', uid);
  else Reflect.deleteProperty(process, 'getuid');
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function fixture(target: string) {
  root = mkdtempSync(join(tmpdir(), 'worker-portability-'));
  mkdirSync(join(root, '.git'));
  const temp = join(root, 'system-temp');
  for (const key of ['TMPDIR', 'TEMP', 'TMP']) vi.stubEnv(key, temp);
  Object.defineProperty(process, 'platform', { value: target, configurable: true });
  Object.defineProperty(process, 'getuid', {
    value: target === 'win32' ? undefined : () => 501,
    configurable: true,
  });
  vi.mocked(lstat).mockResolvedValue({ mode: 0o40777, uid: 501, isDirectory: () => true } as Stats);
  return temp;
}

test('Windows workers use the system temp root and accept synthesized NTFS modes', async () => {
  const temp = fixture('win32');
  expect(workerSandboxPaths(root).TMPDIR.startsWith(join(temp, 'hn-'))).toBe(true);
  const env = await prepareWorkerSandbox(root);
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
