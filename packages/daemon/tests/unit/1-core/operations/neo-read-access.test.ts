import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { neoReadAccess, neoReadCheckoutPaths } from '../../../../src/lib/neo/read-access.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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

test('only the dedicated token reaches gh and a store failure is not swallowed', async () => {
  const access = await neoReadAccess(
    'synthetic-token',
    '/synthetic/Neo',
    async () => 'synthetic-readonly'
  );
  roots.push(access.env.TMPDIR);
  expect(access.env.GH_TOKEN).toBe('synthetic-readonly');
  await expect(
    neoReadAccess('synthetic-token', '/synthetic/Neo', async () => {
      throw new Error('Synthetic store unavailable');
    })
  ).rejects.toThrow('Synthetic store unavailable');
});
