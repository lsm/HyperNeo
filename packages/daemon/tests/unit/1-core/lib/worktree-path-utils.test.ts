import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from 'vitest';
import {
  encodeRepoPath,
  getProjectShortKey,
  getWorktreeBaseDir,
} from '../../../../src/lib/worktree-path-utils';

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  homedir: vi.fn(),
}));

function passthrough<Args extends unknown[], R>(
  mockFn: ReturnType<typeof vi.fn>,
  real: (...args: Args) => R
): (...args: Args) => R {
  return (...args: Args) =>
    mockFn.getMockImplementation() ? (mockFn as (...args: Args) => R)(...args) : real(...args);
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: passthrough(mocks.existsSync, actual.existsSync),
    mkdirSync: passthrough(mocks.mkdirSync, actual.mkdirSync),
    writeFileSync: passthrough(mocks.writeFileSync, actual.writeFileSync),
    readFileSync: passthrough(mocks.readFileSync, actual.readFileSync),
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: passthrough(mocks.homedir, actual.homedir),
  };
});

describe('worktree-path-utils', () => {
  let existsSyncResults: Map<string, boolean>;
  const existsSyncSpy = mocks.existsSync;
  const mkdirSyncSpy = mocks.mkdirSync;
  const writeFileSyncSpy = mocks.writeFileSync;
  const readFileSyncSpy = mocks.readFileSync;
  const homedirSpy = mocks.homedir;

  beforeEach(() => {
    existsSyncResults = new Map();

    existsSyncSpy.mockImplementation((path) => {
      return existsSyncResults.get(path as string) ?? false;
    });

    mkdirSyncSpy.mockImplementation(() => undefined as unknown as string);
    writeFileSyncSpy.mockImplementation(() => undefined);
    readFileSyncSpy.mockImplementation((): string => '/test/repo');
    homedirSpy.mockReturnValue('/home/testuser');
  });

  afterEach(() => {
    existsSyncSpy.mockReset();
    mkdirSyncSpy.mockReset();
    writeFileSyncSpy.mockReset();
    readFileSyncSpy.mockReset();
    homedirSpy.mockReset();
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
      expect(key).toMatch(/^my-project--[0-9a-f]{8}$/);
    });

    test('different paths produce different keys', () => {
      const key1 = getProjectShortKey('/Users/alice/project-a');
      const key2 = getProjectShortKey('/Users/bob/project-a');
      expect(key1).not.toBe(key2);
    });

    test('produces a valid key even when basename is all special chars', () => {
      const key = getProjectShortKey('/path/...');
      expect(key).toMatch(/^----[0-9a-f]{8}$/);
    });
  });

  describe('getWorktreeBaseDir', () => {
    test('creates project dir and sentinel on first use', () => {
      const repoPath = '/Users/alice/my-app';
      const shortKey = getProjectShortKey(repoPath);

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

      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, true);
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

      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, true);
      existsSyncResults.set(
        `/home/testuser/.hyperneo/projects/${shortKey}/.hyperneo-repo-root`,
        true
      );
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

      existsSyncResults.set(`/home/testuser/.hyperneo/projects/${shortKey}`, true);
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
