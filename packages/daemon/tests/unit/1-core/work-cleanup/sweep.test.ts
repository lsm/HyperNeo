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
  test.each(['initial', 'fresh', 'release'])(
    'a folder %s failure is kept as error without losing the digest',
    async (phase) => {
      let reads = 0;
      let told = 0;
      const digest = await sweepWorkCleanup({
        list: async () => ['/work/bad', '/work/good'],
        read: async (folder) => {
          if (
            folder === '/work/bad' &&
            ++reads === (phase === 'initial' ? 1 : 2) &&
            phase !== 'release'
          )
            throw new Error('Unreadable folder');
          return done;
        },
        release: async (folder) => {
          if (folder === '/work/bad') throw new Error('Archive failed');
          return true;
        },
        tell: async () => {
          told++;
        },
      });
      expect(digest.kept.error).toEqual(['/work/bad']);
      expect(digest.removed).toEqual([{ directory: '/work/good', reason: 'todo done' }]);
      expect(told).toBe(1);
    }
  );

  test('the first planning pass checks at most four folders at a time', async () => {
    let active = 0;
    let peak = 0;
    let reads = 0;
    await sweepWorkCleanup({
      list: async () => Array.from({ length: 12 }, (_, index) => `/work/${index}`),
      read: async () => {
        reads++;
        peak = Math.max(peak, ++active);
        await new Promise<void>((done) => setImmediate(done));
        active--;
        return { ...done, owner: null };
      },
      release: async () => {
        throw new Error('Unknown owners must stay');
      },
      tell: async () => {},
    });
    expect(reads).toBe(12);
    expect(peak).toBeLessThanOrEqual(4);
  });

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
      release: async () => ({ keep: 'live' }),
      tell: async () => {},
    });
    expect(digest.removed).toEqual([]);
    expect(digest.kept).toEqual({ live: ['/work/worker'] });
  });

  test('the digest preserves the archive refusal instead of reporting a live owner', async () => {
    const digest = await sweepWorkCleanup({
      list: async () => ['/work/worker'],
      read: async () => done,
      release: async () => ({ keep: 'Unpublished branch; kept.' }),
      tell: async () => {},
    });
    expect(digest.kept).toEqual({ 'Unpublished branch; kept.': ['/work/worker'] });
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
