import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPushedWorkerRepo } from '../../../helpers/native-worker-worktree';
import { cleanupOwnedWorktree } from '../../../../src/lib/drivers/work-placement';

const runs: string[] = [];
afterEach(() => {
  for (const run of runs.splice(0)) rmSync(run, { recursive: true, force: true });
});

function ownedClone() {
  const run = realpathSync(mkdtempSync(join(tmpdir(), 'owned-clone-')));
  runs.push(run);
  const source = createPushedWorkerRepo(run);
  const workers = join(run, 'workers');
  mkdirSync(workers);
  const folder = join(workers, 'worker');
  source.git('clone', '--quiet', source.repo, folder);
  writeFileSync(join(folder, '.git', 'hyperneo-source-checkout'), source.repo);
  const clone = (...args: string[]) => source.git('-C', folder, ...args);
  const cleanup = () => cleanupOwnedWorktree(folder, [workers]);
  return { ...source, run, folder, clone, cleanup };
}

async function expectKept(owned: ReturnType<typeof ownedClone>) {
  expect(await owned.cleanup()).toMatchObject({ directory: owned.folder, removed: false });
  expect(existsSync(owned.folder)).toBe(true);
}

describe('owned clone removal', () => {
  test('removes a clean, published clone with the marker', async () => {
    const owned = ownedClone();
    expect(await owned.cleanup()).toEqual({ directory: owned.folder, removed: true });
    expect(existsSync(owned.folder)).toBe(false);
  });

  test('keeps a clone with an untracked file', async () => {
    const owned = ownedClone();
    writeFileSync(join(owned.folder, 'notes.txt'), 'local work');
    await expectKept(owned);
  });

  test('keeps a clone with a stash', async () => {
    const owned = ownedClone();
    writeFileSync(join(owned.folder, 'stashed.txt'), 'local work');
    owned.clone('add', 'stashed.txt');
    owned.clone('stash', '--quiet');
    expect(owned.clone('status', '--porcelain')).toBe('');
    await expectKept(owned);
  });

  test('keeps a clone with a second worktree', async () => {
    const owned = ownedClone();
    owned.clone('worktree', 'add', '--quiet', '--detach', join(owned.run, 'second'), 'HEAD');
    await expectKept(owned);
  });

  test('keeps a clone with an unpublished local branch while HEAD is published', async () => {
    const owned = ownedClone();
    owned.clone('switch', '--quiet', '-c', 'side');
    owned.clone('commit', '--allow-empty', '-m', 'local only');
    owned.clone('switch', '--quiet', 'dev');
    await expectKept(owned);
  });

  test('keeps a clone whose remote now points at a mirror that has the commit', async () => {
    const owned = ownedClone();
    const mirror = join(owned.run, 'mirror.git');
    owned.git('init', '--quiet', '--bare', mirror);
    owned.clone('commit', '--allow-empty', '-m', 'only on the mirror');
    owned.clone('remote', 'set-url', 'origin', mirror);
    owned.clone('push', '--quiet', 'origin', 'dev');
    await expectKept(owned);
  });

  test('keeps a clone whose branch was deleted upstream since an earlier check', async () => {
    const owned = ownedClone();
    owned.clone('switch', '--quiet', '-c', 'feature');
    owned.clone('commit', '--allow-empty', '-m', 'feature work');
    owned.clone('push', '--quiet', owned.origin, 'feature');
    owned.clone('switch', '--quiet', 'dev');
    writeFileSync(join(owned.folder, 'notes.txt'), 'local work');
    await expectKept(owned);
    rmSync(join(owned.folder, 'notes.txt'));
    owned.git('push', '--quiet', owned.origin, '--delete', 'feature');
    await expectKept(owned);
    expect(owned.clone('log', '-1', '--format=%s', 'feature')).toBe('feature work');
  });

  test('keeps a clone when the fetch from the canonical origin fails', async () => {
    const owned = ownedClone();
    owned.git('remote', 'set-url', 'origin', join(owned.run, 'missing.git'));
    await expectKept(owned);
  });

  test('keeps a non-linked folder without the marker', async () => {
    const owned = ownedClone();
    rmSync(join(owned.folder, '.git', 'hyperneo-source-checkout'));
    expect(await owned.cleanup()).toEqual({
      directory: owned.folder,
      removed: false,
      reason: 'The folder is not a linked worker worktree; kept.',
    });
    expect(existsSync(owned.folder)).toBe(true);
  });
});
