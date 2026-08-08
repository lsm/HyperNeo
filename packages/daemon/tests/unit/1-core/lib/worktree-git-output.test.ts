/**
 * worktree-git-output unit tests
 *
 * Characterization tests for the pure decoders that parse `git`'s
 * machine-readable output (`status --porcelain=v1 -z` and `diff --numstat`)
 * into typed domain objects. These previously lived as private methods on
 * `WorktreeManager` with only indirect integration coverage; the fixtures here
 * are captured from real `git` output to lock in the exact byte formats.
 */

import { describe, it, expect } from 'bun:test';
import {
  gitStatusKind,
  normalizeNumstatPath,
  parseNumstatMap,
  parsePorcelainStatus,
} from '../../../../src/lib/worktree-git-output';

describe('gitStatusKind', () => {
  it('maps untracked and conflicted markers with priority', () => {
    // `??` is the porcelain untracked marker.
    expect(gitStatusKind('?', '?')).toBe('untracked');
    // A single `?` in either column is enough (e.g. ` ?` from --no-renames edge).
    expect(gitStatusKind(' ', '?')).toBe('untracked');
    expect(gitStatusKind('?', ' ')).toBe('untracked');

    // Conflicted: either column `U`, or both-column A/D.
    expect(gitStatusKind('U', ' ')).toBe('conflicted');
    expect(gitStatusKind(' ', 'U')).toBe('conflicted');
    expect(gitStatusKind('A', 'A')).toBe('conflicted');
    expect(gitStatusKind('D', 'D')).toBe('conflicted');
    // Conflict wins over rename.
    expect(gitStatusKind('R', 'U')).toBe('conflicted');
  });

  it('maps rename when R appears in either column', () => {
    expect(gitStatusKind('R', ' ')).toBe('renamed');
    expect(gitStatusKind(' ', 'R')).toBe('renamed');
    // Rename beats plain modified (R in staged column, M unstaged).
    expect(gitStatusKind('R', 'M')).toBe('renamed');
  });

  it('maps added, deleted, and modified from the deciding column', () => {
    expect(gitStatusKind('A', ' ')).toBe('added');
    expect(gitStatusKind('D', ' ')).toBe('deleted');
    expect(gitStatusKind('M', ' ')).toBe('modified');
    expect(gitStatusKind(' ', 'M')).toBe('modified');
    // Type-charge (`T`) is reported as modified.
    expect(gitStatusKind('T', ' ')).toBe('modified');
  });

  it('prefers the unstaged column when both columns carry a code', () => {
    // `MA`: staged-modified, unstaged-added → unstaged wins → added.
    expect(gitStatusKind('M', 'A')).toBe('added');
    // `MD`: unstaged deletion wins → deleted.
    expect(gitStatusKind('M', 'D')).toBe('deleted');
  });

  it('falls back to "other" for unknown or copy codes', () => {
    // Copy (`C`) has no dedicated kind here and resolves to "other" while the
    // porcelain parser still consumes its old-path record (see below).
    expect(gitStatusKind('C', ' ')).toBe('other');
    expect(gitStatusKind(' ', ' ')).toBe('other');
    expect(gitStatusKind('X', 'Y')).toBe('other');
  });
});

describe('parsePorcelainStatus', () => {
  it('returns an empty array for empty output', () => {
    expect(parsePorcelainStatus('')).toEqual([]);
  });

  it('parses a plain working-tree modification', () => {
    // Captured from `git status --porcelain=v1 -z`: ` M b.txt` NUL-terminated.
    const files = parsePorcelainStatus(' M b.txt\0');
    expect(files).toHaveLength(1);
    expect(files[0]).toEqual({
      path: 'b.txt',
      oldPath: undefined,
      status: 'modified',
      staged: false,
      unstaged: true,
    });
  });

  it('marks both staged and unstaged true for an `MM` file', () => {
    const files = parsePorcelainStatus('MM b.txt\0');
    expect(files[0]).toMatchObject({ status: 'modified', staged: true, unstaged: true });
  });

  it('parses untracked files', () => {
    const files = parsePorcelainStatus('?? new.txt\0?? .gitignore\0');
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: '.gitignore', status: 'untracked', staged: false });
    expect(files[1]).toMatchObject({ path: 'new.txt', status: 'untracked' });
  });

  it('parses a staged rename, carrying the old path from the next record', () => {
    // Captured from `git mv a.txt moved.txt`: `R  moved.txt` NUL `a.txt` NUL.
    // The entry path is the NEW path; the trailing record is the OLD path.
    const files = parsePorcelainStatus('R  moved.txt\0a.txt\0');
    expect(files).toHaveLength(1);
    expect(files[0]).toEqual({
      path: 'moved.txt',
      oldPath: 'a.txt',
      status: 'renamed',
      staged: true,
      unstaged: false,
    });
  });

  it('consumes the old-path record for copies but reports status "other"', () => {
    // `C` triggers old-path consumption like rename, but maps to "other".
    const files = parsePorcelainStatus('C  copy.txt\0orig.txt\0');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: 'copy.txt',
      oldPath: 'orig.txt',
      status: 'other',
    });
  });

  it('drops ignored entries and skips malformed short records', () => {
    // `!!` only appears with `--ignored` (this parser never requests it), but
    // the guard must still skip such entries defensively.
    const files = parsePorcelainStatus('!! ignored.log\0 M ok.txt\0ab\0');
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('ok.txt');
  });

  it('sorts files by path', () => {
    const files = parsePorcelainStatus(' M zeta.ts\0?? alpha.ts\0 M mid.ts\0');
    expect(files.map((f) => f.path)).toEqual(['alpha.ts', 'mid.ts', 'zeta.ts']);
  });
});

describe('normalizeNumstatPath', () => {
  it('returns paths without rename syntax unchanged', () => {
    expect(normalizeNumstatPath('src/foo.ts')).toBe('src/foo.ts');
  });

  it('collapses a plain `old => new` rename to the destination', () => {
    // Captured from `git mv root.txt renamed.txt`.
    expect(normalizeNumstatPath('root.txt => renamed.txt')).toBe('renamed.txt');
  });

  it('collapses a brace rename to the destination', () => {
    // Captured from `git mv src/old/f.ts src/newdir/f.ts`.
    expect(normalizeNumstatPath('src/{old => newdir}/f.ts')).toBe('src/newdir/f.ts');
  });
});

describe('parseNumstatMap', () => {
  it('parses additions and deletions per path', () => {
    const stats = parseNumstatMap('5\t2\tsrc/foo.ts\n0\t1\tsrc/bar.ts\n');
    expect(stats.get('src/foo.ts')).toEqual({ additions: 5, deletions: 2 });
    expect(stats.get('src/bar.ts')).toEqual({ additions: 0, deletions: 1 });
  });

  it('normalizes rename paths so callers key on the destination', () => {
    const stats = parseNumstatMap(
      '0\t0\troot.txt => renamed.txt\n0\t0\tsrc/{old => newdir}/f.ts\n'
    );
    expect(stats.has('root.txt => renamed.txt')).toBe(false);
    expect(stats.get('renamed.txt')).toEqual({ additions: 0, deletions: 0 });
    expect(stats.get('src/newdir/f.ts')).toEqual({ additions: 0, deletions: 0 });
  });

  it('treats binary files (`-` counts) as zero additions and deletions', () => {
    // Captured from a binary file addition.
    const stats = parseNumstatMap('-\t-\tbin.dat\n');
    expect(stats.get('bin.dat')).toEqual({ additions: 0, deletions: 0 });
  });

  it('skips blank lines and returns an empty map for empty input', () => {
    expect(parseNumstatMap('').size).toBe(0);
    expect(parseNumstatMap('\n\n').size).toBe(0);
  });
});
