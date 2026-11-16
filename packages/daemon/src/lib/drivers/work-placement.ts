import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { readdir, readFile, readlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { simpleGit } from 'simple-git';
import superpipe, { type PipelineAPI } from 'superpipe';
import { Logger } from '../logger.ts';
import type { SpawnFn } from '../runtime-spawn/index.ts';
import type { Result, WorkArchived } from './types.ts';
import { releaseWorkerWorkFolders } from './worker-sandbox.ts';

const log = new Logger('work-placement');
const execFileAsync = promisify(execFile);

export async function releaseRemovedWorkerFolders(directory: string) {
  await releaseWorkerWorkFolders(directory).catch((error) =>
    log.warn(`Kept work folders of ${directory}:`, error)
  );
}

export interface GitCheckout {
  repo: string;
  linked: boolean;
}

export type WorkPlacement = { kind: 'in_place' } | { kind: 'worktree'; repo: string };

export function planWorkPlacement(checkout: GitCheckout | null): WorkPlacement {
  return checkout && !checkout.linked
    ? { kind: 'worktree', repo: checkout.repo }
    : { kind: 'in_place' };
}

export async function prepareWorkerFolder(
  folder: string,
  deps: {
    worktreesDir: string;
    newId(): string;
    gitCheckout(folder: string): Promise<GitCheckout | null>;
    spawn: SpawnFn;
  },
  inPlace = false
): Promise<Result<{ cwd: string; release(): Promise<void> }>> {
  const placement = planWorkPlacement(
    inPlace ? null : await deps.gitCheckout(folder).catch(() => null)
  );
  if (placement.kind === 'in_place')
    return { ok: true, value: { cwd: folder, release: async () => {} } };
  const worktree = join(deps.worktreesDir, deps.newId().slice(0, 8), basename(placement.repo));
  const run = async (args: string[]) => {
    const proc = deps.spawn(['git', ...args], {
      cwd: placement.repo,
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { code, stderr: stderr.trim() };
  };
  const added = await run(['worktree', 'add', '--detach', worktree, 'HEAD']);
  if (added.code !== 0) {
    const head = await run(['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (head.code === 1) return { ok: true, value: { cwd: folder, release: async () => {} } };
    return {
      ok: false,
      reason: 'not_delivered',
      detail: `Could not create a worktree in ${placement.repo}: ${added.stderr}`,
    };
  }
  return {
    ok: true,
    value: {
      cwd: worktree,
      release: async () => {
        await run(['worktree', 'remove', '--force', worktree]).catch(() => {});
      },
    },
  };
}

type Cleanup = NonNullable<WorkArchived['worktree']>;
type Facts = { dirty: boolean; unpushed: string; submodules: boolean };
export async function workerWorktreeHasSubmodules(directory: string): Promise<boolean> {
  return (await simpleGit(directory).raw(['submodule', 'status', '--recursive'])).trim() !== '';
}
const cleanupPlan = (superpipe({})('worker-worktree-cleanup') as PipelineAPI)
  .input(['facts'])
  .pipe(
    (facts: Facts) =>
      facts.submodules
        ? { reason: { reason: 'Submodule worktrees require manual verification; kept.' } }
        : { value: true },
    'facts',
    'result:ready'
  )
  .pipe(
    (facts: Facts) =>
      facts.dirty
        ? { reason: { reason: 'The worktree has uncommitted changes; kept.' } }
        : { value: true },
    'facts',
    'result:ready'
  )
  .pipe(
    (facts: Facts) =>
      facts.unpushed === '0'
        ? { value: true }
        : { reason: { reason: 'The worktree has unpushed commits or cannot be verified; kept.' } },
    'facts',
    'result:ready'
  )
  .end('ready') as (facts: Facts) => true | { reason: string };

export const WORKTREE_IN_USE =
  'A running process is inside the worktree, or the process check failed; kept.';

type ProcReader = {
  readdir(path: string): Promise<string[]>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readlink(path: string): Promise<string>;
};

export async function procFolderInUse(
  root: string,
  proc: ProcReader = { readdir, readFile, readlink }
): Promise<boolean> {
  const uid = process.getuid?.();
  const pids = (await proc.readdir('/proc')).filter((name) => /^\d+$/.test(name));
  const busy = await Promise.all(
    pids.map(async (pid) => {
      try {
        const ids = /^Uid:\s+(.*)$/m.exec(await proc.readFile(`/proc/${pid}/status`, 'utf8'));
        if (!ids) return true;
        if (!ids[1].split(/\s+/).includes(String(uid))) return false;
        return `${await proc.readlink(`/proc/${pid}/cwd`)}/`.startsWith(`${root}/`);
      } catch (error) {
        return !['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '');
      }
    })
  );
  return busy.includes(true);
}

async function folderInUse(directory: string): Promise<boolean> {
  const root = realpathSync(directory);
  const inside = (path: string) => `${path}/`.startsWith(`${root}/`);
  if (process.platform === 'linux') return procFolderInUse(root);
  const uid = String(process.getuid?.() ?? '');
  const { stdout } = await execFileAsync('lsof', ['-w', '-a', '-d', 'cwd', '-u', uid, '-Fn']);
  return stdout.split('\n').some((line) => line.startsWith('n') && inside(line.slice(1)));
}

export async function cleanupOwnedWorktree(
  directory: string,
  roots: readonly string[]
): Promise<Cleanup | undefined> {
  if (
    !isAbsolute(directory) ||
    !roots.some((root) => {
      const path = relative(resolve(root), resolve(directory));
      return (
        path !== '' &&
        path !== '..' &&
        !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
        !isAbsolute(path)
      );
    })
  )
    return undefined;
  if (!existsSync(directory)) {
    await releaseRemovedWorkerFolders(directory);
    return { directory, removed: true };
  }
  try {
    const git = simpleGit(directory);
    const common = (await git.revparse(['--path-format=absolute', '--git-common-dir'])).trim();
    const own = (await git.revparse(['--path-format=absolute', '--git-dir'])).trim();
    if (common === own)
      return {
        directory,
        removed: false,
        reason: 'The folder is not a linked worker worktree; kept.',
      };
    const [status, unpushed, submodules] = await Promise.all([
      git.status(['--ignore-submodules=none']),
      git.raw(['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']),
      workerWorktreeHasSubmodules(directory),
    ]);
    const plan = cleanupPlan({ dirty: !status.isClean(), unpushed: unpushed.trim(), submodules });
    if (plan !== true) return { directory, removed: false, reason: plan.reason };
    if (await folderInUse(directory).catch(() => true))
      return { directory, removed: false, reason: WORKTREE_IN_USE };
    await simpleGit(dirname(directory)).raw(['--git-dir', common, 'worktree', 'remove', directory]);
    await releaseRemovedWorkerFolders(directory);
    return { directory, removed: true };
  } catch (error) {
    return {
      directory,
      removed: false,
      reason: `Could not verify or remove the worktree; kept: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
