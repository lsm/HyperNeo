import { describe, it, expect } from 'bun:test';
import {
  gitStatusKind,
  normalizeNumstatPath,
  parseNumstatMap,
  parsePorcelainStatus,
} from '../../../../src/lib/worktree-git-output';

describe('gitStatusKind', () => {
  it('maps untracked and conflicted markers with priority', () => {
    expect(gitStatusKind('?', '?')).toBe('untracked');
    expect(gitStatusKind(' ', '?')).toBe('untracked');
    expect(gitStatusKind('?', ' ')).toBe('untracked');

    expect(gitStatusKind('U', ' ')).toBe('conflicted');
    expect(gitStatusKind(' ', 'U')).toBe('conflicted');
    expect(gitStatusKind('A', 'A')).toBe('conflicted');
    expect(gitStatusKind('D', 'D')).toBe('conflicted');
    expect(gitStatusKind('R', 'U')).toBe('conflicted');
  });

  it('maps rename when R appears in either column', () => {
    expect(gitStatusKind('R', ' ')).toBe('renamed');
    expect(gitStatusKind(' ', 'R')).toBe('renamed');
    expect(gitStatusKind('R', 'M')).toBe('renamed');
  });

  it('maps added, deleted, and modified from the deciding column', () => {
    expect(gitStatusKind('A', ' ')).toBe('added');
    expect(gitStatusKind('D', ' ')).toBe('deleted');
    expect(gitStatusKind('M', ' ')).toBe('modified');
    expect(gitStatusKind(' ', 'M')).toBe('modified');
    expect(gitStatusKind('T', ' ')).toBe('modified');
  });

  it('prefers the unstaged column when both columns carry a code', () => {
    expect(gitStatusKind('M', 'A')).toBe('added');
    expect(gitStatusKind('M', 'D')).toBe('deleted');
  });

  it('falls back to "other" for unknown or copy codes', () => {
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
    const files = parsePorcelainStatus('C  copy.txt\0orig.txt\0');
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: 'copy.txt',
      oldPath: 'orig.txt',
      status: 'other',
    });
  });

  it('drops ignored entries and skips malformed short records', () => {
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
    expect(normalizeNumstatPath('root.txt => renamed.txt')).toBe('renamed.txt');
  });

  it('collapses a brace rename to the destination', () => {
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
    const stats = parseNumstatMap('-\t-\tbin.dat\n');
    expect(stats.get('bin.dat')).toEqual({ additions: 0, deletions: 0 });
  });

  it('skips blank lines and returns an empty map for empty input', () => {
    expect(parseNumstatMap('').size).toBe(0);
    expect(parseNumstatMap('\n\n').size).toBe(0);
  });
});
