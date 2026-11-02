import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { simpleGit } from 'simple-git';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { SpawnFn } from '../runtime-spawn/index.ts';
import type { Result, WorkArchived } from './types.ts';

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
  if (!existsSync(directory)) return { directory, removed: true };
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
    await simpleGit(dirname(directory)).raw(['--git-dir', common, 'worktree', 'remove', directory]);
    return { directory, removed: true };
  } catch (error) {
    return {
      directory,
      removed: false,
      reason: `Could not verify or remove the worktree; kept: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
