import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
