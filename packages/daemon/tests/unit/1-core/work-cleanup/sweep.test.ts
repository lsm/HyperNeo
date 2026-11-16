import { describe, expect, test } from 'bun:test';
import {
  listWorkCleanupFolders,
  sweepWorkCleanup,
} from '../../../../src/lib/work-cleanup/sweep.ts';

const done = {
  owner: { kind: 'todo', state: 'done', boundToLiveTodo: false },
  inUse: false,
  unsaved: false,
} as const;

describe('sweepWorkCleanup', () => {
  test('a folder without an owner is retained and included in the digest', async () => {
    const removed: string[] = [];
    const digests: unknown[] = [];
    await sweepWorkCleanup({
      list: async () => ['/work/orphan'],
      read: async () => ({ ...done, owner: null }),
      release: async (folder) => {
        removed.push(folder);
        return true;
      },
      tell: async (digest) => {
        digests.push(digest);
      },
    });
    expect(removed).toEqual([]);
    expect(digests).toEqual([{ removed: [], kept: { unknown: ['/work/orphan'] } }]);
  });

  test('a worker rebound after the initial read keeps its folder', async () => {
    const removed: string[] = [];
    let reads = 0;
    const digest = await sweepWorkCleanup({
      list: async () => ['/work/worker'],
      read: async () =>
        ++reads === 1
          ? done
          : {
              ...done,
              owner: { ...done.owner, boundToLiveTodo: true },
            },
      release: async (folder) => {
        removed.push(folder);
        return true;
      },
      tell: async () => {},
    });
    expect(reads).toBe(2);
    expect(removed).toEqual([]);
    expect(digest.kept).toEqual({ live: ['/work/worker'] });
  });

  test('a release fence lost after the fresh plan retains the worker', async () => {
    const digest = await sweepWorkCleanup({
      list: async () => ['/work/worker'],
      read: async () => done,
      release: async () => false,
      tell: async () => {},
    });
    expect(digest.removed).toEqual([]);
    expect(digest.kept).toEqual({ live: ['/work/worker'] });
  });
});

describe('listWorkCleanupFolders', () => {
  test('human Codex threads and Claude worktrees are never listed', () => {
    expect(
      listWorkCleanupFolders(
        [
          '/codex/worktrees/human/repo',
          '/codex/worktrees/worker/repo',
          '/repo/.claude/worktrees/human',
          '/repo/.claude/worktrees/neo-worker',
          '/data/worktrees/orphan',
        ],
        [{ path: '/codex/worktrees/worker/repo' }, { path: '/repo/.claude/worktrees/neo-worker' }],
        ['/codex/worktrees', '/repo/.claude/worktrees']
      )
    ).toEqual([
      '/codex/worktrees/worker/repo',
      '/repo/.claude/worktrees/neo-worker',
      '/data/worktrees/orphan',
    ]);
  });
});
