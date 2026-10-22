import type { WorkRef } from '../../../drivers/types.ts';
import { isAbsolute } from 'node:path';
import simpleGit from 'simple-git';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { WorktreeMetadata } from '@hyperneo/shared';
import { z } from 'zod';
import { buildGitHubLookupEnv, runGhJson } from '../../../github/gh-lookup-helpers.ts';
import { spawnProcess, type SpawnFn } from '../../../runtime-spawn/index.ts';
import { NEO_WORK_PR_READ_MS } from './work-prs.ts';

type NeoWorkBranch = { branch: string; cwd: string };
type BranchQuery = { cwd: string; branch?: string };
export type NeoBranchPrReader = (branch: NeoWorkBranch) => Promise<string[]>;
const NEO_BRANCH_PR_MAX = 2;
export const CODING_BRANCH_PR_LIMIT = 5;
const BranchPrsSchema = z.array(z.object({ url: z.string() }));
const read = new Map<string, { at: number; urls: string[] }>();
export function localCodingSessionId(ref: WorkRef | null): string | null {
  return ref?.adapter === 'hyperneo' && !ref.daemon ? ref.id : null;
}

export function neoWorkBranch(
  session: { worktree?: WorktreeMetadata } | null
): NeoWorkBranch | null {
  return session?.worktree?.branch
    ? { branch: session.worktree.branch, cwd: session.worktree.worktreePath }
    : null;
}

export function neoCardPrUrls(base: readonly string[], opened: readonly string[]): string[] {
  return [...base, ...opened.filter((url) => !base.includes(url)).slice(0, NEO_BRANCH_PR_MAX)];
}

async function readNamedGithubBranchPrs(
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
      String(CODING_BRANCH_PR_LIMIT),
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

function requireCodingCheckout(query: BranchQuery): { value: BranchQuery } | { reason: string[] } {
  return isAbsolute(query.cwd) && !query.cwd.includes('\0') && query.branch !== ''
    ? { value: query }
    : { reason: [] };
}

async function resolveCodingBranch(
  query: BranchQuery
): Promise<{ value: NeoWorkBranch } | { reason: string[] }> {
  if (query.branch !== undefined) return { value: { cwd: query.cwd, branch: query.branch } };
  try {
    const branch = (
      await simpleGit({ baseDir: query.cwd, timeout: { block: 3_000 } })
        .env(buildGitHubLookupEnv())
        .raw(['symbolic-ref', '--quiet', '--short', 'HEAD'])
    ).trim();
    return branch ? { value: { cwd: query.cwd, branch } } : { reason: [] };
  } catch {
    return { reason: [] };
  }
}

const runCodingBranchPrs = (superpipe({})('neo-coding-branch-prs') as PipelineAPI)
  .input(['query', 'read'])
  .pipe(requireCodingCheckout, 'query', 'result:prs')
  .pipe(resolveCodingBranch, 'prs', 'result:prs')
  .pipe((branch: NeoWorkBranch, read: NeoBranchPrReader) => read(branch), ['prs', 'read'], 'prs')
  .endAsync('prs') as (query: BranchQuery, read: NeoBranchPrReader) => Promise<string[]>;

export function readGithubBranchPrs(
  query: BranchQuery,
  spawnImpl: SpawnFn = spawnProcess
): Promise<string[]> {
  return runCodingBranchPrs(query, (branch) => readNamedGithubBranchPrs(branch, spawnImpl));
}

export function readCodingBranchPrs(
  query: BranchQuery,
  read: NeoBranchPrReader
): Promise<string[]> {
  return runCodingBranchPrs(query, read);
}
