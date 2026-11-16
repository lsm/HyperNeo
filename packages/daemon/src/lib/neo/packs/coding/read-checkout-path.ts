import { lstatSync } from 'node:fs';
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

export function isReadyNeoReadCheckout(folder: string, dataDir = getDataDir()): boolean {
  const base = join(dataDir, 'worktrees');
  const [owner = '', repo = ''] = relative(base, folder).split(sep);
  try {
    return (
      getNeoReadCheckoutPath(owner, repo, dataDir) === folder &&
      [join(base, owner), join(base, owner, repo), folder, join(folder, '.git')].every((path) =>
        lstatSync(path).isDirectory()
      ) &&
      ['HEAD', 'index'].every((name) => lstatSync(join(folder, '.git', name)).isFile())
    );
  } catch {
    return false;
  }
}
