import { describe, expect, test } from 'bun:test';
import {
  neoWorkBranch,
  readGithubBranchPrs,
} from '../../../../src/lib/neo/packs/coding/branch-prs.ts';

const worktree = {
  isWorktree: true as const,
  worktreePath: '/repo/.worktrees/fix',
  mainRepoPath: '/repo',
  branch: 'neo/fix-5546',
};

describe('neoWorkBranch', () => {
  test("takes the card session's worktree branch, and nothing for a session in its main checkout", () => {
    expect(neoWorkBranch({ worktree })).toEqual({
      branch: 'neo/fix-5546',
      cwd: '/repo/.worktrees/fix',
    });
    expect(neoWorkBranch({})).toBe(null);
    expect(neoWorkBranch(null)).toBe(null);
  });
});

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
    expect(calls[0].args.slice(0, 5)).toEqual(['gh', 'pr', 'list', '--head', 'neo/fix-5546']);
  });
});
