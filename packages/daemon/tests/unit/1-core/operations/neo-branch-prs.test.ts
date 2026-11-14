import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnFn } from '../../../../src/lib/runtime-spawn';
import { describe, expect, test } from 'bun:test';
import { readGithubBranchPrs } from '../../../../src/lib/neo/packs/coding/branch-prs.ts';

import type { OperationOutcome } from '../../../../src/lib/operations/invoke.ts';

const worktree = {
  isWorktree: true as const,
  worktreePath: '/repo/.worktrees/fix',
  mainRepoPath: '/repo',
  branch: 'neo/fix-5546',
};

describe('readGithubBranchPrs', () => {
  test('lists pull requests from the branch in its worktree, reusing a fresh read', async () => {
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const spawn = (args: string[], options?: { cwd?: string }) => {
      calls.push({ args, cwd: options?.cwd });
      return {
        stdout: new Response(JSON.stringify([{ url: 'https://github.com/lsm/HyperNeo/pull/6301' }]))
          .body,
        stderr: new Response('').body,
        exited: Promise.resolve(0),
        exitCode: 0,
        kill: () => {},
      };
    };
    const branch = { branch: 'neo/fix-5546', cwd: '/repo/.worktrees/fix' };
    expect(await readGithubBranchPrs(branch, spawn as never)).toEqual([
      'https://github.com/lsm/HyperNeo/pull/6301',
    ]);
    await readGithubBranchPrs(branch, spawn as never);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual([
      'gh',
      'pr',
      'list',
      '--head',
      'neo/fix-5546',
      '--state',
      'all',
      '--json',
      'url',
      '--limit',
      '5',
    ]);
  });
});

describe('readGithubBranchPrs checkout discovery', () => {
  test('uses the worktree HEAD and keys cached results by the resolved branch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding branch '));
    const root = join(dir, 'root');
    const checkout = join(dir, 'execution');
    mkdirSync(root);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe' });
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const spawn: SpawnFn = (args, options) => {
      calls.push({ args, cwd: options?.cwd });
      const branch = args[args.indexOf('--head') + 1];
      return {
        stdout: new Response(
          JSON.stringify([
            { url: `https://github.com/o/r/pull/${branch === 'coding/first' ? 1 : 2}` },
          ])
        ).body,
        stderr: new Response('').body,
        exited: Promise.resolve(0),
        exitCode: 0,
        kill: () => {},
      };
    };
    try {
      git(root, 'init', '-b', 'trunk');
      git(
        root,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'initial'
      );
      git(root, 'worktree', 'add', '-b', 'coding/first', checkout);
      const gitDir = process.env.GIT_DIR;
      try {
        process.env.GIT_DIR = join(root, '.git');
        expect(await readGithubBranchPrs({ cwd: checkout }, spawn)).toEqual([
          'https://github.com/o/r/pull/1',
        ]);
      } finally {
        if (gitDir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = gitDir;
      }
      await readGithubBranchPrs({ cwd: checkout }, spawn);
      expect(calls).toHaveLength(1);
      expect(calls[0].cwd).toBe(checkout);
      expect(calls[0].args).toContain('coding/first');
      git(checkout, 'switch', '-c', 'coding/second');
      expect(await readGithubBranchPrs({ cwd: checkout }, spawn)).toEqual([
        'https://github.com/o/r/pull/2',
      ]);
      expect(calls).toHaveLength(2);
      expect(calls[1].args).toContain('coding/second');
      git(checkout, 'checkout', '--detach', 'HEAD');
      expect(await readGithubBranchPrs({ cwd: checkout }, spawn)).toEqual([]);
      expect(calls).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing, invalid and non-repository locations never reach GitHub', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-no-repo-'));
    let reads = 0;
    const spawn: SpawnFn = () => {
      reads++;
      throw new Error('must not query GitHub');
    };
    try {
      for (const cwd of [dir, join(dir, 'missing'), 'relative', '/invalid\0path']) {
        expect(await readGithubBranchPrs({ cwd }, spawn)).toEqual([]);
      }
      expect(await readGithubBranchPrs({ cwd: dir, branch: '' }, spawn)).toEqual([]);
      expect(reads).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
