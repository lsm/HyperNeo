import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDataDir } from '../data-dir.ts';
import { neoFolderPath } from './folder.ts';
import { getNeoReadCheckoutPath } from './read-checkout-path.ts';

function directories(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(String((error as NodeJS.ErrnoException).code))) return [];
    throw error;
  }
}

export function neoReadCheckoutPaths(dataDir = getDataDir()): string[] {
  const root = join(dataDir, 'worktrees');
  return directories(root).flatMap((owner) =>
    directories(join(root, owner.name)).flatMap((repo) => {
      let path: string;
      try {
        path = getNeoReadCheckoutPath(owner.name, repo.name, dataDir);
      } catch {
        return [];
      }
      return existsSync(path) ? [path] : [];
    })
  );
}

export async function neoReadAccess(
  sessionId: string,
  cwd: string | undefined,
  readToken: () => Promise<string | null> = () => Promise.resolve(null)
) {
  const temp = join(tmpdir(), 'hyperneo-neo', sessionId);
  mkdirSync(join(temp, 'gh'), { recursive: true });
  const token =
    (await readToken().catch(() => null)) ||
    (process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? null);
  return {
    filesystem: {
      allowWrite: [cwd ?? neoFolderPath(), temp, ...neoReadCheckoutPaths()],
    },
    env: {
      TMPDIR: temp,
      ZDOTDIR: temp,
      BASH_ENV: '/dev/null',
      ENV: '/dev/null',
      GH_TOKEN: token ?? '',
      GITHUB_TOKEN: '',
      GH_ENTERPRISE_TOKEN: '',
      GITHUB_ENTERPRISE_TOKEN: '',
      GH_CONFIG_DIR: join(temp, 'gh'),
      GH_PROMPT_DISABLED: '1',
      GH_NO_UPDATE_NOTIFIER: '1',
    },
  };
}
