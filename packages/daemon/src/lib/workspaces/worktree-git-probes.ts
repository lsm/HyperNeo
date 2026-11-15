import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export function resolveRepoRoot(repoRoot: string): { commandCwd: string; dirKey: string } {
  let cwdRoot = repoRoot;
  try {
    cwdRoot = realpathSync(repoRoot);
  } catch {
    return { commandCwd: repoRoot, dirKey: repoRoot };
  }
  let commonDir = '';
  try {
    const commonDirRaw = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: cwdRoot,
      encoding: 'utf8',
      timeout: 30_000,
    }).replace(/\n$/, '');
    if (commonDirRaw) {
      commonDir = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(cwdRoot, commonDirRaw);
    }
  } catch {}
  if (!commonDir) {
    return { commandCwd: cwdRoot, dirKey: cwdRoot };
  }
  try {
    const topLevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: cwdRoot,
      encoding: 'utf8',
      timeout: 30_000,
    }).replace(/\n$/, '');
    return { commandCwd: topLevel || cwdRoot, dirKey: projectDirKey(commonDir) };
  } catch {
    return { commandCwd: cwdRoot, dirKey: projectDirKey(commonDir) };
  }
}

function projectDirKey(commonDir: string): string {
  return basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;
}

export function listWorktreeDirSlugs(worktreesDir: string): string[] {
  try {
    return readdirSync(worktreesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function worktreeGitDir(worktreePath: string): string | null {
  try {
    const raw = readFileSync(join(worktreePath, '.git'), 'utf8').trim();
    const gitdir = raw.startsWith('gitdir:') ? raw.slice('gitdir:'.length).trim() : '';
    if (!gitdir) return null;
    return isAbsolute(gitdir) ? gitdir : resolve(worktreePath, gitdir);
  } catch {
    return null;
  }
}

export function writeWorktreeClaim(worktreePath: string, spaceId: string, taskId: string): void {
  const gitdir = worktreeGitDir(worktreePath);
  if (!gitdir) return;
  try {
    writeFileSync(join(gitdir, 'hyperneo-claim'), `${spaceId}\n${taskId}`);
  } catch {}
}

export function readWorktreeClaim(
  worktreePath: string
): { spaceId: string; taskId: string } | null {
  const gitdir = worktreeGitDir(worktreePath);
  if (!gitdir) return null;
  try {
    const raw = readFileSync(join(gitdir, 'hyperneo-claim'), 'utf8').trim();
    const [spaceId, taskId] = raw.split('\n');
    if (spaceId && taskId) return { spaceId, taskId };
  } catch {}
  return null;
}

export function worktreeCurrentBranch(worktreePath: string): string | null {
  try {
    return execFileSync('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 30_000,
    }).trim();
  } catch {
    return null;
  }
}

export function registeredWorktreePaths(commandCwd: string): Set<string> {
  try {
    const list = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], {
      cwd: commandCwd,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const paths = new Set<string>();
    for (const record of list.split('\0')) {
      if (!record.startsWith('worktree ')) continue;
      try {
        paths.add(realpathSync(record.slice('worktree '.length)));
      } catch {}
    }
    return paths;
  } catch {
    return new Set<string>();
  }
}

function isRegisteredWorktree(commandCwd: string, worktreePath: string): boolean {
  let target: string | null = null;
  try {
    target = realpathSync(worktreePath);
  } catch {
    return false;
  }
  return registeredWorktreePaths(commandCwd).has(target);
}

export function isLiveRegisteredWorktree(commandCwd: string, worktreePath: string): boolean {
  return existsSync(join(worktreePath, '.git')) && isRegisteredWorktree(commandCwd, worktreePath);
}
