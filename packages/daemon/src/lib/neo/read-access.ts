import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeychainCredentialStore } from '../credentials/credential-store.ts';
import { getDataDir } from '../data-dir.ts';
import { neoFolderPath } from './folder.ts';
import { getNeoReadCheckoutPath } from './read-checkout-path.ts';

export function neoReadCheckoutPaths(dataDir = getDataDir()): string[] {
  const root = join(dataDir, 'worktrees');
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((owner) => owner.isDirectory())
    .flatMap((owner) =>
      readdirSync(join(root, owner.name), { withFileTypes: true })
        .filter((repo) => repo.isDirectory())
        .map((repo) => getNeoReadCheckoutPath(owner.name, repo.name, dataDir))
        .filter((path) => existsSync(path))
    );
}

export async function neoReadAccess(
  sessionId: string,
  cwd: string | undefined,
  readToken: () => Promise<string | null> = () =>
    process.env.NODE_ENV === 'test'
      ? Promise.resolve(null)
      : new KeychainCredentialStore().get('hyperneo.neo.github', 'readonly')
) {
  const temp = join(tmpdir(), 'hyperneo-neo', sessionId);
  mkdirSync(join(temp, 'gh'), { recursive: true });
  const token = await readToken();
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
