import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function createPushedWorkerRepo(root: string) {
  const repo = join(realpathSync(root), 'repo');
  const origin = join(realpathSync(root), 'origin.git');
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const result = spawnSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Synthetic',
        '-c',
        'user.email=synthetic@example.invalid',
        ...args,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      }
    );
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'dev');
  git('init', '--bare', origin);
  git('commit', '--allow-empty', '-m', 'initial');
  git('remote', 'add', 'origin', origin);
  git('push', '-u', 'origin', 'dev');
  return { repo, origin, git };
}
