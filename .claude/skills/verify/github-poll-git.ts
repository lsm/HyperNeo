import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createPollingGitFixture(run: string, repositories: string[]) {
  const origin = join(run, 'origin.git'), publisher = join(run, 'publisher');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(run, 'init', '--bare', '--initial-branch=main', origin);
  mkdirSync(publisher);
  git(publisher, 'init', '--initial-branch=main');
  git(publisher, 'config', 'user.name', 'Synthetic polling');
  git(publisher, 'config', 'user.email', 'polling@example.invalid');
  writeFileSync(join(publisher, 'snapshot.txt'), 'Synthetic polling baseline\n');
  git(publisher, 'add', 'snapshot.txt'); git(publisher, 'commit', '-m', 'Synthetic baseline');
  git(publisher, 'remote', 'add', 'origin', origin); git(publisher, 'push', 'origin', 'main');
  writeFileSync(join(run, 'home/.gitconfig'), repositories.map(repo => `[url "${origin}"]\n\tinsteadOf = git@github.com:${repo}.git\n`).join(''));
  return git(publisher, 'rev-parse', 'HEAD');
}
