import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPushedWorkerRepo } from '../../../helpers/native-worker-worktree';
import {
  cleanupOwnedWorktree,
  planWorkPlacement,
} from '../../../../src/lib/drivers/work-placement';

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
