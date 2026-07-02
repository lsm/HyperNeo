/**
 * worktree-path-utils unit tests
 *
 * Tests for the shared worktree path resolution utilities used by both
 * WorktreeManager (room sessions) and SpaceWorktreeManager (space task agents).
 */

import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  encodeRepoPath,
  getProjectShortKey,
  getWorktreeBaseDir,
} from '../../../../src/lib/worktree-path-utils';

describe('worktree-path-utils', () => {
  let existsSyncResults: Map<string, boolean>;
  let existsSyncSpy: ReturnType<typeof spyOn>;
  let mkdirSyncSpy: ReturnType<typeof spyOn>;
  let writeFileSyncSpy: ReturnType<typeof spyOn>;
  let readFileSyncSpy: ReturnType<typeof spyOn>;
  let homedirSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    existsSyncResults = new Map();

    existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path) => {
      return existsSyncResults.get(path as string) ?? false;
    });

    mkdirSyncSpy = spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as unknown as string);
    writeFileSyncSpy = spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    readFileSyncSpy = spyOn(fs, 'readFileSync').mockImplementation((): string => '/test/repo');
    homedirSpy = spyOn(os, 'homedir').mockReturnValue('/home/testuser');
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
    mkdirSyncSpy.mockRestore();
    writeFileSyncSpy.mockRestore();
    readFileSyncSpy.mockRestore();
    homedirSpy.mockRestore();
  });

  describe('encodeRepoPath', () => {
    test('encodes absolute Unix paths', () => {
      expect(encodeRepoPath('/Users/alice/project')).toBe('-Users-alice-project');
    });

    test('encodes deep paths', () => {
      expect(encodeRepoPath('/home/john_doe/my_project')).toBe('-home-john_doe-my_project');
    });

    test('handles non-absolute paths', () => {
      expect(encodeRepoPath('relative/path')).toBe('-relative-path');
    });

    test('handles Windows-style paths', () => {
      // Colons (drive letter separator) are preserved, backslashes become dashes
      expect(encodeRepoPath('C:\\Users\\alice\\project')).toBe('-C:-Users-alice-project');
    });
  });

  describe('getProjectShortKey', () => {
    test('produces deterministic output for the same path', () => {
      const path = '/Users/alice/code/my-project';
      expect(getProjectShortKey(path)).toBe(getProjectShortKey(path));
    });

    test('produces short key with 8-char hex suffix', () => {
      const key = getProjectShortKey('/Users/alice/code/my-project');
      expect(key).toMatch(/^my-project-[0-9a-f]{8}$/);
    });

    test('sanitizes special characters in basename', () => {
      const key = getProjectShortKey('/Users/alice/some.weird path/my@project!');
      // `my@project!` → `my-project-` (trailing dash from `!`), then separator `-` → `my-project--hash`
      expect(key).toMatch(/^my-project--[0-9a-f]{8}$/);
    });

    test('different paths produce different keys', () => {
      const key1 = getProjectShortKey('/Users/alice/project-a');
      const key2 = getProjectShortKey('/Users/bob/project-a');
      expect(key1).not.toBe(key2);
    });

    test('produces a valid key even when basename is all special chars', () => {
      const key = getProjectShortKey('/path/...');
      // `...` sanitizes to `---`, then `-` separator + hash8 → `----<hash8>`
      expect(key).toMatch(/^----[0-9a-f]{8}$/);
    });
  });

  describe('getWorktreeBaseDir', () => {
    test('creates project dir and sentinel on first use', () => {
      const repoPath = '/Users/alice/my-app';
      const shortKey = getProjectShortKey(repoPath);

      // Project dir doesn't exist yet
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, false);

      const result = getWorktreeBaseDir(repoPath);

      expect(result).toBe(`/home/testuser/.hyperneo/projects/${shortKey}/worktrees`);
      expect(mkdirSyncSpy).toHaveBeenCalledWith(`/home/testuser/.hyperneo/projects/${shortKey}`, {
        recursive: true,
      });
      expect(writeFileSyncSpy).toHaveBeenCalledWith(
        `/home/testuser/.hyperneo/projects/${shortKey}/.hyperneo-repo-root`,
        repoPath
      );
    });

    test('returns same path when sentinel matches (same repo)', () => {
      const repoPath = '/Users/bob/cool-lib';
      const shortKey = getProjectShortKey(repoPath);

      // Project dir exists
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, true);
      // Sentinel exists and matches
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/.hyperneo-repo-root`,
        true
      );
      readFileSyncSpy.mockImplementation(() => repoPath);

      const result = getWorktreeBaseDir(repoPath);

      expect(result).toBe(`/home/testuser/.hyperneo/projects/${shortKey}/worktrees`);
    });

    test('falls back to encoded path on collision', () => {
      const repoPath = '/Users/carol/projects/app';
      const shortKey = getProjectShortKey(repoPath);
      const otherPath = '/Users/dave/different-repo';

      // Project dir exists
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, true);
      // Sentinel exists
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/.hyperneo-repo-root`,
        true
      );
      // Sentinel contains a DIFFERENT repo path → collision
      readFileSyncSpy.mockImplementation(() => otherPath);

      const collisions: string[] = [];
      const result = getWorktreeBaseDir(repoPath, (msg) => collisions.push(msg));

      const encoded = encodeRepoPath(repoPath);
      expect(result).toBe(`/home/testuser/.hyperneo/projects/${encoded}/worktrees`);
      expect(collisions.length).toBe(1);
      expect(collisions[0]).toContain('collision');
    });

    test('writes sentinel when dir exists but no sentinel (legacy)', () => {
      const repoPath = '/Users/legacy/app';
      const shortKey = getProjectShortKey(repoPath);

      // Project dir exists
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, true);
      // No sentinel file
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/.hyperneo-repo-root`,
        false
      );

      const result = getWorktreeBaseDir(repoPath);

      expect(result).toBe(`/home/testuser/.hyperneo/projects/${shortKey}/worktrees`);
      expect(writeFileSyncSpy).toHaveBeenCalledWith(
        `/home/testuser/.hyperneo/projects/${shortKey}/.hyperneo-repo-root`,
        repoPath
      );
    });

    test('reads legacy .neokai-repo-root sentinel for collision detection', () => {
      const repoPath = '/Users/legacy/collide';
      const shortKey = getProjectShortKey(repoPath);
      const otherPath = '/Users/someone/else-repo';

      // Upgraded project dir exists, new sentinel absent, legacy sentinel present.
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, true);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/.hyperneo-repo-root`,
        false
      );
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/.neokai-repo-root`,
        true
      );
      // Legacy sentinel belongs to a DIFFERENT repo → must collide, not reuse.
      readFileSyncSpy.mockImplementation(() => otherPath);

      const collisions: string[] = [];
      const result = getWorktreeBaseDir(repoPath, (msg) => collisions.push(msg));

      const encoded = encodeRepoPath(repoPath);
      expect(result).toBe(`/home/testuser/.hyperneo/projects/${encoded}/worktrees`);
      expect(collisions.length).toBe(1);
      expect(collisions[0]).toContain('collision');
    });

    test('matches repo via legacy .neokai-repo-root sentinel (no collision)', () => {
      const repoPath = '/Users/legacy/same-repo';
      const shortKey = getProjectShortKey(repoPath);

      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, true);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/.hyperneo-repo-root`,
        false
      );
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/.neokai-repo-root`,
        true
      );
      readFileSyncSpy.mockImplementation(() => repoPath);

      const result = getWorktreeBaseDir(repoPath);

      expect(result).toBe(`/home/testuser/.hyperneo/projects/${shortKey}/worktrees`);
    });

    test('respects TEST_WORKTREE_BASE_DIR env var', () => {
      const repoPath = '/test/repo';
      const shortKey = getProjectShortKey(repoPath);

      process.env.TEST_WORKTREE_BASE_DIR = '/tmp/test-worktrees';
      existsSyncResults.set(`/tmp/test-worktrees/${shortKey}`, false);

      const result = getWorktreeBaseDir(repoPath);

      expect(result).toBe(`/tmp/test-worktrees/${shortKey}/worktrees`);
      delete process.env.TEST_WORKTREE_BASE_DIR;
    });
  });
});
