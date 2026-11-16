import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPushedWorkerRepo } from '../../../helpers/native-worker-worktree';
import {
  cleanupOwnedWorktree,
  planWorkPlacement,
  procFolderInUse,
} from '../../../../src/lib/drivers/work-placement';
import { workerWorkLocations } from '../../../../src/lib/work-locations';

const runs: string[] = [];
afterEach(() => {
  for (const run of runs.splice(0)) rmSync(run, { recursive: true, force: true });
});

describe('planWorkPlacement', () => {
  test.each([
    ['a plain folder runs in place', null, { kind: 'in_place' }],
    ['a linked worktree runs in place', { repo: '/r', linked: true }, { kind: 'in_place' }],
    [
      'a main checkout gets its own worktree',
      { repo: '/r', linked: false },
      { kind: 'worktree', repo: '/r' },
    ],
  ] as const)('%s', (_label, checkout, expected) => {
    expect(planWorkPlacement(checkout)).toEqual(expected);
  });
});

describe('submodule archive retention', () => {
  test.each(['clean', 'dirty', 'diverged', 'nested-dirty'])(
    'retains a worktree and its submodule data when the superproject looks clean: %s',
    async (state) => {
      const run = realpathSync(mkdtempSync(join(tmpdir(), 'worker-submodules-')));
      runs.push(run);
      const parent = createPushedWorkerRepo(run);
      mkdirSync(join(run, 'child'));
      const child = createPushedWorkerRepo(join(run, 'child'));
      if (state === 'nested-dirty') {
        mkdirSync(join(run, 'nested'));
        const nested = createPushedWorkerRepo(join(run, 'nested'));
        child.git(
          '-c',
          'protocol.file.allow=always',
          'submodule',
          'add',
          '-b',
          'dev',
          nested.origin,
          'nested'
        );
        child.git('commit', '-am', 'register nested module');
        child.git('push', 'origin', 'dev');
      }
      parent.git(
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '-b',
        'dev',
        child.origin,
        'component'
      );
      parent.git('commit', '-am', 'register component');
      parent.git('push', 'origin', 'dev');
      const workers = join(run, 'workers'),
        folder = join(workers, 'worker');
      parent.git('worktree', 'add', '--detach', folder, 'HEAD');
      parent.git(
        '-C',
        folder,
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'update',
        '--init',
        '--recursive'
      );
      parent.git('-C', folder, 'config', 'submodule.component.ignore', 'all');
      const component = join(folder, 'component');
      const dirtyFile =
        state === 'nested-dirty'
          ? join(component, 'nested', 'preserve.txt')
          : join(component, 'preserve.txt');
      if (state === 'nested-dirty')
        parent.git('-C', component, 'config', 'submodule.nested.ignore', 'all');
      if (state === 'dirty' || state === 'nested-dirty')
        writeFileSync(dirtyFile, 'local submodule work');
      if (state === 'diverged')
        parent.git('-C', component, 'commit', '--allow-empty', '-m', 'local-only submodule commit');
      expect(parent.git('-C', folder, 'status', '--porcelain')).toBe('');
      expect(parent.git('rev-list', '--count', 'HEAD', '--not', '--remotes=origin')).toBe('0');
      const retained = await cleanupOwnedWorktree(folder, [workers]);
      expect(retained).toMatchObject({ directory: folder, removed: false });
      expect(existsSync(folder)).toBe(true);
      expect(parent.git('worktree', 'list', '--porcelain')).toContain(folder);
      if (state === 'dirty' || state === 'nested-dirty')
        expect(readFileSync(dirtyFile, 'utf8')).toBe('local submodule work');
      if (state === 'diverged')
        expect(parent.git('-C', component, 'log', '-1', '--format=%s')).toBe(
          'local-only submodule commit'
        );
    }
  );
});

describe('archive removes the worker work folders', () => {
  const priorDataDir = process.env.HYPERNEO_DATA_DIR;
  afterEach(() => {
    process.env.HYPERNEO_DATA_DIR = priorDataDir;
  });

  function setup(label: string) {
    const run = realpathSync(mkdtempSync(join(tmpdir(), `worker-folders-${label}-`)));
    runs.push(run);
    process.env.HYPERNEO_DATA_DIR = join(run, 'data');
    const parent = createPushedWorkerRepo(run);
    const workers = join(run, 'workers');
    const folder = join(workers, 'worker');
    const sibling = join(workers, 'sibling');
    parent.git('worktree', 'add', '--detach', folder, 'HEAD');
    for (const root of [folder, sibling]) {
      const places = workerWorkLocations(root);
      for (const place of [places.builds, places.scratch, places.ghConfig, places.evidence]) {
        mkdirSync(place, { recursive: true });
        writeFileSync(join(place, 'synthetic'), 'synthetic');
      }
    }
    return { run, parent, workers, folder, places: workerWorkLocations(folder), sibling };
  }

  test('a removed worktree takes its builds, scratch and gh-config folders with it', async () => {
    const { workers, folder, places, sibling } = setup('removed');
    expect(await cleanupOwnedWorktree(folder, [workers])).toEqual({
      directory: folder,
      removed: true,
    });
    expect(existsSync(places.builds)).toBe(false);
    expect(existsSync(places.scratch)).toBe(false);
    expect(existsSync(places.ghConfig)).toBe(false);
    expect(readFileSync(join(places.evidence, 'synthetic'), 'utf8')).toBe('synthetic');
    const others = workerWorkLocations(sibling);
    for (const place of [others.builds, others.scratch, others.ghConfig, others.evidence])
      expect(readFileSync(join(place, 'synthetic'), 'utf8')).toBe('synthetic');
    expect(await cleanupOwnedWorktree(folder, [workers])).toEqual({
      directory: folder,
      removed: true,
    });
  });

  test('a retained worktree keeps its work folders', async () => {
    const { workers, folder, places } = setup('retained');
    writeFileSync(join(folder, 'unsaved'), 'local work');
    expect(await cleanupOwnedWorktree(folder, [workers])).toMatchObject({
      directory: folder,
      removed: false,
    });
    for (const place of [places.builds, places.scratch, places.ghConfig])
      expect(readFileSync(join(place, 'synthetic'), 'utf8')).toBe('synthetic');
  });

  test('a linked work folder is unlinked without touching its target', async () => {
    const { run, workers, folder, places } = setup('linked');
    const outside = join(run, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'kept'), 'kept');
    rmSync(places.builds, { recursive: true, force: true });
    symlinkSync(outside, places.builds);
    expect(await cleanupOwnedWorktree(folder, [workers])).toMatchObject({ removed: true });
    expect(existsSync(places.builds)).toBe(false);
    expect(readFileSync(join(outside, 'kept'), 'utf8')).toBe('kept');
  });

  test('a linked parent folder never leads cleanup into evidence', async () => {
    const { workers, folder, places } = setup('parent-linked');
    const buildsParent = dirname(places.builds);
    rmSync(buildsParent, { recursive: true, force: true });
    symlinkSync(dirname(places.evidence), buildsParent);
    expect(await cleanupOwnedWorktree(folder, [workers])).toMatchObject({ removed: true });
    expect(readFileSync(join(places.evidence, 'synthetic'), 'utf8')).toBe('synthetic');
    expect(existsSync(places.scratch)).toBe(false);
    expect(existsSync(places.ghConfig)).toBe(false);
  });
});

describe('procFolderInUse', () => {
  const uid = process.getuid?.() ?? 0;
  const failure = (code: string) => Object.assign(new Error(code), { code });
  const proc = (pids: Record<string, { uid?: number; cwd: string | Error }>) => ({
    readdir: async () => ['self', ...Object.keys(pids)],
    stat: async (path: string) => ({ uid: pids[path.split('/')[2]]?.uid ?? uid }),
    readlink: async (path: string) => {
      const cwd = pids[path.split('/')[2]]?.cwd;
      if (cwd instanceof Error || cwd === undefined) throw cwd ?? failure('ENOENT');
      return cwd;
    },
  });

  test('finds an own process whose working folder is inside', async () => {
    expect(await procFolderInUse('/w', proc({ '1': { cwd: '/w/sub' } }))).toBe(true);
    expect(await procFolderInUse('/w', proc({ '1': { cwd: '/wx' } }))).toBe(false);
  });

  test('keeps the folder when an own process cwd cannot be read', async () => {
    for (const code of ['EACCES', 'EPERM', 'EIO'])
      expect(await procFolderInUse('/w', proc({ '1': { cwd: failure(code) } }))).toBe(true);
  });

  test('ignores only a process that is gone', async () => {
    for (const code of ['ENOENT', 'ESRCH'])
      expect(await procFolderInUse('/w', proc({ '1': { cwd: failure(code) } }))).toBe(false);
  });

  test('skips processes of other users', async () => {
    expect(
      await procFolderInUse('/w', proc({ '1': { uid: uid + 1, cwd: failure('EACCES') } }))
    ).toBe(false);
  });
});
