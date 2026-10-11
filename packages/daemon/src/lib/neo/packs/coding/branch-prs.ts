import type { WorktreeMetadata } from '@hyperneo/shared';
import { z } from 'zod';
import { runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import { NEO_WORK_PR_READ_MS } from './work-prs.ts';

export type NeoWorkBranch = { branch: string; cwd: string };
export type NeoBranchPrReader = (branch: NeoWorkBranch) => Promise<string[]>;
export type NeoWorkRepo = { owner: string; repo: string };
export type NeoWorkRepoReader = (cwd: string) => Promise<NeoWorkRepo | null>;

export const NEO_BRANCH_PR_MAX = 2;
const NEO_BRANCH_PR_READ = 5;
const BranchPrsSchema = z.array(z.object({ url: z.string() }));
const RepoSchema = z.object({ owner: z.object({ login: z.string() }), name: z.string() });
const read = new Map<string, { at: number; urls: string[] }>();
const repos = new Map<string, NeoWorkRepo>();

export function neoWorkBranch(
  session: { worktree?: WorktreeMetadata } | null
): NeoWorkBranch | null {
  return session?.worktree?.branch
    ? { branch: session.worktree.branch, cwd: session.worktree.worktreePath }
    : null;
}

export function neoWorkRepoCwd(
  session: { worktree?: WorktreeMetadata; workspacePath?: string | null } | null
): string | null {
  return session?.worktree?.worktreePath ?? session?.workspacePath ?? null;
}

export async function readGithubWorkRepo(
  cwd: string,
  spawnImpl: SpawnFn = spawnProcess
): Promise<NeoWorkRepo | null> {
  const cached = repos.get(cwd);
  if (cached) return cached;
  const outcome = await runGhJson(['gh', 'repo', 'view', '--json', 'owner,name'], cwd, spawnImpl, {
    resourceHint: 'graphql',
    stripGHRepo: true,
  });
  const parsed = outcome.ok ? RepoSchema.safeParse(outcome.data) : null;
  if (!parsed?.success) return null;
  const repo = { owner: parsed.data.owner.login, repo: parsed.data.name };
  repos.set(cwd, repo);
  return repo;
}

export function neoCardPrUrls(base: readonly string[], opened: readonly string[]): string[] {
  return [...base, ...opened.filter((url) => !base.includes(url)).slice(0, NEO_BRANCH_PR_MAX)];
}

export async function readGithubBranchPrs(
  branch: NeoWorkBranch,
  spawnImpl: SpawnFn = spawnProcess
): Promise<string[]> {
  const key = `${branch.cwd}:${branch.branch}`;
  const cached = read.get(key);
  if (cached && Date.now() - cached.at < NEO_WORK_PR_READ_MS) return cached.urls;
  const outcome = await runGhJson(
    [
      'gh',
      'pr',
      'list',
      '--head',
      branch.branch,
      '--state',
      'all',
      '--json',
      'url',
      '--limit',
      String(NEO_BRANCH_PR_READ),
    ],
    branch.cwd,
    spawnImpl,
    { resourceHint: 'graphql', stripGHRepo: true }
  );
  const parsed = outcome.ok ? BranchPrsSchema.safeParse(outcome.data) : null;
  if (!parsed?.success) return cached?.urls ?? [];
  const urls = parsed.data.map((pr) => pr.url);
  read.set(key, { at: Date.now(), urls });
  return urls;
}
