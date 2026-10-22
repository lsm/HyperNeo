import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import {
  KeychainCredentialStore,
  KeychainUnavailableError,
} from '../../../../src/lib/credentials/credential-store.ts';
import { neoReadAccess, neoReadCheckoutPaths } from '../../../../src/lib/neo/read-access.ts';

const { runtimePlatform } = vi.hoisted(() => ({ runtimePlatform: vi.fn(() => process.platform) }));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  platform: runtimePlatform,
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  runtimePlatform.mockReturnValue(process.platform);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('a locked dedicated keychain leaves Neo usable and gh visibly unauthenticated', async () => {
  runtimePlatform.mockReturnValue('darwin');
  vi.stubEnv('NODE_ENV', 'production');
  vi.spyOn(KeychainCredentialStore.prototype, 'get').mockRejectedValue(
    new KeychainUnavailableError('Synthetic keychain locked')
  );
  const access = await neoReadAccess('synthetic-locked-token', '/synthetic/Neo');
  roots.push(access.env.TMPDIR);
  expect(access.env.GH_TOKEN).toBe('');
  expect(access.env.GITHUB_TOKEN).toBe('');
});

test('only exact existing Neo checkout leaves become writable, never worker siblings', () => {
  const data = mkdtempSync(join(tmpdir(), 'neo-read-access-'));
  roots.push(data);
  const leaf = join(data, 'worktrees', 'lsm', 'hyperneo', 'neo-read');
  mkdirSync(leaf, { recursive: true });
  mkdirSync(join(data, 'worktrees', 'lsm', 'hyperneo', 'worker-id'));
  mkdirSync(join(data, 'worktrees', 'lsm', 'another', 'worker-id'), { recursive: true });
  expect(neoReadCheckoutPaths(data)).toEqual([leaf]);
});

test('a missing dedicated token leaves gh unauthenticated without inherited-token fallback', async () => {
  const access = await neoReadAccess('synthetic-missing-token', '/synthetic/Neo', async () => null);
  roots.push(access.env.TMPDIR);
  expect(access.env).toMatchObject({
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    GH_ENTERPRISE_TOKEN: '',
    GITHUB_ENTERPRISE_TOKEN: '',
    GH_CONFIG_DIR: join(access.env.TMPDIR, 'gh'),
    ZDOTDIR: access.env.TMPDIR,
    BASH_ENV: '/dev/null',
    ENV: '/dev/null',
    GH_PROMPT_DISABLED: '1',
  });
  expect(access.filesystem.denyWrite).toEqual(['/synthetic/Neo']);
});

test('only the dedicated token reaches gh and unavailable stores stay unauthenticated', async () => {
  const access = await neoReadAccess(
    'synthetic-token',
    '/synthetic/Neo',
    async () => 'synthetic-readonly'
  );
  roots.push(access.env.TMPDIR);
  expect(access.env.GH_TOKEN).toBe('synthetic-readonly');
  const unavailable = await neoReadAccess('synthetic-token', '/synthetic/Neo', async () => {
    throw new Error('Synthetic store unavailable');
  });
  expect(unavailable.env.GH_TOKEN).toBe('');
});

test.each(['linux', 'win32'] as const)(
  '%s does not attempt macOS Keychain access',
  async (host) => {
    runtimePlatform.mockReturnValue(host);
    vi.stubEnv('NODE_ENV', 'production');
    const get = vi.spyOn(KeychainCredentialStore.prototype, 'get');
    const access = await neoReadAccess(`synthetic-${host}`, '/synthetic/Neo');
    roots.push(access.env.TMPDIR);
    expect(access.env.GH_TOKEN).toBe('');
    expect(get).not.toHaveBeenCalled();
  }
);

test('unrelated owner and repo directory names never prevent safe checkout enumeration', () => {
  const data = mkdtempSync(join(tmpdir(), 'neo-read-names-'));
  roots.push(data);
  const leaf = join(data, 'worktrees/lsm/hyperneo/neo-read');
  for (const path of [
    leaf,
    join(data, 'worktrees/owner with space/repo/neo-read'),
    join(data, 'worktrees/lsm/@unrelated/neo-read'),
  ])
    mkdirSync(path, { recursive: true });
  expect(neoReadCheckoutPaths(data)).toEqual([leaf]);
});

test('a checkout owner removed during enumeration is skipped without wider grants', () => {
  const data = mkdtempSync(join(tmpdir(), 'neo-read-vanished-'));
  roots.push(data);
  const owner = join(data, 'worktrees/lsm');
  mkdirSync(join(owner, 'hyperneo/neo-read'), { recursive: true });
  const read = fs.readdirSync;
  vi.spyOn(fs, 'readdirSync').mockImplementationOnce(((
    ...args: Parameters<typeof fs.readdirSync>
  ) => {
    const entries = read(...args);
    rmSync(owner, { recursive: true });
    return entries;
  }) as typeof fs.readdirSync);
  expect(neoReadCheckoutPaths(data)).toEqual([]);
});
