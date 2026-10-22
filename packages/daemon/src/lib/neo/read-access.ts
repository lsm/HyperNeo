import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeychainCredentialStore } from '../credentials/credential-store.ts';
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
  readToken: () => Promise<string | null> = () =>
    process.env.NODE_ENV === 'test' || platform() !== 'darwin'
      ? Promise.resolve(null)
      : new KeychainCredentialStore().get('hyperneo.neo.github', 'readonly')
) {
  const temp = join(tmpdir(), 'hyperneo-neo', sessionId);
  mkdirSync(join(temp, 'gh'), { recursive: true });
  const token = await readToken().catch(() => null);
  return {
    filesystem: {
      allowWrite: [temp, ...neoReadCheckoutPaths()],
      denyWrite: [cwd ?? neoFolderPath()],
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
