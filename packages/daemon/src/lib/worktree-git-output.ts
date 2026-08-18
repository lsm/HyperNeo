import type { GitChangedFile, GitFileStatusKind } from '@hyperneo/shared';

export function gitStatusKind(stagedCode: string, unstagedCode: string): GitFileStatusKind {
  if (
    stagedCode === 'U' ||
    unstagedCode === 'U' ||
    (stagedCode === 'A' && unstagedCode === 'A') ||
    (stagedCode === 'D' && unstagedCode === 'D')
  ) {
    return 'conflicted';
  }
  if (stagedCode === '?' || unstagedCode === '?') return 'untracked';
  if (stagedCode === 'R' || unstagedCode === 'R') return 'renamed';

  const code = unstagedCode !== ' ' ? unstagedCode : stagedCode;
  switch (code) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'M':
    case 'T':
      return 'modified';
    default:
      return 'other';
  }
}

export function parsePorcelainStatus(output: string): GitChangedFile[] {
  const entries = output.split('\0').filter(Boolean);
  const files: GitChangedFile[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;

    const stagedCode = entry[0];
    const unstagedCode = entry[1];
    if (stagedCode === '!' && unstagedCode === '!') continue;

    const isRename = stagedCode === 'R' || unstagedCode === 'R';
    const isCopy = stagedCode === 'C' || unstagedCode === 'C';
    const path = entry.slice(3);
    const oldPath = isRename || isCopy ? entries[++i] : undefined;

    files.push({
      path,
      oldPath,
      status: gitStatusKind(stagedCode, unstagedCode),
      staged: stagedCode !== ' ' && stagedCode !== '?' && stagedCode !== '!',
      unstaged: unstagedCode !== ' ' && unstagedCode !== '!',
    });
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export type NumstatEntry = { additions: number; deletions: number };

export function normalizeNumstatPath(path: string): string {
  if (!path.includes(' => ')) return path;

  const braceRename = path.match(/^(.*)\{(.+) => (.+)\}(.*)$/);
  if (braceRename) {
    return `${braceRename[1]}${braceRename[3]}${braceRename[4]}`;
  }

  return path.slice(path.lastIndexOf(' => ') + 4);
}

export function parseNumstatMap(output: string): Map<string, NumstatEntry> {
  const stats = new Map<string, NumstatEntry>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [additionsRaw, deletionsRaw, path] = line.split('\t');
    if (!path) continue;
    stats.set(normalizeNumstatPath(path), {
      additions: Number.parseInt(additionsRaw, 10) || 0,
      deletions: Number.parseInt(deletionsRaw, 10) || 0,
    });
  }
  return stats;
}
