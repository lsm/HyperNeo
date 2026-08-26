import { describe, expect, test } from 'bun:test';
import {
  runWorktreeLfsHydration,
  type WorktreeLfsHydrationDeps,
} from '../../../src/lib/worktree-lfs-hydration';

function makeDeps(overrides: Partial<WorktreeLfsHydrationDeps> = {}): WorktreeLfsHydrationDeps {
  return {
    listLfsTrackedFiles: async () => 'asset.bin\n',
    listAttrLfsPaths: async () => '',
    indexHasLfsPointer: async () => false,
    pullLfsObjects: async () => {},
    ...overrides,
  };
}

describe('runWorktreeLfsHydration', () => {
  test('pulls when the LFS listing reports tracked files', async () => {
    let pulled = false;
    const outcome = await runWorktreeLfsHydration(
      makeDeps({
        pullLfsObjects: async () => {
          pulled = true;
        },
      })
    );
    expect(outcome).toEqual({ action: 'pulled' });
    expect(pulled).toBe(true);
  });

  test('reports clean when no tracked files exist', async () => {
    let pulled = false;
    const outcome = await runWorktreeLfsHydration(
      makeDeps({
        listLfsTrackedFiles: async () => '',
        pullLfsObjects: async () => {
          pulled = true;
        },
      })
    );
    expect(outcome).toEqual({ action: 'clean' });
    expect(pulled).toBe(false);
  });

  test('fails fail-closed when the probe errors in an LFS-declaring worktree', async () => {
    let attrProbed = false;
    const outcome = await runWorktreeLfsHydration(
      makeDeps({
        listLfsTrackedFiles: async () => {
          throw new Error('git: "lfs" is not a git command');
        },
        listAttrLfsPaths: async () => {
          attrProbed = true;
          return 'asset.bin\0';
        },
        pullLfsObjects: async () => {
          throw new Error('pull must not run');
        },
      })
    );
    expect(outcome.action).toBe('failed');
    expect(attrProbed).toBe(true);
    if (outcome.action === 'failed') {
      expect(outcome.cause).toContain('"lfs" is not a git command');
    }
  });

  test('skips quietly when the probe errors without declared attributes', async () => {
    const outcome = await runWorktreeLfsHydration(
      makeDeps({
        listLfsTrackedFiles: async () => {
          throw new Error('git: "lfs" is not a git command');
        },
        listAttrLfsPaths: async () => '',
        indexHasLfsPointer: async () => false,
      })
    );
    expect(outcome.action).toBe('skipped');
  });

  test('propagates pull failures', async () => {
    await expect(
      runWorktreeLfsHydration(
        makeDeps({
          pullLfsObjects: async () => {
            throw new Error('lfs pull network failure');
          },
        })
      )
    ).rejects.toThrow('lfs pull network failure');
  });
});
