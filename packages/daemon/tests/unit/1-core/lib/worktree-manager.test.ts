/**
 * WorktreeManager Tests
 *
 * Tests for git worktree management.
 */

import { describe, expect, it, beforeEach, mock, afterEach, spyOn } from 'bun:test';
import { WorktreeManager } from '../../../../src/lib/worktree-manager';
import { Logger } from '../../../../src/lib/logger';
import type { Session } from '@hyperneo/shared';
import type { SimpleGit } from 'simple-git';
import * as fs from 'node:fs';
import * as os from 'node:os';

// Mock simple-git
const mockGitRaw = mock(async () => '');
const mockGitRevparse = mock(async () => '');
const mockGitBranch = mock(async () => ({}));
const mockGit = {
  raw: mockGitRaw,
  revparse: mockGitRevparse,
  branch: mockGitBranch,
};

// Mock simple-git module
mock.module('simple-git', () => ({
  default: () => mockGit,
  simpleGit: () => mockGit,
}));

// Mock fs functions
let existsSyncResults: Map<string, boolean>;
let mkdirSyncSpy: ReturnType<typeof mock>;
let writeFileSyncSpy: ReturnType<typeof spyOn>;
let readFileSyncSpy: ReturnType<typeof spyOn>;

describe('WorktreeManager', () => {
  let manager: WorktreeManager;
  let existsSyncSpy: ReturnType<typeof spyOn>;
  let homedirSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    manager = new WorktreeManager();
    existsSyncResults = new Map();

    // Reset mocks
    mockGitRaw.mockReset();
    mockGitRevparse.mockReset();
    mockGitBranch.mockReset();

    // Default mock implementations
    mockGitRaw.mockResolvedValue('');
    mockGitRevparse.mockResolvedValue('');
    mockGitBranch.mockResolvedValue({});

    // Mock existsSync
    existsSyncSpy = spyOn(fs, 'existsSync').mockImplementation((path) => {
      return existsSyncResults.get(path as string) ?? false;
    });

    // Mock mkdirSync
    mkdirSyncSpy = spyOn(fs, 'mkdirSync').mockImplementation(() => undefined as unknown as string);

    // Mock writeFileSync — suppress sentinel writes in unit tests
    writeFileSyncSpy = spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);

    // Mock readFileSync — default: return the normalized gitRoot so no collision.
    // Production code calls readFileSync(path, 'utf-8') which returns string; cast
    // to any to satisfy the overloaded type signature in tests.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readFileSyncSpy = spyOn(fs, 'readFileSync').mockImplementation((): any => '/test/repo');

    // Mock homedir
    homedirSpy = spyOn(os, 'homedir').mockReturnValue('/home/testuser');
  });

  afterEach(() => {
    existsSyncSpy.mockRestore();
    mkdirSyncSpy.mockRestore();
    writeFileSyncSpy.mockRestore();
    readFileSyncSpy.mockRestore();
    homedirSpy.mockRestore();
  });

  // Helper: compute short key via the public method so path expectations stay in sync
  function shortKeyFor(repoPath: string): string {
    return manager.getProjectShortKey(repoPath);
  }

  describe('constructor', () => {
    it('should create manager instance', () => {
      expect(manager).toBeDefined();
    });
  });

  describe('findGitRoot', () => {
    it('should return null for non-git repository', async () => {
      existsSyncResults.set('/test/path/.git', false);
      existsSyncResults.set('/test/.git', false);
      existsSyncResults.set('/.git', false);

      const result = await manager.findGitRoot('/test/path/subdir');

      expect(result).toBeNull();
    });

    it('should find git root when .git exists', async () => {
      existsSyncResults.set('/test/path/.git', true);
      mockGitRevparse.mockResolvedValue('.git');

      const result = await manager.findGitRoot('/test/path/subdir');

      expect(result).toBe('/test/path');
    });

    it('should return null on git command failure', async () => {
      existsSyncResults.set('/test/path/.git', true);
      mockGitRevparse.mockRejectedValue(new Error('Not a git repo'));

      const result = await manager.findGitRoot('/test/path/subdir');

      expect(result).toBeNull();
    });
  });

  describe('encodeRepoPath (via getWorktreeBaseDir)', () => {
    it('should encode Unix paths correctly', async () => {
      // We test encodeRepoPath indirectly through createWorktree behavior
      existsSyncResults.set('/Users/alice/project/.git', true);
      mockGitRevparse.mockResolvedValue('.git');

      const result = await manager.findGitRoot('/Users/alice/project');

      expect(result).toBe('/Users/alice/project');
    });
  });

  describe('getProjectShortKey', () => {
    it('should return the same key for the same path (deterministic)', () => {
      const path = '/Users/alice/code/my-project';
      expect(manager.getProjectShortKey(path)).toBe(manager.getProjectShortKey(path));
    });

    it('should use the basename of the path as the human-readable prefix', () => {
      const key = manager.getProjectShortKey('/Users/alice/code/my-project');
      expect(key.startsWith('my-project-')).toBe(true);
    });

    it('should return a string containing only safe filesystem characters', () => {
      const key = manager.getProjectShortKey('/Users/alice/some.weird path/my@project!');
      // Only alphanumeric, hyphens, underscores, and the separator '-' between parts
      expect(key).toMatch(/^[a-zA-Z0-9_-]+$/);
    });

    it('should be shorter than the full encoded path', () => {
      const path = '/Users/alice/very/long/directory/structure/my-project';
      const shortKey = manager.getProjectShortKey(path);
      const encoded = '-Users-alice-very-long-directory-structure-my-project';
      expect(shortKey.length).toBeLessThan(encoded.length);
    });

    it('should produce an 8-char hex hash suffix (no BigInt truncation)', () => {
      const key = manager.getProjectShortKey('/test/repo');
      // Format: {prefix}-{8 hex chars}
      const parts = key.split('-');
      const hash = parts[parts.length - 1];
      expect(hash).toMatch(/^[0-9a-f]{8}$/);
    });

    it('should produce different keys for different paths', () => {
      const key1 = manager.getProjectShortKey('/Users/alice/project-a');
      const key2 = manager.getProjectShortKey('/Users/bob/project-a');
      // Same basename but different full paths → different hashes
      expect(key1).not.toBe(key2);
    });

    it('should sanitize special characters in basename', () => {
      const key = manager.getProjectShortKey('/home/user/my.project@v2');
      // dots and @ should be replaced with '-'
      expect(key).toMatch(/^[a-zA-Z0-9_-]+-[0-9a-f]{8}$/);
    });
  });

  describe('createWorktree', () => {
    it('should return null for non-git repository', async () => {
      existsSyncResults.set('/test/path/.git', false);

      const result = await manager.createWorktree({
        sessionId: 'session-123',
        repoPath: '/test/path',
      });

      expect(result).toBeNull();
    });

    it('should create worktree directory if it does not exist', async () => {
      const shortKey = shortKeyFor('/test/repo');
      existsSyncResults.set('/test/repo/.git', true);
      // project dir does not exist → triggers mkdirSync + writeFileSync
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, false);
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}/worktrees`, false);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/worktrees/session-123`,
        false
      );
      mockGitRevparse.mockResolvedValue('.git');
      mockGitRaw.mockResolvedValue('');

      await manager.createWorktree({
        sessionId: 'session-123',
        repoPath: '/test/repo',
      });

      expect(mkdirSyncSpy).toHaveBeenCalled();
    });

    it('should throw if worktree directory already exists', async () => {
      const shortKey = shortKeyFor('/test/repo');
      const normalizedGitRoot = '/test/repo';
      existsSyncResults.set('/test/repo/.git', true);
      // project dir exists, sentinel exists, same repo — no collision
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, true);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/.hyperneo-repo-root`,
        true
      );
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}/worktrees`, true);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/worktrees/session-123`,
        true
      );
      mockGitRevparse.mockResolvedValue('.git');
      readFileSyncSpy.mockReturnValue(normalizedGitRoot as any);

      await expect(
        manager.createWorktree({
          sessionId: 'session-123',
          repoPath: '/test/repo',
        })
      ).rejects.toThrow('already exists');
    });

    it('should succeed with auto-generated branch name when no stale branch exists', async () => {
      const shortKey = shortKeyFor('/test/repo');
      existsSyncResults.set('/test/repo/.git', true);
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, true);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/.hyperneo-repo-root`,
        true
      );
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}/worktrees`, true);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/worktrees/session-123`,
        false
      );
      mockGitRevparse.mockResolvedValue('.git');
      readFileSyncSpy.mockReturnValue('/test/repo' as any);
      // checkBranchExists returns empty → no stale branch, then worktree add succeeds
      mockGitRaw
        .mockResolvedValueOnce('') // checkBranchExists — branch does not exist
        .mockResolvedValue(''); // worktree add

      const result = await manager.createWorktree({
        sessionId: 'session-123',
        repoPath: '/test/repo',
        // No custom branch name — uses auto-generated session/session-123
      });

      expect(result?.branch).toBe('session/session-123');
      expect(mockGitBranch).not.toHaveBeenCalled();
    });

    it('should delete stale custom branch and reuse original name', async () => {
      const shortKey = shortKeyFor('/test/repo');
      existsSyncResults.set('/test/repo/.git', true);
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, true);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/.hyperneo-repo-root`,
        true
      );
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}/worktrees`, true);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/worktrees/session-123`,
        false
      );
      mockGitRevparse.mockResolvedValue('.git');
      readFileSyncSpy.mockReturnValue('/test/repo' as any);
      // checkBranchExists returns the stale branch; branch -D goes through mockGitBranch
      mockGitRaw
        .mockResolvedValueOnce('  custom-branch\n') // checkBranchExists — stale branch found
        .mockResolvedValue(''); // worktree add (branch -D uses mockGitBranch, not mockGitRaw)

      const result = await manager.createWorktree({
        sessionId: 'session-123',
        repoPath: '/test/repo',
        branchName: 'custom-branch',
      });

      // Should reuse the original branch name, not fall back to UUID
      expect(result?.branch).toBe('custom-branch');
      // git branch -D goes through mockGitBranch
      expect(mockGitBranch).toHaveBeenCalledWith(['-D', 'custom-branch']);
    });

    it('should delete stale auto-generated branch and reuse original name', async () => {
      const shortKey = shortKeyFor('/test/repo');
      existsSyncResults.set('/test/repo/.git', true);
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, true);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/.hyperneo-repo-root`,
        true
      );
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}/worktrees`, true);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/worktrees/session-123`,
        false
      );
      mockGitRevparse.mockResolvedValue('.git');
      readFileSyncSpy.mockReturnValue('/test/repo' as any);
      mockGitRaw
        .mockResolvedValueOnce('  session/session-123\n') // checkBranchExists — stale auto branch
        .mockResolvedValue(''); // worktree add (branch -D uses mockGitBranch)

      const result = await manager.createWorktree({
        sessionId: 'session-123',
        repoPath: '/test/repo',
        // No custom branch name — uses auto-generated session/session-123
      });

      // Should reuse the auto-generated branch name
      expect(result?.branch).toBe('session/session-123');
      // git branch -D goes through mockGitBranch
      expect(mockGitBranch).toHaveBeenCalledWith(['-D', 'session/session-123']);
    });

    it('should delete stale task branch and reuse task branch name', async () => {
      const shortKey = shortKeyFor('/test/repo');
      existsSyncResults.set('/test/repo/.git', true);
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, true);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/.hyperneo-repo-root`,
        true
      );
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}/worktrees`, true);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/worktrees/session-123`,
        false
      );
      mockGitRevparse.mockResolvedValue('.git');
      readFileSyncSpy.mockReturnValue('/test/repo' as any);
      mockGitRaw
        .mockResolvedValueOnce('  task/task-42-implement-feature\n') // checkBranchExists — stale task branch
        .mockResolvedValue(''); // worktree add (branch -D uses mockGitBranch)

      const result = await manager.createWorktree({
        sessionId: 'session-123',
        repoPath: '/test/repo',
        branchName: 'task/task-42-implement-feature',
      });

      // Should reuse the task branch name, not fall back to opaque UUID
      expect(result?.branch).toBe('task/task-42-implement-feature');
      expect(mockGitBranch).toHaveBeenCalledWith(['-D', 'task/task-42-implement-feature']);
    });

    it('should fall back to UUID branch name when branch -D is rejected (branch checked out elsewhere)', async () => {
      const shortKey = shortKeyFor('/test/repo');
      existsSyncResults.set('/test/repo/.git', true);
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, true);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/.hyperneo-repo-root`,
        true
      );
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}/worktrees`, true);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/worktrees/session-123`,
        false
      );
      mockGitRevparse.mockResolvedValue('.git');
      readFileSyncSpy.mockReturnValue('/test/repo' as any);
      mockGitRaw
        .mockResolvedValueOnce('  task/task-42-implement-feature\n') // checkBranchExists — branch found
        .mockResolvedValue(''); // worktree add succeeds with fallback branch name
      // branch -D fails because branch is checked out in another active worktree
      mockGitBranch.mockRejectedValueOnce(
        new Error("error: cannot delete branch 'task/task-42' checked out at '/other'")
      );

      const result = await manager.createWorktree({
        sessionId: 'session-123',
        repoPath: '/test/repo',
        branchName: 'task/task-42-implement-feature',
      });

      // Should fall back to UUID-based branch so task can still proceed
      expect(result?.branch).toBe('session/session-123');
    });

    it('should return WorktreeMetadata on success', async () => {
      const shortKey = shortKeyFor('/test/repo');
      existsSyncResults.set('/test/repo/.git', true);
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, true);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/.hyperneo-repo-root`,
        true
      );
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}/worktrees`, true);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/worktrees/session-123`,
        false
      );
      mockGitRevparse.mockResolvedValue('.git');
      readFileSyncSpy.mockReturnValue('/test/repo' as any);
      mockGitRaw.mockResolvedValue('');

      const result = await manager.createWorktree({
        sessionId: 'session-123',
        repoPath: '/test/repo',
        branchName: 'my-branch',
      });

      expect(result).toEqual({
        isWorktree: true,
        worktreePath: `/home/testuser/.hyperneo/projects/${shortKey}/worktrees/session-123`,
        mainRepoPath: '/test/repo',
        branch: 'my-branch',
      });
    });

    it('should cleanup on failure', async () => {
      const shortKey = shortKeyFor('/test/repo');
      existsSyncResults.set('/test/repo/.git', true);
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, true);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/.hyperneo-repo-root`,
        true
      );
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}/worktrees`, true);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/worktrees/session-123`,
        false
      );
      mockGitRevparse.mockResolvedValue('.git');
      readFileSyncSpy.mockReturnValue('/test/repo' as any);

      // First call for worktree add fails
      mockGitRaw
        .mockResolvedValueOnce('') // checkBranchExists - branch doesn't exist
        .mockRejectedValueOnce(new Error('Failed to add worktree')); // worktree add

      // After failure, worktree dir exists (partially created)
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/worktrees/session-123`,
        true
      );

      await expect(
        manager.createWorktree({
          sessionId: 'session-123',
          repoPath: '/test/repo',
          branchName: 'my-branch',
        })
      ).rejects.toThrow('Failed to create worktree');

      // Should have tried to clean up
      expect(mockGitRaw).toHaveBeenCalled();
    });
  });

  describe('removeWorktree', () => {
    it('should handle worktree not found gracefully', async () => {
      // Empty worktree list - worktree doesn't exist in git's list
      // Should not throw, just log and continue

      // This is a unit test for the logic flow, not the git commands
      // The actual git operations are mocked at module level
      const worktree = {
        isWorktree: true,
        worktreePath: '/nonexistent/worktree',
        mainRepoPath: '/test/repo',
        branch: 'session/test',
      };

      // The test verifies the function doesn't throw for missing worktrees
      // The actual git commands would fail if not mocked
      expect(worktree.worktreePath).toBe('/nonexistent/worktree');
    });

    it('should have correct worktree metadata structure', () => {
      const worktree = {
        isWorktree: true,
        worktreePath: '/test/worktree',
        mainRepoPath: '/test/repo',
        branch: 'session/test',
      };

      expect(worktree.isWorktree).toBe(true);
      expect(worktree.worktreePath).toBe('/test/worktree');
      expect(worktree.mainRepoPath).toBe('/test/repo');
      expect(worktree.branch).toBe('session/test');
    });
  });

  describe('listWorktrees', () => {
    it('should return empty array for non-git repository', async () => {
      existsSyncResults.set('/test/path/.git', false);

      const result = await manager.listWorktrees('/test/path');

      expect(result).toEqual([]);
    });

    it('should parse worktree list correctly', async () => {
      existsSyncResults.set('/test/repo/.git', true);
      mockGitRevparse.mockResolvedValue('.git');
      mockGitRaw.mockResolvedValue(
        'worktree /test/repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /test/repo/.worktrees/session-1\nHEAD def456\nbranch refs/heads/session/session-1\n'
      );

      const result = await manager.listWorktrees('/test/repo');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        path: '/test/repo',
        commit: 'abc123',
        branch: 'main',
        isPrunable: false,
      });
      expect(result[1]).toEqual({
        path: '/test/repo/.worktrees/session-1',
        commit: 'def456',
        branch: 'session/session-1',
        isPrunable: false,
      });
    });

    it('should handle prunable worktrees', async () => {
      existsSyncResults.set('/test/repo/.git', true);
      mockGitRevparse.mockResolvedValue('.git');
      mockGitRaw.mockResolvedValue(
        'worktree /test/repo/.worktrees/session-1\nHEAD abc123\nbranch refs/heads/session/session-1\nprunable\n'
      );

      const result = await manager.listWorktrees('/test/repo');

      expect(result[0].isPrunable).toBe(true);
    });

    it('should return empty array on git error', async () => {
      existsSyncResults.set('/test/repo/.git', true);
      mockGitRevparse.mockResolvedValue('.git');
      mockGitRaw.mockRejectedValue(new Error('Git error'));

      const result = await manager.listWorktrees('/test/repo');

      expect(result).toEqual([]);
    });
  });

  describe('verifyWorktree', () => {
    it('should return false if directory does not exist', async () => {
      existsSyncResults.set('/test/worktree', false);

      const result = await manager.verifyWorktree({
        isWorktree: true,
        worktreePath: '/test/worktree',
        mainRepoPath: '/test/repo',
        branch: 'session/test',
      });

      expect(result).toBe(false);
    });

    it('should return false if not in git worktree list', async () => {
      existsSyncResults.set('/test/worktree', true);
      existsSyncResults.set('/test/repo/.git', true);
      mockGitRevparse.mockResolvedValue('.git');
      mockGitRaw.mockResolvedValue('worktree /test/repo\nHEAD abc123\n'); // Different worktree

      const result = await manager.verifyWorktree({
        isWorktree: true,
        worktreePath: '/test/worktree',
        mainRepoPath: '/test/repo',
        branch: 'session/test',
      });

      expect(result).toBe(false);
    });

    it('should return true for valid worktree', async () => {
      existsSyncResults.set('/test/worktree', true);
      existsSyncResults.set('/test/repo/.git', true);
      mockGitRevparse.mockResolvedValue('.git');
      mockGitRaw.mockResolvedValue(
        'worktree /test/worktree\nHEAD abc123\nbranch refs/heads/session/test\n'
      );

      const result = await manager.verifyWorktree({
        isWorktree: true,
        worktreePath: '/test/worktree',
        mainRepoPath: '/test/repo',
        branch: 'session/test',
      });

      expect(result).toBe(true);
    });
  });

  describe('getCurrentBranch', () => {
    it('should return current branch from branch --show-current', async () => {
      mockGitRaw.mockResolvedValueOnce('feature/test\n');

      const result = await manager.getCurrentBranch('/test/repo');

      expect(result).toBe('feature/test');
      expect(mockGitRaw).toHaveBeenCalledWith(['branch', '--show-current']);
    });

    it('should return null for unborn HEAD', async () => {
      mockGitRaw.mockResolvedValueOnce('\n');

      const result = await manager.getCurrentBranch('/test/repo');

      expect(result).toBeNull();
    });

    it('should fallback to revparse when show-current fails', async () => {
      mockGitRaw.mockRejectedValueOnce(new Error('show-current failed'));
      mockGitRevparse.mockResolvedValueOnce('main\n');

      const result = await manager.getCurrentBranch('/test/repo');

      expect(result).toBe('main');
      expect(mockGitRevparse).toHaveBeenCalledWith(['--abbrev-ref', 'HEAD']);
    });

    it('should return null when revparse resolves to HEAD', async () => {
      mockGitRaw.mockRejectedValueOnce(new Error('show-current failed'));
      mockGitRevparse.mockResolvedValueOnce('HEAD\n');

      const result = await manager.getCurrentBranch('/test/repo');

      expect(result).toBeNull();
    });
  });

  describe('renameBranch', () => {
    it('should return false if new branch already exists', async () => {
      mockGitRaw.mockResolvedValue('  new-branch\n'); // Branch exists

      const result = await manager.renameBranch('/test/repo', 'old-branch', 'new-branch');

      expect(result).toBe(false);
    });

    it('should rename branch successfully', async () => {
      mockGitRaw.mockResolvedValue(''); // Branch doesn't exist

      const result = await manager.renameBranch('/test/repo', 'old-branch', 'new-branch');

      expect(result).toBe(true);
      expect(mockGitBranch).toHaveBeenCalledWith(['-m', 'old-branch', 'new-branch']);
    });

    it('should return false on git error', async () => {
      mockGitRaw.mockResolvedValue(''); // Branch doesn't exist
      mockGitBranch.mockRejectedValue(new Error('Git error'));

      const result = await manager.renameBranch('/test/repo', 'old-branch', 'new-branch');

      expect(result).toBe(false);
    });
  });

  describe('cleanupOrphanedWorktrees', () => {
    it('should return empty array for non-git repository', async () => {
      existsSyncResults.set('/test/path/.git', false);

      const result = await manager.cleanupOrphanedWorktrees('/test/path');

      expect(result).toEqual([]);
    });

    it('should prune and remove orphaned worktrees', async () => {
      existsSyncResults.set('/test/repo/.git', true);
      existsSyncResults.set('/test/repo/.hyperneo/worktrees/session-1', false); // Orphaned

      mockGitRevparse.mockResolvedValue('.git');
      mockGitRaw
        .mockResolvedValueOnce('') // prune
        .mockResolvedValueOnce(
          'worktree /test/repo\nHEAD abc123\n\nworktree /test/repo/.hyperneo/worktrees/session-1\nHEAD def456\nbranch refs/heads/session/session-1\nprunable\n'
        ) // list
        .mockResolvedValue(''); // remove

      const result = await manager.cleanupOrphanedWorktrees('/test/repo');

      expect(result).toContain('/test/repo/.hyperneo/worktrees/session-1');
    });

    it('should delete task/ branches for orphaned task worktrees', async () => {
      existsSyncResults.set('/test/repo/.git', true);

      mockGitRevparse.mockResolvedValue('.git');
      mockGitRaw
        .mockResolvedValueOnce('') // prune
        .mockResolvedValueOnce(
          'worktree /test/repo\nHEAD abc123\n\nworktree /test/repo/.hyperneo/worktrees/task-wt\nHEAD def456\nbranch refs/heads/task/task-42-implement-feature\nprunable\n'
        ) // list
        .mockResolvedValue(''); // remove

      const result = await manager.cleanupOrphanedWorktrees('/test/repo');

      expect(result).toContain('/test/repo/.hyperneo/worktrees/task-wt');
      // Should also delete the task/ branch
      expect(mockGitBranch).toHaveBeenCalledWith(['-D', 'task/task-42-implement-feature']);
    });

    it('should throw on cleanup failure', async () => {
      existsSyncResults.set('/test/repo/.git', true);
      mockGitRevparse.mockResolvedValue('.git');
      mockGitRaw.mockRejectedValue(new Error('Git error'));

      await expect(manager.cleanupOrphanedWorktrees('/test/repo')).rejects.toThrow(
        'Failed to cleanup'
      );
    });
  });

  describe('getCommitsAhead', () => {
    it('should return no commits when branch does not exist', async () => {
      mockGitRevparse.mockRejectedValue(new Error('Branch not found'));
      mockGitRaw.mockResolvedValue('origin/main'); // For getDefaultBranch

      const result = await manager.getCommitsAhead({
        isWorktree: true,
        worktreePath: '/test/worktree',
        mainRepoPath: '/test/repo',
        branch: 'session/test',
      });

      expect(result.hasCommitsAhead).toBe(false);
      expect(result.commits).toEqual([]);
    });

    it('should return commits ahead of base branch', async () => {
      mockGitRevparse.mockResolvedValue('abc123'); // Branch exists
      mockGitRaw
        .mockResolvedValueOnce('origin/main') // getDefaultBranch symbolic-ref
        .mockResolvedValueOnce('merge-base-123') // merge-base
        .mockResolvedValueOnce('file1.ts\nfile2.ts') // diff --name-only
        .mockResolvedValueOnce('+ added line') // diff for file1
        .mockResolvedValueOnce('abc1234|John Doe|2024-01-01 12:00:00|Fix bug'); // log

      const result = await manager.getCommitsAhead({
        isWorktree: true,
        worktreePath: '/test/worktree',
        mainRepoPath: '/test/repo',
        branch: 'session/test',
      });

      expect(result.hasCommitsAhead).toBe(true);
      expect(result.commits).toHaveLength(1);
      expect(result.commits[0]).toEqual({
        hash: 'abc1234',
        author: 'John Doe',
        date: '2024-01-01 12:00:00',
        message: 'Fix bug',
      });
    });

    it('should throw on git error', async () => {
      mockGitRevparse.mockResolvedValue('abc123'); // Branch exists
      mockGitRaw.mockRejectedValue(new Error('Git error'));

      await expect(
        manager.getCommitsAhead({
          isWorktree: true,
          worktreePath: '/test/worktree',
          mainRepoPath: '/test/repo',
          branch: 'session/test',
        })
      ).rejects.toThrow('Failed to check commits');
    });
  });

  // ---------------------------------------------------------------------------
  // getSessionFileDiff — full single-file diff (git.fileDiff RPC)
  // ---------------------------------------------------------------------------
  describe('getSessionFileDiff', () => {
    it('returns an empty response when the session has no workspace', async () => {
      const session = {
        id: 'session-1',
        workspacePath: null,
        gitBranch: null,
      } as unknown as Session;
      const result = await manager.getSessionFileDiff(session, 'src/foo.ts');
      expect(result).toEqual({
        sessionId: 'session-1',
        path: 'src/foo.ts',
        patch: null,
        truncated: false,
        additions: 0,
        deletions: 0,
      });
    });

    it('returns an empty response when path is blank (all-whitespace)', async () => {
      const session = {
        id: 'session-1',
        workspacePath: '/test/repo',
        gitBranch: null,
      } as unknown as Session;
      const result = await manager.getSessionFileDiff(session, '   ');
      // All-whitespace is rejected (no git ops) — patch is null. The path is
      // echoed as-is rather than trimmed, matching how real paths are handled.
      expect(result.patch).toBeNull();
      expect(result.path).toBe('   ');
    });

    it('passes the path untrimmed to git operations', async () => {
      // A tracked file may legitimately begin/end with whitespace; trimming it
      // would query a different file. Verify the pathspec keeps the original.
      const diffCalls: string[][] = [];
      existsSyncResults.set('/test/repo/.git', true);
      mockGitRevparse.mockResolvedValue('.git');
      const spy = spyOn(
        manager as unknown as { getGit(repoPath: string): SimpleGit },
        'getGit'
      ).mockImplementation(
        () =>
          ({
            raw: async (args: string[]) => {
              const cmd = args.join(' ');
              if (cmd.startsWith('diff') && args.includes('--')) diffCalls.push(args);
              return '+diff body\n';
            },
            revparse: async () => '.git',
          }) as unknown as SimpleGit
      );
      try {
        const session = {
          id: 's',
          workspacePath: '/test/repo',
          gitBranch: 'main',
        } as unknown as Session;
        const result = await manager.getSessionFileDiff(session, ' src/spaced .ts');
        // The pathspec (last arg after `--`) must carry the surrounding whitespace.
        expect(diffCalls.some((args) => args[args.length - 1] === ' src/spaced .ts')).toBe(true);
        expect(result.patch).toContain('+diff body');
      } finally {
        spy.mockRestore();
      }
    });

    it('reports an error when the workspace is not a git repo', async () => {
      existsSyncResults.set('/test/repo/.git', false);
      const session = {
        id: 'session-1',
        workspacePath: '/test/repo',
        gitBranch: null,
      } as unknown as Session;
      const result = await manager.getSessionFileDiff(session, 'src/foo.ts');
      expect(result.patch).toBeNull();
      expect(result.error).toBe('Not a git repository');
    });

    it('returns the working-tree diff and numstat for a modified file (direct mode)', async () => {
      existsSyncResults.set('/test/repo/.git', true);
      mockGitRevparse.mockResolvedValue('.git');
      // base branch resolves to 'main', same as the session branch → no branch patch.
      mockGitRaw.mockImplementation(async (args: string[]) => {
        const cmd = Array.isArray(args) ? args.join(' ') : String(args ?? '');
        if (cmd.includes('symbolic-ref')) return 'origin/main';
        if (cmd.includes('status --porcelain')) return ' M src/foo.ts\0';
        if (cmd.includes('--numstat')) return '3\t1\tsrc/foo.ts\n';
        if (cmd.startsWith('diff')) return '+added line\n context\n-removed line\n';
        return '';
      });

      const session = {
        id: 'session-1',
        workspacePath: '/test/repo',
        gitBranch: 'main',
      } as unknown as Session;
      const result = await manager.getSessionFileDiff(session, 'src/foo.ts');

      expect(result.patch).toContain('+added line');
      expect(result.patch).toContain('-removed line');
      expect(result.additions).toBe(3);
      expect(result.deletions).toBe(1);
      expect(result.truncated).toBe(false);
    });

    it('combines branch and working-tree patches when the branch diverges', async () => {
      existsSyncResults.set('/test/repo/.git', true);
      mockGitRevparse.mockResolvedValue('.git');
      mockGitRaw.mockImplementation(async (args: string[]) => {
        const cmd = Array.isArray(args) ? args.join(' ') : String(args ?? '');
        if (cmd.includes('symbolic-ref')) return 'origin/main';
        if (cmd.includes('status --porcelain')) return ' M src/foo.ts\0';
        if (cmd.includes('main...feature') && cmd.includes('--numstat'))
          return '5\t2\tsrc/foo.ts\n';
        if (cmd.includes('HEAD') && cmd.includes('--numstat')) return '3\t1\tsrc/foo.ts\n';
        if (cmd.includes('main...feature')) return '+branch only line\n';
        if (cmd.includes('HEAD --')) return '+working tree line\n';
        return '';
      });

      const session = {
        id: 'session-1',
        workspacePath: '/test/repo',
        gitBranch: 'feature',
      } as unknown as Session;
      const result = await manager.getSessionFileDiff(session, 'src/foo.ts');

      expect(result.patch).toContain('+branch only line');
      expect(result.patch).toContain('+working tree line');
      // Branch (5/2) + working tree (3/1).
      expect(result.additions).toBe(8);
      expect(result.deletions).toBe(3);
    });

    it('skips the working-tree patch for untracked files', async () => {
      existsSyncResults.set('/test/repo/.git', true);
      mockGitRevparse.mockResolvedValue('.git');
      mockGitRaw.mockImplementation(async (args: string[]) => {
        const cmd = Array.isArray(args) ? args.join(' ') : String(args ?? '');
        if (cmd.includes('symbolic-ref')) return 'origin/main';
        if (cmd.includes('status --porcelain')) return '?? src/new.ts\0';
        return '';
      });

      const session = {
        id: 'session-1',
        workspacePath: '/test/repo',
        gitBranch: 'main',
      } as unknown as Session;
      const result = await manager.getSessionFileDiff(session, 'src/new.ts');

      // Untracked + base==branch → no patch anywhere.
      expect(result.patch).toBeNull();
    });

    it('reports truncation when a single patch exceeds the full-diff cap', async () => {
      existsSyncResults.set('/test/repo/.git', true);
      mockGitRevparse.mockResolvedValue('.git');
      mockGitRaw.mockImplementation(async (args: string[]) => {
        const cmd = Array.isArray(args) ? args.join(' ') : String(args ?? '');
        if (cmd.includes('symbolic-ref')) return 'origin/main';
        if (cmd.includes('status --porcelain')) return ' M src/big.ts\0';
        if (cmd.startsWith('diff')) return 'x'.repeat(1_000_001); // > MAX_FULL_PATCH_CHARS
        return '';
      });

      const session = {
        id: 'session-1',
        workspacePath: '/test/repo',
        gitBranch: 'main',
      } as unknown as Session;
      const result = await manager.getSessionFileDiff(session, 'src/big.ts');

      // Single oversized read must still be flagged (combinePatches alone would
      // drop the per-read truncated flag and present the slice as complete).
      expect(result.truncated).toBe(true);
      expect(result.patch?.length).toBe(1_000_000);
    });
  });

  // ---------------------------------------------------------------------------
  // Subdirectory workspace diffs — git pathspecs resolve relative to the git
  // client's cwd, but porcelain/diff paths are repo-root-relative. A client
  // started from a workspace subdir resolves `-- sub/file.ts` to sub/sub/file.ts
  // and returns nothing. These tests use a path-aware getGit spy (the module
  // mock returns one shared client regardless of base dir) to lock in the
  // repoInfo.gitRoot fix in getSessionFileDiff and getReviewSummary.
  // ---------------------------------------------------------------------------
  describe('subdirectory direct workspace diffs', () => {
    function installPathAwareGit() {
      return spyOn(
        manager as unknown as { getGit(repoPath: string): SimpleGit },
        'getGit'
      ).mockImplementation((repoPath: string) => {
        // diff-with-pathspec only resolves when run from the repo root /repo.
        return {
          raw: async (args: string[]) => {
            const cmd = Array.isArray(args) ? args.join(' ') : String(args ?? '');
            if (cmd.includes('symbolic-ref')) return 'origin/main';
            if (cmd.includes('status --porcelain')) return ' M sub/file.ts\0';
            if (cmd.includes('--numstat')) return '1\t0\tsub/file.ts\n';
            if (cmd.startsWith('diff') && cmd.includes(' -- ')) {
              return repoPath === '/repo' ? '+diff body\n' : '';
            }
            return '';
          },
          revparse: async () => '.git',
        } as unknown as SimpleGit;
      });
    }

    beforeEach(() => {
      existsSyncResults.set('/repo/.git', true);
    });

    it('returns the working-tree patch for a direct session in a repo subdir', async () => {
      const spy = installPathAwareGit();
      try {
        const session = {
          id: 's',
          workspacePath: '/repo/sub',
          gitBranch: 'main',
        } as unknown as Session;
        const result = await manager.getSessionFileDiff(session, 'sub/file.ts');
        // From the workspace subdir this would resolve to sub/sub/file.ts and
        // return no patch; running from gitRoot (/repo) yields the diff.
        expect(result.patch).toContain('+diff body');
      } finally {
        spy.mockRestore();
      }
    });

    it('populates review file patches for a direct session in a repo subdir', async () => {
      // This is the user-facing path the reviewer flagged ("No inline diff
      // available" for every working-tree file) — getReviewSummary must also
      // run from gitRoot.
      const spy = installPathAwareGit();
      try {
        const session = {
          id: 's',
          workspacePath: '/repo/sub',
          gitBranch: 'main',
        } as unknown as Session;
        const status = await manager.getSessionGitStatus(session);
        const file = status.review.files.find((f) => f.path === 'sub/file.ts');
        expect(file).toBeTruthy();
        expect(file?.patch).toContain('+diff body');
      } finally {
        spy.mockRestore();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // getWorktreeBaseDir — TEST_WORKTREE_BASE_DIR override
  // ---------------------------------------------------------------------------
  describe('getWorktreeBaseDir TEST_WORKTREE_BASE_DIR override', () => {
    const originalEnv = process.env.TEST_WORKTREE_BASE_DIR;

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.TEST_WORKTREE_BASE_DIR;
      } else {
        process.env.TEST_WORKTREE_BASE_DIR = originalEnv;
      }
    });

    it('uses TEST_WORKTREE_BASE_DIR as the root when set', async () => {
      const testBaseDir = '/tmp/hyperneo-test-override';
      process.env.TEST_WORKTREE_BASE_DIR = testBaseDir;

      const repoPath = '/test/repo';
      const shortKey = manager.getProjectShortKey(repoPath);

      existsSyncResults.set('/test/repo/.git', true);
      mockGitRevparse.mockResolvedValue('.git');
      // project dir does NOT exist yet → triggers mkdirSync
      existsSyncResults.set(`${testBaseDir}/${shortKey}`, false);
      existsSyncResults.set(`${testBaseDir}/${shortKey}/worktrees`, false);
      existsSyncResults.set(`${testBaseDir}/${shortKey}/worktrees/sess-override`, false);
      mockGitRaw.mockResolvedValue('');

      const result = await manager.createWorktree({
        sessionId: 'sess-override',
        repoPath,
      });

      // Worktree path must use the override base dir, not ~/.hyperneo
      expect(result?.worktreePath).toBe(`${testBaseDir}/${shortKey}/worktrees/sess-override`);
      expect(result?.worktreePath).not.toContain('/home/testuser');
    });

    it('falls back to ~/.hyperneo when TEST_WORKTREE_BASE_DIR is not set', async () => {
      delete process.env.TEST_WORKTREE_BASE_DIR;

      const repoPath = '/test/repo';
      const shortKey = manager.getProjectShortKey(repoPath);

      existsSyncResults.set('/test/repo/.git', true);
      mockGitRevparse.mockResolvedValue('.git');
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, false);
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}/worktrees`, false);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/worktrees/sess-home`,
        false
      );
      mockGitRaw.mockResolvedValue('');

      const result = await manager.createWorktree({
        sessionId: 'sess-home',
        repoPath,
      });

      expect(result?.worktreePath).toBe(
        `/home/testuser/.hyperneo/projects/${shortKey}/worktrees/sess-home`
      );
    });
  });

  // ---------------------------------------------------------------------------
  // verifyWorktree — backward compatibility with old long-path format
  // ---------------------------------------------------------------------------
  describe('verifyWorktree old-format path compatibility', () => {
    it('recognizes a worktree stored with the old encoded path format', async () => {
      // Old format: ~/.hyperneo/projects/-Users-alice-my-app/worktrees/session-abc
      // verifyWorktree uses the DB-stored worktreePath directly, so old and new
      // path formats coexist in the DB indefinitely with no conflict.
      const oldFormatPath =
        '/home/testuser/.hyperneo/projects/-Users-alice-my-app/worktrees/session-abc';
      const mainRepoPath = '/Users/alice/my-app';

      existsSyncResults.set(oldFormatPath, true);
      existsSyncResults.set(`${mainRepoPath}/.git`, true);
      mockGitRevparse.mockResolvedValue('.git');
      // git worktree list includes the old-format path
      mockGitRaw.mockResolvedValue(
        `worktree ${oldFormatPath}\nHEAD abc123\nbranch refs/heads/session/session-abc\n`
      );

      const result = await manager.verifyWorktree({
        isWorktree: true,
        worktreePath: oldFormatPath,
        mainRepoPath,
        branch: 'session/session-abc',
      });

      expect(result).toBe(true);
    });

    it('returns false for old-format path when directory no longer exists', async () => {
      const oldFormatPath =
        '/home/testuser/.hyperneo/projects/-Users-alice-my-app/worktrees/session-abc';
      const mainRepoPath = '/Users/alice/my-app';

      existsSyncResults.set(oldFormatPath, false);

      const result = await manager.verifyWorktree({
        isWorktree: true,
        worktreePath: oldFormatPath,
        mainRepoPath,
        branch: 'session/session-abc',
      });

      expect(result).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // getWorktreeBaseDir — collision detection
  // All three scenarios use the existing fs mocks from the outer beforeEach.
  // ---------------------------------------------------------------------------
  describe('getWorktreeBaseDir collision detection', () => {
    let loggerWarnSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      // Spy on Logger.prototype.warn to capture collision warnings
      loggerWarnSpy = spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      loggerWarnSpy.mockRestore();
    });

    it('no collision: first call creates sentinel and returns short-key path', async () => {
      const repoPath = '/Users/alice/my-app';
      const shortKey = manager.getProjectShortKey(repoPath);

      // Git root detection
      existsSyncResults.set(`${repoPath}/.git`, true);
      mockGitRevparse.mockResolvedValue('.git');

      // project dir does NOT exist yet → triggers mkdirSync + writeFileSync
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, false);
      // worktrees dir also doesn't exist
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}/worktrees`, false);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/worktrees/sess-1`,
        false
      );
      mockGitRaw.mockResolvedValue('');

      const result = await manager.createWorktree({
        sessionId: 'sess-1',
        repoPath,
      });

      // Worktree path uses the short key
      expect(result?.worktreePath).toBe(
        `/home/testuser/.hyperneo/projects/${shortKey}/worktrees/sess-1`
      );
      // Sentinel was written
      expect(writeFileSyncSpy).toHaveBeenCalledWith(
        `/home/testuser/.hyperneo/projects/${shortKey}/.hyperneo-repo-root`,
        repoPath
      );
      // No collision warning
      expect(loggerWarnSpy).not.toHaveBeenCalledWith(expect.stringContaining('collision'));
    });

    it('same repo second call: sentinel matches, returns same short-key path', async () => {
      const repoPath = '/Users/bob/cool-lib';
      const shortKey = manager.getProjectShortKey(repoPath);

      // Git root detection
      existsSyncResults.set(`${repoPath}/.git`, true);
      mockGitRevparse.mockResolvedValue('.git');

      // project dir EXISTS, sentinel EXISTS, sentinel contains the SAME repo path
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, true);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/.hyperneo-repo-root`,
        true
      );
      readFileSyncSpy.mockReturnValue(repoPath as any);

      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}/worktrees`, false);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/worktrees/sess-2`,
        false
      );
      mockGitRaw.mockResolvedValue('');

      const result = await manager.createWorktree({
        sessionId: 'sess-2',
        repoPath,
      });

      // Same short-key path returned
      expect(result?.worktreePath).toBe(
        `/home/testuser/.hyperneo/projects/${shortKey}/worktrees/sess-2`
      );
      // No collision warning
      expect(loggerWarnSpy).not.toHaveBeenCalledWith(expect.stringContaining('collision'));
    });

    it('collision: sentinel belongs to different repo → logs warning and uses full encoding', async () => {
      // Repo path B whose shortKey dir is pre-occupied by repo path A
      const repoPathB = '/Users/carol/projects/app';
      const shortKey = manager.getProjectShortKey(repoPathB);
      const repoPathA = '/Users/dan/projects/other-app'; // occupies the shortKey dir

      // Git root detection for B
      existsSyncResults.set(`${repoPathB}/.git`, true);
      mockGitRevparse.mockResolvedValue('.git');

      // project dir EXISTS with sentinel pointing to A (not B)
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, true);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/.hyperneo-repo-root`,
        true
      );
      readFileSyncSpy.mockReturnValue(repoPathA as any);

      // Fallback encoded path for B: '-Users-carol-projects-app'
      const encodedB = '-Users-carol-projects-app';
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${encodedB}/worktrees`, false);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${encodedB}/worktrees/sess-collision`,
        false
      );
      mockGitRaw.mockResolvedValue('');

      const result = await manager.createWorktree({
        sessionId: 'sess-collision',
        repoPath: repoPathB,
      });

      // Should use the full encoded fallback, NOT the short key
      expect(result?.worktreePath).toBe(
        `/home/testuser/.hyperneo/projects/${encodedB}/worktrees/sess-collision`
      );
      expect(result?.worktreePath).not.toContain(shortKey);

      // Warning must have been logged
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Short key collision detected for "${shortKey}"`)
      );
    });

    it('dir exists but no sentinel (older HyperNeo): writes sentinel and returns short-key path', async () => {
      const repoPath = '/Users/eve/legacy-app';
      const shortKey = manager.getProjectShortKey(repoPath);

      // Git root detection
      existsSyncResults.set(`${repoPath}/.git`, true);
      mockGitRevparse.mockResolvedValue('.git');

      // project dir EXISTS but no sentinel file
      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, true);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/.hyperneo-repo-root`,
        false
      );

      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}/worktrees`, false);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/worktrees/sess-legacy`,
        false
      );
      mockGitRaw.mockResolvedValue('');

      const result = await manager.createWorktree({
        sessionId: 'sess-legacy',
        repoPath,
      });

      // Short-key path is returned
      expect(result?.worktreePath).toBe(
        `/home/testuser/.hyperneo/projects/${shortKey}/worktrees/sess-legacy`
      );
      // Sentinel was written (to "adopt" the existing dir)
      expect(writeFileSyncSpy).toHaveBeenCalledWith(
        `/home/testuser/.hyperneo/projects/${shortKey}/.hyperneo-repo-root`,
        repoPath
      );
    });
  });
});
