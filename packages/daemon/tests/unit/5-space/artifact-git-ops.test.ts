/**
 * Tests for packages/daemon/src/lib/space/artifact-git-ops.ts
 *
 * Covers the pure parsers (parseNumstat, parseCommitLog, countDiffLines) and
 * the merge-base in-process TTL cache (getDiffBaseRef, invalidateDiffBaseRef).
 * execGit itself isn't unit-tested here — its behaviour is exercised
 * end-to-end by the handler tests that shell out to real git.
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import {
  parseNumstat,
  parseCommitLog,
  countDiffLines,
  getDiffBaseRef,
  invalidateDiffBaseRef,
  mergeBaseCacheSize,
  fileDiffCacheKey,
  commitFilesCacheKey,
  commitFileDiffCacheKey,
  CACHE_KEY_GATE_ARTIFACTS,
  CACHE_KEY_COMMITS,
  FILE_DIFF_SIZE_LIMIT_BYTES,
  MERGE_BASE_TTL_MS,
  normalizeGithubUrl,
  getGitRemoteUrl,
} from '../../../src/lib/space/artifact-git-ops';

describe('parseNumstat', () => {
  it('returns zero totals for empty output', () => {
    const summary = parseNumstat('');
    expect(summary.files).toEqual([]);
    expect(summary.totalAdditions).toBe(0);
    expect(summary.totalDeletions).toBe(0);
  });

  it('parses standard additions/deletions lines', () => {
    const output = ['5\t2\tsrc/a.ts', '10\t0\tsrc/b.ts', '0\t3\tsrc/c.ts'].join('\n');
    const summary = parseNumstat(output);
    expect(summary.files).toHaveLength(3);
    expect(summary.totalAdditions).toBe(15);
    expect(summary.totalDeletions).toBe(5);
  });

  it('treats binary files (- / -) as zero-stat entries', () => {
    const summary = parseNumstat('-\t-\tassets/image.png\n5\t1\tsrc/a.ts');
    expect(summary.files).toEqual([
      { path: 'assets/image.png', additions: 0, deletions: 0 },
      { path: 'src/a.ts', additions: 5, deletions: 1 },
    ]);
    expect(summary.totalAdditions).toBe(5);
    expect(summary.totalDeletions).toBe(1);
  });

  it('handles paths containing tabs', () => {
    const summary = parseNumstat('5\t2\tpath/with\ttab.ts');
    expect(summary.files[0].path).toBe('path/with\ttab.ts');
    expect(summary.files[0].additions).toBe(5);
  });

  it('ignores blank lines', () => {
    const summary = parseNumstat('\n5\t2\tsrc/a.ts\n\n\n');
    expect(summary.files).toHaveLength(1);
  });
});

describe('parseCommitLog', () => {
  const DL = '\x1F'; // COMMIT_LOG_FIELD_DELIMITER — must mirror the producer in artifact-git-ops.

  it('returns empty array for empty output', () => {
    expect(parseCommitLog('')).toEqual([]);
  });

  it('parses a single commit with numstat lines', () => {
    const input = [
      `COMMIT:abc123${DL}feat: do thing${DL}Alice${DL}1700000000`,
      '5\t2\tsrc/a.ts',
      '3\t0\tsrc/b.ts',
    ].join('\n');

    const commits = parseCommitLog(input);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({
      sha: 'abc123',
      message: 'feat: do thing',
      author: 'Alice',
      additions: 8,
      deletions: 2,
      fileCount: 2,
    });
    expect(commits[0].timestamp).toBe(1700000000 * 1000);
  });

  it('parses multiple commits and separates their stats', () => {
    const input = [
      `COMMIT:aaa${DL}first${DL}A${DL}1700000000`,
      '5\t2\tfile1',
      `COMMIT:bbb${DL}second${DL}B${DL}1700000100`,
      '3\t1\tfile2',
      '1\t0\tfile3',
    ].join('\n');

    const commits = parseCommitLog(input);
    expect(commits).toHaveLength(2);
    expect(commits[0].additions).toBe(5);
    expect(commits[0].fileCount).toBe(1);
    expect(commits[1].additions).toBe(4);
    expect(commits[1].fileCount).toBe(2);
  });

  it('tolerates commits with no numstat body', () => {
    const input = `COMMIT:abc${DL}no files${DL}X${DL}1700000000`;
    const commits = parseCommitLog(input);
    expect(commits).toHaveLength(1);
    expect(commits[0].additions).toBe(0);
    expect(commits[0].fileCount).toBe(0);
  });

  it('preserves commit subjects that contain a pipe character', () => {
    // Regression for the `|` delimiter: previously a subject like
    // `fix: handle | in input` would shift author/timestamp fields.
    const input = `COMMIT:deadbeef${DL}fix: handle | in input${DL}Bob${DL}1700000200`;
    const commits = parseCommitLog(input);
    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe('fix: handle | in input');
    expect(commits[0].author).toBe('Bob');
    expect(commits[0].timestamp).toBe(1700000200 * 1000);
  });
});

describe('countDiffLines', () => {
  it('returns zeros for empty input', () => {
    expect(countDiffLines('')).toEqual({ additions: 0, deletions: 0 });
  });

  it('counts + and - lines, ignoring +++/--- headers', () => {
    const diff = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,4 @@',
      ' unchanged',
      '+added',
      '+another add',
      '-removed',
    ].join('\n');
    expect(countDiffLines(diff)).toEqual({ additions: 2, deletions: 1 });
  });
});

describe('cache key helpers', () => {
  it('exposes stable constants', () => {
    expect(CACHE_KEY_GATE_ARTIFACTS).toBe('gateArtifacts');
    expect(CACHE_KEY_COMMITS).toBe('commits');
    expect(FILE_DIFF_SIZE_LIMIT_BYTES).toBe(100 * 1024);
  });

  it('generates deterministic file/commit keys', () => {
    expect(fileDiffCacheKey('src/a.ts')).toBe('fileDiff:src/a.ts');
    expect(commitFilesCacheKey('abc123')).toBe('commitFiles:abc123');
    expect(commitFileDiffCacheKey('abc123', 'src/a.ts')).toBe('commitFileDiff:abc123:src/a.ts');
  });
});

describe('getDiffBaseRef / merge-base cache', () => {
  beforeEach(() => {
    invalidateDiffBaseRef();
  });

  it('memoises the result per worktree path for MERGE_BASE_TTL_MS', async () => {
    // A non-existent path means every git probe fails → the function
    // returns the empty-string fallback. That is still a legitimate cache
    // entry and should be reused on the second call.
    const path = '/tmp/nonexistent-worktree-for-cache-test';
    const firstCallStart = Date.now();
    const first = await getDiffBaseRef(path);
    const firstCallDuration = Date.now() - firstCallStart;
    expect(first).toBe('');
    expect(mergeBaseCacheSize()).toBe(1);

    // The second call should hit the in-memory cache and return immediately.
    const secondCallStart = Date.now();
    const second = await getDiffBaseRef(path);
    const secondCallDuration = Date.now() - secondCallStart;
    expect(second).toBe('');
    // Be generous: second call must still be noticeably faster than the first
    // (which ran 3 × merge-base subprocess probes). In CI we allow a 50ms
    // buffer because the cached path is < 1 ms but scheduling can add noise.
    expect(secondCallDuration).toBeLessThan(Math.max(50, firstCallDuration));
  });

  it('invalidates the cache when TTL expires', async () => {
    const path = '/tmp/nonexistent-worktree-ttl';
    // Seed the cache with TTL=0 so the next call is already stale.
    await getDiffBaseRef(path, { ttlMs: 0 });
    expect(mergeBaseCacheSize()).toBe(1);

    // When we call again with a future `now`, the cached entry has
    // expired and a fresh probe runs (returning '' since git can't find
    // the path). The cache entry is then refreshed.
    await getDiffBaseRef(path, { now: Date.now() + 60_000, ttlMs: 60_000 });
    expect(mergeBaseCacheSize()).toBe(1);
  });

  it('invalidateDiffBaseRef() with no args clears the whole cache', async () => {
    await getDiffBaseRef('/tmp/a');
    await getDiffBaseRef('/tmp/b');
    expect(mergeBaseCacheSize()).toBe(2);
    invalidateDiffBaseRef();
    expect(mergeBaseCacheSize()).toBe(0);
  });

  it('invalidateDiffBaseRef(path) drops only the matching entry', async () => {
    await getDiffBaseRef('/tmp/a');
    await getDiffBaseRef('/tmp/b');
    invalidateDiffBaseRef('/tmp/a');
    expect(mergeBaseCacheSize()).toBe(1);
  });

  it('defaults the TTL to MERGE_BASE_TTL_MS', () => {
    expect(MERGE_BASE_TTL_MS).toBe(60_000);
  });
});

describe('normalizeGithubUrl', () => {
  it('converts SSH remote to HTTPS GitHub URL (with .git)', () => {
    expect(normalizeGithubUrl('git@github.com:owner/repo.git')).toBe(
      'https://github.com/owner/repo'
    );
  });

  it('converts SSH remote to HTTPS GitHub URL (without .git)', () => {
    expect(normalizeGithubUrl('git@github.com:owner/repo')).toBe('https://github.com/owner/repo');
  });

  it('normalises HTTPS GitHub URL with .git suffix', () => {
    expect(normalizeGithubUrl('https://github.com/owner/repo.git')).toBe(
      'https://github.com/owner/repo'
    );
  });

  it('passes through HTTPS GitHub URL without .git suffix unchanged', () => {
    expect(normalizeGithubUrl('https://github.com/owner/repo')).toBe(
      'https://github.com/owner/repo'
    );
  });

  it('returns null for non-GitHub remotes', () => {
    expect(normalizeGithubUrl('https://gitlab.com/owner/repo.git')).toBeNull();
    expect(normalizeGithubUrl('git@bitbucket.org:owner/repo.git')).toBeNull();
    expect(normalizeGithubUrl('https://example.com/repo')).toBeNull();
  });

  it('returns null for arbitrary strings', () => {
    expect(normalizeGithubUrl('not-a-url')).toBeNull();
    expect(normalizeGithubUrl('')).toBeNull();
  });
});

describe('getGitRemoteUrl', () => {
  // These tests shell out to real git, whose subprocess startup can take
  // several seconds on a loaded CI machine; give them a generous timeout so
  // they don't race the 5s execGit timeout (the vitest default is also 5s).
  it('returns null for a non-existent directory (git command fails)', async () => {
    const result = await getGitRemoteUrl('/tmp/nonexistent-dir-for-remote-url-test');
    expect(result).toBeNull();
  }, 20_000);

  it('returns null for a directory with no git repo', async () => {
    const { mkdtempSync, rmdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(`${tmpdir()}/hyperneo-no-git-`);
    try {
      const result = await getGitRemoteUrl(dir);
      expect(result).toBeNull();
    } finally {
      rmdirSync(dir);
    }
  }, 20_000);
});
