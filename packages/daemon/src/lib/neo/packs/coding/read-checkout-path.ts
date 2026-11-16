import { join, relative, sep } from 'node:path';
import { getDataDir } from '../../../data-dir.ts';

export function getNeoReadCheckoutPath(
  owner: string,
  repo: string,
  dataDir = getDataDir()
): string {
  if ([owner, repo].some((name) => !/^[a-z\d_.-]+$/i.test(name) || name === '.' || name === '..'))
    throw new Error('GitHub owner and repository must be single path segments');
  return join(dataDir, 'worktrees', owner.toLowerCase(), repo.toLowerCase(), 'neo-read');
}

export function isNeoReadCheckoutPath(folder: string, dataDir = getDataDir()): boolean {
  const [owner = '', repo = ''] = relative(join(dataDir, 'worktrees'), folder).split(sep);
  try {
    return getNeoReadCheckoutPath(owner, repo, dataDir) === folder;
  } catch {
    return false;
  }
}
